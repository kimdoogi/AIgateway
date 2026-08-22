import { beforeAll, describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { bootstrapProviders } from "./bootstrap.js";
import { GatewayError } from "./errors.js";
import { executeNonStream, executeStream, type StreamEventDraft } from "./execute.js";
import { SessionStore } from "./session.js";

// 크로스 프로바이더 폴백 트리 (ir-v0 §6.4, 폴백 경합 매트릭스) — mock fetch (D9).

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["OPENAI_API_KEY"] = "test-key";
delete process.env["XAI_API_KEY"]; // 자격증명 skip 케이스용
beforeAll(() => bootstrapProviders());

const FAST_RETRY = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 }; // 폴백만 관찰 (같은-타깃 리트라이 배제)

const OVERLOADED = JSON.stringify({ error: { type: "overloaded_error", message: "busy" } });
const BAD_REQUEST = JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } });
const ANTHROPIC_OK = JSON.stringify({
  id: "msg_fb", model: "claude-sonnet-4-6",
  content: [{ type: "text", text: "from sonnet" }],
  stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 },
});
const OPENAI_OK = JSON.stringify({
  id: "resp_fb", model: "gpt-5.6-luna", status: "completed",
  output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "from gpt", annotations: [] }] }],
  usage: { input_tokens: 5, output_tokens: 2 },
});

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model: "claude-haiku-4-5",
    maxOutputTokens: 100,
    messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    ...input,
  });
}

/** URL·body 기반 응답 선택 mock */
function mockFetch(responder: (url: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ url: string; model: string }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), model: String(body["model"]) });
    return responder(String(url), body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("폴백 트리 — 비스트림", () => {
  it("claude 529 → gpt 성공: attempts 병합 + 최종 응답은 폴백 타깃", async () => {
    const { fetchImpl, calls } = mockFetch((url) =>
      url.includes("anthropic")
        ? new Response(OVERLOADED, { status: 529 })
        : new Response(OPENAI_OK, { status: 200 }),
    );
    const res = await executeNonStream(ir({ fallbackModels: ["gpt-5.6-luna"] }), { fetchImpl, retry: FAST_RETRY });
    expect(res.model.resolved.provider).toBe("openai");
    expect(res.message.blocks[0]).toMatchObject({ type: "text", text: "from gpt" });
    expect(res.gateway.attempts).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", outcome: "failed", error: "overloaded" },
      { provider: "openai", model: "gpt-5.6-luna", outcome: "success" },
    ]);
    expect(calls.map((c) => c.model)).toEqual(["claude-haiku-4-5", "gpt-5.6-luna"]);
  });

  it("부적격 실패(400)는 즉시 반환 — 폴백 미진행", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(BAD_REQUEST, { status: 400 }));
    await expect(
      executeNonStream(ir({ fallbackModels: ["gpt-5.6-luna"] }), { fetchImpl, retry: FAST_RETRY }),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.category === "invalid_request");
    expect(calls).toHaveLength(1);
  });

  it("자격증명 없는 타깃은 skipped 후 다음 타깃 (매트릭스 BYO 행)", async () => {
    const { fetchImpl, calls } = mockFetch((url) =>
      url.includes("anthropic")
        ? new Response(OVERLOADED, { status: 529 })
        : new Response(OPENAI_OK, { status: 200 }),
    );
    const res = await executeNonStream(ir({ fallbackModels: ["grok-4.6", "gpt-5.6-luna"] }), {
      fetchImpl,
      retry: FAST_RETRY,
    });
    expect(res.gateway.attempts).toMatchObject([
      { provider: "anthropic", outcome: "failed" },
      { provider: "xai", model: "grok-4.6", outcome: "skipped" },
      { provider: "openai", outcome: "success" },
    ]);
    expect(calls.map((c) => c.model)).toEqual(["claude-haiku-4-5", "gpt-5.6-luna"]); // grok 미호출
  });

  it("pinned passthrough — 타 프로바이더 타깃 전부 skipped 시 원 에러 반환", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(OVERLOADED, { status: 529 }));
    await expect(
      executeNonStream(
        ir({
          fallbackModels: ["gpt-5.6-luna"],
          passthroughParams: { provider: "anthropic", params: { top_k: 1 }, pinned: true },
        }),
        { fetchImpl, retry: FAST_RETRY },
      ),
    ).rejects.toSatisfy((e: unknown) => (e as GatewayError).irError.category === "overloaded");
    expect(calls).toHaveLength(1); // gpt는 pinned skip — 호출 자체가 없음
  });

  it("비-pinned passthrough 불일치 타깃은 드롭+warning 후 시도 (§13.3)", async () => {
    const { fetchImpl } = mockFetch((url, body) => {
      if (url.includes("anthropic")) return new Response(OVERLOADED, { status: 529 });
      expect(body["top_k"]).toBeUndefined(); // passthrough가 openai wire로 새지 않음
      return new Response(OPENAI_OK, { status: 200 });
    });
    const res = await executeNonStream(
      ir({
        fallbackModels: ["gpt-5.6-luna"],
        passthroughParams: { provider: "anthropic", params: { top_k: 1 } },
      }),
      { fetchImpl, retry: FAST_RETRY },
    );
    expect(res.warnings.some((w) => w.code === "passthrough-params-dropped")).toBe(true);
  });
});

