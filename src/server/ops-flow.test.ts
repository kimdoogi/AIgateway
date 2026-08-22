import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { InMemoryKeyStore, InMemoryLedger, InMemoryProviderKeyStore } from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { createApp } from "./app.js";

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
