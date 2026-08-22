import { beforeAll, describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { GatewayError } from "../gateway/errors.js";
import { InMemoryBatchStore, InMemoryLedger } from "../state/memory.js";
import { cancelBatch, createBatch, getBatch, getBatchResults } from "./batches.js";
import { buildBilling } from "../ops/billing.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";

// Batches 브리지 (부록 (b) §3) — mock fetch + 인메모리 스토어 (D9).
// google·xai wire는 인벤토리 기반 가정 — 실 녹화 검증 좌석 (problem log).

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["OPENAI_API_KEY"] = "test-key";
process.env["GEMINI_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

function ir(model: string, text = "hi"): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model,
    maxOutputTokens: 100,
    messages: [{ role: "user", blocks: [{ type: "text", text }] }],
  });
}

interface Call {
  url: string;
  method?: string;
  body?: string | FormData;
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body as string | FormData });
    return responder(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const store = () => new InMemoryBatchStore();

describe("Batches 브리지 — 검증", () => {
  it("customId 중복·stream 항목·혼합 프로바이더는 사전 400 (§3.1/§3.2)", async () => {
    const deps = { batches: store() };
    await expect(
      createBatch(
        [
          { customId: "a", request: ir("claude-haiku-4-5") },
          { customId: "a", request: ir("claude-haiku-4-5") },
        ],
        deps,
      ),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.message.includes("중복"));

    await expect(
      createBatch([{ customId: "s", request: { ...ir("claude-haiku-4-5"), stream: true } }], deps),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.message.includes("stream"));

    await expect(
      createBatch(
        [
          { customId: "a", request: ir("claude-haiku-4-5") },
          { customId: "b", request: ir("gpt-5.6-luna") },
        ],
        deps,
      ),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.message.includes("단일 프로바이더"));
  });

  it("google 배치는 단일 모델 강제 (§3.1 — 모델이 경로에)", async () => {
    await expect(
      createBatch(
        [
          { customId: "a", request: ir("gemini-3.7-flash") },
          { customId: "b", request: ir("gemini-3.1-pro-preview") },
        ],
        { batches: store() },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.message.includes("단일 모델"));
  });
});

describe("Batches 브리지 — anthropic 수명주기", () => {
  it("생성(custom_id+params, stream 제거) → 폴링(ended→completed) → 결과 정규화 + 원장 1회", async () => {
    const batches = store();
    const ledger = new InMemoryLedger();
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.endsWith("/v1/messages/batches")) {
        return new Response(JSON.stringify({ id: "msgbatch_1", processing_status: "in_progress" }), { status: 200 });
      }
      if (url.endsWith("/results")) {
        const lines = [
          JSON.stringify({
            custom_id: "q1",
            result: {
              type: "succeeded",
              message: {
                id: "msg_b1", model: "claude-haiku-4-5",
                content: [{ type: "text", text: "Paris" }],
                stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 },
              },
            },
          }),
          JSON.stringify({ custom_id: "q2", result: { type: "errored", error: { type: "invalid_request_error", message: "bad" } } }),
          JSON.stringify({ custom_id: "q3", result: { type: "canceled" } }),
        ];
        return new Response(lines.join("\n"), { status: 200 });
      }
      // poll
      return new Response(
        JSON.stringify({
          id: "msgbatch_1", processing_status: "ended",
          request_counts: { succeeded: 1, errored: 1, canceled: 1, expired: 0 },
          results_url: "https://api.anthropic.com/v1/messages/batches/msgbatch_1/results",
        }),
        { status: 200 },
      );
    });
    const deps = { batches, ledger, fetchImpl, genId: () => "req_b1" };

    const created = await createBatch(
      [
        { customId: "q1", request: ir("claude-haiku-4-5", "capital of France?") },
        { customId: "q2", request: ir("claude-haiku-4-5") },
        { customId: "q3", request: ir("claude-haiku-4-5") },
      ],
      deps,
    );
    expect(created.id).toBe("gwb_b1");
    expect(created.counts.total).toBe(3);
    const createWire = JSON.parse(calls[0]!.body as string) as { requests: Array<{ custom_id: string; params: Record<string, unknown> }> };
    expect(createWire.requests[0]!.custom_id).toBe("q1");
    expect(createWire.requests[0]!.params["model"]).toBe("claude-haiku-4-5");
    expect(createWire.requests[0]!.params["stream"]).toBeUndefined();

    const polled = await getBatch("gwb_b1", deps);
    expect(polled.status).toBe("completed");
    expect(polled.counts).toEqual({ total: 3, succeeded: 1, errored: 1, canceled: 1, expired: 0 });

    const results = await getBatchResults("gwb_b1", deps);
    expect(results).toHaveLength(3);
    const ok = results.find((r) => r.customId === "q1")!;
    expect(ok.response!.message.blocks[0]).toMatchObject({ type: "text", text: "Paris" });
    expect(ok.response!.usage.totalTokens).toBe(7);
    const errored = results.find((r) => r.customId === "q2")!;
    expect(errored.error!.category).toBe("invalid_request");
    const canceled = results.find((r) => r.customId === "q3")!;
    expect(canceled.error!.provider?.code).toBe("batch-item-canceled");

    // 원장: 결과 수확 시점 1회 (재조회 중복 금지)
    expect(ledger.rows).toHaveLength(3);
    await getBatchResults("gwb_b1", deps);
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows[0]!.requestId).toBe("gwb_b1:q1");
    expect(ledger.rows[0]!.billed).toBe(true);
  });
});

