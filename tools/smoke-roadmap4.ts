// 로드맵 4 실 E2E 스모크 (opt-in — 실 API 과금 소액). 실행: pnpm exec tsx tools/smoke-roadmap4.ts
import { loadDotenv } from "../src/env.js";
import { bootstrapProviders } from "../src/gateway/bootstrap.js";
import { createApp } from "../src/server/app.js";
import { parseSSEText } from "../src/stream/sse.js";

loadDotenv();
bootstrapProviders();
const app = createApp();

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

// ── 1. OpenAI 비스트림 (native — Responses 표면) ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: "gpt-5.6-luna",
    maxOutputTokens: 500,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Say OK and nothing else." }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `openai 비스트림 200 (실제 ${res.status})`);
  assert(body.model.resolved.provider === "openai" && body.model.resolved.surface === "responses", "resolved openai/responses");
  assert(body.message.blocks.some((b: any) => b.type === "text"), "text 블록 존재");
  assert(body.message.origin.surface === "responses", "origin.surface 채워짐");
  assert(body.usage.totalTokens > 0, `usage ${body.usage.totalTokens}토큰`);
}

// ── 2. OpenAI 스트림 완주 ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: "gpt-5.6-luna",
    maxOutputTokens: 500,
    stream: true,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Count 1 to 3." }] }],
  });
  const frames = parseSSEText(await res.text());
  const types = frames.map((f) => f.event);
  assert(res.status === 200, "openai 스트림 200");
  assert(types[0] === "stream-start" && types.includes("response-metadata"), "수명주기 이벤트");
  assert(types.includes("text-delta"), "text-delta 수신");
  assert(types.at(-1) === "finish", `터미널 finish (실제 ${types.at(-1)})`);
  const seqs = frames.map((f) => Number(f.id));
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), "seq 단조 증가");
}

// ── 3. 크로스 프로바이더 대화 (목표 2 실증): claude 턴 → 히스토리 → gpt 턴 ──
{
  const first = await post("/v0/responses", {
    version: "0",
    model: "claude-haiku-4-5",
    maxOutputTokens: 100,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Pick a number between 1 and 10. Reply with just the number." }] }],
  });
  const firstBody = (await first.json()) as Record<string, any>;
  assert(first.status === 200, "claude 1턴 200");
  // §13.1 편입: PM→PO 복사 + origin 보존 (서버 유틸과 동일 규칙 — 여기선 그대로 전달)
  const history = { role: "assistant", blocks: firstBody.message.blocks, origin: firstBody.message.origin };
  const second = await post("/v0/responses", {
    version: "0",
    model: "gpt-5.6-luna",
    maxOutputTokens: 500,
    messages: [
      { role: "user", blocks: [{ type: "text", text: "Pick a number between 1 and 10. Reply with just the number." }] },
      history,
      { role: "user", blocks: [{ type: "text", text: "What number did you pick? Just the number." }] },
    ],
  });
  const secondBody = (await second.json()) as Record<string, any>;
  assert(second.status === 200, `gpt 2턴 200 (실제 ${second.status})`);
  assert(secondBody.model.resolved.provider === "openai", "2턴이 openai로 라우팅");
  const a1 = firstBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  const a2 = secondBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  assert(a1 !== undefined && a1 === a2, `히스토리 연속성: claude가 고른 ${a1} = gpt가 읽은 ${a2}`);
}

// ── 4. compat 인바운드 실검증: openai-compat 포맷으로 claude 호출 ──
{
  const res = await post("/compat/openai/v1/chat/completions", {
    model: "claude-haiku-4-5",
    max_completion_tokens: 100,
    messages: [{ role: "user", content: "Say OK and nothing else." }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, "compat CC→claude 200");
  assert(body.object === "chat.completion" && body.choices[0].finish_reason === "stop", "CC 응답 형태");
  assert(Array.isArray(body.gateway?.ir), "gateway.ir 확장 부착");
}

// ── 5. OpenAI reasoning 왕복 (encrypted_content — §4.2 무손실) ──
{
  const first = await post("/v0/responses", {
    version: "0",
    model: "gpt-5.6-luna",
    maxOutputTokens: 2000,
    reasoning: { effort: "low" },
    providerOptions: { openai: { reasoning: { summary: "auto" } } },
    messages: [{ role: "user", blocks: [{ type: "text", text: "Is 391 prime? Think it through, then answer in one word." }] }],
  });
  const firstBody = (await first.json()) as Record<string, any>;
  const reasoningBlock = firstBody.message.blocks.find((b: any) => b.type === "reasoning");
  assert(reasoningBlock?.opaqueState?.provider === "openai", "encrypted reasoning 수신");
  const history = { role: "assistant", blocks: firstBody.message.blocks, origin: firstBody.message.origin };
  const second = await post("/v0/responses", {
    version: "0",
    model: "gpt-5.6-luna",
    maxOutputTokens: 2000,
    reasoning: { effort: "low" },
    messages: [
      { role: "user", blocks: [{ type: "text", text: "Is 391 prime? Think it through, then answer in one word." }] },
      history,
      { role: "user", blocks: [{ type: "text", text: "And 397? One word." }] },
    ],
  });
  assert(second.status === 200, `reasoning 왕복 2턴 200 (실제 ${second.status})`);
}

console.log("\n스모크 전부 통과");
