import { readFileSync } from "node:fs";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { IRError } from "../ir/error.js";
import { irError, toIRError } from "../gateway/errors.js";
import { encryptSecret, issueVirtualKey } from "../ops/keys.js";
import {
  burnVerifyTiming,
  hashPassword,
  hashSessionToken,
  newAccountId,
  newSessionToken,
  verifyPassword,
} from "../ops/accounts.js";
import type { PortalAccount, QueryableLedger, VirtualKey } from "../state/types.js";
import type { AppDeps } from "./app.js";

// 셀프 가입 포털 (2026-08-24) — 계정 = 테넌트 1:1. 관리자 개입 없이 가입 → 키 발급 → 사용량.
//
// 공개 가입이 유료 게이트웨이에 붙는다는 사실이 설계의 출발점이다:
//   · 포털이 발급하는 키는 **항상 기본 한도**(rpm·기간 예산)를 강제로 단다 — 계정이 스스로
//     못 올린다 (올리는 건 관리자 소관, 관리 콘솔로). 무한도 셀프 발급 = 무한도 지출.
//   · PORTAL_INVITE_CODE 설정 시 가입에 초대 코드 요구 — 인터넷 노출 배포의 권장 구성.
//   · 로그인은 이메일별 분당 10회 (rateLimiter 경유 — Redis면 크로스노드), 가입은 전역 분당 20회.
//   · 계정 부재/비번 오류는 같은 메시지·같은 scrypt 비용 — 이메일 존재 여부를 새지 않게.
//
// 세션: HttpOnly + SameSite=Strict 쿠키, 저장은 sha256 해시만. CSRF는 Strict 쿠키 +
// 모든 변이에 content-type: application/json 요구(교차 출처 form은 이 헤더를 못 단다)의
// 이중 방어 — CORS 헤더를 내지 않으므로 preflight가 교차 출처 fetch를 막는다.

const COOKIE = "gw_portal";

interface PortalLimits {
  rpm: number;
  periodDays: number;
  softUsd: number;
  hardUsd: number;
  maxKeys: number;
  sessionTtlDays: number;
}

