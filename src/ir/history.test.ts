import { describe, expect, it } from "vitest";
import { blockToHistory, responseToHistoryMessage } from "./history.js";
import type { Block } from "./blocks.js";
import type { IRResponse } from "./response.js";

describe("히스토리 편입 (§13.1 — metadata→options 복사 계약)", () => {
  it("providerMetadata가 providerOptions로 복사되고 origin·opaqueState는 보존", () => {
    const block: Block = {
      type: "reasoning",
      text: "요약된 추론",
      origin: { provider: "openai", model: "gpt-5.6", surface: "responses" },
      opaqueState: { provider: "openai", data: "ZW5j" },
      providerMetadata: { openai: { itemId: "rs_1" } },
    };
    const h = blockToHistory(block);
    expect(h.providerOptions).toEqual({ openai: { itemId: "rs_1" } });
    expect("providerMetadata" in h).toBe(false);
    expect(h.origin).toEqual(block.origin);
    expect(h.opaqueState).toEqual(block.opaqueState);
  });

  it("기존 providerOptions가 응답 메타보다 우선", () => {
    const block: Block = {
      type: "text",
      text: "x",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      providerMetadata: { anthropic: { cacheControl: { type: "other" }, extra: 1 } },
    };
    const h = blockToHistory(block);
    expect(h.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" }, extra: 1 },
    });
  });

  it("빈 blocks 응답은 히스토리 메시지를 생성하지 않는다 — null (리뷰 R9 / §13.1 빈 응답 규칙)", () => {
    const base: IRResponse = {
      version: "0",
      id: "req_1",
      created: "2026-08-20T12:00:00Z",
      model: {
        requested: "claude-haiku-4-5",
        resolved: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
      },
      message: {
        role: "assistant",
        blocks: [],
        origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
      },
      finishReason: { unified: "length", raw: "max_tokens" },
      usage: {
        input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        output: { total: 0, text: 0, reasoning: 0 },
        totalTokens: 1,
        raw: {},
      },
      warnings: [],
      gateway: { requestId: "req_1" },
    };
    expect(responseToHistoryMessage(base)).toBeNull();

    const withBlock: IRResponse = {
      ...base,
      message: { ...base.message, blocks: [{ type: "text", text: "ok" }] },
    };
    expect(responseToHistoryMessage(withBlock)?.blocks).toHaveLength(1);
  });
});
