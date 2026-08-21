import { describe, expect, it } from "vitest";
import { createStreamTransformer } from "./stream.js";
import type { AdapterStreamEvent } from "../types.js";

const ctx = { modelId: "claude-haiku-4-5" };

// 문서 포맷 기반 합성 SSE 시퀀스 — 녹화 픽스처는 캡처 하네스(4단계)에서 대체·보강
function run(events: Array<[string, unknown]>, streamEnd = true): AdapterStreamEvent[] {
  const t = createStreamTransformer(ctx);
  const out: AdapterStreamEvent[] = [];
  for (const [name, data] of events) out.push(...t.onEvent(name, JSON.stringify(data)));
  if (streamEnd) out.push(...t.onStreamEnd());
  return out;
}

const messageStart = (usage: Record<string, unknown> = { input_tokens: 20, cache_read_input_tokens: 4 }) =>
  ["message_start", {
    type: "message_start",
    message: { id: "msg_01", model: "claude-haiku-4-5", usage },
  }] as [string, unknown];

describe("anthropic 스트림 상태 머신", () => {
  it("thinking(signature_delta 포함)+텍스트+툴 스트림 전체 시퀀스", () => {
    const out = run([
      messageStart(),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "생각중" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sigX" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "확인할게요" } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "weather", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":' } }],
      ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"서울"}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 2 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } }],
      ["message_stop", { type: "message_stop" }],
    ]);

    expect(out.map((e) => e.type)).toEqual([
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta", // signature-only
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "usage-interim",
      "finish",
    ]);

    const meta = out[0] as Extract<AdapterStreamEvent, { type: "response-metadata" }>;
    // draft enrich 계약: 어댑터는 resolved·providerRequestId만 (id/created/requested는 게이트웨이)
    expect(meta).toEqual({
      type: "response-metadata",
      model: { resolved: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" } },
      providerRequestId: "msg_01",
      // §10.1 PM — message_start usage 원문 (compat 재합성의 input 토큰 소스)
      providerMetadata: { anthropic: { usage: { input_tokens: 20, cache_read_input_tokens: 4 } } },
    });

    const sigDelta = out[3] as Extract<AdapterStreamEvent, { type: "reasoning-delta" }>;
    expect(sigDelta.opaqueState).toEqual({ provider: "anthropic", data: "sigX" });
    expect(sigDelta.delta).toBeUndefined();

    const toolCall = out[12] as Extract<AdapterStreamEvent, { type: "tool-call" }>;
    expect(toolCall.block).toMatchObject({
      toolCallId: "toolu_9",
      toolName: "weather",
      input: { type: "json", value: { city: "서울" } },
      origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" }, // 리뷰 R8
    });

    const finish = out[14] as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.finishReason).toEqual({ unified: "tool_call", raw: "tool_use" });
    expect(finish.usage.input).toEqual({ total: 24, noCache: 20, cacheRead: 4, cacheWrite: 0 });
    expect(finish.usage.output.total).toBe(15);
    // §8 raw — 스트림은 분산 도착 원문을 함께 보존
    expect(finish.usage.raw).toEqual({
      message_start: { input_tokens: 20, cache_read_input_tokens: 4 },
      message_delta: { output_tokens: 15 },
    });
  });

  it("message_delta의 누적 input/cache 갱신을 finish에 반영 (리뷰 R3 — 서버 툴 mid-turn 증가)", () => {
    const out = run([
      messageStart({ input_tokens: 1000 }),
      ["message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 9000, cache_read_input_tokens: 100, output_tokens: 500 },
      }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const interim = out.find((e) => e.type === "usage-interim") as Extract<AdapterStreamEvent, { type: "usage-interim" }>;
    expect(interim.usage.input?.noCache).toBe(9000);
    const finish = out.find((e) => e.type === "finish") as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.usage.input).toEqual({ total: 9100, noCache: 9000, cacheRead: 100, cacheWrite: 0 });
    expect(finish.usage.output.total).toBe(500);
  });

  it("in-stream 에러: 529 승격 + message_start 이후엔 billed·usage 동봉 (리뷰 R2)", () => {
    // message_start 이전 — 무과금, usage 없음
    const before = run([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]], false);
    const errBefore = before[0] as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(errBefore.error.httpStatus).toBe(529);
    expect(errBefore.error.billed).toBe(false);
    expect(errBefore.usage).toBeUndefined();

    // message_start 이후 — input 과금 발생, usage 동봉
    const after = run(
      [messageStart({ input_tokens: 50000 }), ["error", { type: "error", error: { type: "overloaded_error" } }]],
      false,
    );
    const errAfter = after.find((e) => e.type === "provider-error") as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(errAfter.error.billed).toBe(true);
    expect(errAfter.usage?.input.total).toBe(50000);
  });

  it("in-stream invalid_request_error는 400으로 정합 매핑 (리뷰 P7)", () => {
    const out = run([["error", { type: "error", error: { type: "invalid_request_error", message: "bad" } }]], false);
    const err = out[0] as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(err.error.category).toBe("invalid_request");
    expect(err.error.httpStatus).toBe(400);
    expect(err.error.fallbackEligible).toBe(false);
  });

  it("터미널 이후 이벤트는 무시 — 이중 터미널 금지 (리뷰 R10)", () => {
    const t = createStreamTransformer(ctx);
    t.onEvent("message_start", JSON.stringify({ type: "message_start", message: { id: "m", model: "x", usage: {} } }));
    const finish = t.onEvent("message_stop", JSON.stringify({ type: "message_stop" }));
    expect(finish.map((e) => e.type)).toEqual(["finish"]);
    // 후행 error/중복 stop → 전부 무시
    expect(t.onEvent("error", JSON.stringify({ type: "error", error: { type: "overloaded_error" } }))).toEqual([]);
    expect(t.onEvent("message_stop", JSON.stringify({ type: "message_stop" }))).toEqual([]);
    expect(t.onStreamEnd()).toEqual([]);
  });

  it("종료 신호 없는 절단 → provider-error (billed + usage — 리뷰 R2/C3)", () => {
    const t = createStreamTransformer(ctx);
    t.onEvent("message_start", JSON.stringify({ type: "message_start", message: { id: "m", model: "x", usage: { input_tokens: 7 } } }));
    const end = t.onStreamEnd();
    const err = end[0] as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(err.error.category).toBe("provider_error");
    expect(err.error.httpStatus).toBe(502);
    expect(err.error.billed).toBe(true);
    expect(err.usage?.input.total).toBe(7);
  });

  it("미지 블록의 후속 delta·미지 delta 타입·미지 이벤트 전부 보존 + 타입별 1회 warning (리뷰 R7)", () => {
    const out = run([
      messageStart(),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "hologram", seed: 1 } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "hologram_delta", part: "a" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "hologram_delta", part: "b" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "future_delta", x: 1 } }],
      ["future_event", { type: "future_event", y: 2 }],
      ["message_stop", { type: "message_stop" }],
    ], false);

    const passthroughs = out.filter((e) => e.type === "passthrough");
    // 미지 블록 start 1 + 후속 delta 2 + 미지 delta 1 + 미지 이벤트 1 = 5건 전부 보존
    expect(passthroughs).toHaveLength(5);
    const warnings = out.filter((e) => e.type === "warning");
    // 타입별 1회: hologram 블록, future_delta, future_event = 3건
    expect(warnings).toHaveLength(3);
  });

  it("content_block_start의 non-empty 초기 스냅샷은 delta로 재현 (리뷰 P3)", () => {
    const out = run([
      messageStart(),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "프리픽스" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "-이어서" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ], false);
    const deltas = out.filter((e) => e.type === "text-delta") as Array<Extract<AdapterStreamEvent, { type: "text-delta" }>>;
    expect(deltas.map((d) => d.delta)).toEqual(["프리픽스", "-이어서"]);
  });

  it("id 미발급 tool_use는 결정론적 합성 id (리뷰 P1 — G5)", () => {
    const events: Array<[string, unknown]> = [
      messageStart(),
      ["content_block_start", { type: "content_block_start", index: 3, content_block: { type: "tool_use", name: "f", input: {} } }],
      ["content_block_stop", { type: "content_block_stop", index: 3 }],
    ];
    const first = run(events, false);
    const second = run(events, false);
    const toolCall = first.find((e) => e.type === "tool-call") as Extract<AdapterStreamEvent, { type: "tool-call" }>;
    expect(toolCall.block.toolCallId).toBe("synth:anthropic:msg_01:3:f");
    const toolCall2 = second.find((e) => e.type === "tool-call") as Extract<AdapterStreamEvent, { type: "tool-call" }>;
    expect(toolCall2.block.toolCallId).toBe(toolCall.block.toolCallId); // 재변환 = 동일 id (결정론)
  });

  it("유효 JSON이 아닌 tool input은 text 강등 + tool-input-demoted (날조 금지)", () => {
    const out = run([
      messageStart(),
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "f", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"broken":' } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
    const warning = out.find(
      (e) => e.type === "warning" && e.warning.code === "tool-input-demoted",
    ) as Extract<AdapterStreamEvent, { type: "warning" }>;
    expect(warning).toBeDefined();
    const toolCall = out.find((e) => e.type === "tool-call") as Extract<AdapterStreamEvent, { type: "tool-call" }>;
    expect(toolCall.block.input).toEqual({ type: "text", text: '{"broken":' });
  });

  it("includeRaw 시 프로바이더 원문을 raw 이벤트로 병행 방출 (리뷰 R6b)", () => {
    const t = createStreamTransformer({ modelId: "m", includeRaw: true });
    const out = t.onEvent("message_start", JSON.stringify({ type: "message_start", message: { id: "m1", model: "x", usage: {} } }));
    expect(out[0]!.type).toBe("raw");
    expect(out[1]!.type).toBe("response-metadata");
  });
});