/** 발급 기본 한도 — env가 단일 소스 (요청 시점 평가: 테스트·재설정 반영) */
function limits(): PortalLimits {
  const num = (k: string, d: number): number => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const hardUsd = num("PORTAL_KEY_HARD_USD", 5);
  return {
    rpm: Math.floor(num("PORTAL_KEY_RPM", 60)),
    periodDays: Math.floor(num("PORTAL_KEY_PERIOD_DAYS", 30)),
    softUsd: Math.min(num("PORTAL_KEY_SOFT_USD", hardUsd * 0.8), hardUsd),
    hardUsd,
    maxKeys: Math.floor(num("PORTAL_MAX_KEYS", 5)),
    sessionTtlDays: Math.floor(num("PORTAL_SESSION_TTL_DAYS", 7)),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let cachedHtml: string | undefined;
function portalHtml(): string {
  cachedHtml ??= readFileSync(new URL("./portal.html", import.meta.url), "utf8");
  return cachedHtml;
}

function errJson(c: Context, error: IRError) {
  const status = Math.min(599, Math.max(200, error.httpStatus));
  return c.json({ error }, status as 400);
}

/** 변이 요청은 JSON 강제 — SameSite=Strict와 함께 CSRF 이중 방어 */
function requireJson(c: Context): boolean {
  return (c.req.header("content-type") ?? "").includes("application/json");
}

function keySafe(k: VirtualKey): Omit<VirtualKey, "keyHash"> {
  const { keyHash: _hash, ...safe } = k;
  return safe;
}

export function registerPortalRoutes(app: Hono, deps: AppDeps): void {
  const portalCtx = new WeakMap<Request, { account: PortalAccount }>();
  const enabled = (): boolean =>
    deps.accounts !== undefined && deps.portalSessions !== undefined && deps.keys !== undefined;
  const now = (): Date => deps.now?.() ?? new Date();

  // ── 페이지 · 공개 메타 ──────────────────────────────────
  app.get("/portal", (c) => c.html(portalHtml()));

  app.get("/portal/config", (c) => {
    const l = limits();
    return c.json({
      enabled: enabled(),
      inviteRequired: Boolean(process.env["PORTAL_INVITE_CODE"]),
      limits: { rpm: l.rpm, hardUsd: l.hardUsd, softUsd: l.softUsd, periodDays: l.periodDays, maxKeys: l.maxKeys },
    });
  });

  // ── 세션 미들웨어 (공개 경로 외 전부) ───────────────────
  const PUBLIC = new Set(["/portal/config", "/portal/signup", "/portal/login", "/portal/logout"]);
  app.use("/portal/*", async (c, next) => {
    if (PUBLIC.has(c.req.path)) return next();
    if (!enabled()) return errJson(c, irError("invalid_request", 501, "포털 비활성 — 인증 모드(GATEWAY_ADMIN_KEY)에서만 제공됩니다"));
    const token = getCookie(c, COOKIE);
    if (!token) return errJson(c, irError("auth", 401, "로그인이 필요합니다"));
    const session = await deps.portalSessions!.get(hashSessionToken(token));
    if (!session || session.expiresAt <= now().toISOString()) {
      if (session) await deps.portalSessions!.delete(session.tokenHash).catch(() => undefined);
      return errJson(c, irError("auth", 401, "세션이 만료되었습니다 — 다시 로그인하세요"));
    }
    const account = await deps.accounts!.get(session.accountId);
    if (!account || account.disabled) return errJson(c, irError("auth", 401, "계정을 사용할 수 없습니다"));
    portalCtx.set(c.req.raw, { account });
    return next();
  });
  const accountOf = (c: Context): PortalAccount => portalCtx.get(c.req.raw)!.account;

  async function openSession(c: Context, accountId: string): Promise<void> {
    const ttlDays = limits().sessionTtlDays;
    const { token, tokenHash } = newSessionToken();
    const at = now();
    await deps.portalSessions!.put({
      tokenHash,
      accountId,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + ttlDays * 86_400_000).toISOString(),
    });
    setCookie(c, COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: ttlDays * 86_400,
      // TLS 종료 뒤에서만 Secure — 로컬 http 데모를 죽이지 않으면서 프록시 배포는 보호
      ...(c.req.header("x-forwarded-proto") === "https" ? { secure: true } : {}),
    });
  }

  // ── 가입 ────────────────────────────────────────────────
  app.post("/portal/signup", async (c) => {
    if (!enabled()) return errJson(c, irError("invalid_request", 501, "포털 비활성 — 인증 모드(GATEWAY_ADMIN_KEY)에서만 제공됩니다"));
    if (!requireJson(c)) return errJson(c, irError("invalid_request", 415, "content-type: application/json 필요"));
    if (deps.rateLimiter) {
      // 전역 가입 빈도 — 봇 대량 가입의 1차 방어 (정밀 방어는 초대 코드)
      const v = await deps.rateLimiter.hit("portal:signup", 20, 60, now());
      if (!v.allowed) return errJson(c, irError("rate_limit", 429, "가입 요청이 많습니다 — 잠시 후 다시 시도하세요"));
    }
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown; inviteCode?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!EMAIL_RE.test(email)) return errJson(c, irError("invalid_request", 400, "올바른 이메일이 아닙니다"));
    if (password.length < 8) return errJson(c, irError("invalid_request", 400, "비밀번호는 8자 이상이어야 합니다"));
    const invite = process.env["PORTAL_INVITE_CODE"];
    if (invite && body?.inviteCode !== invite) {
      return errJson(c, irError("permission", 403, "초대 코드가 올바르지 않습니다"));
    }
    const accountId = newAccountId();
    const account: PortalAccount = {
      accountId,
      email,
      passwordHash: await hashPassword(password),
      tenant: accountId, // 계정 = 테넌트 1:1 — 원장·키·BYO가 전부 이 값으로 격리
      createdAt: now().toISOString(),
    };
    const created = await deps.accounts!.create(account);
    if (!created) return errJson(c, irError("invalid_request", 409, "이미 가입된 이메일입니다"));
    await openSession(c, accountId);
    return c.json({ account: { accountId, email, tenant: account.tenant } }, 201);
  });

  // ── 로그인 / 로그아웃 ───────────────────────────────────
  app.post("/portal/login", async (c) => {
    if (!enabled()) return errJson(c, irError("invalid_request", 501, "포털 비활성 — 인증 모드(GATEWAY_ADMIN_KEY)에서만 제공됩니다"));
    if (!requireJson(c)) return errJson(c, irError("invalid_request", 415, "content-type: application/json 필요"));
    const body = (await c.req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const denied = () => errJson(c, irError("auth", 401, "이메일 또는 비밀번호가 올바르지 않습니다"));
    if (!email || !password) return denied();
    if (deps.rateLimiter) {
      // 이메일별 브루트포스 방어 — Redis면 레플리카 합산으로 성립.
      // 키는 해시로 상한 — 무검증 이메일 문자열이 그대로 저장 키가 되면 무인증 메모리
      // 팽창 벡터 + 리미터 스토어에 PII 잔존 (감사 #47)
      const loginKey = `portal:login:${hashSessionToken(email).slice(0, 32)}`;
      const v = await deps.rateLimiter.hit(loginKey, 10, 60, now());
      if (!v.allowed) return errJson(c, irError("rate_limit", 429, `로그인 시도 한도 초과 — ${v.retryAfterSeconds}초 후 재시도`));
    }
    const account = await deps.accounts!.getByEmail(email);
    if (!account || account.disabled) {
      await burnVerifyTiming(); // 존재 여부가 응답 시간으로 새지 않게
      return denied();
    }
    if (!(await verifyPassword(password, account.passwordHash))) return denied();
    await openSession(c, account.accountId);
    return c.json({ account: { accountId: account.accountId, email: account.email, tenant: account.tenant } });
  });

  app.post("/portal/logout", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token && deps.portalSessions) await deps.portalSessions.delete(hashSessionToken(token)).catch(() => undefined);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ── 내 정보 ─────────────────────────────────────────────
  app.get("/portal/me", (c) => {
    const a = accountOf(c);
    const l = limits();
    return c.json({
      accountId: a.accountId,
      email: a.email,
      tenant: a.tenant,
      limits: { rpm: l.rpm, hardUsd: l.hardUsd, softUsd: l.softUsd, periodDays: l.periodDays, maxKeys: l.maxKeys },
    });
  });

  // ── API 키 셀프서비스 ───────────────────────────────────
  const myKeys = async (tenant: string): Promise<VirtualKey[]> =>
    (await deps.keys!.list()).filter((k) => k.tenant === tenant);

  app.get("/portal/keys", async (c) => {
    return c.json({ keys: (await myKeys(accountOf(c).tenant)).map(keySafe) });
  });

  // maxKeys 검사↔발급 TOCTOU 차단 — 테넌트별 프로세스 내 직렬화 (감사 #48).
  // ponytail: 크로스 레플리카 경합은 잔존 (포털 단일 인스턴스 전제) — 필요해지면 KeyStore 조건부 발급으로
  const keyIssueTail = new Map<string, Promise<unknown>>();
  app.post("/portal/keys", async (c) => {
    if (!requireJson(c)) return errJson(c, irError("invalid_request", 415, "content-type: application/json 필요"));
    const a = accountOf(c);
    const l = limits();
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 64) : "";
    const run = (keyIssueTail.get(a.tenant) ?? Promise.resolve()).then(async () => {
      const active = (await myKeys(a.tenant)).filter((k) => !k.disabled);
      if (active.length >= l.maxKeys) return null;
      // 포털 발급 키는 항상 기본 한도 부착 — 셀프서비스가 무한도 지출로 이어지지 않게.
      // 한도 상향은 관리자 소관 (관리 콘솔에서 별도 키 발급)
      return issueVirtualKey(
        deps.keys!,
        {
          tenant: a.tenant,
          ...(name ? { name } : {}),
          rateLimit: { requestsPerMinute: l.rpm },
          budget: { periodDays: l.periodDays, softUsd: l.softUsd, hardUsd: l.hardUsd },
        },
        deps.now ?? (() => new Date()),
      );
    });
    keyIssueTail.set(a.tenant, run.catch(() => undefined));
    const issued = await run;
    if (issued === null) {
      return errJson(c, irError("invalid_request", 400, `활성 키 한도(${l.maxKeys}개) 초과 — 안 쓰는 키를 비활성화하세요`));
    }
    return c.json({ key: keySafe(issued.key), secret: issued.secret }, 201); // 시크릿 1회 노출 — 관리 API와 동일 계약
  });

  app.post("/portal/keys/:id/disable", async (c) => {
    const a = accountOf(c);
    const key = await deps.keys!.get(c.req.param("id"));
    // 타 테넌트 키는 404 — 존재를 노출하지 않는다 (Files·세션과 동일 규약)
    if (!key || key.tenant !== a.tenant) return errJson(c, irError("not_found", 404, "키 없음"));
    await deps.keys!.put({ ...key, disabled: true });
    return c.json({ keyId: key.keyId, disabled: true });
  });

  // ── 사용량 (테넌트 스코프) ──────────────────────────────
  app.get("/portal/usage", async (c) => {
    const a = accountOf(c);
    const at = now();
    const keys = await myKeys(a.tenant);
    const out = [];
    for (const k of keys) {
      const windowDays = k.budget?.periodDays ?? 30;
      const since = new Date(at.getTime() - windowDays * 86_400_000).toISOString();
      let spentUsd: number | undefined;
      if (deps.spendTracker) {
        try {
          spentUsd = await deps.spendTracker.spentSince(k.keyId, since);
        } catch {
          /* 집계 조회 실패는 뷰를 막지 않는다 */
        }
      }
      out.push({
        ...keySafe(k),
        windowDays,
        ...(spentUsd !== undefined ? { spentUsd } : {}),
        blocked: k.budget?.hardUsd !== undefined && spentUsd !== undefined && spentUsd >= k.budget.hardUsd,
      });
    }
    // 모델별 집계 (최근 30일) — QueryableLedger일 때만
    const ledger = deps.ledger as QueryableLedger | undefined;
    let models: unknown[] = [];
    if (ledger && typeof ledger.aggregate === "function") {
      try {
        models = await ledger.aggregate({
          from: new Date(at.getTime() - 30 * 86_400_000).toISOString(),
          to: at.toISOString(),
          groupBy: "model",
          tenant: a.tenant,
        });
      } catch {
        /* 집계 불가 원장(비 Queryable)·일시 장애 — 키별 지출만 제공 */
      }
    }
    return c.json({ keys: out, models });
  });

  // ── BYO 프로바이더 키 (자기 테넌트 전용) ────────────────
  app.put("/portal/provider-keys", async (c) => {
    if (!requireJson(c)) return errJson(c, irError("invalid_request", 415, "content-type: application/json 필요"));
    if (!deps.providerKeys) return errJson(c, irError("invalid_request", 501, "BYO 키 스토어 미설정"));
    const a = accountOf(c);
    const body = (await c.req.json().catch(() => null)) as { provider?: unknown; key?: unknown } | null;
    const provider = typeof body?.provider === "string" ? body.provider : "";
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!["anthropic", "openai", "google", "xai"].includes(provider) || !key) {
      return errJson(c, irError("invalid_request", 400, "provider(4사 중 하나)·key 필수"));
    }
    try {
      await deps.providerKeys.put({
        tenant: a.tenant, // 세션의 테넌트만 — 요청 본문의 테넌트 지정은 받지 않는다
        provider,
        encryptedKey: encryptSecret(key),
        createdAt: now().toISOString(),
      });
      return c.json({ provider, stored: true });
    } catch (err) {
      return errJson(c, toIRError(err)); // GATEWAY_KEY_ENCRYPTION_KEY 미설정 등
    }
  });

  app.delete("/portal/provider-keys/:provider", async (c) => {
    if (!deps.providerKeys) return errJson(c, irError("invalid_request", 501, "BYO 키 스토어 미설정"));
    await deps.providerKeys.delete(accountOf(c).tenant, c.req.param("provider"));
    return c.json({ deleted: true });
  });
}
