import { describe, expect, it } from "vitest";
import { transformResponse } from "./response.js";

const ctx = { requestId: "req_t", modelId: "claude-haiku-4-5", requestedModel: "claude-haiku-4-5" };

describe("anthropic transformResponse", () => {
  it("텍스트+thinking+tool_use 응답 → IR 블록 + usage 공식(G4) + finishReason", () => {
    const res = transformResponse(
      {
        id: "msg_01",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [
          { type: "thinking", thinking: "추론", signature: "sig" },
          { type: "text", text: "서울 날씨를 확인할게요." },
          { type: "tool_use", id: "toolu_01", name: "weather", input: { city: "서울" } },
        ],
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 2,
        },
      },
      ctx,
    );
    expect(res.blocks.map((b) => b.type)).toEqual(["reasoning", "text", "toolCall"]);
    expect(res.blocks[0]).toMatchObject({
      opaqueState: { provider: "anthropic", data: "sig" },
      origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
    });
    expect(res.finishReason).toEqual({ unified: "tool_call", raw: "tool_use" });
    // Anthropic input_tokens는 non-cached만 → total 합성 (10+5+2)
    expect(res.usage.input).toEqual({ total: 17, noCache: 10, cacheRead: 5, cacheWrite: 2 });
    expect(res.usage.totalTokens).toBe(24);
    expect(res.providerRequestId).toBe("msg_01");
  });

  it("pause_turn은 paused로 노출 (ADR-0005), redacted_thinking 왕복", () => {
    const res = transformResponse(
      {
        id: "msg_02",
        model: "claude-opus-5",
        content: [{ type: "redacted_thinking", data: "ZW5j" }],
        stop_reason: "pause_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ctx,
    );
    expect(res.finishReason).toEqual({ unified: "paused", raw: "pause_turn" });
    expect(res.blocks[0]).toMatchObject({
      type: "reasoning",
      redacted: true,
      opaqueState: { provider: "anthropic", data: "ZW5j" },
    });
  });

  it("응답 블록에 id·origin 부여 (§4.0 — 리뷰 P2), 서버 툴은 wireType 보존 (리뷰 R1)", () => {
    const res = transformResponse(
      {
        id: "msg_04",
        model: "claude-haiku-4-5",
        content: [
          { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ url: "https://x" }] },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ctx,
    );
    expect(res.blocks.map((b) => b.id)).toEqual(["blk_0", "blk_1"]);
    expect(res.blocks[0]).toMatchObject({
      type: "toolCall",
      providerExecuted: true,
      providerMetadata: { anthropic: { wireType: "server_tool_use" } },
    });
    expect(res.blocks[1]).toMatchObject({
      type: "toolResult",
      providerExecuted: true,
      providerMetadata: { anthropic: { wireType: "web_search_tool_result" } },
    });
  });

  it("웹서치 citation은 url 출처로 보존 (리뷰 P5), end 미검증 제거 (리뷰 P6)", () => {
    const res = transformResponse(
      {
        id: "msg_05",
        model: "claude-haiku-4-5",
        content: [
          {
            type: "text",
            text: "결과",
            citations: [
              { type: "web_search_result_location", url: "https://x", title: "제목", cited_text: "인용" },
              { type: "char_location", start_char_index: 120 }, // end 부재 → location 생략
            ],
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ctx,
    );
    const text = res.blocks[0] as Extract<(typeof res.blocks)[number], { type: "text" }>;
    expect(text.citations![0]).toEqual({
      source: { type: "url", url: "https://x", title: "제목" },
      citedText: "인용",
    });
    expect(text.citations![1]!.location).toBeUndefined();
  });

  it("미지 블록 타입은 passthrough 보존 + warning (D10 day-1)", () => {
    const res = transformResponse(
      {
        id: "msg_03",
        model: "claude-haiku-4-5",
        content: [{ type: "hologram_block", stuff: 1 }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ctx,
    );
    expect(res.blocks[0]).toMatchObject({
      type: "passthrough",
      provider: "anthropic",
      raw: { type: "hologram_block", stuff: 1 },
    });
    expect(res.warnings.map((x) => x.code)).toContain("unknown-block-passthrough");
  });
});
