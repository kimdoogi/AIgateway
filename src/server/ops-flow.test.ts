import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { InMemoryKeyStore, InMemoryLedger, InMemoryProviderKeyStore } from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { createApp } from "./app.js";
import { SessionStore } from "../gateway/session.js";

// 운영 평면 E2E — 인증→예산→BYO 자격증명→원장(tenant·cost)→billing→정산 리포트 (D9 mock fetch)

process.env["ANTHROPIC_API_KEY"] = "pool-anthropic-key";
process.env["GATEWAY_ADMIN_KEY"] = "admin-master";
process.env["GATEWAY_KEY_ENCRYPTION_KEY"] = "b".repeat(64);
beforeAll(() => bootstrapProviders());

const WIRE_OK = {
  id: "msg_ops1",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 50 },
};

function mockFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
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

describe("운영 평면 E2E", () => {
  it("인증 활성 시 무키 401 → 발급 키로 성공, 원장에 tenant·keyId·costUsd·keySource, billing 블록 포함", async () => {
    const keys = new InMemoryKeyStore();
    const providerKeys = new InMemoryProviderKeyStore();
    const baseLedger = new InMemoryLedger();
    const tracker = new InMemorySpendTracker();
    const { fetchImpl, calls } = mockFetch();
    const app = createApp({
      keys,
      providerKeys,
      ledger: withSpendTracking(baseLedger, tracker),
      spendTracker: tracker,
      fetchImpl,
    });

    // 무키 → 401
    const denied = await app.request("/v0/responses", { method: "POST", headers: { "content-type": "application/json" }, body: irBody });
    expect(denied.status).toBe(401);

    // 관리 API로 키 발급 (마스터 키 인증)
    const issued = await app.request("/v0/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
      body: JSON.stringify({ tenant: "acme", name: "test" }),
    });
    expect(issued.status).toBe(200);
    const { secret, keyId } = (await issued.json()) as { secret: string; keyId: string };
    expect(secret.startsWith("gwk_")).toBe(true);

    // BYO 키 등록 → 요청은 BYO 자격증명으로 나가야 함
    const put = await app.request("/v0/admin/provider-keys", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
      body: JSON.stringify({ tenant: "acme", provider: "anthropic", key: "byo-secret-key" }),
    });
    expect(put.status).toBe(200);

    const ok = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: irBody,
    });
    const body = (await ok.json()) as Record<string, any>;
    expect(ok.status).toBe(200);
    expect(body.billing.lineItems.length).toBeGreaterThan(0); // ADR-0007 §1
    expect(body.billing.currency).toBe("USD");
    expect(calls[0]!.headers["x-api-key"]).toBe("byo-secret-key"); // BYO 우선 (하이브리드)

    const row = baseLedger.rows[0]!;
    expect(row.tenant).toBe("acme");
    expect(row.keyId).toBe(keyId);
    expect(row.keySource).toBe("byo");
    expect(row.costUsd).toBeGreaterThan(0);

    // 정산 리포트 (관리 API)
    const report = await app.request("/v0/admin/usage-report?groupBy=tenant", {
      headers: { authorization: "Bearer admin-master" },
    });
    const rep = (await report.json()) as Record<string, any>;
    expect(rep.rows[0].group).toBe("acme");
    expect(rep.rows[0].costUsd).toBeGreaterThan(0);
    const csv = await app.request("/v0/admin/usage-report?groupBy=tenant&format=csv", {
      headers: { authorization: "Bearer admin-master" },
    });
    expect(await csv.text()).toContain("acme");
  });

  it("예산 hard 초과 — 402 budget_exceeded (§10.4: 다음 요청 차단)", async () => {
    const keys = new InMemoryKeyStore();
    const tracker = new InMemorySpendTracker();
    const { fetchImpl } = mockFetch();
    const app = createApp({ keys, spendTracker: tracker, fetchImpl });

    const issued = await app.request("/v0/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
      body: JSON.stringify({ tenant: "acme", budget: { periodDays: 30, hardUsd: 0.001 } }),
    });
    const { secret, keyId } = (await issued.json()) as { secret: string; keyId: string };
    tracker.add(keyId, 0.002, new Date().toISOString()); // 기지출 주입

    const blocked = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: irBody,
    });
    expect(blocked.status).toBe(402);
    const err = (await blocked.json()) as Record<string, any>;
    expect(err.error.category).toBe("budget_exceeded");
  });

  it("관리 API — 마스터 키 불일치 401, 잘못된 가상 키 401", async () => {
    const app = createApp({ keys: new InMemoryKeyStore() });
    const wrongAdmin = await app.request("/v0/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ tenant: "x" }),
    });
    expect(wrongAdmin.status).toBe(401);
    const wrongKey = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer gwk_bogus" },
      body: irBody,
    });
    expect(wrongKey.status).toBe(401);
  });
});

