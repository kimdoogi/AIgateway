import { beforeAll, describe, expect, it } from "vitest";
import { IRRequestSchema } from "../ir/index.js";
import type { IRResponse } from "../ir/response.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { GatewayError } from "../gateway/errors.js";
import { InMemoryKeyStore, InMemoryProviderKeyStore, InMemoryResourceStore } from "../state/memory.js";
import { decryptSecret, encryptSecret, issueVirtualKey, tenantCredentialResolver, verifyVirtualKey } from "./keys.js";
import { evaluateBudget, InMemorySpendTracker, withSpendTracking } from "./budget.js";
import { buildBilling } from "./billing.js";
import { checkInboundResources, registerResponseResources } from "./resources.js";
import { stripForLog } from "./body-log.js";
import { toCsv } from "./report.js";

// 운영 평면 단위 테스트 (ADR-0006 §3 / ADR-0007 / ADR-0008 — D9 픽스처·인메모리만)

process.env["GATEWAY_KEY_ENCRYPTION_KEY"] = "a".repeat(64); // 32바이트 hex (테스트 전용)
process.env["ANTHROPIC_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

describe("가상 키·BYO 암호화", () => {
  it("발급 시크릿은 1회 노출, 저장은 해시만 — 검증은 해시 대조", async () => {
    const store = new InMemoryKeyStore();
    const { key, secret } = await issueVirtualKey(store, { tenant: "acme", name: "ci" });
    expect(secret.startsWith("gwk_")).toBe(true);
    expect(key.keyHash).not.toContain(secret.slice(4)); // 원문 미저장
    const verified = await verifyVirtualKey(store, secret);
    expect(verified.tenant).toBe("acme");
    await expect(verifyVirtualKey(store, "gwk_wrong")).rejects.toBeInstanceOf(GatewayError);
    await store.put({ ...key, disabled: true });
    await expect(verifyVirtualKey(store, secret)).rejects.toBeInstanceOf(GatewayError);
  });

  it("BYO 키 AES-256-GCM 왕복 + 변조 검출", () => {
    const ct = encryptSecret("sk-provider-secret");
    expect(ct).not.toContain("sk-provider-secret");
    expect(decryptSecret(ct)).toBe("sk-provider-secret");
    const [iv, tag, data] = ct.split(":");
    expect(() => decryptSecret(`${iv}:${tag}:${data!.slice(0, -4)}QUFB`)).toThrow(); // GCM 태그 불일치
  });

  it("자격증명 결정자 — BYO 우선, 부재 시 env 풀 키 (keySource 분리)", async () => {
    const providerKeys = new InMemoryProviderKeyStore();
    await providerKeys.put({
      tenant: "acme",
      provider: "anthropic",
      encryptedKey: encryptSecret("byo-anthropic-key"),
      createdAt: "2026-08-21T00:00:00Z",
    });
    const resolver = tenantCredentialResolver("acme", providerKeys);
    const rtLike = { provider: "anthropic", auth: { envVar: "ANTHROPIC_API_KEY", header: "x-api-key" } };
    const headers = await resolver.credentials(rtLike as never);
    expect(headers["x-api-key"]).toBe("byo-anthropic-key");
    expect(await resolver.sourceFor("anthropic")).toBe("byo");
    expect(await resolver.sourceFor("openai")).toBe("pool");
  });
});

describe("예산·billing·리포트", () => {
  const usage = {
    input: { total: 1000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
    output: { total: 500, text: 500, reasoning: 0 },
    totalTokens: 1500,
    raw: {},
  };

  it("billing 라인아이템 — 0수량 제외, 배치는 :batch SKU + 50% 근사", () => {
    const b = buildBilling("anthropic", "claude-haiku-4-5", usage);
    expect(b.lineItems.map((i) => i.sku)).toEqual([
      "anthropic:claude-haiku-4-5:input",
      "anthropic:claude-haiku-4-5:input:cache_read",
      "anthropic:claude-haiku-4-5:output",
    ]);
    expect(b.total).toBeCloseTo(0.0008 + 0.00002 + 0.0025, 6);
    const batch = buildBilling("anthropic", "claude-haiku-4-5", usage, { batch: true });
    expect(batch.lineItems[0]!.sku).toContain(":batch");
    expect(batch.total).toBeCloseTo(b.total / 2, 6);
  });

  it("지출 트래커 데코레이터 + soft/hard 평가 (§10.4 — 다음 요청 차단)", async () => {
    const tracker = new InMemorySpendTracker();
    const ledger = withSpendTracking(undefined, tracker);
    await ledger.record({
      requestId: "r1", attempt: 1, provider: "anthropic", model: "claude-haiku-4-5", surface: "messages",
      stream: false, outcome: "success", billed: true, durationMs: 10,
      createdAt: "2026-08-21T10:00:00Z", keyId: "gwkid_1", costUsd: 0.06,
    });
    const key = {
      keyId: "gwkid_1", tenant: "acme", keyHash: "h", createdAt: "2026-08-21T00:00:00Z",
      budget: { periodDays: 30, softUsd: 0.05, hardUsd: 0.1 },
    };
    const soft = await evaluateBudget(key, tracker, new Date("2026-08-21T12:00:00Z"));
    expect(soft.blocked).toBe(false);
    expect(soft.warning?.code).toBe("budget-soft-warning");
    await ledger.record({
      requestId: "r2", attempt: 1, provider: "anthropic", model: "claude-haiku-4-5", surface: "messages",
      stream: false, outcome: "success", billed: true, durationMs: 10,
      createdAt: "2026-08-21T11:00:00Z", keyId: "gwkid_1", costUsd: 0.05,
    });
    expect((await evaluateBudget(key, tracker, new Date("2026-08-21T12:00:00Z"))).blocked).toBe(true);
  });

  it("CSV — 이스케이프 포함", () => {
    const csv = toCsv([{ group: 'a,"b"', requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5, costUsd: 0.5 }]);
    expect(csv).toContain('"a,""b"""');
    expect(csv.split("\n")[0]).toBe("group,requests,input_tokens,output_tokens,total_tokens,cost_usd");
  });
});

describe("서버 상태 리소스 레지스트리 (ADR-0006 §3)", () => {
  const reqWith = (po: Record<string, unknown>) =>
    IRRequestSchema.parse({
      version: "0",
      model: "gpt-5.6-luna",
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      providerOptions: { openai: po },
    });

  it("미등록 외부 id 기본 거부, opt-in 통과 + server-state-unmanaged warning", async () => {
    const store = new InMemoryResourceStore();
    await expect(
      checkInboundResources(reqWith({ previousResponseId: "resp_x" }), "openai", "acme", store),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.httpStatus === 400);
    const warnings = await checkInboundResources(reqWith({ previousResponseId: "resp_x" }), "openai", "acme", store, {
      allowUnregistered: true,
    });
    expect(warnings[0]!.code).toBe("server-state-unmanaged");
  });

  it("테넌트 격리 — 타 테넌트 리소스는 404 (존재 노출 금지)", async () => {
    const store = new InMemoryResourceStore();
    await store.register({
      tenant: "other", provider: "openai", resourceType: "response", externalId: "resp_y",
      createdAt: "2026-08-21T00:00:00Z",
    });
    await expect(
      checkInboundResources(reqWith({ previousResponseId: "resp_y" }), "openai", "acme", store),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.httpStatus === 404);
    // 소유 테넌트는 통과
    expect(await checkInboundResources(reqWith({ previousResponseId: "resp_y" }), "openai", "other", store)).toEqual([]);
  });

  it("응답 등록 — openai는 store 옵트인 시에만, anthropic container는 존재 시", async () => {
    const store = new InMemoryResourceStore();
    const res = (provider: string, pm?: IRResponse["providerMetadata"]): IRResponse => ({
      version: "0", id: "req_1", created: "2026-08-21T00:00:00Z",
      model: { requested: "m", resolved: { provider, model: "m", surface: "s" } },
      message: { role: "assistant", blocks: [], origin: { provider, model: "m" } },
      finishReason: { unified: "stop", raw: "stop" },
      usage: { input: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, output: { total: 0, text: 0, reasoning: 0 }, totalTokens: 0, raw: {} },
      warnings: [],
      gateway: { requestId: "req_1", providerRequestId: "resp_new" },
      ...(pm ? { providerMetadata: pm } : {}),
    });
    // openai store 미지정 → 미등록
    await registerResponseResources(res("openai"), reqWith({}), "acme", store);
    expect(await store.ownerOf("openai", "response", "resp_new")).toBeNull();
    // store:true → 등록
    await registerResponseResources(res("openai"), reqWith({ store: true }), "acme", store);
    expect(await store.ownerOf("openai", "response", "resp_new")).toBe("acme");
    // anthropic container
    await registerResponseResources(
      res("anthropic", { anthropic: { container: { id: "cont_1" } } }),
      IRRequestSchema.parse({ version: "0", model: "claude-haiku-4-5", messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }] }),
      "acme",
      store,
    );
    expect(await store.ownerOf("anthropic", "container", "cont_1")).toBe("acme");
  });
});

