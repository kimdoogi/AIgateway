// 부록 (b) 실 E2E 스모크 (opt-in — 실 API, 과금 극소). 실행: pnpm smoke:appendix-b
// 검증: count_tokens 2사, Files 업로드→조회→삭제(anthropic — 무과금), Batches 생성→폴링→취소/결과(anthropic 1항목).
import { loadDotenv } from "../src/env.js";
import { bootstrapProviders } from "../src/gateway/bootstrap.js";
import { InMemoryBatchStore, InMemoryFileStore } from "../src/state/memory.js";
import { createApp } from "../src/server/app.js";

loadDotenv();
bootstrapProviders();
const app = createApp({ files: new InMemoryFileStore(), batches: new InMemoryBatchStore() });

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

const postJson = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── 1. count_tokens (anthropic·google — 무과금) ──
for (const model of ["claude-haiku-4-5", "gemini-3.7-flash"] as const) {
  const res = await postJson("/v0/count-tokens", {
    version: "0",
    model,
    messages: [{ role: "user", blocks: [{ type: "text", text: "How many tokens is this sentence?" }] }],
  });
  const body = (await res.json()) as Record<string, any>;
  assert(res.status === 200, `count-tokens ${model} 200 (실제 ${res.status})`);
  assert(typeof body.inputTokens === "number" && body.inputTokens > 0, `inputTokens ${body.inputTokens}`);
}
{
  const res = await postJson("/v0/count-tokens", {
    version: "0",
    model: "gpt-5.6-luna",
    messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
  });
  assert(res.status === 501, `count-tokens openai 501 (실제 ${res.status})`);
}

// ── 2. Files — anthropic 업로드→조회→refs 치환 실사용→삭제 ──
{
  const form = new FormData();
  form.append("provider", "anthropic");
  form.append("file", new Blob(["Golden gateway file bridge test.\n"], { type: "text/plain" }), "bridge-test.txt");
  const up = await app.request("/v0/files", { method: "POST", body: form });
  const upBody = (await up.json()) as Record<string, any>;
  assert(up.status === 200, `파일 업로드 200 (실제 ${up.status}${up.status !== 200 ? ` — ${JSON.stringify(upBody).slice(0, 200)}` : ""})`);
  assert(typeof upBody.id === "string" && upBody.id.startsWith("gwf_"), `gwf id 발급 (${upBody.id})`);
  assert(typeof upBody.providerFileId === "string" && upBody.providerFileId.length > 0, "프로바이더 file id 매핑");

  const got = await app.request(`/v0/files/${upBody.id}`);
  assert(got.status === 200, "파일 조회 200");

  const del = await app.request(`/v0/files/${upBody.id}`, { method: "DELETE" });
  assert(del.status === 200, "파일 삭제(프로바이더 대행) 200");
  const gone = await app.request(`/v0/files/${upBody.id}`);
  assert(gone.status === 404, "삭제 후 404");
}

// ── 3. Batches — anthropic 1항목 생성→폴링→(완료 시 결과 / 미완료 시 취소) ──
{
  const create = await postJson("/v0/batches", {
    version: "0",
    requests: [
      {
        customId: "smoke-1",
        request: {
          version: "0",
          model: "claude-haiku-4-5",
          maxOutputTokens: 50,
          messages: [{ role: "user", blocks: [{ type: "text", text: "Say OK and nothing else." }] }],
        },
      },
    ],
  });
  const created = (await create.json()) as Record<string, any>;
  assert(create.status === 200, `배치 생성 200 (실제 ${create.status}${create.status !== 200 ? ` — ${JSON.stringify(created).slice(0, 300)}` : ""})`);
  assert(created.id.startsWith("gwb_"), `gwb id 발급 (${created.id}, provider ${created.provider})`);

  let status = created.status as string;
  for (let i = 0; i < 12 && !["completed", "failed", "expired", "canceled"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await app.request(`/v0/batches/${created.id}`);
    const body = (await poll.json()) as Record<string, any>;
    assert(poll.status === 200, `폴링 ${i + 1} 200 (status ${body.status})`);
    status = body.status;
  }

  if (status === "completed") {
    const res = await app.request(`/v0/batches/${created.id}/results`);
    const body = (await res.json()) as Record<string, any>;
    assert(res.status === 200, "결과 조회 200");
    const item = body.results.find((r: any) => r.customId === "smoke-1");
    assert(item?.response?.message?.blocks?.some((b: any) => b.type === "text"), "결과 정규화 (IR message)");
    assert(item.response.usage.totalTokens > 0, `usage ${item.response.usage.totalTokens}토큰`);
    console.log("  (배치 60초 내 완료 — 결과 경로 검증)");
  } else {
    const cancel = await app.request(`/v0/batches/${created.id}/cancel`, { method: "POST" });
    const body = (await cancel.json()) as Record<string, any>;
    assert(cancel.status === 200, `취소 200 (status ${body.status})`);
    assert(["canceling", "canceled", "completed"].includes(body.status), "취소 상태 정규화");
    console.log("  (배치 미완료 — 취소 경로 검증)");
  }
}

console.log("\n부록 (b) 스모크 전부 통과");