// ── 리뷰 2026-08-22 회귀: compat 평면·세션 격리·브리지 자격증명 ──

const compatBody = JSON.stringify({
  model: "claude-haiku-4-5",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
});

/** 인증 켠 앱 + 발급된 가상 키 시크릿 */
async function appWithKey(extra: Record<string, unknown> = {}) {
  const keys = new InMemoryKeyStore();
  const ledger = new InMemoryLedger();
  const { fetchImpl, calls } = mockFetch();
  const app = createApp({ keys, ledger, fetchImpl, ...extra });
  const issued = await app.request("/v0/admin/keys", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
    body: JSON.stringify({ tenant: "t-compat" }),
  });
  const { secret } = (await issued.json()) as { secret: string };
  return { app, secret, ledger, calls, keys };
}

describe("compat 인바운드도 운영 평면을 통과한다 (ops-plane 좌석 클로즈)", () => {
  const paths = ["/compat/openai/v1/chat/completions", "/compat/anthropic/v1/messages"] as const;

  it.each(paths)("%s — 무키 401 (인증 활성 시 무인증 유료 경로 없음)", async (path) => {
    const { app, calls } = await appWithKey();
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: compatBody,
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0); // 업스트림 호출 자체가 없어야 한다
  });

  it("유효 키면 통과 + 원장 행에 tenant·keyId 귀속", async () => {
    const { app, secret, ledger } = await appWithKey();
    const res = await app.request("/compat/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: compatBody,
    });
    expect(res.status).toBe(200);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ tenant: "t-compat", outcome: "success" });
    expect(ledger.rows[0]!.keyId).toMatch(/^gwkid_/);
  });

  it("compat도 BYO 프로바이더 키를 쓴다 (풀 키 고정 아님)", async () => {
    const providerKeys = new InMemoryProviderKeyStore();
    const { app, secret, calls } = await appWithKey({ providerKeys });
    await app.request("/v0/admin/provider-keys", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
      body: JSON.stringify({ tenant: "t-compat", provider: "anthropic", key: "byo-secret-key" }),
    });
    await app.request("/compat/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: compatBody,
    });
    expect(calls[0]!.headers["x-api-key"]).toBe("byo-secret-key");
  });
});

