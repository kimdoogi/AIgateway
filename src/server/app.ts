import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { IRRequestSchema } from "../ir/request.js";
import type { IRError } from "../ir/error.js";
import type { JSONValue } from "../ir/json.js";
import { executeNonStream, genRequestId, startStreamSession, type ExecuteDeps } from "../gateway/execute.js";
import { executeCountTokens } from "../gateway/count-tokens.js";
import { deleteFile, getFile, listFiles, resolveGatewayFileRefs, uploadFile } from "../bridge/files.js";
import { cancelBatch, createBatch, getBatch, getBatchResults, listBatches } from "../bridge/batches.js";
import type {
  BodyLogSink,
  KeyStore,
  ProviderKeyStore,
  QueryableLedger,
  ResourceStore,
  VirtualKey,
} from "../state/types.js";
import type { Warning } from "../ir/common.js";
import { timingSafeEqual } from "node:crypto";
import { encryptSecret, issueVirtualKey, tenantCredentialResolver, verifyVirtualKey } from "../ops/keys.js";
import { budgetExceededError, evaluateBudget, type SpendTracker } from "../ops/budget.js";
import { makeWarning } from "../adapters/shared.js";
import { limitOf, rateLimitedError, type RateLimiter } from "../ops/rate-limit.js";
import { checkInboundResources, registerResponseResources, sweepExpiredResources } from "../ops/resources.js";
import { logBody } from "../ops/body-log.js";
import { parseReportQuery, toCsv, usageReport } from "../ops/report.js";
import { credentialHeaders, type ExecuteDeps as GatewayExecuteDeps } from "../gateway/execute.js";
import { getProvider } from "../gateway/registry.js";
import { resolveModel } from "../gateway/registry.js";
import type { BatchStore, FileStore } from "../state/types.js";
import { GatewayError, irError, toIRError } from "../gateway/errors.js";
import type { IRRequest } from "../ir/request.js";
import type { IRResponse } from "../ir/response.js";
import type { StreamEvent } from "../ir/stream.js";
import type { JSONObject } from "../ir/json.js";
import { compatChatToIR } from "../inbound/openai-compat/request.js";
import { toChatError, toChatResponse } from "../inbound/openai-compat/response.js";
import { createChatDownconverter } from "../inbound/openai-compat/stream.js";
import { compatMessagesToIR } from "../inbound/anthropic-compat/request.js";
import { toMessagesError, toMessagesResponse } from "../inbound/anthropic-compat/response.js";
import { createMessagesDownconverter } from "../inbound/anthropic-compat/stream.js";
import { SessionStore, sessionPersistenceKey, type StreamSession } from "../gateway/session.js";
import { consoleHtml, docsHtml } from "./console.js";
import type { AccountStore, PortalSessionStore, SessionPersistence, StreamControl } from "../state/types.js";
import { registerPortalRoutes } from "./portal.js";

// native 인바운드 (walking-skeleton 6단계) — IR envelope 그대로 (ir-v0 §6/§7/§10.4).
// 스트림 오케스트레이션(펌프·heartbeat·seq)은 게이트웨이 소관 — 여기는 파싱 + SSE 인코딩만.
//   POST /v0/responses            비스트림 → IRResponse JSON / stream → SSE (id: = seq)
//   GET  /v0/streams/:id          재개 — Last-Event-ID(=seq)부터 버퍼 재생 + 라이브 테일. 만료 410
//   POST /v0/streams/:id/cancel   명시적 취소 — 즉시 업스트림 abort (D7)

export interface AppDeps extends ExecuteDeps {
  sessions?: SessionStore;
  heartbeatMs?: number;
  /** 프로세스 재시작 후 재개 폴백 (재생 전용 — Redis, ADR-0006) */
  persistence?: SessionPersistence;
  /** 취소 크로스노드 전파 (ADR-0001 D7) — 미설정이면 취소는 소유 레플리카에서만 가능 */
  streamControl?: StreamControl;
  /** Files 브리지 매핑 스토어 (부록 (b) §2) — 미설정이면 /v0/files·refs.gateway 501/400 */
  files?: FileStore;
  /** Batches 브리지 잡 스토어 (부록 (b) §3) */
  batches?: BatchStore;
  // ── 운영 평면 (ADR-0006/0007/0008 — 2026-08-21) ──
  /** 가상 키 스토어 — 설정 시 /v0/* Bearer gwk_ 인증 활성 (미설정 = 개방 모드, 로컬) */
  keys?: KeyStore;
  /** 테넌트 BYO 프로바이더 키 (AES-GCM 암호화 저장 — 사용자 결정 D2) */
  providerKeys?: ProviderKeyStore;
  /** 서버 상태 리소스 레지스트리 (ADR-0006 §3) */
  resources?: ResourceStore;
  /** 본문 로그 sink (ADR-0008 — 기본 on, 키 opt-out) */
  bodyLog?: BodyLogSink;
  /** 예산 실시간 집계 (ADR-0007 §3) — withSpendTracking으로 원장에 배선 */
  spendTracker?: SpendTracker;
  /** 요청 빈도 제한 — 키의 rateLimit 설정이 있을 때만 발동 (리뷰 2026-08-22 #14) */
  rateLimiter?: RateLimiter;
  // ── 셀프 가입 포털 (2026-08-24) — 둘 다 + keys 설정 시 /portal 활성 ──
  accounts?: AccountStore;
  portalSessions?: PortalSessionStore;
  // ── 운영 프로브 (오케스트레이터 배포 — 2026-08-22) ──
  /** readiness 의존성 검사 — 하나라도 실패하면 /ready 503 */
  readiness?: ReadonlyArray<{ name: string; check: () => Promise<void> }>;
  /** 종료 절차 진입 여부 — true면 /ready가 503을 내 LB가 먼저 빠진다 */
  isDraining?: () => boolean;
  /** 빌드 식별자 — /health 응답에 병기 (배포 추적) */
  version?: string;
}

