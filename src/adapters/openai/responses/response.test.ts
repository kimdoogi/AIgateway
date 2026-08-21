import { describe, expect, it } from "vitest";
import type { RequestContext } from "../../types.js";
import { transformResponse } from "./response.js";

const ctx: RequestContext & { requestedModel: string } = {
  requestId: "req_t", modelId: "gpt-5.6-luna", requestedModel: "gpt-5.6-luna",
};

describe("openai responses transformResponse", () => {
  it("message+reasoning+function_call — 블록·origin·usage·finishReason", () => {
    const t = transformResponse(
      {
        id: "resp_1",
        model: "gpt-5.6-luna-2026",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC" },
          { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [] }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
        ],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } },
      },
      ctx,
    );
    expect(t.blocks.map((b) => b.type)).toEqual(["reasoning", "text", "toolCall"]);
    const reasoning = t.blocks[0]!;
    expect(reasoning.type === "reasoning" && reasoning.opaqueState).toEqual({ provider: "openai", data: "ENC" });
    expect(reasoning.providerMetadata?.["openai"]?.["item"]).toMatchObject({ type: "reasoning", id: "rs_1" });
    expect(t.blocks.every((b) => b.origin?.surface === "responses")).toBe(true);
    expect(t.finishReason.unified).toBe("tool_call");
    expect(t.usage).toMatchObject({
      input: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
      output: { total: 50, text: 20, reasoning: 30 },
      totalTokens: 150,
    });
    expect(t.providerRequestId).toBe("resp_1");
  });

  it("refusal 파트 — text 강등 + PM 표식 + finishReason refusal", () => {
    const t = transformResponse(
      {
        id: "resp_1", model: "m", status: "completed",
        output: [{ type: "message", id: "msg_1", content: [{ type: "refusal", refusal: "cannot" }] }],
      },
      ctx,
    );
    expect(t.blocks[0]).toMatchObject({ type: "text", text: "cannot", providerMetadata: { openai: { refusal: true, itemId: "msg_1" } } });
    expect(t.finishReason.unified).toBe("refusal");
  });

  it("url_citation annotation → Citation outputRange", () => {
    const t = transformResponse(
      {
        id: "resp_1", model: "m", status: "completed",
        output: [
          {
            type: "message", id: "msg_1",
            content: [
              {
                type: "output_text", text: "Paris is the capital.",
                annotations: [{ type: "url_citation", url: "https://x.test", title: "X", start_index: 0, end_index: 5 }],
              },
            ],
          },
        ],
      },
      ctx,
    );
    const text = t.blocks[0]!;
    expect(text.type === "text" && text.citations).toEqual([
      { source: { type: "url", url: "https://x.test", title: "X" }, location: { type: "outputRange", start: 0, end: 5 } },
    ]);
  });

  it("call_id 미발급 → 결정론적 합성 (같은 응답 재변환 = 같은 id)", () => {
    const body = {
      id: "resp_x", model: "m", status: "completed",
      output: [{ type: "function_call", name: "f", arguments: "{}" }],
    };
    const a = transformResponse(body, ctx);
    const b = transformResponse(body, ctx);
    const call = a.blocks[0]!;
    expect(call.type === "toolCall" && call.toolCallId).toBe("synth:openai:resp_x:0:f");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("미지 item 타입 — passthrough + warning", () => {
    const t = transformResponse(
      { id: "resp_1", model: "m", status: "completed", output: [{ type: "future_item", data: 1 }] },
      ctx,
    );
    expect(t.blocks[0]!.type).toBe("passthrough");
    expect(t.warnings.some((w) => w.code === "unknown-block-passthrough")).toBe(true);
  });

  it("compaction item → custom 블록 (무변경 라운드트립 좌석)", () => {
    const t = transformResponse(
      { id: "resp_1", model: "m", status: "completed", output: [{ type: "compaction", id: "cmp_1" }] },
      ctx,
    );
    expect(t.blocks[0]).toMatchObject({ type: "custom", kind: "openai.compaction" });
  });

  it("incomplete/max_output_tokens → length", () => {
    const t = transformResponse(
      { id: "r", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      ctx,
    );
    expect(t.finishReason).toEqual({ unified: "length", raw: "incomplete:max_output_tokens" });
  });
});
