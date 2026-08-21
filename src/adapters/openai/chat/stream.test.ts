import { describe, expect, it } from "vitest";
import type { AdapterStreamEvent, StreamTransformer } from "../../types.js";
import { createStreamTransformer } from "./stream.js";

// CC chat.completion.chunk → IR draft. 툴콜 파편 조립·[DONE] 종결·usage 마지막 chunk.

function chunk(t: StreamTransformer, data: unknown): AdapterStreamEvent[] {
  return t.onEvent(undefined, typeof data === "string" ? data : JSON.stringify(data));
}

const base = { id: "chatcmpl-1", model: "gpt-5.6-luna-2026", object: "chat.completion.chunk" };

describe("openai chat-completions 스트림 상태 머신", () => {
  it("텍스트 + [DONE]: metadata → text → finish(usage)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = [
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { content: "lo" } }] }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ...chunk(t, { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      ...chunk(t, "[DONE]"),
    ];
    expect(events.map((e) => e.type)).toEqual([
      "response-metadata", "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]);
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason).toEqual({ unified: "stop", raw: "stop" });
    expect(finish.type === "finish" && finish.usage.totalTokens).toBe(15);
    expect(t.onStreamEnd()).toEqual([]);
  });

  it("병렬 툴콜 파편 조립 — index별 tool-call 완성본", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = [
      ...chunk(t, {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather", arguments: "" } }] } }],
      }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] } }] }),
      ...chunk(t, {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "get_time", arguments: '{"tz":"UTC"}' } }] } }],
      }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ...chunk(t, "[DONE]"),
    ];
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls.length).toBe(2);
    expect(calls[0]!.type === "tool-call" && calls[0]!.block).toMatchObject({
      toolCallId: "call_a", toolName: "get_weather", input: { type: "json", value: { city: "Paris" } },
    });
    expect(calls[1]!.type === "tool-call" && calls[1]!.block.toolCallId).toBe("call_b");
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("tool_call");
  });

  it("비JSON 툴 인자 — text 강등 + warning (조용한 날조 금지)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = [
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "f", arguments: "not json" } }] } }] }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
      ...chunk(t, "[DONE]"),
    ];
    const call = events.find((e) => e.type === "tool-call")!;
    expect(call.type === "tool-call" && call.block.input).toEqual({ type: "text", text: "not json" });
    expect(events.some((e) => e.type === "warning" && e.warning.code === "tool-input-demoted")).toBe(true);
  });

  it("refusal delta — 별도 text 블록 + end PM 표식", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = [
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { refusal: "cannot " } }] }),
      ...chunk(t, { ...base, choices: [{ index: 0, delta: { refusal: "comply" }, finish_reason: "stop" }] }),
      ...chunk(t, "[DONE]"),
    ];
    const end = events.find((e) => e.type === "text-end")!;
    expect(end.type === "text-end" && end.providerMetadata?.["openai"]).toEqual({ refusal: true });
  });

  it("[DONE] 없는 절단 — finish_reason 수신 시 finish, 미수신 시 provider-error", () => {
    const withReason = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    chunk(withReason, { ...base, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] });
    const ended = withReason.onStreamEnd();
    expect(ended.at(-1)!.type).toBe("finish");

    const without = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    chunk(without, { ...base, choices: [{ index: 0, delta: { content: "hi" } }] });
    const truncated = without.onStreamEnd();
    expect(truncated.at(-1)!.type).toBe("provider-error");
    expect(truncated.at(-1)!.type === "provider-error" && (truncated.at(-1) as { error: { billed: boolean } }).error.billed).toBe(true);
  });

  it("in-stream error 객체 → provider-error 터미널", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = chunk(t, { error: { type: "server_error", message: "boom" } });
    expect(events.at(-1)!.type).toBe("provider-error");
    expect(t.onStreamEnd()).toEqual([]);
  });
});
