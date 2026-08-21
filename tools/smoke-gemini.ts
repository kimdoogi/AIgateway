// Gemini(로드맵 5) 실 E2E 스모크 (opt-in — 실 API 과금 소액). 실행: pnpm smoke:gemini
// 검증 대상 (ADR-0003): generateContent 표면 + alt=sse 스트림 + thinking 블록 수신 +
// **툴콜 thoughtSignature 왕복**(Gemini 3 검증 실통과 — MISSING_THOUGHT_SIGNATURE 방어) +
// 크로스 프로바이더 히스토리(목표 2) + compat 인바운드.
import { loadDotenv } from "../src/env.js";
import { bootstrapProviders } from "../src/gateway/bootstrap.js";
import { createApp } from "../src/server/app.js";
import { parseSSEText } from "../src/stream/sse.js";

loadDotenv();
bootstrapProviders();
const app = createApp();

const GEMINI_MODEL = "gemini-3.7-flash";

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

// ── 1. Gemini 비스트림 (native — generateContent 단일 표면) ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 500,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Say OK and nothing else." }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `gemini 비스트림 200 (실제 ${res.status})`);
  assert(body.model.resolved.provider === "google" && body.model.resolved.surface === "generate-content", "resolved google/generate-content");
  assert(body.message.blocks.some((b: any) => b.type === "text"), "text 블록 존재");
  assert(body.message.origin.surface === "generate-content", "origin.surface 채워짐");
  assert(body.usage.totalTokens > 0, `usage ${body.usage.totalTokens}토큰`);
}

// ── 2. Gemini 스트림 완주 (?alt=sse 강제 경로 — ADR-0003 §2) ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 500,
    stream: true,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Count 1 to 3." }] }],
  });
  const frames = parseSSEText(await res.text());
  const types = frames.map((f) => f.event);
  assert(res.status === 200, "gemini 스트림 200");
  assert(types[0] === "stream-start" && types.includes("response-metadata"), "수명주기 이벤트");
  assert(types.includes("text-delta"), "text-delta 수신");
  assert(types.at(-1) === "finish", `터미널 finish (실제 ${types.at(-1)})`);
  const seqs = frames.map((f) => Number(f.id));
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), "seq 단조 증가");
}

// ── 3. thinking — reasoning.effort → thinkingLevel + thought summary 수신 ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 4000,
    reasoning: { effort: "low" },
    messages: [{ role: "user", blocks: [{ type: "text", text: "Is 91 prime? Think it through, then answer in one word." }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `thinking 200 (실제 ${res.status})`);
  assert(body.message.blocks.some((b: any) => b.type === "reasoning"), "reasoning 블록 수신 (thought summary)");
  assert(body.usage.output.reasoning > 0, `thoughts 토큰 분리 집계 (${body.usage.output.reasoning})`);
}

// ── 4. 툴콜 서명 왕복 (핵심 — Gemini 3 thoughtSignature 검증 실통과) ──
{
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "Get the current weather for a city.",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  ];
  const ask = { role: "user", blocks: [{ type: "text", text: "What's the weather in Paris?" }] };
  const first = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 4000,
    tools,
    toolChoice: "required",
    messages: [ask],
  });
  const firstBody = (await first.json()) as Record<string, any>;
  assert(first.status === 200, `툴콜 1턴 200 (실제 ${first.status})`);
  const toolCall = firstBody.message.blocks.find((b: any) => b.type === "toolCall");
  assert(toolCall !== undefined, "functionCall → toolCall 블록");
  assert(firstBody.finishReason.unified === "tool_call", `STOP→tool_call 승격 (raw ${firstBody.finishReason.raw})`);
  const signed = firstBody.message.blocks.some((b: any) => b.opaqueState?.provider === "google");
  assert(signed, "실서명 수신 (opaqueState.provider=google) — 더미 경로가 아닌 실검증"); // 리뷰: 로그만으론 회귀 은폐
  const history = { role: "assistant", blocks: firstBody.message.blocks, origin: firstBody.message.origin };
  const second = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 4000,
    tools,
    messages: [
      ask,
      history,
      {
        role: "tool",
        blocks: [
          {
            type: "toolResult",
            toolCallId: toolCall.toolCallId,
            toolName: "get_weather",
            output: { type: "json", value: { temp_c: 21, condition: "sunny" } },
          },
        ],
      },
    ],
  });
  const secondBody = (await second.json()) as Record<string, any>;
  assert(second.status === 200, `서명 왕복 2턴 200 — MISSING_THOUGHT_SIGNATURE 없음 (실제 ${second.status})`);
  assert(secondBody.message.blocks.some((b: any) => b.type === "text"), "툴 결과 반영 텍스트 응답");
}

// ── 5. 크로스 프로바이더 대화 (목표 2 — google 방향 첫 실증): claude 턴 → 히스토리 → gemini 턴 ──
{
  const pick = { role: "user", blocks: [{ type: "text", text: "Pick a number between 1 and 10. Reply with just the number." }] };
  const first = await post("/v0/responses", {
    version: "0",
    model: "claude-haiku-4-5",
    maxOutputTokens: 100,
    messages: [pick],
  });
  const firstBody = (await first.json()) as Record<string, any>;
  assert(first.status === 200, "claude 1턴 200");
  const history = { role: "assistant", blocks: firstBody.message.blocks, origin: firstBody.message.origin };
  const second = await post("/v0/responses", {
    version: "0",
    model: GEMINI_MODEL,
    maxOutputTokens: 500,
    messages: [pick, history, { role: "user", blocks: [{ type: "text", text: "What number did you pick? Just the number." }] }],
  });
  const secondBody = (await second.json()) as Record<string, any>;
  assert(second.status === 200, `gemini 2턴 200 (실제 ${second.status})`);
  assert(secondBody.model.resolved.provider === "google", "2턴이 google로 라우팅");
  const a1 = firstBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  const a2 = secondBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  assert(a1 !== undefined && a1 === a2, `히스토리 연속성: claude가 고른 ${a1} = gemini가 읽은 ${a2}`);
}

// ── 6. compat 인바운드 실검증: openai-compat 포맷으로 gemini 호출 ──
{
  const res = await post("/compat/openai/v1/chat/completions", {
    model: GEMINI_MODEL,
    max_completion_tokens: 100,
    messages: [{ role: "user", content: "Say OK and nothing else." }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, "compat CC→gemini 200");
  assert(body.object === "chat.completion" && body.choices[0].finish_reason === "stop", "CC 응답 형태");
  assert(Array.isArray(body.gateway?.ir), "gateway.ir 확장 부착");
}

console.log("\nGemini 스모크 전부 통과");