describe("본문 로그 (ADR-0008)", () => {
  it("stripForLog — groundingMetadata 제거 + 제거 사실 표기 (TOS)", () => {
    const body = {
      message: { blocks: [] },
      providerMetadata: { google: { groundingMetadata: { big: "data" }, other: 1 } },
    };
    const stripped = stripForLog(body) as Record<string, any>;
    expect(stripped["providerMetadata"]["google"]["groundingMetadata"]).toBeUndefined();
    expect(stripped["providerMetadata"]["google"]["groundingMetadataOmitted"]).toBe(true);
    expect(stripped["providerMetadata"]["google"]["other"]).toBe(1);
    // 원본 비변조
    expect(body.providerMetadata.google.groundingMetadata).toEqual({ big: "data" });
  });
});

// ── 리뷰 2026-08-22 회귀 ──
describe("InMemorySpendTracker 창 관리", () => {
  it("창 밖 항목은 조회 시 정리 — 프로세스 수명 내내 증가하지 않는다", async () => {
    const tracker = new InMemorySpendTracker();
    for (let i = 0; i < 100; i++) await tracker.add("k1", 0.01, `2026-08-2${i % 2}T00:00:00.000Z`);
    await tracker.add("k1", 1, "2026-08-22T00:00:00.000Z");

    // 창 안 지출만 합산
    expect(await tracker.spentSince("k1", "2026-08-22T00:00:00.000Z")).toBeCloseTo(1, 6);
    // 두 번째 조회도 같은 값 (정리가 창 안 항목을 먹지 않는다)
    expect(await tracker.spentSince("k1", "2026-08-22T00:00:00.000Z")).toBeCloseTo(1, 6);
  });
});
