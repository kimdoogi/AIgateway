import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../../ir/index.js";
import type { RequestContext } from "../types.js";
import { openaiChatAdapter, openaiResponsesAdapter } from "./index.js";
import { describeAdapterConformance } from "../adapter-conformance.js";

// 골든셋 ① — IR 입력 → OpenAI wire body 스냅샷 (D9). 케이스는 캡처 하네스 oai-* 세트와 짝.
// Responses(주) + Chat Completions(보조) 양 표면. 스냅샷 갱신은 의도된 wire 변경일 때만.

const ctx: RequestContext = { requestId: "req_golden", modelId: "gpt-5.6-luna" };

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({ version: "0", model: "gpt-5.6-luna", ...input });
}

const user = (text: string) => ({ role: "user", blocks: [{ type: "text", text }] });

const WEATHER_TOOL = {
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
} as const;

const RESPONSES_CASES: Array<{ name: string; request: IRRequest; ctx?: RequestContext }> = [
  {
    name: "text-minimal — store:false 강제 + encrypted_content include",
    request: ir({ messages: [user("hi")] }),
  },
  {
    name: "system — 선두 system은 instructions, 중간 system은 input item",
    request: ir({
      messages: [
        { role: "system", blocks: [{ type: "text", text: "Be brief." }] },
        user("hi"),
        { role: "system", blocks: [{ type: "text", text: "Now be verbose." }] },
        user("more"),
      ],
    }),
  },
  {
    name: "sampling — Responses 미지원(topK/seed/penalties/stop)은 드롭 + warning",
    request: ir({
      messages: [user("hi")],
      maxOutputTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      seed: 42,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ["END"],
    }),
  },
  {
    name: "capability-gate — reasoning 모델은 temperature/topP 드롭 (레지스트리 공급)",
    request: ir({ messages: [user("hi")], temperature: 0.7, topP: 0.5, maxOutputTokens: 50 }),
    ctx: { ...ctx, capabilities: { unsupportedParams: ["temperature", "topP"] } },
  },
  {
    name: "tools — function + 지정 toolChoice + 병렬 off",
    request: ir({
      messages: [user("weather?")],
      tools: [WEATHER_TOOL],
      toolChoice: { type: "tool", toolName: "get_weather" },
      parallelToolCalls: false,
    }),
  },
  {
    name: "provider-tool — openai.web_search",
    request: ir({
      messages: [user("news?")],
      tools: [{ type: "provider", id: "openai.web_search", args: {} }],
    }),
  },
  {
    name: "tool-roundtrip — toolCall(item 보존)·toolResult 재전송",
    request: ir({
      messages: [
        user("weather in Paris?"),
        {
          role: "assistant",
          origin: { provider: "openai", model: "gpt-5.6-luna", surface: "responses" },
          blocks: [
            {
              type: "toolCall",
              toolCallId: "call_fixture0001",
              toolName: "get_weather",
              input: { type: "json", value: { city: "Paris" } },
              origin: { provider: "openai", model: "gpt-5.6-luna", surface: "responses" },
              providerOptions: {
                openai: {
                  item: { type: "function_call", id: "fc_fixture0001", call_id: "call_fixture0001", name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              },
            },
          ],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: "call_fixture0001",
              toolName: "get_weather",
              output: { type: "json", value: { temp_c: 21 } },
            },
          ],
        },
      ],
      tools: [WEATHER_TOOL],
    }),
  },
  {
    name: "reasoning-roundtrip — item 원문 우선 복원 (§4.2 무손실)",
    request: ir({
      messages: [
        user("Is 91 prime?"),
        {
          role: "assistant",
          origin: { provider: "openai", model: "gpt-5.6-luna", surface: "responses" },
          blocks: [
            {
              type: "reasoning",
              text: "91 = 7 × 13.",
              opaqueState: { provider: "openai", data: "ENCRYPTED_FIXTURE" },
              providerOptions: {
                openai: {
                  item: {
                    type: "reasoning",
                    id: "rs_fixture0001",
                    summary: [{ type: "summary_text", text: "91 = 7 × 13." }],
                    encrypted_content: "ENCRYPTED_FIXTURE",
                  },
                },
              },
            },
            { type: "text", text: "No, 91 = 7 × 13." },
          ],
        },
        user("and 97?"),
      ],
      reasoning: { effort: "low" },
    }),
  },
  {
    name: "reasoning-foreign — 외래(anthropic) reasoning은 retarget 정책 (기본 drop)",
    request: ir({
      messages: [
        user("hi"),
        {
          role: "assistant",
          origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
          blocks: [
            { type: "reasoning", text: "thinking...", opaqueState: { provider: "anthropic", data: "SIG" } },
            { type: "text", text: "hello" },
          ],
        },
        user("again"),
      ],
    }),
  },
  {
    name: "json-schema — text.format + strict",
    request: ir({
      messages: [user("extract")],
      responseFormat: {
        type: "json",
        name: "person",
        strict: true,
        schema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    }),
  },
  {
    name: "multimodal — 이미지(base64)·PDF(file_data)",
    request: ir({
      messages: [
        {
          role: "user",
          blocks: [
            { type: "text", text: "look" },
            { type: "file", mediaType: "image/png", data: { type: "base64", data: "AAAA" } },
            { type: "file", mediaType: "application/pdf", filename: "doc.pdf", data: { type: "base64", data: "BBBB" } },
          ],
        },
      ],
    }),
  },
  {
    name: "po-full — 서버상태 opt-in(override warning)·reasoning 옵션·serviceTier",
    request: ir({
      messages: [user("hi")],
      reasoning: { effort: "high" },
      providerOptions: {
        openai: {
          store: true,
          previousResponseId: "resp_fixture0001",
          reasoning: { summary: "auto", context: "all_turns" },
          textVerbosity: "low",
          serviceTier: "flex",
          promptCacheKey: "tenant-1",
        },
      },
    }),
  },
  {
    name: "effort-clamp — supportedEfforts 밖 값은 최근접 클램프",
    request: ir({ messages: [user("hi")], reasoning: { effort: "minimal" } }),
    ctx: { ...ctx, capabilities: { supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"] } },
  },
  {
    name: "metadata — userId → safety_identifier, 문자열 키만 metadata",
    request: ir({ messages: [user("hi")], metadata: { userId: "u1", tenant: "t1", n: 3 } }),
  },
  {
    name: "stream — stream:true",
    request: ir({ messages: [user("hi")], stream: true }),
  },
];

const CHAT_CASES: Array<{ name: string; request: IRRequest }> = [
  {
    name: "cc-text — CC 전용 파라미터(seed/penalties/stop) 통과",
    request: ir({
      messages: [{ role: "system", blocks: [{ type: "text", text: "Be brief." }] }, user("hi")],
      maxOutputTokens: 100,
      temperature: 0.5,
      seed: 42,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ["END"],
    }),
  },
  {
    name: "cc-tools — function 툴 + toolChoice + 툴콜 왕복",
    request: ir({
      messages: [
        user("weather?"),
        {
          role: "assistant",
          blocks: [
            { type: "toolCall", toolCallId: "call_f1", toolName: "get_weather", input: { type: "json", value: { city: "Paris" } } },
          ],
        },
        { role: "tool", blocks: [{ type: "toolResult", toolCallId: "call_f1", toolName: "get_weather", output: { type: "text", text: "21C" } }] },
      ],
      tools: [WEATHER_TOOL],
      toolChoice: "auto",
    }),
  },
  {
    name: "cc-reasoning-drop — reasoning 블록은 CC 왕복 불가 (드롭 + warning)",
    request: ir({
      messages: [
        user("hi"),
        {
          role: "assistant",
          blocks: [
            { type: "reasoning", text: "hmm", opaqueState: { provider: "openai", data: "ENC" } },
            { type: "text", text: "hello" },
          ],
        },
        user("again"),
      ],
      seed: 1,
    }),
  },
  {
    name: "cc-audio — 오디오 입력(input_audio) + PO audio/modalities",
    request: ir({
      messages: [
        {
          role: "user",
          blocks: [
            { type: "text", text: "transcribe" },
            { type: "file", mediaType: "audio/wav", data: { type: "base64", data: "AAAA" } },
          ],
        },
      ],
      providerOptions: { openai: { modalities: ["text", "audio"], audio: { voice: "alloy", format: "wav" } } },
    }),
  },
  {
    name: "cc-stream — stream_options.include_usage 자동",
    request: ir({ messages: [user("hi")], stream: true, seed: 7 }),
  },
];

describe("골든셋 ① IR → openai responses wire", () => {
  for (const c of RESPONSES_CASES) {
    it(c.name, () => {
      const result = openaiResponsesAdapter.transformRequest(c.request, c.ctx ?? ctx);
      expect(result).toMatchSnapshot();
    });
  }
});

describe("골든셋 ① IR → openai chat-completions wire", () => {
  for (const c of CHAT_CASES) {
    it(c.name, () => {
      const result = openaiChatAdapter.transformRequest(c.request, ctx);
      expect(result).toMatchSnapshot();
    });
  }
});

describeAdapterConformance(openaiResponsesAdapter, RESPONSES_CASES[0]!.request, ctx, {
  id: "resp_conf",
  model: "gpt-5.6-luna",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_conf", summary: [], encrypted_content: "ENC" },
    { type: "message", id: "msg_conf", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
});

describeAdapterConformance(openaiChatAdapter, CHAT_CASES[0]!.request, ctx, {
  id: "chatcmpl_conf",
  model: "gpt-5.6-luna",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