describe("스트림 세션 테넌트 격리 (ADR-0006 §3)", () => {
  async function twoTenants() {
    const keys = new InMemoryKeyStore();
    const app = createApp({
      keys,
      fetchImpl: (async () =>
        new Response(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_x", model: "claude-haiku-4-5", usage: { input_tokens: 1 } } })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch,
      heartbeatMs: 60_000,
    });
    const secrets: string[] = [];
    for (const tenant of ["tenant-a", "tenant-b"]) {
      const issued = await app.request("/v0/admin/keys", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer admin-master" },
        body: JSON.stringify({ tenant }),
      });
      secrets.push(((await issued.json()) as { secret: string }).secret);
    }
    return { app, a: secrets[0]!, b: secrets[1]! };
  }

  it("타 테넌트는 재개·취소 모두 410 (존재 노출 금지)", async () => {
    const { app, a, b } = await twoTenants();
    const started = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${a}` },
      body: JSON.stringify({
        version: "0",
        model: "claude-haiku-4-5",
        maxOutputTokens: 100,
        stream: true,
        messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      }),
    });
    const id = started.headers.get("x-gateway-request-id")!;
    await started.text(); // 스트림 소비 종료

    const foreignResume = await app.request(`/v0/streams/${id}`, { headers: { authorization: `Bearer ${b}` } });
    expect(foreignResume.status).toBe(410);
    const foreignCancel = await app.request(`/v0/streams/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${b}` },
    });
    expect(foreignCancel.status).toBe(410);

    // 소유 테넌트는 정상 접근
    const own = await app.request(`/v0/streams/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${a}` },
    });
    expect(own.status).toBe(200);
  });
});

// ── 운영 프로브·드레인 (오케스트레이터 배포 — 리뷰 2026-08-22) ──

describe("health / readiness 프로브", () => {
  it("/health는 인증 밖 + 의존성과 무관하게 200 (재시작 루프 방지)", async () => {
    // 인증을 켜고 의존성 프로브가 전부 실패해도 liveness는 200이어야 한다 —
    // 여기서 503을 내면 DB 장애에 오케스트레이터가 컨테이너를 계속 죽인다
    const app = createApp({
      keys: new InMemoryKeyStore(),
      readiness: [{ name: "postgres", check: () => Promise.reject(new Error("down")) }],
      version: "test-sha",
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "test-sha" });
  });

  it("/ready는 의존성 실패 시 503 + 실패 사유를 이름별로 노출", async () => {
    const app = createApp({
      readiness: [
        { name: "postgres", check: () => Promise.resolve() },
        { name: "redis", check: () => Promise.reject(new Error("ECONNREFUSED")) },
      ],
    });
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe("degraded");
    expect(body.checks["postgres"]).toBe("ok");
    expect(body.checks["redis"]).toContain("ECONNREFUSED");
  });

  it("의존성 정상이면 200", async () => {
    const app = createApp({ readiness: [{ name: "postgres", check: () => Promise.resolve() }] });
    expect((await app.request("/ready")).status).toBe(200);
  });

  it("드레인 진입 시 /ready 503 — LB가 먼저 빠지고 /health는 살아 있다", async () => {
    let draining = false;
    const app = createApp({ isDraining: () => draining });
    expect((await app.request("/ready")).status).toBe(200);
    draining = true;
    const res = await app.request("/ready");
    expect(res.status).toBe(503);
    expect((await res.json()) as { status: string }).toMatchObject({ status: "draining" });
    expect((await app.request("/health")).status).toBe(200); // 아직 살아서 in-flight를 처리 중
  });

  it("프로브는 가상 키 인증을 요구하지 않는다", async () => {
    const app = createApp({ keys: new InMemoryKeyStore() }); // 인증 활성
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/ready")).status).toBe(200);
  });
});

describe("전역 onError — 미포착 예외도 IRError 형태 (ir-v0 §12)", () => {
  it("try 밖에서 던진 예외가 맨 500이 아니라 IRError로 나온다", async () => {
    // startStreamSession은 라우트 try 밖 호출이라, 여기서 던지면 onError만이 형태를 지킨다
    const brokenSessions = new SessionStore();
    brokenSessions.create = () => {
      throw new TypeError("세션 스토어 결함");
    };
    const app = createApp({ sessions: brokenSessions });
    const res = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(irBody), stream: true }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { category: string; message: string; gatewayException?: boolean } };
    expect(body.error.category).toBe("gateway_error");
    expect(body.error.gatewayException).toBe(true); // 내부 결함 마킹 — 폴백 트리 오염 방지
    expect(body.error.message).toContain("세션 스토어 결함");
  });
});
