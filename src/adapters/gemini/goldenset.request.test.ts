import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../../ir/index.js";
import type { RequestContext } from "../types.js";
import { geminiAdapter } from "./index.js";
import { describeAdapterConformance } from "../adapter-conformance.js";

// 골든셋 ① — IR 입력 → Gemini generateContent wire 스냅샷 (D9). 케이스는 캡처 하네스 세트와 짝.
// 스냅샷 갱신은 의도된 wire 변경일 때만 (`vitest -u`) — diff가 곧 리뷰 대상.

const MODEL = "gemini-3.7-flash";
const ctx: RequestContext = {
  requestId: "req_golden",
  modelId: MODEL,
  capabilities: { supportedEfforts: ["minimal", "low", "medium", "high"] },
};

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({ version: "0", model: MODEL, ...input });
}

const user = (text: string) => ({ role: "user", blocks: [{ type: "text", text }] });

const WEATHER_TOOL = {
  type: "function" as const,
  name: "get_weather",
  description: "Get weather.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

const CASES: Array<{ name: string; request: IRRequest; ctx?: RequestContext }> = [
  {
    name: "text-minimal — 스트림 아님 = generateContent 경로",
    request: ir({ messages: [user("hi")] }),
  },
  {
    name: "text-stream — :streamGenerateContent?alt=sse 경로 강제 (ADR-0003 §2)",
    request: ir({ messages: [user("hi")], stream: true, maxOutputTokens: 100 }),
  },
  {
    name: "sampling-full — 표준 파라미터 전부 지원 (드롭 없음, 인벤토리 B-2)",
    request: ir({
      messages: [user("hi")],
      maxOutputTokens: 100,
      temperature: 1.0,
      topP: 0.9,
      topK: 40,
      stopSequences: ["END"],
      seed: 42,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
    }),
  },
  {
    name: "system — 선두 system → systemInstruction, 중간 system → user 변환 + warning (D6-4)",
    request: ir({
      messages: [
        { role: "system", blocks: [{ type: "text", text: "You are terse." }] },
        user("hi"),
        { role: "assistant", blocks: [{ type: "text", text: "ok" }] },
        { role: "system", blocks: [{ type: "text", text: "Now be verbose." }] },
        user("continue"),
      ],
      maxOutputTokens: 100,
    }),
  },
  {
    name: "tools — 함수 툴(parametersJsonSchema 경로) + 지정 toolChoice + 병렬 off 드롭",
    request: ir({
      messages: [user("weather?")],
      maxOutputTokens: 200,
      tools: [{ ...WEATHER_TOOL, strict: true }],
      toolChoice: { type: "tool", toolName: "get_weather" },
      parallelToolCalls: false,
    }),
  },
  {
    name: "provider-tool — google.google_search (wire 멤버 키 변환)",
    request: ir({
      messages: [user("search")],
      maxOutputTokens: 300,
      tools: [{ type: "provider", id: "google.google_search" }],
    }),
  },
  {
    name: "reasoning-effort — thinkingLevel 매핑 + includeThoughts",
    request: ir({ messages: [user("why?")], maxOutputTokens: 1500, reasoning: { effort: "low" } }),
  },
  {
    name: "reasoning-clamp — xhigh는 최근접 high로 클램프 + warning (§6.3)",
    request: ir({ messages: [user("why?")], maxOutputTokens: 1500, reasoning: { effort: "xhigh" } }),
  },
  {
    name: "reasoning-po-conflict — PO thinkingConfig 우선 + provider-option-override (§2)",
    request: ir({
      messages: [user("why?")],
      maxOutputTokens: 1500,
      reasoning: { effort: "high" },
      providerOptions: { google: { thinkingConfig: { thinkingBudget: 2048 } } },
    }),
  },
  {
    name: "json-schema — responseMimeType + responseJsonSchema (raw 통과)",
    request: ir({
      messages: [user("profile")],
      maxOutputTokens: 500,
      responseFormat: {
        type: "json",
        schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        name: "profile",
        strict: true,
      },
    }),
  },
  {
    name: "multimodal — base64 이미지 → inlineData",
    request: ir({
      messages: [
        {
          role: "user",
          blocks: [
            { type: "text", text: "What is this?" },
            { type: "file", mediaType: "image/png", data: { type: "base64", data: "aGk=" } },
          ],
        },
      ],
      maxOutputTokens: 200,
    }),
  },
  {
    name: "history-roundtrip — thought part 원문 복원 + functionCall 서명 보존 (C-2)",
    request: ir({
      messages: [
        user("weather in Paris?"),
        {
          role: "assistant",
          blocks: [
            {
              type: "reasoning",
              text: "User wants weather.",
              opaqueState: { provider: "google", data: "c2lnLXRob3VnaHQ=" },
              origin: { provider: "google", model: MODEL, surface: "generate-content" },
            },
            {
              type: "toolCall",
              toolCallId: "synth:google:resp1:1:get_weather",
              toolName: "get_weather",
              input: { type: "json", value: { city: "Paris" } },
              opaqueState: { provider: "google", data: "c2lnLWZj" },
              origin: { provider: "google", model: MODEL, surface: "generate-content" },
            },
          ],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: "synth:google:resp1:1:get_weather",
              toolName: "get_weather",
              output: { type: "json", value: { temp: 21, unit: "C" } },
            },
          ],
        },
      ],
      tools: [WEATHER_TOOL],
      maxOutputTokens: 300,
    }),
  },
  {
    name: "dummy-signature — 서명 없는 크로스 히스토리 functionCall에 더미 삽입 (D6-9)",
    request: ir({
      messages: [
        user("weather in Paris?"),
        {
          role: "assistant",
          blocks: [
            {
              type: "toolCall",
              toolCallId: "call_openai_123",
              toolName: "get_weather",
              input: { type: "json", value: { city: "Paris" } },
              origin: { provider: "openai", model: "gpt-5.6-luna", surface: "responses" },
            },
          ],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: "call_openai_123",
              toolName: "get_weather",
              output: { type: "text", text: "21C, sunny" },
            },
          ],
        },
      ],
      tools: [WEATHER_TOOL],
      maxOutputTokens: 300,
    }),
  },
  {
    name: "foreign-reasoning-demote — 외래 reasoning은 retarget 정책 적용 (D6-2)",
    request: ir({
      messages: [
        user("hi"),
        {
          role: "assistant",
          blocks: [
            {
              type: "reasoning",
              text: "prior thoughts",
              origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
            },
            { type: "text", text: "hello" },
          ],
        },
        user("again"),
      ],
      retarget: { reasoning: "demote-to-text" },
      maxOutputTokens: 100,
    }),
  },
  {
    name: "po-known-keys — safetySettings·cachedContent·serviceTier·store",
    request: ir({
      messages: [user("hi")],
      maxOutputTokens: 100,
      providerOptions: {
        google: {
          safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" }],
          cachedContent: "cachedContents/fixture-cache",
          serviceTier: "STANDARD",
          store: false,
        },
      },
    }),
  },
  {
    name: "metadata-drop — gemini 대응 필드 없음 (userId 포함 전부 드롭 + warning)",
    request: ir({ messages: [user("hi")], maxOutputTokens: 100, metadata: { userId: "u-1", team: "x" } }),
  },
];

describe("골든셋 ① IR → gemini generateContent wire", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(geminiAdapter.transformRequest(c.request, c.ctx ?? ctx)).toMatchSnapshot();
    });
  }

  it("2.5 세대(supportedEfforts 빈 집합)는 effort 드롭 + warning", () => {
    const t = geminiAdapter.transformRequest(ir({ messages: [user("why?")], maxOutputTokens: 100, reasoning: { effort: "low" } }), {
      requestId: "req_golden",
      modelId: "gemini-2.5-flash",
      capabilities: { supportedEfforts: [] },
    });
    expect((t.request.body["generationConfig"] as Record<string, unknown>)?.["thinkingConfig"]).toBeUndefined();
    expect(t.warnings.some((w) => w.code === "parameter-dropped" && w.path === "reasoning.effort")).toBe(true);
  });
});

describeAdapterConformance(
  geminiAdapter,
  ir({ messages: [user("conformance")], maxOutputTokens: 100 }),
  ctx,
  {
    responseId: "resp-conf",
    modelVersion: MODEL,
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  },
);
