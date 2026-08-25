import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { InMemoryKeyStore, InMemoryLedger } from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { InMemoryRateLimiter } from "../ops/rate-limit.js";
import { createApp } from "./app.js";

// 운영 콘솔 + 셀프서비스 사용량 (/v0/usage).
// 핵심 계약: /v0/usage는 인증은 받되 쿼터·예산 게이트를 **면제**한다 —
// 402/429의 원인을 보는 창구가 같은 402/429로 막히면 순환이다.

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["GATEWAY_ADMIN_KEY"] = "admin-master";
beforeAll(() => bootstrapProviders());

const WIRE_OK = {
  id: "msg_c1",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50 },
};
function mockFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(WIRE_OK), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const irBody = JSON.stringify({
  version: "0",
  model: "claude-haiku-4-5",
  maxOutputTokens: 100,
  messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
});

async function appWithKey(keyOpts: Record<string, unknown>) {
  const keys = new InMemoryKeyStore();
  const tracker = new InMemorySpendTracker();
  const { fetchImpl, calls } = mockFetch();
  const app = createApp({
    keys,
    ledger: withSpendTracking(new InMemoryLedger(), tracker),
    spendTracker: tracker,
    rateLimiter: new InMemoryRateLimiter(),
    fetchImpl,
  });
  const issued = await app.request("/v0/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
    body: JSON.stringify({ tenant: "t-console", ...keyOpts }),
  });
  const { secret } = (await issued.json()) as { secret: string };
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, ...(init.headers ?? {}) } });
  return { app, call, calls };
}

describe("콘솔 페이지", () => {
  it("GET /console — 인증 없이 200 HTML (비밀 없음, 데이터는 전부 키 뒤)", async () => {
    const app = createApp({ keys: new InMemoryKeyStore() }); // 인증 활성 상태에서도
    const res = await app.request("/console");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("ai-gateway 콘솔");
    expect(html).toContain("/v0/admin/keys"); // 관리 화면 배선
    expect(html).toContain("/v0/usage"); // 셀프서비스 배선
  });

  it("GET /docs — Native IR 가이드 서빙 (인증 밖, 포털·콘솔에서 링크)", async () => {
    const app = createApp({});
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Native IR 가이드");
    expect(html).toContain("/v0/responses"); // 실제 내용이 실려 있다
  });

  it("GET / → 소개 페이지 (200, 포털·콘솔·가이드 링크)", async () => {
    const app = createApp({});
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ai-gateway 소개");
    for (const href of ["/portal", "/console", "/docs"]) expect(html).toContain(`href="${href}"`);
  });
});

describe("GET /v0/usage — 셀프서비스", () => {
  it("개방 모드(키 미설정)는 501 — 키 개념이 없다", async () => {
    const app = createApp({});
    expect((await app.request("/v0/usage")).status).toBe(501);
  });

  it("무키는 401 (면제는 게이트만, 인증은 아니다)", async () => {
    const app = createApp({ keys: new InMemoryKeyStore() });
    expect((await app.request("/v0/usage")).status).toBe(401);
  });

  it("호출 후 지출·예산 상태가 보인다", async () => {
    const { call } = await appWithKey({ budget: { periodDays: 7, softUsd: 0.00001, hardUsd: 5 } });
    expect((await call("/v0/responses", { method: "POST", body: irBody })).status).toBe(200);
    const d = (await (await call("/v0/usage")).json()) as Record<string, any>;
    expect(d["tenant"]).toBe("t-console");
    expect(d["windowDays"]).toBe(7);
    expect(d["spentUsd"]).toBeGreaterThan(0); // 원장 데코레이터 → 트래커 경유
    expect(d["softExceeded"]).toBe(true); // soft를 극소로 걸었다
    expect(d["blocked"]).toBe(false);
  });

  it("레이트리밋을 소모하지 않는다 — 대시보드 폴링이 실호출 쿼터를 갉아먹으면 안 된다", async () => {
    const { call, calls } = await appWithKey({ rateLimit: { requestsPerMinute: 1 } });
    expect((await call("/v0/responses", { method: "POST", body: irBody })).status).toBe(200); // 쿼터 1/1 소진
    for (let i = 0; i < 3; i++) expect((await call("/v0/usage")).status).toBe(200); // 면제 — 전부 통과
    expect((await call("/v0/responses", { method: "POST", body: irBody })).status).toBe(429); // 실호출은 차단
    expect(calls).toHaveLength(1);
  });

  it("hard 초과로 402가 떠도 /v0/usage는 200 + blocked:true — 막힌 이유를 보는 창구", async () => {
    const { call } = await appWithKey({ budget: { periodDays: 7, hardUsd: 0.0000001 } });
    expect((await call("/v0/responses", { method: "POST", body: irBody })).status).toBe(200); // hard는 다음 요청 차단
    expect((await call("/v0/responses", { method: "POST", body: irBody })).status).toBe(402);
    const res = await call("/v0/usage");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>)["blocked"]).toBe(true);
  });
});