describe("Batches 브리지 — openai 파일 기반", () => {
  it("JSONL 업로드(purpose:batch) → input_file_id 생성 → output 파일 결과", async () => {
    const batches = store();
    const { fetchImpl, calls } = mockFetch((url, init) => {
      if (url.endsWith("/v1/files") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "file_in1" }), { status: 200 });
      }
      if (url.endsWith("/v1/batches") && init?.method === "POST") {
        return new Response(JSON.stringify({ id: "batch_1", status: "validating" }), { status: 200 });
      }
      if (url.includes("/content")) {
        return new Response(
          JSON.stringify({
            custom_id: "q1",
            response: {
              status_code: 200,
              body: {
                id: "resp_1", model: "gpt-5.6-luna", status: "completed",
                output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
                usage: { input_tokens: 3, output_tokens: 1 },
              },
            },
          }),
          { status: 200 },
        );
      }
      // poll
      return new Response(
        JSON.stringify({ id: "batch_1", status: "completed", request_counts: { completed: 1, failed: 0 }, output_file_id: "file_out1" }),
        { status: 200 },
      );
    });
    const deps = { batches, fetchImpl, genId: () => "req_b2" };

    const created = await createBatch([{ customId: "q1", request: ir("gpt-5.6-luna") }], deps);
    expect(created.status).toBe("validating");
    // 업로드가 첫 호출, 배치 생성이 두 번째
    expect(calls[0]!.url).toContain("/v1/files");
    expect(calls[1]!.body as string).toContain("file_in1");

    const polled = await getBatch("gwb_b2", deps);
    expect(polled.status).toBe("completed");

    const results = await getBatchResults("gwb_b2", deps);
    expect(results[0]!.customId).toBe("q1");
    expect(results[0]!.response!.message.blocks.some((b) => b.type === "text")).toBe(true);
  });
});