/** 인증 미들웨어가 요청별로 해석한 운영 컨텍스트 */
interface OpsContext {
  key: VirtualKey;
  preWarnings: Warning[];
  resolver: ReturnType<typeof tenantCredentialResolver>;
}

function errJson(c: Context, error: IRError) {
  // Response 유효 범위 밖 status 방어 (프로바이더 status 패스스루 대비 — 리뷰 D5-r3)
  const status = Math.min(599, Math.max(200, error.httpStatus));
  return c.json({ error }, status as 400);
}

/** Last-Event-ID 파싱 — 부재 -1, 불량 null (Number("")→0·16진·2^53 초과 방지 — 리뷰 F8/F10) */
function parseAfterSeq(header: string | undefined): number | null {
  if (header === undefined || header === "") return -1;
  const n = /^\d+$/.test(header) ? Number(header) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** GET 재개·cancel 공용 — 동일 상태 = 동일 응답 (리뷰 E5/RU6) */
const goneStream = (): IRError => irError("not_found", 410, "재개 버퍼 만료 또는 미지 스트림 (TTL 5분)");

/** 세션 이벤트를 SSE로 방출 — 직렬화는 append 시 1회 완료된 문자열 재사용 (id: = seq) */
function sseFromSession(c: Context, session: StreamSession, afterSeq: number) {
  return streamSSE(c, async (stream) => {
    session.attach();
    try {
      for await (const event of session.read(afterSeq, c.req.raw.signal)) {
        if (c.req.raw.signal.aborted) break;
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: event.json });
      }
    } finally {
      session.detach();
    }
  });
}

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const sessions = deps.sessions ?? new SessionStore({ persistence: deps.persistence }); // 기본 스토어도 영속화 배선 (리뷰 F3-r4)
  const opsCtx = new WeakMap<Request, OpsContext>();

  // ── 바디 크기 상한 (리뷰 2026-08-22 #9) ──
  // 인증보다 먼저 걸어야 한다 — 미인증 요청이 수백 MB를 힙에 올리는 것을 막는 게 목적.
  // 파일 업로드만 별도 상한(멀티파트는 본래 크다), 그 외 JSON 경로는 공통 상한.
  const jsonLimit = Number(process.env["MAX_JSON_BODY_BYTES"] ?? 10 * 1024 * 1024);
  const uploadLimit = Number(process.env["MAX_UPLOAD_BYTES"] ?? 64 * 1024 * 1024);
  const tooLarge = (limit: number) => (c: Context) =>
    errJson(c, irError("content_too_large", 413, `요청 본문이 상한(${limit}B)을 초과했습니다`));
  app.post("/v0/files", bodyLimit({ maxSize: uploadLimit, onError: tooLarge(uploadLimit) }));
  // hono bodyLimit는 미들웨어마다 독립 실행 — /v0/* 공통 리미터가 업로드에도 중첩되면
  // 더 작은 10MB가 항상 이겨 MAX_UPLOAD_BYTES가 사문화된다 (감사 2026-08-24 #12).
  const jsonLimiter = bodyLimit({ maxSize: jsonLimit, onError: tooLarge(jsonLimit) });
  app.use("/v0/*", (c, next) =>
    c.req.method === "POST" && c.req.path === "/v0/files" ? next() : jsonLimiter(c, next),
  );
  app.use("/compat/*", bodyLimit({ maxSize: jsonLimit, onError: tooLarge(jsonLimit) }));
  app.use("/portal/*", bodyLimit({ maxSize: jsonLimit, onError: tooLarge(jsonLimit) }));

  // ── 운영 프로브 (인증 밖 — 오케스트레이터가 자격증명 없이 찔러야 한다) ──
  // liveness: 프로세스 생존만. 의존성 상태와 무관하게 200 — 여기서 503을 내면
  // DB 일시 장애에 컨테이너가 재시작 루프에 빠진다 (재시작이 DB를 고치지 않는다).
  app.get("/health", (c) =>
    c.json({ status: "ok", ...(deps.version ? { version: deps.version } : {}) }),
  );

  // readiness: 트래픽 수용 가능 여부. 종료 절차 진입·의존성 장애 시 503 → LB가 이 파드를 뺀다.
  app.get("/ready", async (c) => {
    if (deps.isDraining?.()) {
      return c.json({ status: "draining", checks: {} }, 503);
    }
    const checks: Record<string, string> = {};
    let healthy = true;
    await Promise.all(
      (deps.readiness ?? []).map(async (probe) => {
        try {
          await probe.check();
          checks[probe.name] = "ok";
        } catch (err) {
          healthy = false;
          checks[probe.name] = err instanceof Error ? err.message : String(err);
        }
      }),
    );
    return c.json({ status: healthy ? "ok" : "degraded", checks }, healthy ? 200 : 503);
  });

  // ── 전역 예외 안전망 — 핸들러가 던진 비-GatewayError도 IRError 형태로 (ir-v0 §12) ──
  app.onError((err, c) => {
    const irErr = toIRError(err);
    if (irErr.gatewayException) console.error("[gateway] 미포착 예외", err);
    return errJson(c, irErr);
  });

  // ── 운영 콘솔 (정적 1페이지 — 비밀 없음, 모든 데이터는 키 인증 뒤) ──
  app.get("/", (c) => c.redirect("/console"));
  app.get("/console", (c) => c.html(consoleHtml()));
  app.get("/docs", (c) => c.html(docsHtml())); // Native IR 가이드 — 포털 사용자용 (원본: docs/guides/native-ir.md)

  // ── 셀프 가입 포털 — 세션 쿠키 인증, 계정=테넌트 격리 (server/portal.ts) ──
  registerPortalRoutes(app, deps);

  // ── 가상 키 인증 (ADR-0007 §3 — keys 설정 시 활성, 미설정 = 개방 모드/로컬) ──
  // native(/v0/*)와 compat(/compat/*)에 동일 적용 — 한쪽만 걸면 무인증 유료 경로가 남는다
  // (리뷰 2026-08-22: ops-plane "compat 인바운드 인증" 좌석 클로즈)
  const authenticate = async (c: Context, next: () => Promise<void>) => {
    if (!deps.keys) return next();
    const auth = c.req.header("authorization") ?? "";
    const secret = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let key: VirtualKey;
    try {
      key = await verifyVirtualKey(deps.keys, secret);
    } catch (err) {
      return errJson(c, toIRError(err));
    }
    const preWarnings: Warning[] = [];
    // 자기 상태 조회(/v0/usage)는 쿼터·예산 게이트 **면제** (인증은 그대로) —
    // 402/429의 원인을 보는 창구가 같은 402/429로 막히면 사용자는 왜 막혔는지 영영 알 수 없고,
    // 대시보드 폴링이 실호출 쿼터를 갉아먹는다
    if (c.req.path !== "/v0/usage") {
      // 빈도 제한이 예산보다 **앞** — 예산은 지출 발생 후 평가라 순간 폭주를 못 막는다.
      // 여기서 막으면 프로바이더 호출 자체가 일어나지 않는다
      const rpm = limitOf(key);
      if (deps.rateLimiter && rpm !== undefined) {
        const v = await deps.rateLimiter.hit(key.keyId, rpm, 60, deps.now?.() ?? new Date());
        c.header("x-ratelimit-limit", String(rpm));
        c.header("x-ratelimit-remaining", String(v.remaining));
        if (!v.allowed) {
          c.header("retry-after", String(v.retryAfterSeconds));
          return errJson(c, rateLimitedError(key.keyId, rpm, v).irError);
        }
      }

      // 예산 평가 — 요청당 1회 PreRequest (§10.4: hard는 다음 요청 차단, soft는 warning)
      if (deps.spendTracker) {
        const verdict = await evaluateBudget(key, deps.spendTracker, deps.now?.() ?? new Date());
        if (verdict.blocked) return errJson(c, budgetExceededError(key, verdict.spentUsd).irError);
        if (verdict.warning) preWarnings.push(verdict.warning);
      }
    }
    opsCtx.set(c.req.raw, { key, preWarnings, resolver: tenantCredentialResolver(key.tenant, deps.providerKeys) });
    return next();
  };
  app.use("/v0/*", async (c, next) => {
    if (c.req.path.startsWith("/v0/admin")) return next(); // 관리 API는 마스터 키 (아래 미들웨어)
    return authenticate(c, next);
  });
  app.use("/compat/*", authenticate);

  // ── 관리 API 인증 (사용자 결정 D1 — GATEWAY_ADMIN_KEY 마스터 키, 상수 시간 비교) ──
  app.use("/v0/admin/*", async (c, next) => {
    const configured = process.env["GATEWAY_ADMIN_KEY"];
    if (!configured) {
      return errJson(c, irError("invalid_request", 501, "GATEWAY_ADMIN_KEY 미설정 — 관리 API 비활성 (ops-plane D1)"));
    }
    const presented = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/, "");
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return errJson(c, irError("auth", 401, "관리 키 불일치"));
    return next();
  });

  /** 요청별 실행 deps 확장 — 테넌트 컨텍스트·BYO 자격증명·사전 warning.
   *  keySource는 프로바이더별 맵 — 폴백 타깃 시도 행에 최초 타깃 값이 오염되는 것 방지 (감사 #35) */
  async function withOps(c: Context, targetProviders: string[] = []): Promise<Partial<GatewayExecuteDeps>> {
    const ops = opsCtx.get(c.req.raw);
    if (!ops) return {};
    const providers = [...new Set(targetProviders)];
    const keySourceByProvider: Record<string, "byo" | "pool"> = {};
    for (const p of providers) keySourceByProvider[p] = await ops.resolver.sourceFor(p);
    return {
      tenantContext: {
        tenant: ops.key.tenant,
        keyId: ops.key.keyId,
        ...(providers[0] ? { keySource: keySourceByProvider[providers[0]] } : {}),
        ...(providers.length > 0 ? { keySourceByProvider } : {}),
      },
      ...(ops.preWarnings.length > 0 ? { preWarnings: [...ops.preWarnings] } : {}),
      credentials: ops.resolver.credentials,
      // §10.4 — 스트림 finish 직전 hard 예산 재평가 (감사 #46). 이 요청 비용을 더해 판단
      ...(deps.spendTracker && ops.key.budget?.hardUsd !== undefined
        ? {
            budgetRecheck: async (pendingCostUsd: number): Promise<Warning | undefined> => {
              const v = await evaluateBudget(ops.key, deps.spendTracker!, deps.now?.() ?? new Date());
              const hard = ops.key.budget!.hardUsd!;
              if (v.spentUsd + pendingCostUsd < hard) return undefined;
              return makeWarning(
                "other",
                "budget-exhausted-next-request-blocked",
                `예산 하드 한도 소진 — ${ops.key.budget!.periodDays}일 지출 $${(v.spentUsd + pendingCostUsd).toFixed(4)} ≥ $${hard} (다음 요청부터 402)`,
              );
            },
          }
        : {}),
    };
  }
  const tenantOf = (c: Context): string | undefined => opsCtx.get(c.req.raw)?.key.tenant;

  /**
   * 인바운드 공통 전처리 — native와 compat이 같은 운영 평면을 통과한다 (부록 (a) §1: 실행 경로 동일).
   * ① refs.gateway → 프로바이더 파일 id 치환 ② 테넌트·BYO 자격증명·사전 warning
   * ③ 서버 상태 리소스 참조 검증 (테넌트 격리)
   */
  async function prepareInbound(
    c: Context,
    req: IRRequest,
  ): Promise<{ request: IRRequest; execDeps: Partial<GatewayExecuteDeps> }> {
    let targetProvider: string | undefined;
    try {
      targetProvider = resolveModel(req.model).provider;
    } catch { /* 미라우팅 모델은 실행부의 라우팅 에러 경로로 */ }
    // 폴백 타깃 프로바이더까지 — keySource 맵은 시도 가능한 전 프로바이더를 덮는다 (감사 #35)
    const allProviders = [req.model, ...(req.fallbackModels ?? [])].flatMap((m) => {
      try {
        return [resolveModel(m).provider];
      } catch {
        return [];
      }
    });
    const ops = opsCtx.get(c.req.raw);
    let request = req;
    if (targetProvider) {
      request = (await resolveGatewayFileRefs(request, targetProvider, deps.files, ops?.key.tenant)).request;
    }
    const execDeps = await withOps(c, allProviders);
    if (targetProvider && deps.resources && ops) {
      const resourceWarnings = await checkInboundResources(request, targetProvider, ops.key.tenant, deps.resources);
      if (resourceWarnings.length > 0) {
        execDeps.preWarnings = [...(execDeps.preWarnings ?? []), ...resourceWarnings];
      }
    }
    return { request, execDeps };
  }

  app.post("/v0/responses", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return errJson(c, irError("invalid_request", 400, "JSON body가 아닙니다"));
    }
    const parsed = IRRequestSchema.safeParse(json);
    if (!parsed.success) {
      return errJson(c, {
        ...irError("invalid_request", 400, "IR 요청 검증 실패 (ir-v0 §6 — 미지 최상위 키는 4xx, D5)"),
        provider: { key: "gateway", status: 400, raw: z.treeifyError(parsed.error) as JSONValue },
      });
    }
    const ops = opsCtx.get(c.req.raw);
    let req: IRRequest;
    let opsDeps: Partial<GatewayExecuteDeps>;
    try {
      ({ request: req, execDeps: opsDeps } = await prepareInbound(c, parsed.data));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
    const bodyLogEnabled = deps.bodyLog !== undefined && ops?.key.bodyLogOptOut !== true; // ADR-0008 기본 on

    if (!req.stream) {
      // id를 먼저 발급해 에러 응답에도 상관관계 헤더 제공 (ADR-0008 — 리뷰 A7-r3)
      const id = genRequestId(deps);
      c.header("x-gateway-request-id", id);
      try {
        const response = await executeNonStream(req, { ...deps, ...opsDeps, genId: () => id }, c.req.raw.signal);
        if (deps.resources && ops) {
          await registerResponseResources(response, req, ops.key.tenant, deps.resources, {
            keyId: ops.key.keyId,
            ...(deps.now ? { now: deps.now } : {}),
          }).catch((err) => console.error("[resource-register]", err));
        }
        if (bodyLogEnabled) {
          // 비블로킹 — 본문 로그는 감사 자산이지 응답 경로의 일부가 아니다.
          // await하면 모든 요청이 DB 왕복 2회를 기다린다 (logBody 자체가 실패를 로그 강등)
          const logCtx = { tenant: ops?.key.tenant, now: deps.now };
          void logBody(deps.bodyLog, { requestId: id, ...logCtx, direction: "request", body: json });
          void logBody(deps.bodyLog, { requestId: id, ...logCtx, direction: "response", body: response });
        }
        return c.json(response);
      } catch (err) {
        return errJson(c, toIRError(err));
      }
    }

    const session = startStreamSession(req, { ...deps, ...opsDeps, sessions });
    c.header("x-gateway-request-id", session.id);
    if (bodyLogEnabled) {
      // 스트림은 요청 방향만 v1 — 응답 재조립 로그는 후속 좌석 (ops-plane §6)
      void logBody(deps.bodyLog, { requestId: session.id, tenant: ops?.key.tenant, direction: "request", body: json, now: deps.now });
    }
    return sseFromSession(c, session, -1);
  });

  // count_tokens 프록시 (부록 (b) §1) — 동기 IR 요청과 같은 형태, stream 불가
  app.post("/v0/count-tokens", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return errJson(c, irError("invalid_request", 400, "JSON body가 아닙니다"));
    }
    const parsed = IRRequestSchema.safeParse(json);
    if (!parsed.success) {
      return errJson(c, {
        ...irError("invalid_request", 400, "IR 요청 검증 실패 (ir-v0 §6)"),
        provider: { key: "gateway", status: 400, raw: z.treeifyError(parsed.error) as JSONValue },
      });
    }
    const id = genRequestId(deps);
    c.header("x-gateway-request-id", id);
    try {
      const { request: req, execDeps } = await prepareInbound(c, parsed.data);
      return c.json(await executeCountTokens(req, { ...deps, ...execDeps, genId: () => id }, c.req.raw.signal));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  // ── 셀프서비스 사용량 (콘솔 "내 키 · 사용량") — 키 소유자가 자기 상태를 본다 ──
  app.get("/v0/usage", async (c) => {
    const ops = opsCtx.get(c.req.raw);
    if (!ops) {
      return errJson(
        c,
        irError("invalid_request", 501, "가상 키 인증 비활성(개방 모드) — GATEWAY_ADMIN_KEY 설정 시 사용 가능"),
      );
    }
    const key = ops.key;
    const windowDays = key.budget?.periodDays ?? 30;
    const now = deps.now?.() ?? new Date();
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    let spentUsd: number | undefined;
    if (deps.spendTracker) {
      try {
        spentUsd = await deps.spendTracker.spentSince(key.keyId, since);
      } catch {
        /* 집계 조회 실패는 조회 자체를 막지 않는다 — spentUsd 생략으로 표현 */
      }
    }
    return c.json({
      keyId: key.keyId,
      tenant: key.tenant,
      ...(key.name ? { name: key.name } : {}),
      ...(key.rateLimit ? { rateLimit: key.rateLimit } : {}),
      ...(key.budget ? { budget: key.budget } : {}),
      windowDays,
      ...(spentUsd !== undefined ? { spentUsd } : {}),
      blocked: key.budget?.hardUsd !== undefined && spentUsd !== undefined && spentUsd >= key.budget.hardUsd,
      softExceeded: key.budget?.softUsd !== undefined && spentUsd !== undefined && spentUsd >= key.budget.softUsd,
    });
  });

  // ── Files 브리지 (부록 (b) §2) ──
  const fileDeps = (c: Context) => {
    if (!deps.files) return undefined;
    const ops = opsCtx.get(c.req.raw);
    // 업로드/삭제도 본 요청과 같은 계정으로 — 풀 키로 올린 파일은 BYO 요청에서 404가 된다
    return {
      ...deps,
      files: deps.files,
      signal: c.req.raw.signal, // 클라이언트가 끊으면 업스트림 업로드도 끊는다
      ...(ops ? { tenant: ops.key.tenant, credentials: ops.resolver.credentials } : {}),
    };
  };

  app.post("/v0/files", async (c) => {
    const fd = fileDeps(c);
    if (!fd) return errJson(c, irError("invalid_request", 501, "파일 스토어 미설정 (AppDeps.files)"));
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return errJson(c, irError("invalid_request", 400, "multipart/form-data가 아닙니다 (file·provider 필드 필요)"));
    }
    const file = form.get("file");
    const provider = form.get("provider");
    if (!(file instanceof File) || typeof provider !== "string" || provider.length === 0) {
      return errJson(c, irError("invalid_request", 400, "file(파일)·provider(문자열) 필드 필요"));
    }
    try {
      const envelope = await uploadFile(
        {
          provider,
          data: new Uint8Array(await file.arrayBuffer()),
          mediaType: file.type || "application/octet-stream",
          ...(file.name ? { filename: file.name } : {}),
        },
        fd,
      );
      return c.json(envelope);
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.get("/v0/files", async (c) => {
    const fd = fileDeps(c);
    if (!fd) return errJson(c, irError("invalid_request", 501, "파일 스토어 미설정 (AppDeps.files)"));
    return c.json({ files: await listFiles(fd) });
  });

  app.get("/v0/files/:id", async (c) => {
    const fd = fileDeps(c);
    if (!fd) return errJson(c, irError("invalid_request", 501, "파일 스토어 미설정 (AppDeps.files)"));
    try {
      return c.json(await getFile(c.req.param("id"), fd));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.delete("/v0/files/:id", async (c) => {
    const fd = fileDeps(c);
    if (!fd) return errJson(c, irError("invalid_request", 501, "파일 스토어 미설정 (AppDeps.files)"));
    try {
      await deleteFile(c.req.param("id"), fd);
      return c.json({ deleted: true });
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  // ── Batches 브리지 (부록 (b) §3) ──
  const batchDeps = (c: Context) => {
    if (!deps.batches) return undefined;
    const ops = opsCtx.get(c.req.raw);
    return {
      ...deps,
      batches: deps.batches,
      signal: c.req.raw.signal,
      ...(ops
        ? {
            tenant: ops.key.tenant,
            keyId: ops.key.keyId,
            credentials: ops.resolver.credentials,
            keySourceFor: ops.resolver.sourceFor, // 배치 원장 keySource (감사 #35)
          }
        : {}),
    };
  };
  const noBatchStore = (c: Context) =>
    errJson(c, irError("invalid_request", 501, "배치 스토어 미설정 (AppDeps.batches)"));

  const BatchCreateSchema = z.strictObject({
    version: z.literal("0"),
    requests: z
      .array(z.strictObject({ customId: z.string().min(1), request: IRRequestSchema }))
      .min(1),
  });

  app.post("/v0/batches", async (c) => {
    const bd = batchDeps(c);
    if (!bd) return noBatchStore(c);
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return errJson(c, irError("invalid_request", 400, "JSON body가 아닙니다"));
    }
    const parsed = BatchCreateSchema.safeParse(json);
    if (!parsed.success) {
      return errJson(c, {
        ...irError("invalid_request", 400, "배치 요청 검증 실패 (부록 (b) §3.2)"),
        provider: { key: "gateway", status: 400, raw: z.treeifyError(parsed.error) as JSONValue },
      });
    }
    try {
      return c.json(await createBatch(parsed.data.requests, bd));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.get("/v0/batches", async (c) => {
    const bd = batchDeps(c);
    if (!bd) return noBatchStore(c);
    return c.json({ batches: await listBatches(bd) });
  });

  app.get("/v0/batches/:id", async (c) => {
    const bd = batchDeps(c);
    if (!bd) return noBatchStore(c);
    try {
      return c.json(await getBatch(c.req.param("id"), bd));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.get("/v0/batches/:id/results", async (c) => {
    const bd = batchDeps(c);
    if (!bd) return noBatchStore(c);
    try {
      return c.json({ results: await getBatchResults(c.req.param("id"), bd) });
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.post("/v0/batches/:id/cancel", async (c) => {
    const bd = batchDeps(c);
    if (!bd) return noBatchStore(c);
    try {
      return c.json(await cancelBatch(c.req.param("id"), bd));
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  // ── 관리 API (운영 평면 — 인증은 상단 미들웨어) ──

  const KeyCreateSchema = z.strictObject({
    tenant: z.string().min(1),
    name: z.string().optional(),
    budget: z
      .strictObject({
        periodDays: z.number().int().positive(),
        softUsd: z.number().positive().optional(),
        hardUsd: z.number().positive().optional(),
      })
      .optional(),
    rateLimit: z.strictObject({ requestsPerMinute: z.number().int().positive() }).optional(),
    bodyLogOptOut: z.boolean().optional(),
  });

  app.post("/v0/admin/keys", async (c) => {
    if (!deps.keys) return errJson(c, irError("invalid_request", 501, "키 스토어 미설정 (AppDeps.keys)"));
    const parsed = KeyCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errJson(c, irError("invalid_request", 400, "키 발급 요청 검증 실패 (tenant 필수)"));
    try {
      const { key, secret } = await issueVirtualKey(deps.keys, parsed.data, deps.now);
      const { keyHash: _hash, ...safe } = key;
      return c.json({ ...safe, secret }); // 시크릿 1회 노출 — 저장은 해시만 (ops/keys)
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.get("/v0/admin/keys", async (c) => {
    if (!deps.keys) return errJson(c, irError("invalid_request", 501, "키 스토어 미설정 (AppDeps.keys)"));
    return c.json({ keys: (await deps.keys.list()).map(({ keyHash: _h, ...safe }) => safe) });
  });

  app.post("/v0/admin/keys/:id/disable", async (c) => {
    if (!deps.keys) return errJson(c, irError("invalid_request", 501, "키 스토어 미설정 (AppDeps.keys)"));
    const key = await deps.keys.get(c.req.param("id"));
    if (!key) return errJson(c, irError("not_found", 404, "키 없음"));
    await deps.keys.put({ ...key, disabled: true });
    return c.json({ keyId: key.keyId, disabled: true });
  });

  const ProviderKeySchema = z.strictObject({
    tenant: z.string().min(1),
    provider: z.string().min(1),
    key: z.string().min(1),
  });

  app.put("/v0/admin/provider-keys", async (c) => {
    if (!deps.providerKeys) return errJson(c, irError("invalid_request", 501, "BYO 키 스토어 미설정 (AppDeps.providerKeys)"));
    const parsed = ProviderKeySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errJson(c, irError("invalid_request", 400, "tenant·provider·key 필수"));
    try {
      await deps.providerKeys.put({
        tenant: parsed.data.tenant,
        provider: parsed.data.provider,
        encryptedKey: encryptSecret(parsed.data.key), // AES-256-GCM (사용자 결정 D2)
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
      });
      return c.json({ tenant: parsed.data.tenant, provider: parsed.data.provider, stored: true });
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.delete("/v0/admin/provider-keys/:tenant/:provider", async (c) => {
    if (!deps.providerKeys) return errJson(c, irError("invalid_request", 501, "BYO 키 스토어 미설정 (AppDeps.providerKeys)"));
    await deps.providerKeys.delete(c.req.param("tenant"), c.req.param("provider"));
    return c.json({ deleted: true });
  });

  app.get("/v0/admin/usage-report", async (c) => {
    const ledger = deps.ledger as QueryableLedger | undefined;
    if (!ledger || typeof ledger.aggregate !== "function") {
      return errJson(c, irError("invalid_request", 501, "집계 가능한 원장 미설정 (QueryableLedger 필요)"));
    }
    try {
      const query = parseReportQuery({
        from: c.req.query("from"),
        to: c.req.query("to"),
        groupBy: c.req.query("groupBy"),
        tenant: c.req.query("tenant"),
        format: c.req.query("format"),
      });
      const rows = await usageReport(ledger, query);
      if (query.format === "csv") {
        return c.text(toCsv(rows), 200, { "content-type": "text/csv; charset=utf-8" });
      }
      return c.json({ from: query.from, to: query.to, groupBy: query.groupBy, rows });
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.post("/v0/admin/resources/sweep", async (c) => {
    if (!deps.resources) return errJson(c, irError("invalid_request", 501, "리소스 레지스트리 미설정 (AppDeps.resources)"));
    try {
      // 본문 로그 보관 정책 — 리소스 스윕과 같은 유지보수 트리거에 태운다 (ADR-0008)
      const retentionDays = Number(process.env["BODY_LOG_RETENTION_DAYS"] ?? 0);
      let bodyLogsDeleted: number | undefined;
      if (retentionDays > 0 && deps.bodyLog?.deleteOlderThan) {
        const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - retentionDays * 86_400_000).toISOString();
        bodyLogsDeleted = await deps.bodyLog.deleteOlderThan(cutoff);
      }
      // 만료 포털 세션 정리 — 같은 유지보수 트리거에 태운다
      let portalSessionsPurged: number | undefined;
      if (deps.portalSessions?.deleteExpired) {
        portalSessionsPurged = await deps.portalSessions.deleteExpired((deps.now?.() ?? new Date()).toISOString());
      }
      const result = await sweepExpiredResources(deps.resources, {
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        baseUrlFor: (p) => getProvider(p).baseUrl,
        credentialsFor: (p) => credentialHeaders(getProvider(p)),
      });
      return c.json({
        ...result,
        ...(bodyLogsDeleted !== undefined ? { bodyLogsDeleted } : {}),
        ...(portalSessionsPurged !== undefined ? { portalSessionsPurged } : {}),
      });
    } catch (err) {
      return errJson(c, toIRError(err));
    }
  });

  app.get("/v0/streams/:id", async (c) => {
    // 헤더 검증은 분기 전 1회 — 라이브/재시작 경로 동일 응답 (리뷰 F7-r4)
    const afterSeq = parseAfterSeq(c.req.header("Last-Event-ID"));
    if (afterSeq === null) {
      return errJson(c, irError("invalid_request", 400, "Last-Event-ID는 안전 정수 범위의 십진 seq여야 합니다"));
    }
    const session = sessions.get(c.req.param("id"));
    // 소유 테넌트 불일치는 미지 세션과 동일 응답 — 존재를 노출하지 않는다 (ADR-0006 §3)
    if (session) {
      if (!session.ownedBy(tenantOf(c))) return errJson(c, goneStream());
      return sseFromSession(c, session, afterSeq);
    }

    // 인메모리 부재 — 영속 버퍼에서 재생 전용 폴백 (프로세스 재시작 시나리오).
    // null = 미지/만료 → 410; [] = 존재하나 커서 이후 없음 → 빈 재생 (리뷰 E1-r4)
    // 키는 테넌트 스코프 — 재시작 후에도 타 테넌트 버퍼에 닿지 않는다
    const persisted = await deps.persistence
      ?.loadEvents(sessionPersistenceKey(c.req.param("id"), tenantOf(c)), afterSeq)
      .catch(() => null);
    if (persisted === null || persisted === undefined) return errJson(c, goneStream());
    return streamSSE(c, async (stream) => {
      let lastSeq = afterSeq;
      let lastType = "";
      for (const json of persisted) {
        const event = JSON.parse(json) as { seq: number; type: string };
        lastSeq = event.seq;
        lastType = event.type;
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: json });
      }
      // 크래시 절단 버퍼 — 터미널 없으면 방어 터미널 합성 (터미널 보장, 리뷰 SW2-r4)
      if (persisted.length > 0 && !["finish", "error-final", "error-partial"].includes(lastType)) {
        const defensive = {
          type: "error-partial",
          seq: lastSeq + 1,
          error: irError("gateway_error", 502, "재시작으로 절단된 스트림 — 버퍼 프리픽스만 유효", { gatewayException: true }),
          willRetry: false,
        };
        await stream.writeSSE({ id: String(defensive.seq), event: defensive.type, data: JSON.stringify(defensive) });
      }
    });
  });

  // ── compat 인바운드 2종 (부록 (a)) — 실행 경로는 native와 동일 (G1 우회 없음) ──
  interface CompatFormat {
    toIR(body: unknown, allowUnknown: boolean, c: Context): { request: IRRequest; warnings: Warning[] };
    toWireResponse(response: IRResponse, strict: boolean): JSONObject;
    toWireError(error: import("../ir/error.js").IRError): JSONObject;
    downconverter(strict: boolean): (event: StreamEvent) => Array<{ event?: string; data: string; comment?: string }>;
  }

  const compatFormats: Record<string, CompatFormat> = {
    "/compat/openai/v1/chat/completions": {
      toIR: (body, allowUnknown) => compatChatToIR(body, allowUnknown),
      toWireResponse: toChatResponse,
      toWireError: toChatError,
      downconverter: createChatDownconverter,
    },
    "/compat/anthropic/v1/messages": {
      toIR: (body, allowUnknown, c) => compatMessagesToIR(body, allowUnknown, c.req.header("anthropic-beta")),
      toWireResponse: toMessagesResponse,
      toWireError: toMessagesError,
      downconverter: createMessagesDownconverter,
    },
  };

  for (const [path, format] of Object.entries(compatFormats)) {
    app.post(path, async (c) => {
      const compatErr = (error: import("../ir/error.js").IRError) => {
        const status = Math.min(599, Math.max(200, error.httpStatus));
        return c.json(format.toWireError(error), status as 400);
      };
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return compatErr(irError("invalid_request", 400, "JSON body가 아닙니다"));
      }
      const allowUnknown = c.req.header("x-gateway-allow-unknown") === "true";
      const strict = c.req.header("x-gateway-compat") === "strict"; // §2 — gateway 확장 미부가
      const ops = opsCtx.get(c.req.raw);
      let req: IRRequest;
      let opsDeps: Partial<GatewayExecuteDeps>;
      try {
        // 인바운드 변환 warnings → preWarnings 합류 (D5 — 강등·드롭도 응답 warnings로 보고)
        const conv = format.toIR(json, allowUnknown, c);
        req = conv.request;
        ({ request: req, execDeps: opsDeps } = await prepareInbound(c, req));
        if (conv.warnings.length > 0) {
          opsDeps.preWarnings = [...(opsDeps.preWarnings ?? []), ...conv.warnings];
        }
      } catch (err) {
        if (err instanceof GatewayError) return compatErr(err.irError);
        throw err;
      }
      const bodyLogEnabled = deps.bodyLog !== undefined && ops?.key.bodyLogOptOut !== true;

      if (!req.stream) {
        const id = genRequestId(deps);
        c.header("x-gateway-request-id", id);
        try {
          const response = await executeNonStream(req, { ...deps, ...opsDeps, genId: () => id }, c.req.raw.signal);
          if (bodyLogEnabled) {
            const logCtx = { tenant: ops?.key.tenant, now: deps.now };
            void logBody(deps.bodyLog, { requestId: id, ...logCtx, direction: "request", body: json });
            void logBody(deps.bodyLog, { requestId: id, ...logCtx, direction: "response", body: response });
          }
          return c.json(format.toWireResponse(response, strict));
        } catch (err) {
          return compatErr(toIRError(err));
        }
      }

      const session = startStreamSession(req, { ...deps, ...opsDeps, sessions });
      c.header("x-gateway-request-id", session.id);
      if (bodyLogEnabled) {
        void logBody(deps.bodyLog, { requestId: session.id, tenant: ops?.key.tenant, direction: "request", body: json, now: deps.now });
      }
      const downconvert = format.downconverter(strict);
      return streamSSE(c, async (stream) => {
        session.attach();
        try {
          for await (const stored of session.read(-1, c.req.raw.signal)) {
            if (c.req.raw.signal.aborted) break;
            const event = JSON.parse(stored.json) as StreamEvent;
            for (const frame of downconvert(event)) {
              if (frame.comment !== undefined) {
                await stream.write(`: ${frame.comment}\n\n`);
              } else if (frame.event !== undefined) {
                await stream.writeSSE({ event: frame.event, data: frame.data });
              } else {
                await stream.writeSSE({ data: frame.data });
              }
            }
          }
        } finally {
          session.detach();
        }
      });
    });
  }

  app.post("/v0/streams/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const session = sessions.get(id);
    if (session) {
      // GET 재개와 동일 상태 = 동일 status (리뷰 E5 — 404/410 드리프트 방지).
      // 타 테넌트 세션도 동일 취급 — 취소는 파괴적 작업이라 소유권 검사 필수 (ADR-0006 §3)
      if (!session.ownedBy(tenantOf(c))) return errJson(c, goneStream());
      const wasLive = !session.isDone;
      session.cancel(); // D7 — 명시적 abort는 grace 없이 즉시. 터미널은 펌프가 적재
      return c.json({ canceled: wasLive }); // 이미 종료된 스트림 취소는 false (리뷰 E6)
    }
    // 로컬에 없음 = 타 레플리카 소유이거나 미지/만료 — 여기서는 구분할 수 없다.
    // 전파하고 판정은 세션을 가진 쪽에 위임한다 (권한 대조도 그쪽에서만 가능 — 리뷰 2026-08-22 #12).
    if (deps.streamControl) {
      await deps.streamControl.requestCancel(id, tenantOf(c)).catch((err: unknown) => {
        console.error("[stream-control] 취소 전파 실패", err instanceof Error ? err.message : err);
      });
      // 202 — "요청을 전파했다"까지만 보장. 미지 id와 타 레플리카 세션이 같은 응답이라
      // 존재 여부도 노출하지 않는다
      return c.json({ canceled: null, dispatched: true }, 202);
    }
    return errJson(c, goneStream());
  });

  return app;
}
