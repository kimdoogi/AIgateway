import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import {
  InMemoryAccountStore,
  InMemoryKeyStore,
  InMemoryLedger,
  InMemoryPortalSessionStore,
  InMemoryProviderKeyStore,
} from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { InMemoryRateLimiter } from "../ops/rate-limit.js";
import { createApp, type AppDeps } from "./app.js";

// 셀프 가입 포털 (2026-08-24) — 계약의 핵심 셋:
//   ① 계정 = 테넌트 격리: 남의 키·사용량·BYO에 절대 닿지 않는다 (타인 것은 404)
//   ② 셀프 발급 키는 **항상** 기본 한도(rpm·예산)를 달고 나온다 — 무한도 셀프 발급 금지
//   ③ 발급된 키가 실제 게이트웨이 인증을 통과한다 (포털은 장식이 아니라 발급 경로다)

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["GATEWAY_KEY_ENCRYPTION_KEY"] = "c".repeat(64);
beforeAll(() => bootstrapProviders());

const WIRE_OK = {
  id: "msg_p1",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50 },
};

function portalApp(extra: Partial<AppDeps> = {}) {
  const tracker = new InMemorySpendTracker();
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(WIRE_OK), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const app = createApp({
    keys: new InMemoryKeyStore(),
    accounts: new InMemoryAccountStore(),
    portalSessions: new InMemoryPortalSessionStore(),
    providerKeys: new InMemoryProviderKeyStore(),
    rateLimiter: new InMemoryRateLimiter(),
    ledger: withSpendTracking(new InMemoryLedger(), tracker),
    spendTracker: tracker,
    fetchImpl,
    ...extra,
  });
  return { app, calls };
}

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = /gw_portal=([^;]+)/.exec(raw);
  return m ? `gw_portal=${m[1]}` : "";
}

async function signup(app: ReturnType<typeof createApp>, email: string) {
  const res = await app.request("/portal/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "hunter22!" }),
  });
  expect(res.status).toBe(201);
  return { cookie: cookieOf(res), body: (await res.json()) as { account: { tenant: string } } };
}

const asUser = (app: ReturnType<typeof createApp>, cookie: string) =>
  (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { cookie, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    });

describe("페이지·구성", () => {
  it("GET /portal — 인증 없이 200 HTML", async () => {
    const { app } = portalApp();
    const res = await app.request("/portal");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ai-gateway 포털");
  });

  it("스토어 미설정(개방 모드)이면 config.enabled=false, 가입은 501", async () => {
    const app = createApp({});
    const cfg = (await (await app.request("/portal/config")).json()) as { enabled: boolean };
    expect(cfg.enabled).toBe(false);
    const res = await app.request("/portal/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "12345678" }),
    });
    expect(res.status).toBe(501);
  });
});

