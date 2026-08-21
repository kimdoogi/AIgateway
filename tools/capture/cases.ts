import type { JSONObject } from "../../src/ir/json.js";

// 초기 골든셋 케이스 정의 (walking-skeleton 4단계 — 저비용 녹화 전략).
// 기본 모델은 Haiku 4.5: wire 포맷은 프로바이더 내 모델 불문 동일하므로 골든셋은 품질이 아니라
// 포맷을 검증한다. 5세대 전용 wire(adaptive thinking)만 Sonnet 4.6 소량.
// 400 게이트 픽스처는 무과금이라 적극 수집한다.

export const HAIKU = "claude-haiku-4-5";
export const SONNET = "claude-sonnet-4-6";
export const OAI_CHEAP = "gpt-5.6-luna"; // GPT-5.6 저비용 (인벤토리 §H)
export const XAI_MODEL = "grok-4.6"; // 권장 모델 (인벤토리 §G — $2/$6)

const OAI_WEATHER_TOOL: JSONObject = {
  type: "function",
  name: "get_weather",
  description: "Get the current weather for a city.",
  strict: true,
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

export interface CaptureCase {
  name: string;
  /** 기본 anthropic */
  provider?: "anthropic" | "openai" | "xai";
  /** 프로바이더 기본 path 오버라이드 (openai: /v1/responses | /v1/chat/completions) */
  path?: string;
  model: string;
  body: JSONObject;
  stream?: boolean;
  /** 기대 HTTP status — 불일치는 경고만 (프로바이더가 게이트를 바꾼 신호) */
  expectStatus?: number;
  /** 일부러 잘못된 키로 호출 (401 픽스처) */
  invalidKey?: boolean;
  /** 유도 불가(429·529·절단) — 기본 실행에서 제외. 기회가 오면 이름 지정해 녹화 */
  manual?: boolean;
  headers?: Record<string, string>;
  note?: string;
}

// 1x1 PNG — 멀티모달 입력 wire 형태 검증용 (내용은 무의미)
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** xref까지 갖춘 최소 PDF 1장 — 외부 에셋 없이 결정론적으로 만든다 */
function minimalPdfBase64(): string {
  const content = "BT /F1 18 Tf 20 100 Td (Golden set fixture page) Tj ET";
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

// 캐시 최소 프리픽스(모델별 1024~2048 토큰)를 넘기기 위한 결정론적 필러
const CACHE_PREFIX = "The gateway records golden set fixtures for wire format verification. ".repeat(400);

const WEATHER_TOOL: JSONObject = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
    required: ["city"],
    additionalProperties: false,
  },
};

const SHORT = "Answer in one short sentence.";

