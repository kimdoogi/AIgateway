// xAI(로드맵 5) 실 E2E 스모크 (opt-in — 실 API 과금 소액). 실행: pnpm smoke:xai
// 검증 대상 (ADR-0004): CC 주 표면 + 표면 선택자의 responses 강제 스위칭 +
// encrypted reasoning 왕복 + 크로스 프로바이더 히스토리(목표 2) + compat 인바운드.
import { loadDotenv } from "../src/env.js";
import { bootstrapProviders } from "../src/gateway/bootstrap.js";
import { createApp } from "../src/server/app.js";
import { parseSSEText } from "../src/stream/sse.js";

loadDotenv();
bootstrapProviders();
const app = createApp();

const XAI_MODEL = "grok-4.6";

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

// ── 1. xAI 비스트림 (native — CC 주 표면, OpenAI와 반대) ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: XAI_MODEL,
    maxOutputTokens: 500,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Say OK and nothing else." }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `xai 비스트림 200 (실제 ${res.status})`);
  assert(body.model.resolved.provider === "xai" && body.model.resolved.surface === "chat-completions", "resolved xai/chat-completions (주 표면)");
  assert(body.message.blocks.some((b: any) => b.type === "text"), "text 블록 존재");
  assert(body.message.origin.surface === "chat-completions", "origin.surface 채워짐");
  assert(body.usage.totalTokens > 0, `usage ${body.usage.totalTokens}토큰`);
}

// ── 2. xAI 스트림 완주 ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: XAI_MODEL,
    maxOutputTokens: 500,
    stream: true,
    messages: [{ role: "user", blocks: [{ type: "text", text: "Count 1 to 3." }] }],
  });
  const frames = parseSSEText(await res.text());
  const types = frames.map((f) => f.event);
  assert(res.status === 200, "xai 스트림 200");
  assert(types[0] === "stream-start" && types.includes("response-metadata"), "수명주기 이벤트");
  assert(types.includes("text-delta"), "text-delta 수신");
  assert(types.at(-1) === "finish", `터미널 finish (실제 ${types.at(-1)})`);
  const seqs = frames.map((f) => Number(f.id));
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), "seq 단조 증가");
}

// ── 3. CC 표면 reasoning (오버라이드 B2-6: reasoning_content → reasoning 블록) ──
{
  const res = await post("/v0/responses", {
    version: "0",
    model: XAI_MODEL,
    maxOutputTokens: 4000,
    reasoning: { effort: "low" },
    messages: [{ role: "user", blocks: [{ type: "text", text: "Is 91 prime? Think it through, then answer in one word." }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `CC reasoning 200 (실제 ${res.status})`);
  assert(body.model.resolved.surface === "chat-completions", "reasoning effort만으로는 CC 유지 (스위칭 없음)");
  assert(body.message.blocks.some((b: any) => b.type === "reasoning"), "reasoning 블록 수신 (reasoning_content 매핑)");
}

// ── 4. 표면 스위칭 + encrypted reasoning 왕복 (ADR-0004 §2 — 트리거 시 responses 강제) ──
{
  const ask = { role: "user", blocks: [{ type: "text", text: "Is 97 prime? Think it through, then answer in one word." }] };
  const first = await post("/v0/responses", {
    version: "0",
    model: XAI_MODEL,
    maxOutputTokens: 4000,
    reasoning: { effort: "low" },
    providerOptions: { xai: { include: ["reasoning.encrypted_content"] } },
    messages: [ask],
  });
  const firstBody = (await first.json()) as Record<string, any>;
  assert(first.status === 200, `responses 1턴 200 (실제 ${first.status})`);
  assert(firstBody.model.resolved.surface === "responses", "PO include 트리거 → responses 강제");
  const reasoningBlock = firstBody.message.blocks.find((b: any) => b.type === "reasoning");
  assert(reasoningBlock?.opaqueState?.provider === "xai", "encrypted reasoning 수신 (opaqueState.provider=xai)");
  const history = { role: "assistant", blocks: firstBody.message.blocks, origin: firstBody.message.origin };
  const second = await post("/v0/responses", {
    version: "0",
    model: XAI_MODEL,
    maxOutputTokens: 4000,
    reasoning: { effort: "low" },
    messages: [ask, history, { role: "user", blocks: [{ type: "text", text: "And 133? One word." }] }],
  });
  const secondBody = (await second.json()) as Record<string, any>;
  assert(second.status === 200, `reasoning 왕복 2턴 200 (실제 ${second.status})`);
  assert(secondBody.model.resolved.surface === "responses", "히스토리 opaqueState 트리거 → responses 유지");
}

// ── 5. 크로스 프로바이더 대화 (목표 2 — xai 방향 첫 실증): claude 턴 → 히스토리 → grok 턴 ──
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
    model: XAI_MODEL,
    maxOutputTokens: 500,
    messages: [pick, history, { role: "user", blocks: [{ type: "text", text: "What number did you pick? Just the number." }] }],
  });
  const secondBody = (await second.json()) as Record<string, any>;
  assert(second.status === 200, `grok 2턴 200 (실제 ${second.status})`);
  assert(secondBody.model.resolved.provider === "xai", "2턴이 xai로 라우팅");
  const a1 = firstBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  const a2 = secondBody.message.blocks.find((b: any) => b.type === "text")?.text?.match(/\d+/)?.[0];
  assert(a1 !== undefined && a1 === a2, `히스토리 연속성: claude가 고른 ${a1} = grok이 읽은 ${a2}`);
}

// ── 6. compat 인바운드 실검증: openai-compat 포맷으로 grok 호출 ──
{
  const res = await post("/compat/openai/v1/chat/completions", {
    model: XAI_MODEL,
    max_completion_tokens: 100,
    messages: [{ role: "user", content: "Say OK and nothing else." }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, "compat CC→grok 200");
  assert(body.object === "chat.completion" && body.choices[0].finish_reason === "stop", "CC 응답 형태");
  assert(Array.isArray(body.gateway?.ir), "gateway.ir 확장 부착");
}

console.log("\nxAI 스모크 전부 통과");
