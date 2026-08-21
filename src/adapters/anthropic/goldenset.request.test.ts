import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../../ir/index.js";
import type { RequestContext } from "../types.js";
import { anthropicAdapter } from "./index.js";
import { describeAdapterConformance } from "../adapter-conformance.js";

// 골든셋 ① — IR 입력 → Anthropic wire body 스냅샷 (D9). 케이스는 캡처 하네스 세트와 짝.
// 스냅샷 갱신은 의도된 wire 변경일 때만 (`vitest -u`) — diff가 곧 리뷰 대상.

const ctx: RequestContext = { requestId: "req_golden", modelId: "claude-haiku-4-5" };

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({ version: "0", model: "claude-haiku-4-5", ...input });
}

const user = (text: string) => ({ role: "user", blocks: [{ type: "text", text }] });

const CASES: Array<{ name: string; request: IRRequest; ctx?: RequestContext }> = [
  {
    name: "text-minimal — maxOutputTokens 미지정은 기본값 주입 + warning",
    request: ir({ messages: [user("hi")] }),
  },
  {
    name: "sampling-full — 미지원 3종(seed/presence/frequency)은 드롭 + warning",
    request: ir({
      messages: [user("hi")],
      maxOutputTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      stopSequences: ["END"],
      seed: 42,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    }),
  },
  {
    name: "tools — function 툴 + 지정 toolChoice + 병렬 off",
    request: ir({
      messages: [user("weather?")],
      maxOutputTokens: 200,
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "Get weather.",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      toolChoice: { type: "tool", toolName: "get_weather" },
      parallelToolCalls: false,
    }),
  },
  {
    name: "provider-tool — anthropic.web_search (args가 wire 원문)",
    request: ir({
      messages: [user("search")],
      maxOutputTokens: 300,
      tools: [
        { type: "provider", id: "anthropic.web_search", args: { type: "web_search_20260209", max_uses: 1 } },
      ],
    }),
  },
  {
    name: "thinking-po — providerOptions.anthropic.thinking + betas 헤더",
    request: ir({
      messages: [user("why?")],
      maxOutputTokens: 1500,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budget_tokens: 1024 },
          betas: ["interleaved-thinking-2025-05-14"],
        },
      },
    }),
  },
  {
    name: "cache-breakpoint — 블록 PO cacheControl → cache_control",
    request: ir({
      messages: [
        {
          role: "system",
          blocks: [
            {
              type: "text",
              text: "You are terse.",
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ],
        },
        user("hi"),
      ],
      maxOutputTokens: 100,
    }),
  },
  {
    name: "reasoning-replay — anthropic opaqueState는 thinking+signature 복원, redacted 포함",
    request: ir({
      messages: [
        user("continue"),
        {
          role: "assistant",
          blocks: [
            {
              type: "reasoning",
              text: "step by step",
              opaqueState: { provider: "anthropic", data: "SIG_BYTES" },
            },
            {
              type: "reasoning",
              text: "",
              redacted: true,
              opaqueState: { provider: "anthropic", data: "REDACTED_BYTES" },
            },
            { type: "text", text: "answer" },
          ],
        },
        user("next"),
      ],
      maxOutputTokens: 100,
    }),
  },
  {
    name: "reasoning-foreign — 외래 reasoning은 retarget 정책(demote-to-text) + warning",
    request: ir({
      messages: [
        user("continue"),
        {
          role: "assistant",
          origin: { provider: "openai", model: "gpt-x" },
          blocks: [
            { type: "reasoning", text: "foreign thought" },
            { type: "text", text: "answer" },
          ],
        },
        user("next"),
      ],
      maxOutputTokens: 100,
      retarget: { reasoning: "demote-to-text" },
    }),
  },
  {
    name: "mid-system-unsupported — capability 없으면 user 변환 + warning",
    request: ir({
      messages: [
        { role: "system", blocks: [{ type: "text", text: "top system" }] },
        user("hi"),
        { role: "system", blocks: [{ type: "text", text: "mid instruction" }] },
      ],
      maxOutputTokens: 100,
    }),
  },
  {
    name: "mid-system-supported — capability 있으면 messages 내 role system 유지",
    request: ir({
      messages: [
        { role: "system", blocks: [{ type: "text", text: "top system" }] },
        user("hi"),
        { role: "system", blocks: [{ type: "text", text: "mid instruction" }] },
      ],
      maxOutputTokens: 100,
    }),
    ctx: { ...ctx, capabilities: { midConversationSystem: true } },
  },
  {
    name: "multimodal — 이미지 base64 + 텍스트 문서(citations enabled)",
    request: ir({
      messages: [
        {
          role: "user",
          blocks: [
            { type: "file", mediaType: "image/png", data: { type: "base64", data: "PNGDATA" } },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "text", text: "The hub is v0." },
              title: "IR overview",
              citationsEnabled: true,
            },
            { type: "text", text: "describe" },
          ],
        },
      ],
      maxOutputTokens: 100,
    }),
  },
  {
    name: "tool-roundtrip — toolCall/toolResult 히스토리 + tool role → user 병합",
    request: ir({
      messages: [
        user("weather in Seoul?"),
        {
          role: "assistant",
          blocks: [
            {
              type: "toolCall",
              toolCallId: "toolu_01",
              toolName: "get_weather",
              input: { type: "json", value: { city: "Seoul" } },
            },
          ],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: "toolu_01",
              toolName: "get_weather",
              output: { type: "content", blocks: [{ type: "text", text: "18C, clear" }] },
            },
          ],
        },
      ],
      maxOutputTokens: 150,
    }),
  },
  {
    name: "server-tool-roundtrip — providerExecuted + wireType 복원 (G1)",
    request: ir({
      messages: [
        user("search it"),
        {
          role: "assistant",
          blocks: [
            {
              type: "toolCall",
              toolCallId: "srvtoolu_01",
              toolName: "web_search",
              input: { type: "json", value: { query: "ir hub" } },
              providerExecuted: true,
              providerOptions: { anthropic: { wireType: "server_tool_use" } },
            },
            {
              type: "toolResult",
              toolCallId: "srvtoolu_01",
              toolName: "web_search",
              output: { type: "json", value: [{ type: "web_search_result", url: "https://x" }] },
              providerExecuted: true,
              providerOptions: { anthropic: { wireType: "web_search_tool_result" } },
            },
          ],
        },
        user("summarize"),
      ],
      maxOutputTokens: 150,
    }),
  },
  {
    name: "response-format+effort — output_config 조립, 미지원 effort는 클램프 + warning",
    request: ir({
      messages: [user("json please")],
      maxOutputTokens: 200,
      reasoning: { effort: "none" },
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
        name: "result",
      },
    }),
  },
  {
    name: "passthrough-params — 미지 키 병합 + 커스텀 헤더 (D10-1)",
    request: ir({
      messages: [user("hi")],
      maxOutputTokens: 100,
      stream: true,
      passthroughParams: {
        provider: "anthropic",
        params: { container: { id: "container_x" } },
        headers: { "anthropic-beta": "computer-use-2025-01-24" },
      },
    }),
  },
];

describe("골든셋 ① IR → anthropic wire", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(anthropicAdapter.transformRequest(c.request, c.ctx ?? ctx)).toMatchSnapshot();
    });
  }

  it("바이트 결정론 — 전 케이스 2회 변환 동일 (D10)", () => {
    for (const c of CASES) {
      const once = JSON.stringify(anthropicAdapter.transformRequest(c.request, c.ctx ?? ctx));
      const twice = JSON.stringify(anthropicAdapter.transformRequest(c.request, c.ctx ?? ctx));
      expect(twice).toBe(once);
    }
  });
});

describeAdapterConformance(anthropicAdapter, CASES[0]!.request, ctx, {
  id: "msg_conf", model: "claude-haiku-4-5", content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
});