export const CASES: CaptureCase[] = [
  {
    name: "text",
    model: HAIKU,
    body: {
      model: HAIKU,
      max_tokens: 100,
      messages: [{ role: "user", content: `What is the capital of France? ${SHORT}` }],
    },
  },
  {
    name: "text-stream",
    model: HAIKU,
    stream: true,
    body: {
      model: HAIKU,
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: `Name three primary colors. ${SHORT}` }],
    },
  },
  {
    name: "stop-max-tokens",
    model: HAIKU,
    note: "finishReason length 매핑",
    body: {
      model: HAIKU,
      max_tokens: 1,
      messages: [{ role: "user", content: "Write a long essay about the sea." }],
    },
  },
  {
    name: "tool-call",
    model: HAIKU,
    body: {
      model: HAIKU,
      max_tokens: 200,
      tools: [WEATHER_TOOL],
      messages: [{ role: "user", content: "What is the weather in Seoul? Use the tool." }],
    },
  },
  {
    name: "tool-call-parallel",
    model: HAIKU,
    note: "병렬 tool_use — 모델 재량이라 1건만 나오면 재녹화",
    body: {
      model: HAIKU,
      max_tokens: 300,
      tools: [WEATHER_TOOL],
      messages: [
        { role: "user", content: "Get the weather for Tokyo and Paris. Call the tool for both cities." },
      ],
    },
  },
  {
    name: "tool-call-stream",
    model: HAIKU,
    stream: true,
    note: "input_json_delta 누적",
    body: {
      model: HAIKU,
      max_tokens: 300,
      stream: true,
      tools: [WEATHER_TOOL],
      messages: [{ role: "user", content: "What is the weather in Busan? Use the tool." }],
    },
  },
  {
    name: "tool-result-roundtrip",
    model: HAIKU,
    note: "tool_result 입력 방향 + 후속 응답",
    body: {
      model: HAIKU,
      max_tokens: 150,
      tools: [WEATHER_TOOL],
      messages: [
        { role: "user", content: "What is the weather in Seoul?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_capture_seed01", name: "get_weather", input: { city: "Seoul" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_capture_seed01",
              content: [{ type: "text", text: "18C, clear" }],
            },
          ],
        },
      ],
    },
  },
  {
    name: "thinking",
    model: HAIKU,
    note: "budget_tokens 계열 (4.5 이하) — thinking 블록 + signature",
    body: {
      model: HAIKU,
      max_tokens: 1500,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "If 3 shirts dry in 2 hours, how long for 9 shirts? Be brief." }],
    },
  },
  {
    name: "thinking-stream",
    model: HAIKU,
    stream: true,
    note: "thinking_delta + signature_delta",
    body: {
      model: HAIKU,
      max_tokens: 1500,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "What is 17 * 23? Show brief reasoning." }],
    },
  },
  {
    name: "thinking-interleaved",
    model: HAIKU,
    headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
    note: "thinking과 tool_use 교차",
    body: {
      model: HAIKU,
      max_tokens: 1500,
      thinking: { type: "enabled", budget_tokens: 1024 },
      tools: [WEATHER_TOOL],
      messages: [{ role: "user", content: "Decide whether Seoul needs an umbrella today; use the tool first." }],
    },
  },
  {
    name: "thinking-adaptive",
    model: SONNET,
    note: "5세대 전용 wire — adaptive thinking + output_config.effort",
    body: {
      model: SONNET,
      max_tokens: 1200,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "A bat and a ball cost $1.10 total. The bat costs $1.00 more than the ball. What does the ball cost? Think carefully." }],
    },
  },
  {
    name: "thinking-adaptive-stream",
    model: SONNET,
    stream: true,
    body: {
      model: SONNET,
      max_tokens: 1200,
      stream: true,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "If all Bloops are Razzies and some Razzies are Lazzies, must some Bloops be Lazzies? Reason it out." }],
    },
  },
  {
    name: "cache-write",
    model: HAIKU,
    note: "cache_creation_input_tokens — cache-read와 동일 프리픽스",
    body: {
      model: HAIKU,
      max_tokens: 100,
      system: [{ type: "text", text: CACHE_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `What does the gateway record? ${SHORT}` }],
    },
  },
  {
    name: "cache-read",
    model: HAIKU,
    note: "cache-write 직후 실행해야 hit — cache_read_input_tokens 0이면 재녹화",
    body: {
      model: HAIKU,
      max_tokens: 100,
      system: [{ type: "text", text: CACHE_PREFIX, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `What is verified by fixtures? ${SHORT}` }],
    },
  },
  {
    name: "multimodal-image",
    model: HAIKU,
    body: {
      model: HAIKU,
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } },
            { type: "text", text: `Describe this image. ${SHORT}` },
          ],
        },
      ],
    },
  },
  {
    name: "multimodal-pdf",
    model: HAIKU,
    body: {
      model: HAIKU,
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: minimalPdfBase64() },
            },
            { type: "text", text: `What text is on this page? ${SHORT}` },
          ],
        },
      ],
    },
  },
  {
    name: "citations",
    model: HAIKU,
    note: "citations_delta·char_location 매핑 (텍스트 문서 — PDF보다 저렴)",
    body: {
      model: HAIKU,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "The gateway converts N inbound formats and M providers through one IR hub. The IR hub is versioned as v0. Fixtures are recorded with Haiku 4.5.",
              },
              title: "IR overview",
              citations: { enabled: true },
            },
            { type: "text", text: "Which model records fixtures? Cite the document." },
          ],
        },
      ],
    },
  },
  {
    name: "citations-stream",
    model: HAIKU,
    stream: true,
    body: {
      model: HAIKU,
      max_tokens: 300,
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "text",
                media_type: "text/plain",
                data: "The IR hub is versioned as v0. Golden set fixtures verify wire formats, not answer quality.",
              },
              title: "IR overview",
              citations: { enabled: true },
            },
            { type: "text", text: "What do golden set fixtures verify? Cite the document." },
          ],
        },
      ],
    },
  },

  // ── 무과금 게이트/에러 픽스처 ──────────────────────────────
  {
    name: "error-400-effort-gate",
    model: HAIKU,
    expectStatus: 400,
    note: "Haiku 4.5는 output_config.effort 미지원 — 모델 게이트 픽스처",
    body: {
      model: HAIKU,
      max_tokens: 50,
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    name: "error-400-adaptive-gate",
    model: HAIKU,
    expectStatus: 400,
    note: "adaptive thinking은 4.6+ 전용",
    body: {
      model: HAIKU,
      max_tokens: 50,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    name: "error-400-missing-max-tokens",
    model: HAIKU,
    expectStatus: 400,
    body: { model: HAIKU, messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "error-400-budget-exceeds-max",
    model: HAIKU,
    expectStatus: 400,
    note: "budget_tokens >= max_tokens",
    body: {
      model: HAIKU,
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    name: "error-404-unknown-model",
    model: "claude-does-not-exist",
    expectStatus: 404,
    body: {
      model: "claude-does-not-exist",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    },
  },
  {
    name: "error-401-invalid-key",
    model: HAIKU,
    invalidKey: true,
    expectStatus: 401,
    body: { model: HAIKU, max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
  },

  // ── 유도 불가: 기회 채집 (기본 실행에서 제외) ───────────────
  {
    name: "error-429-rate-limit",
    model: HAIKU,
    manual: true,
    expectStatus: 429,
    note: "레이트리밋을 만났을 때만 녹화 — rate vs quota 구분 근거",
    body: { model: HAIKU, max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "error-529-overloaded",
    model: HAIKU,
    manual: true,
    expectStatus: 529,
    body: { model: HAIKU, max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "stream-in-flight-error",
    model: HAIKU,
    manual: true,
    stream: true,
    note: "in-stream overloaded/절단 — 만났을 때만",
    body: {
      model: HAIKU,
      max_tokens: 2000,
      stream: true,
      messages: [{ role: "user", content: "Write a long story about the sea." }],
    },
  },

  // ══ OpenAI (로드맵 4) — Responses 주 표면 + CC 보조 (ADR-0002) ══════════
  // 저비용 모델(gpt-5.6-luna)로 wire 포맷 검증. store:false 강제 재현 (게이트웨이와 동일 body).

  {
    name: "oai-text",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `What is the capital of France? ${SHORT}` }] }],
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 100,
    },
  },
  {
    name: "oai-text-stream",
    provider: "openai",
    model: OAI_CHEAP,
    stream: true,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Count from 1 to 5. ${SHORT}` }] }],
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 200,
      stream: true,
    },
  },
  {
    name: "oai-system",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      instructions: "You are a pirate. Answer in pirate speak.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Say hello. ${SHORT}` }] }],
      store: false,
      max_output_tokens: 100,
    },
  },
  {
    name: "oai-tool-call",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather in Paris?" }] }],
      tools: [OAI_WEATHER_TOOL],
      tool_choice: "required",
      store: false,
      max_output_tokens: 500,
    },
  },
  {
    name: "oai-tool-call-stream",
    provider: "openai",
    model: OAI_CHEAP,
    stream: true,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather in Tokyo and Seoul?" }] }],
      tools: [OAI_WEATHER_TOOL],
      tool_choice: "required",
      store: false,
      max_output_tokens: 800,
      stream: true,
    },
  },
  {
    name: "oai-tool-result-roundtrip",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "What's the weather in Paris?" }] },
        { type: "function_call", call_id: "call_fixture0001", name: "get_weather", arguments: '{"city":"Paris"}' },
        { type: "function_call_output", call_id: "call_fixture0001", output: '{"temp_c":21,"sky":"clear"}' },
      ],
      tools: [OAI_WEATHER_TOOL],
      store: false,
      max_output_tokens: 150,
    },
  },
  {
    name: "oai-reasoning",
    provider: "openai",
    model: OAI_CHEAP,
    note: "encrypted_content 왕복 페이로드 확보 (opaqueState 검증)",
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Is 91 prime? Think it through." }] }],
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 2000,
    },
  },
  {
    name: "oai-reasoning-stream",
    provider: "openai",
    model: OAI_CHEAP,
    stream: true,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Is 133 prime? Think it through." }] }],
      reasoning: { effort: "low", summary: "auto" },
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 2000,
      stream: true,
    },
  },
  {
    name: "oai-json-schema",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Extract: 'Alice is 30 years old.'" }] }],
      text: {
        format: {
          type: "json_schema",
          name: "person",
          strict: true,
          schema: {
            type: "object",
            properties: { name: { type: "string" }, age: { type: "integer" } },
            required: ["name", "age"],
            additionalProperties: false,
          },
        },
      },
      store: false,
      max_output_tokens: 200,
    },
  },
  {
    name: "oai-multimodal-image",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: `What color is this image? ${SHORT}` },
            { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
          ],
        },
      ],
      store: false,
      max_output_tokens: 100,
    },
  },
  {
    name: "oai-pdf",
    provider: "openai",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: `What does the PDF say? ${SHORT}` },
            { type: "input_file", filename: "fixture.pdf", file_data: `data:application/pdf;base64,${minimalPdfBase64()}` },
          ],
        },
      ],
      store: false,
      max_output_tokens: 150,
    },
  },
  {
    name: "oai-web-search",
    provider: "openai",
    model: OAI_CHEAP,
    note: "서버 툴 item wire 확보 (web_search_call) — 소액 추가 과금",
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is the current UTC date? Use web search." }] }],
      tools: [{ type: "web_search" }],
      store: false,
      max_output_tokens: 600,
    },
  },
  // ── 무과금 게이트 (400/404/401) ──
  {
    name: "oai-gate-sampling-reasoning",
    provider: "openai",
    model: OAI_CHEAP,
    expectStatus: 400,
    note: "reasoning 모델의 temperature 거부 — unsupportedParams 게이트 근거 실증",
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      temperature: 0.5,
      store: false,
      max_output_tokens: 50,
    },
  },
  {
    name: "oai-gate-bad-schema",
    provider: "openai",
    model: OAI_CHEAP,
    expectStatus: 400,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      text: { format: { type: "json_schema", name: "bad", strict: true, schema: { type: "object", properties: { x: { allOf: [] } } } } },
      store: false,
      max_output_tokens: 50,
    },
  },
  {
    name: "oai-gate-unknown-model",
    provider: "openai",
    model: "gpt-nonexistent-model",
    expectStatus: 400, // Responses는 미지 모델을 404가 아닌 400으로 (2026-08-21 실측)
    body: {
      model: "gpt-nonexistent-model",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      store: false,
    },
  },
  {
    name: "oai-gate-401",
    provider: "openai",
    model: OAI_CHEAP,
    expectStatus: 401,
    invalidKey: true,
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      store: false,
    },
  },
  {
    name: "oai-gate-pro-on-cc",
    provider: "openai",
    path: "/v1/chat/completions",
    model: "gpt-5-pro",
    expectStatus: 404,
    note: "Responses 전용 모델의 CC 호출 404 — surfaces capability 근거 실증 (ADR-0002)",
    body: { model: "gpt-5-pro", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 50 },
  },
  // ── Chat Completions 보조 표면 ──
  {
    name: "oai-cc-text",
    provider: "openai",
    path: "/v1/chat/completions",
    model: OAI_CHEAP,
    body: {
      model: OAI_CHEAP,
      messages: [{ role: "user", content: `What is the capital of Japan? ${SHORT}` }],
      max_completion_tokens: 100,
    },
  },
  {
    name: "oai-cc-stream",
    provider: "openai",
    path: "/v1/chat/completions",
    model: OAI_CHEAP,
    stream: true,
    body: {
      model: OAI_CHEAP,
      messages: [{ role: "user", content: `Count from 1 to 5. ${SHORT}` }],
      max_completion_tokens: 200,
      stream: true,
      stream_options: { include_usage: true },
    },
  },
  {
    name: "oai-cc-tool-call",
    provider: "openai",
    path: "/v1/chat/completions",
    model: OAI_CHEAP,
    note: "GPT-5.6 CC 함수 툴은 reasoning_effort none 필수 (2026-08-21 실측 400)",
    body: {
      model: OAI_CHEAP,
      reasoning_effort: "none",
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } } }],
      tool_choice: "required",
      max_completion_tokens: 500,
    },
  },
  {
    name: "oai-cc-tool-call-stream",
    provider: "openai",
    path: "/v1/chat/completions",
    model: OAI_CHEAP,
    stream: true,
    body: {
      model: OAI_CHEAP,
      reasoning_effort: "none",
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } } }],
      tool_choice: "required",
      max_completion_tokens: 500,
      stream: true,
      stream_options: { include_usage: true },
    },
  },
  // ── manual (기회 채집) ──
  {
    name: "oai-429",
    provider: "openai",
    model: OAI_CHEAP,
    manual: true,
    expectStatus: 429,
    body: { model: OAI_CHEAP, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], store: false },
  },
  {
    name: "oai-stream-truncation",
    provider: "openai",
    model: OAI_CHEAP,
    manual: true,
    stream: true,
    note: "response.completed 없는 절단 — 만났을 때만",
    body: {
      model: OAI_CHEAP,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Write a long story about the sea." }] }],
      store: false,
      max_output_tokens: 2000,
      stream: true,
    },
  },

  // ══ xAI (로드맵 5) — CC 주 표면 + responses(에이전트 툴·encrypted reasoning) (ADR-0004) ══

  {
    name: "xai-text",
    provider: "xai",
    model: XAI_MODEL,
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: `What is the capital of France? ${SHORT}` }],
      max_completion_tokens: 2000,
    },
  },
  {
    name: "xai-text-stream",
    provider: "xai",
    model: XAI_MODEL,
    stream: true,
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: `Count from 1 to 5. ${SHORT}` }],
      max_completion_tokens: 2000,
      stream: true,
      stream_options: { include_usage: true },
    },
  },
  {
    name: "xai-reasoning",
    provider: "xai",
    model: XAI_MODEL,
    note: "reasoning_content 필드 wire 확보 (B2-6)",
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "Is 91 prime? Think it through, then answer in one word." }],
      reasoning_effort: "low",
      max_completion_tokens: 4000,
    },
  },
  {
    name: "xai-reasoning-stream",
    provider: "xai",
    model: XAI_MODEL,
    stream: true,
    note: "delta.reasoning_content 스트림 확보",
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "Is 133 prime? Think it through, then answer in one word." }],
      reasoning_effort: "low",
      max_completion_tokens: 4000,
      stream: true,
      stream_options: { include_usage: true },
    },
  },
  {
    name: "xai-tool-call",
    provider: "xai",
    model: XAI_MODEL,
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } } }],
      tool_choice: "required",
      max_completion_tokens: 4000,
    },
  },
  {
    name: "xai-tool-call-stream",
    provider: "xai",
    model: XAI_MODEL,
    stream: true,
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false } } }],
      tool_choice: "required",
      max_completion_tokens: 4000,
      stream: true,
      stream_options: { include_usage: true },
    },
  },
  {
    name: "xai-responses-text",
    provider: "xai",
    path: "/v1/responses",
    model: XAI_MODEL,
    note: "responses 표면 + encrypted reasoning 왕복 페이로드",
    body: {
      model: XAI_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Is 97 prime? One word." }] }],
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 4000,
    },
  },
  {
    name: "xai-responses-web-search",
    provider: "xai",
    path: "/v1/responses",
    model: XAI_MODEL,
    note: "서버측 에이전트 툴 wire 확보 — 툴 호출 횟수 추가 과금 소액",
    body: {
      model: XAI_MODEL,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "What is the current UTC date? Use web search." }] }],
      tools: [{ type: "web_search" }],
      store: false,
      max_output_tokens: 4000,
    },
  },
  // ── 무과금 게이트 ──
  {
    name: "xai-gate-unsupported-param",
    provider: "xai",
    model: XAI_MODEL,
    expectStatus: 400,
    note: "미지원 파라미터 400 거부 실증 (B2-7 — strip 필요 근거)",
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "hi" }],
      store: true,
      max_completion_tokens: 100,
    },
  },
  {
    name: "xai-gate-penalty-reasoning",
    provider: "xai",
    model: XAI_MODEL,
    expectStatus: 400,
    note: "reasoning 모델 + presence_penalty 400 실증 (B2-3)",
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "hi" }],
      presence_penalty: 0.5,
      max_completion_tokens: 100,
    },
  },
  {
    name: "xai-gate-invalid-key",
    provider: "xai",
    model: XAI_MODEL,
    invalidKey: true,
    note: "인증 오류 상태코드 실측 (문서 401 vs 실측 400 — B2-2)",
    body: { model: XAI_MODEL, messages: [{ role: "user", content: "hi" }], max_completion_tokens: 50 },
  },
  {
    name: "xai-gate-live-search-410",
    provider: "xai",
    model: XAI_MODEL,
    expectStatus: 410,
    note: "폐기 Live Search 410 실증 (B2-18)",
    body: {
      model: XAI_MODEL,
      messages: [{ role: "user", content: "hi" }],
      search_parameters: { mode: "auto" },
      max_completion_tokens: 50,
    },
  },
];

export function selectCases(names: readonly string[]): CaptureCase[] {
  if (names.length === 0) return CASES.filter((c) => !c.manual);
  return names.map((name) => {
    const found = CASES.find((c) => c.name === name);
    if (!found) throw new Error(`알 수 없는 케이스: ${name} (--list로 확인)`);
    return found;
  });
}