// ── 스트림 ──

const SSE_OK = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_s", model: "claude-sonnet-4-6", usage: { input_tokens: 5 } } })}\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "from sonnet" } })}\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
].join("\n");

const SSE_MIDFAIL = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_m", model: "claude-haiku-4-5", usage: { input_tokens: 5 } } })}\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n`,
  `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "mid-stream" } })}\n`,
].join("\n");

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(gen: AsyncGenerator<StreamEventDraft>): Promise<StreamEventDraft[]> {
  const out: StreamEventDraft[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("폴백 트리 — 스트림 (§6.4)", () => {
  it("콘텐츠 방출 전 실패 → error-partial(willRetry:true) + provider-switched + 새 타깃 완주", async () => {
    const { fetchImpl } = mockFetch((_url, body) =>
      body["model"] === "claude-haiku-4-5" ? new Response(OVERLOADED, { status: 529 }) : sse(SSE_OK),
    );
    const events = await collect(
      executeStream(ir({ stream: true, fallbackModels: ["claude-sonnet-4-6"] }), { fetchImpl, retry: FAST_RETRY }),
    );
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "stream-start")).toHaveLength(1); // stream-start 1회 (§10.1)
    const partialIdx = types.indexOf("error-partial");
    const switchIdx = types.indexOf("provider-switched");
    expect(partialIdx).toBeGreaterThan(-1);
    expect((events[partialIdx] as { willRetry: boolean }).willRetry).toBe(true);
    expect(switchIdx).toBe(partialIdx + 1);
    const sw = events[switchIdx] as Extract<StreamEventDraft, { type: "provider-switched" }>;
    expect(sw.to.model).toBe("claude-sonnet-4-6");
    expect(types.at(-1)).toBe("finish");
    const finish = events.at(-1) as Extract<StreamEventDraft, { type: "finish" }>;
    expect(finish.attempts).toMatchObject([
      { provider: "anthropic", model: "claude-haiku-4-5", outcome: "failed" },
      { provider: "anthropic", model: "claude-sonnet-4-6", outcome: "success" },
    ]);
    expect(types).toContain("text-delta");
  });

  it("콘텐츠 방출 후 실패 → 전환 없이 터미널 종결 (중복 콘텐츠 금지)", async () => {
    const { fetchImpl, calls } = mockFetch((_url, body) =>
      body["model"] === "claude-haiku-4-5" ? sse(SSE_MIDFAIL) : sse(SSE_OK),
    );
    const events = await collect(
      executeStream(ir({ stream: true, fallbackModels: ["claude-sonnet-4-6"] }), { fetchImpl, retry: FAST_RETRY }),
    );
    const types = events.map((e) => e.type);
    expect(types).not.toContain("provider-switched");
    // 콘텐츠 방출 후 실패는 error-partial — 기방출 델타는 유효하다 (ir-v0 §10, 절단 경로와 동일 규칙).
    // willRetry:false이므로 세션은 여기서 done — 전환도 재시도도 없다
    const last = events.at(-1)!;
    expect(last.type).toBe("error-partial");
    expect(last.type === "error-partial" && last.willRetry).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("세션 — error-partial(willRetry:true)는 done이 아니다", () => {
    const store = new SessionStore();
    const session = store.create("s_fb");
    session.append({
      type: "error-partial",
      error: { category: "overloaded", httpStatus: 529, message: "x", fallbackEligible: true, billed: false },
      willRetry: true,
    });
    expect(session.isDone).toBe(false);
    session.append({
      type: "error-partial",
      error: { category: "overloaded", httpStatus: 529, message: "x", fallbackEligible: true, billed: false },
      willRetry: false,
    });
    expect(session.isDone).toBe(true);
  });
});
