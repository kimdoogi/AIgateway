import { describe, expect, it } from "vitest";
import { StreamEventSchema, TERMINAL_EVENT_TYPES } from "./stream.js";

describe("스트림 이벤트 (§10, ADR-0005)", () => {
  it("대표 시퀀스 전부 파싱", () => {
    const events = [
      { type: "stream-start", seq: 0, warnings: [] },
      {
        type: "response-metadata",
        seq: 1,
        id: "req_1",
        created: "2026-08-20T12:00:00Z",
        model: {
          requested: "claude-opus-5",
          resolved: { provider: "anthropic", model: "claude-opus-5", surface: "messages" },
        },
        providerRequestId: "prov_abc",
      },
      { type: "reasoning-start", seq: 2, id: "blk_0" },
      // signature-only delta (Anthropic signature_delta 패턴)
      {
        type: "reasoning-delta",
        seq: 3,
        id: "blk_0",
        opaqueState: { provider: "anthropic", data: "c2ln" },
      },
      { type: "reasoning-end", seq: 4, id: "blk_0" },
      { type: "text-start", seq: 5, id: "blk_1" },
      { type: "text-delta", seq: 6, id: "blk_1", delta: "안녕" },
      // Gemini signature-only text part (스키마 검증 A-1 해소 확인)
      { type: "text-end", seq: 7, id: "blk_1", opaqueState: { provider: "google", data: "dGhvdWdodA==" } },
      { type: "tool-input-start", seq: 8, id: "blk_2", toolCallId: "t1", toolName: "search" },
      { type: "tool-input-delta", seq: 9, id: "blk_2", delta: '{"q":' },
      { type: "tool-input-end", seq: 10, id: "blk_2" },
      {
        type: "tool-call",
        seq: 11,
        block: {
          type: "toolCall",
          toolCallId: "t1",
          toolName: "search",
          input: { type: "json", value: { q: "x" } },
        },
      },
      { type: "heartbeat", seq: 12 },
      {
        type: "provider-switched",
        seq: 13,
        from: { provider: "anthropic", model: "claude-opus-5" },
        to: { provider: "openai", model: "gpt-5.6" },
        reason: "overloaded",
      },
      { type: "usage-interim", seq: 14, usage: { output: { total: 42 } } },
      {
        type: "finish",
        seq: 15,
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          output: { total: 2, text: 2, reasoning: 0 },
          totalTokens: 3,
          raw: {},
        },
        attempts: [
          { provider: "anthropic", model: "claude-opus-5", outcome: "failed", error: "529" },
          { provider: "openai", model: "gpt-5.6", outcome: "success" },
        ],
      },
    ];
    for (const e of events) expect(() => StreamEventSchema.parse(e)).not.toThrow();
  });

  it("error-partial은 willRetry 필수", () => {
    expect(() =>
      StreamEventSchema.parse({
        type: "error-partial",
        seq: 1,
        error: {
          category: "overloaded",
          httpStatus: 529,
          message: "overloaded",
          fallbackEligible: true,
          billed: false,
        },
      }),
    ).toThrow();
  });

  it("터미널 이벤트 3종 정의 (ADR-0005)", () => {
    expect(TERMINAL_EVENT_TYPES).toEqual(["finish", "error-final", "error-partial"]);
  });
});
