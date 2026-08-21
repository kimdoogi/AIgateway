import type { JSONObject } from "../../src/ir/json.js";

// 초기 골든셋 케이스 정의 (walking-skeleton 4단계 — 저비용 녹화 전략).
// 기본 모델은 Haiku 4.5: wire 포맷은 프로바이더 내 모델 불문 동일하므로 골든셋은 품질이 아니라
// 포맷을 검증한다. 5세대 전용 wire(adaptive thinking)만 Sonnet 4.6 소량.
// 400 게이트 픽스처는 무과금이라 적극 수집한다.

export const HAIKU = "claude-haiku-4-5";
export const SONNET = "claude-sonnet-4-6";

export interface CaptureCase {
  name: string;
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
];

export function selectCases(names: readonly string[]): CaptureCase[] {
  if (names.length === 0) return CASES.filter((c) => !c.manual);
  return names.map((name) => {
    const found = CASES.find((c) => c.name === name);
    if (!found) throw new Error(`알 수 없는 케이스: ${name} (--list로 확인)`);
    return found;
  });
}