describe("Batches 브리지 — xai (2026-08-22 실측 wire 회귀)", () => {
  it("생성 2단계 — batch_requests[].batch_request 태그드 유니온 (chat_get_completion)", async () => {
    const batches = store();
    process.env["XAI_API_KEY"] = "test-key";
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.endsWith("/v1/batches")) {
        return new Response(JSON.stringify({ batch_id: "xb_1" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    await createBatch([{ customId: "q1", request: ir("grok-4.3") }], { batches, fetchImpl, genId: () => "req_bx" });
    const reg = JSON.parse(calls[1]!.body as string) as {
      batch_requests: Array<{ unique_id: string; batch_request: Record<string, unknown> }>;
    };
    expect(calls[1]!.url).toContain("/v1/batches/xb_1/requests");
    expect(reg.batch_requests[0]!.unique_id).toBe("q1");
    // 태그드 유니온 — CC 표면은 chat_get_completion 변형 (실측 2026-08-22)
    const variant = reg.batch_requests[0]!.batch_request;
    expect(Object.keys(variant)).toEqual(["chat_get_completion"]);
    expect((variant["chat_get_completion"] as Record<string, unknown>)["model"]).toBe("grok-4.3");
  });
});

describe("Batches 브리지 — google·취소", () => {
  it("google 생성 wire(batchGenerateContent + metadata.key) + 인라인 결과", async () => {
    const batches = store();
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.includes(":batchGenerateContent")) {
        return new Response(JSON.stringify({ name: "batches/g1", metadata: { state: "BATCH_STATE_PENDING" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "batches/g1", done: true, metadata: { state: "BATCH_STATE_SUCCEEDED" },
          response: {
            inlinedResponses: {
              inlinedResponses: [
                {
                  metadata: { key: "q1" },
                  response: {
                    responseId: "r1", modelVersion: "gemini-3.7-flash",
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      );
    });
    const deps = { batches, fetchImpl, genId: () => "req_b3" };
    const created = await createBatch([{ customId: "q1", request: ir("gemini-3.7-flash") }], deps);
    expect(created.status).toBe("in_progress");
    const wire = JSON.parse(calls[0]!.body as string) as Record<string, any>;
    expect(wire["batch"]["inputConfig"]["requests"]["requests"][0]["metadata"]["key"]).toBe("q1");

    const results = await getBatchResults("gwb_b3", deps);
    expect(results[0]!.response!.message.blocks[0]).toMatchObject({ type: "text", text: "ok" });
  });

  it("취소 — 프로바이더 전파 후 최신 상태 재조회 (§3.2 비동기 취소)", async () => {
    const batches = store();
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.endsWith("/cancel")) return new Response("{}", { status: 200 });
      if (url.endsWith("/v1/messages/batches")) {
        return new Response(JSON.stringify({ id: "msgbatch_c", processing_status: "in_progress" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "msgbatch_c", processing_status: "canceling", request_counts: {} }), { status: 200 });
    });
    const deps = { batches, fetchImpl, genId: () => "req_b4" };
    await createBatch([{ customId: "q1", request: ir("claude-haiku-4-5") }], deps);
    const canceled = await cancelBatch("gwb_b4", deps);
    expect(canceled.status).toBe("canceling");
    expect(calls.some((c) => c.url.endsWith("/cancel") && c.method === "POST")).toBe(true);
  });
});

// ── 리뷰 2026-08-22 회귀 ──
describe("배치 회계·자격증명 귀속", () => {
  const ANTHROPIC_RESULT = JSON.stringify({
    custom_id: "a",
    result: {
      type: "succeeded",
      message: {
        id: "msg_b1",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    },
  });

  function batchFetch() {
    return mockFetch((url) => {
      if (url.endsWith("/batches")) {
        return new Response(JSON.stringify({ id: "batch_1", processing_status: "ended" }), { status: 200 });
      }
      if (url.endsWith("/results")) return new Response(ANTHROPIC_RESULT, { status: 200 });
      return new Response(
        JSON.stringify({ id: "batch_1", processing_status: "ended", request_counts: { succeeded: 1 } }),
        { status: 200 },
      );
    });
  }

  it("원장 행에 tenant·keyId·costUsd(배치 할인) 병기 — 예산·정산에서 누락되지 않는다", async () => {
    const { fetchImpl } = batchFetch();
    const ledger = new InMemoryLedger();
    const deps = { batches: store(), ledger, fetchImpl, tenant: "t9", keyId: "gwkid_abc", keySource: "pool" as const };
    const created = await createBatch([{ customId: "a", request: ir("claude-haiku-4-5") }], deps);
    const results = await getBatchResults(created.id, deps);
    expect(results[0]!.response).toBeDefined();

    expect(ledger.rows).toHaveLength(1);
    const row = ledger.rows[0]!;
    expect(row).toMatchObject({ tenant: "t9", keyId: "gwkid_abc", keySource: "pool", billed: true });
    expect(row.costUsd).toBeGreaterThan(0);
    // 배치 할인 50% (부록 (b) §3.4) — 동기 단가의 절반
    const sync = buildBilling("anthropic", "claude-haiku-4-5", row.usage!).total;
    expect(row.costUsd).toBeCloseTo(sync / 2, 6);

    // 예산 트래커가 실제로 이 지출을 본다
    const tracker = new InMemorySpendTracker();
    const tracked = withSpendTracking(undefined, tracker);
    await tracked.record(row);
    expect(tracker.spentSince("gwkid_abc", "1970-01-01T00:00:00Z")).toBeCloseTo(row.costUsd!, 6);
  });

  it("주입된 BYO 리졸버로 업스트림 호출 (풀 키 고정 아님)", async () => {
    const authSeen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      authSeen.push(((init?.headers ?? {}) as Record<string, string>)["x-api-key"] ?? "(none)");
      return new Response(JSON.stringify({ id: "batch_1", processing_status: "in_progress" }), { status: 200 });
    }) as typeof fetch;
    await createBatch([{ customId: "a", request: ir("claude-haiku-4-5") }], {
      batches: store(),
      fetchImpl,
      credentials: async () => ({ "x-api-key": "byo-batch-key" }),
    });
    expect(authSeen).toEqual(["byo-batch-key"]);
  });
});
