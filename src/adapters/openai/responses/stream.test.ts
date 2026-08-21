import { describe, expect, it } from "vitest";
import type { AdapterStreamEvent, StreamTransformer } from "../../types.js";
import { createStreamTransformer } from "./stream.js";

// Responses semantic events → IR draft 상태 머신 검증 (인벤토리 §D 조립 시나리오).

function feed(transformer: StreamTransformer, events: Array<Record<string, unknown>>): AdapterStreamEvent[] {
  const out: AdapterStreamEvent[] = [];
  for (const e of events) {
    out.push(...transformer.onEvent(e["type"] as string, JSON.stringify(e)));
  }
  return out;
}

const created = {
  type: "response.created",
  response: { id: "resp_1", model: "gpt-5.6-luna-2026", status: "in_progress" },
};

function completed(output: unknown[] = [], usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 }) {
  return { type: "response.completed", response: { id: "resp_1", model: "gpt-5.6-luna-2026", status: "completed", output, usage } };
}

describe("openai responses 스트림 상태 머신", () => {
  it("텍스트: created → item → part → delta → done → completed", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
      { type: "response.content_part.added", item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "Hel" },
      { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "lo" },
      { type: "response.content_part.done", item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "Hello" } },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant" } },
      completed(),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      "response-metadata", "text-start", "text-delta", "text-delta", "text-end", "finish",
    ]);
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("stop");
    expect(finish.type === "finish" && finish.usage.totalTokens).toBe(15);
    // 터미널 후 멱등
    expect(t.onStreamEnd()).toEqual([]);
  });

  it("reasoning: 요약 delta + encrypted_content는 opaqueState로, item 원문은 PM으로", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const doneItem = {
      type: "reasoning", id: "rs_1",
      summary: [{ type: "summary_text", text: "part1" }],
      encrypted_content: "ENC",
    };
    const events = feed(t, [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0 },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "part1" },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0 },
      { type: "response.output_item.done", output_index: 0, item: doneItem },
      completed([doneItem]),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["response-metadata", "reasoning-start", "reasoning-delta", "reasoning-delta", "reasoning-end", "finish"]);
    const enriched = events[3]!;
    expect(enriched.type === "reasoning-delta" && enriched.opaqueState).toEqual({ provider: "openai", data: "ENC" });
    expect(enriched.type === "reasoning-delta" && enriched.providerMetadata?.["openai"]).toEqual({ item: doneItem });
  });

  it("function_call: 인자 delta 누적 → tool-call 완성본 (call_id 사용)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Paris"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"city":"Paris"}' },
      { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' } },
      completed(),
    ]);
    const call = events.find((e) => e.type === "tool-call")!;
    expect(call.type === "tool-call" && call.block).toMatchObject({
      toolCallId: "call_1",
      toolName: "get_weather",
      input: { type: "json", value: { city: "Paris" } },
    });
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason.unified).toBe("stop");
  });

  it("refusal 파트: text 강등 + end에 PM 표식 (§10.2 확정)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
      { type: "response.content_part.added", item_id: "msg_1", content_index: 0, part: { type: "refusal", refusal: "" } },
      { type: "response.refusal.delta", item_id: "msg_1", content_index: 0, delta: "cannot" },
      { type: "response.content_part.done", item_id: "msg_1", content_index: 0, part: { type: "refusal", refusal: "cannot" } },
    ]);
    const end = events.at(-1)!;
    expect(end.type).toBe("text-end");
    expect(end.type === "text-end" && end.providerMetadata?.["openai"]).toEqual({ refusal: true });
  });

  it("서버 툴: 진행 이벤트는 passthrough, 완성 item은 providerExecuted tool-call", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const wsItem = { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x" } };
    const events = feed(t, [
      created,
      { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1" } },
      { type: "response.web_search_call.in_progress", item_id: "ws_1" },
      { type: "response.web_search_call.searching", item_id: "ws_1" },
      { type: "response.web_search_call.completed", item_id: "ws_1" },
      { type: "response.output_item.done", output_index: 0, item: wsItem },
    ]);
    const passthroughs = events.filter((e) => e.type === "passthrough");
    expect(passthroughs.length).toBe(3); // 진행 3건 보존 — warning 없음 (알려진 진행 이벤트)
    expect(events.filter((e) => e.type === "warning").length).toBe(0);
    const call = events.find((e) => e.type === "tool-call")!;
    expect(call.type === "tool-call" && call.block).toMatchObject({
      toolCallId: "ws_1",
      providerExecuted: true,
      providerMetadata: { openai: { item: wsItem } },
    });
  });

  it("incomplete(max_output_tokens) → finish length", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      {
        type: "response.incomplete",
        response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 100 } },
      },
    ]);
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason).toEqual({ unified: "length", raw: "incomplete:max_output_tokens" });
  });

  it("response.failed → provider-error (billed, usage 동봉)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      {
        type: "response.failed",
        response: { id: "resp_1", status: "failed", error: { code: "server_error", message: "boom" }, usage: { input_tokens: 5, output_tokens: 0 } },
      },
    ]);
    const err = events.at(-1)!;
    expect(err.type).toBe("provider-error");
    expect(err.type === "provider-error" && err.error.billed).toBe(true);
    expect(err.type === "provider-error" && err.usage?.input.total).toBe(5);
  });

  it("종료 이벤트 없는 절단 → onStreamEnd 터미널 + 멱등", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    feed(t, [created]);
    const end = t.onStreamEnd();
    expect(end.length).toBe(1);
    expect(end[0]!.type).toBe("provider-error");
    expect(end[0]!.type === "provider-error" && end[0]!.error.billed).toBe(true);
    expect(t.onStreamEnd()).toEqual([]);
  });

  it("미지 이벤트: passthrough 보존 + 타입별 warning 1회 (§10.2)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    const events = feed(t, [
      created,
      { type: "response.novel_thing.delta", item_id: "x", delta: "?" },
      { type: "response.novel_thing.delta", item_id: "x", delta: "?" },
    ]);
    expect(events.filter((e) => e.type === "warning").length).toBe(1);
    expect(events.filter((e) => e.type === "passthrough").length).toBe(2);
  });

  it("터미널 이후 이벤트 무시 (§10.2)", () => {
    const t = createStreamTransformer({ modelId: "gpt-5.6-luna" });
    feed(t, [created, completed()]);
    expect(feed(t, [{ type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "late" }])).toEqual([]);
  });
});