describe("가입·로그인", () => {
  it("가입 → 세션 쿠키(HttpOnly·SameSite=Strict) → /portal/me", async () => {
    const { app } = portalApp();
    const res = await app.request("/portal/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "USER@Example.com", password: "hunter22!" }),
    });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const me = await asUser(app, cookieOf(res))("/portal/me");
    expect(me.status).toBe(200);
    const d = (await me.json()) as { email: string; tenant: string; limits: { maxKeys: number } };
    expect(d.email).toBe("user@example.com"); // 소문자 정규화
    expect(d.tenant).toMatch(/^acc_/);
    expect(d.limits.maxKeys).toBeGreaterThan(0);
  });

  it("중복 이메일 409, 짧은 비밀번호 400, JSON 아닌 변이는 415 (CSRF 방어)", async () => {
    const { app } = portalApp();
    await signup(app, "dup@x.co");
    const dup = await app.request("/portal/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@x.co", password: "hunter22!" }),
    });
    expect(dup.status).toBe(409);
    const weak = await app.request("/portal/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "w@x.co", password: "short" }),
    });
    expect(weak.status).toBe(400);
    const notJson = await app.request("/portal/signup", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ email: "t@x.co", password: "hunter22!" }),
    });
    expect(notJson.status).toBe(415);
  });

  it("초대 코드: 설정 시 없으면·틀리면 403, 맞으면 201", async () => {
    process.env["PORTAL_INVITE_CODE"] = "secret-invite";
    try {
      const { app } = portalApp();
      const post = (body: Record<string, unknown>) =>
        app.request("/portal/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await post({ email: "i@x.co", password: "hunter22!" })).status).toBe(403);
      expect((await post({ email: "i@x.co", password: "hunter22!", inviteCode: "wrong" })).status).toBe(403);
      expect((await post({ email: "i@x.co", password: "hunter22!", inviteCode: "secret-invite" })).status).toBe(201);
    } finally {
      delete process.env["PORTAL_INVITE_CODE"];
    }
  });

  it("로그인: 오답과 미존재 계정이 같은 401 메시지 (존재 노출 금지), 성공 시 세션", async () => {
    const { app } = portalApp();
    await signup(app, "login@x.co");
    const attempt = (email: string, password: string) =>
      app.request("/portal/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
    const wrongPw = await attempt("login@x.co", "not-the-password");
    const noUser = await attempt("ghost@x.co", "whatever123");
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(JSON.stringify(await wrongPw.json())).toBe(JSON.stringify(await noUser.json()));
    const ok = await attempt("login@x.co", "hunter22!");
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).not.toBe("");
  });

  it("로그인 브루트포스: 이메일별 분당 10회 초과 시 429", async () => {
    const { app } = portalApp();
    await signup(app, "brute@x.co");
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.request("/portal/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "brute@x.co", password: "wrong-pass" }),
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("로그아웃 후 세션 무효", async () => {
    const { app } = portalApp();
    const { cookie } = await signup(app, "out@x.co");
    const u = asUser(app, cookie);
    expect((await u("/portal/me")).status).toBe(200);
    await u("/portal/logout", { method: "POST", body: "{}" });
    expect((await u("/portal/me")).status).toBe(401);
  });
});

describe("키 셀프서비스 — 기본 한도 강제 + 실작동", () => {
  it("발급 키에 rpm·예산이 자동 부착되고, 그 키로 /v0/responses가 실제로 된다", async () => {
    process.env["PORTAL_KEY_RPM"] = "7";
    process.env["PORTAL_KEY_HARD_USD"] = "2";
    try {
      const { app, calls } = portalApp();
      const { cookie, body } = await signup(app, "use@x.co");
      const u = asUser(app, cookie);
      const issued = await u("/portal/keys", { method: "POST", body: JSON.stringify({ name: "my-app" }) });
      expect(issued.status).toBe(201);
      const d = (await issued.json()) as { key: Record<string, any>; secret: string };
      expect(d.secret).toMatch(/^gwk_/);
      expect(d.key["keyHash"]).toBeUndefined(); // 해시 미노출
      expect(d.key["tenant"]).toBe(body.account.tenant); // 자기 테넌트로만
      expect(d.key["rateLimit"]).toEqual({ requestsPerMinute: 7 }); // 강제 한도
      expect(d.key["budget"]["hardUsd"]).toBe(2);

      // ③ 발급 키가 게이트웨이 인증을 실제로 통과 — 원장에 테넌트 귀속까지
      const call = await app.request("/v0/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${d.secret}` },
        body: JSON.stringify({
          version: "0", model: "claude-haiku-4-5", maxOutputTokens: 50,
          messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
        }),
      });
      expect(call.status).toBe(200);
      expect(calls).toHaveLength(1);

      // 사용량 뷰에 지출 반영
      const usage = (await (await u("/portal/usage")).json()) as { keys: Array<Record<string, any>>; models: Array<Record<string, any>> };
      expect(usage.keys[0]!["spentUsd"]).toBeGreaterThan(0);
      expect(usage.models[0]!["group"]).toBe("claude-haiku-4-5");
    } finally {
      delete process.env["PORTAL_KEY_RPM"];
      delete process.env["PORTAL_KEY_HARD_USD"];
    }
  });

  it("활성 키 한도 초과는 400 — 비활성화 후 재발급 가능", async () => {
    process.env["PORTAL_MAX_KEYS"] = "2";
    try {
      const { app } = portalApp();
      const { cookie } = await signup(app, "cap@x.co");
      const u = asUser(app, cookie);
      const issue = () => u("/portal/keys", { method: "POST", body: "{}" });
      const k1 = (await (await issue()).json()) as { key: { keyId: string } };
      expect((await issue()).status).toBe(201);
      expect((await issue()).status).toBe(400); // 3번째 — 한도
      await u(`/portal/keys/${k1.key.keyId}/disable`, { method: "POST", body: "{}" });
      expect((await issue()).status).toBe(201); // 자리 생김
    } finally {
      delete process.env["PORTAL_MAX_KEYS"];
    }
  });

  it("테넌트 격리: 남의 키는 목록에 없고, 비활성화 시도는 404 (존재 노출 금지)", async () => {
    const { app } = portalApp();
    const a = await signup(app, "alice@x.co");
    const b = await signup(app, "bob@x.co");
    const ua = asUser(app, a.cookie);
    const ub = asUser(app, b.cookie);
    const issued = (await (await ua("/portal/keys", { method: "POST", body: "{}" })).json()) as { key: { keyId: string } };

    const bobList = (await (await ub("/portal/keys")).json()) as { keys: unknown[] };
    expect(bobList.keys).toHaveLength(0);
    expect((await ub(`/portal/keys/${issued.key.keyId}/disable`, { method: "POST", body: "{}" })).status).toBe(404);
    // 사용량도 서로 안 보인다
    const bobUsage = (await (await ub("/portal/usage")).json()) as { keys: unknown[] };
    expect(bobUsage.keys).toHaveLength(0);
  });

  it("BYO: 자기 테넌트로만 저장된다 (본문의 테넌트 지정 불가)", async () => {
    const { app } = portalApp();
    const providerKeys = new InMemoryProviderKeyStore();
    const { app: app2 } = portalApp({ providerKeys });
    void app;
    const { cookie, body } = await signup(app2, "byo@x.co");
    const u = asUser(app2, cookie);
    const res = await u("/portal/provider-keys", {
      method: "PUT",
      body: JSON.stringify({ provider: "anthropic", key: "sk-byo-secret", tenant: "someone-else" }),
    });
    expect(res.status).toBe(200);
    expect(await providerKeys.get(body.account.tenant, "anthropic")).not.toBeNull();
    expect(await providerKeys.get("someone-else", "anthropic")).toBeNull(); // 본문 tenant 무시
    expect((await u("/portal/provider-keys/anthropic", { method: "DELETE" })).status).toBe(200);
    expect(await providerKeys.get(body.account.tenant, "anthropic")).toBeNull();
  });
});
