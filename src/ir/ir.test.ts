import { describe, expect, it } from "vitest";
import { IRRequestSchema } from "./request.js";
import { MessageSchema } from "./message.js";
import { BlockSchema } from "./blocks.js";
import { FinishReasonSchema } from "./finish.js";
import { IRResponseSchema } from "./response.js";

// 스펙의 대표 시나리오가 스키마로 표현 가능한지 — "표현력 시뮬레이션"의 코드판.

const fullRequest = {
  version: "0",
  model: "claude-opus-5",
  messages: [
    { role: "system", blocks: [{ type: "text", text: "You are helpful." }] },
    {
      role: "user",
      blocks: [
        { type: "text", text: "이 PDF 요약해줘", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        {
          type: "file",
          mediaType: "application/pdf",
          data: { type: "base64", data: "aGVsbG8=" },
          citationsEnabled: true,
        },
      ],
    },
    {
      role: "assistant",
      origin: { provider: "anthropic", model: "claude-opus-5", surface: "messages" },
      blocks: [
        {
          type: "reasoning",
          text: "",
          opaqueState: { provider: "anthropic", data: "c2ln" },
          origin: { provider: "anthropic", model: "claude-opus-5" },
        },
        {
          type: "toolCall",
          toolCallId: "toolu_01",
          toolName: "search",
          input: { type: "json", value: { q: "날씨" } },
        },
      ],
    },
    {
      role: "tool",
      blocks: [
        {
          type: "toolResult",
          toolCallId: "toolu_01",
          toolName: "search",
          output: { type: "content", blocks: [{ type: "text", text: "맑음" }] },
        },
      ],
    },
  ],
  tools: [
    {
      type: "function",
      name: "search",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      strict: true,
    },
    { type: "provider", id: "anthropic.web_search", args: { max_uses: 3 } },
  ],
  toolChoice: "auto",
  maxOutputTokens: 1024,
  reasoning: { effort: "xhigh" },
  retarget: { reasoning: "demote-to-text" },
  providerOptions: { anthropic: { betas: ["files-api-2025-04-14"] } },
} as const;

describe("IRRequest", () => {
  it("스펙 대표 요청을 수용한다", () => {
    expect(() => IRRequestSchema.parse(fullRequest)).not.toThrow();
  });

  it("미지의 최상위 키는 거부한다 (D5)", () => {
    expect(() => IRRequestSchema.parse({ ...fullRequest, thinking: { budget: 1 } })).toThrow();
  });

  it("미지의 effort 값은 거부한다 (게이트가 클램프하기 전 스키마 레벨)", () => {
    expect(() =>
      IRRequestSchema.parse({ ...fullRequest, reasoning: { effort: "ultra" } }),
    ).toThrow();
  });

  it("passthroughParams는 pinned 포함 수용", () => {
    expect(() =>
      IRRequestSchema.parse({
        ...fullRequest,
        passthroughParams: {
          provider: "anthropic",
          params: { future_param: true },
          headers: { "anthropic-beta": "new-beta-2027" },
          pinned: true,
        },
      }),
    ).not.toThrow();
  });
});

describe("Message role-블록 허용 (§3)", () => {
  it("system에 toolCall은 거부", () => {
    expect(() =>
      MessageSchema.parse({
        role: "system",
        blocks: [
          { type: "toolCall", toolCallId: "x", toolName: "t", input: { type: "json", value: {} } },
        ],
      }),
    ).toThrow();
  });

  it("assistant의 toolResult는 providerExecuted 없으면 거부", () => {
    const msg = {
      role: "assistant",
      blocks: [
        { type: "toolResult", toolCallId: "x", toolName: "t", output: { type: "text", text: "r" } },
      ],
    };
    expect(() => MessageSchema.parse(msg)).toThrow();
    expect(() =>
      MessageSchema.parse({
        ...msg,
        blocks: [{ ...msg.blocks[0], providerExecuted: true }],
      }),
    ).not.toThrow();
  });

  it("user에 custom 블록 허용 (anthropic.search_result — D10)", () => {
    expect(() =>
      MessageSchema.parse({
        role: "user",
        blocks: [{ type: "custom", kind: "anthropic.search_result", payload: { title: "doc" } }],
      }),
    ).not.toThrow();
  });
});

describe("블록 엣지 케이스", () => {
  it("빈 text + opaqueState (Gemini signature-only part) 표현 가능", () => {
    expect(() =>
      BlockSchema.parse({ type: "text", text: "", opaqueState: { provider: "google", data: "c2ln" } }),
    ).not.toThrow();
  });

  it("비JSON 툴 입력 (input.type=text) 표현 가능", () => {
    expect(() =>
      BlockSchema.parse({
        type: "toolCall",
        toolCallId: "call_1",
        toolName: "apply_patch",
        input: { type: "text", text: "*** diff ***" },
      }),
    ).not.toThrow();
  });

  it("custom kind 형식 강제", () => {
    expect(() => BlockSchema.parse({ type: "custom", kind: "no-dot", payload: {} })).toThrow();
  });
});

describe("FinishReason (G7)", () => {
  it("unified는 닫힌 enum + raw 원문 보존", () => {
    expect(() =>
      FinishReasonSchema.parse({ unified: "paused", raw: "pause_turn" }),
    ).not.toThrow();
    expect(() =>
      FinishReasonSchema.parse({ unified: "MALFORMED_FUNCTION_CALL", raw: "x" }),
    ).toThrow();
  });
});

describe("IRResponse", () => {
  it("대표 응답 수용 (단일 후보 — G2)", () => {
    expect(() =>
      IRResponseSchema.parse({
        version: "0",
        id: "req_1",
        created: "2026-08-20T12:00:00+09:00",
        model: {
          requested: "claude-opus-5",
          resolved: { provider: "anthropic", model: "claude-opus-5", surface: "messages" },
        },
        message: {
          role: "assistant",
          blocks: [{ type: "text", text: "안녕하세요" }],
          origin: { provider: "anthropic", model: "claude-opus-5", surface: "messages" },
        },
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: {
          input: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          output: { total: 5, text: 5, reasoning: 0 },
          totalTokens: 15,
          raw: { input_tokens: 10, output_tokens: 5 },
        },
        warnings: [],
        gateway: { requestId: "req_1" },
      }),
    ).not.toThrow();
  });
});
