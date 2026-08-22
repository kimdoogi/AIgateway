// Batches 브리지 4사 wire 실판정 (opt-in — 실 API, 항목당 1건 소액).
// 실행: pnpm smoke:batches [providers]   (기본 anthropic,openai,google,xai — 쉼표 구분)
// 목적: 부록 (b) §3.4의 미검증 wire 가정(google·xai)을 사실/반증으로 판정 — 비중단형(전사 수집).
import { loadDotenv } from "../src/env.js";
import { bootstrapProviders } from "../src/gateway/bootstrap.js";
import { InMemoryBatchStore } from "../src/state/memory.js";
import { createApp } from "../src/server/app.js";

loadDotenv();
bootstrapProviders();
const app = createApp({ batches: new InMemoryBatchStore() });

const MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.6-luna",
  google: "gemini-3.7-flash",
  xai: process.env["SMOKE_XAI_BATCH_MODEL"] ?? "grok-4.6",
};

const providers = (process.argv[2] ?? "anthropic,openai,google,xai").split(",").map((p) => p.trim());
const POLLS = 6;
const POLL_MS = 5000;

const postJson = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Verdict {
  provider: string;
  stage: string; // 도달한 최종 단계
  ok: boolean;
  detail: string;
}
const verdicts: Verdict[] = [];

for (const provider of providers) {
  const model = MODELS[provider];
  if (!model) {
    verdicts.push({ provider, stage: "config", ok: false, detail: "미지 프로바이더" });
    continue;
  }
  console.log(`\n── ${provider} (${model}) ──`);
  try {
    const create = await postJson("/v0/batches", {
      version: "0",
      requests: [
        {
          customId: "wire-check",
          request: {
            version: "0",
            model,
            maxOutputTokens: 50,
            messages: [{ role: "user", blocks: [{ type: "text", text: "Say OK and nothing else." }] }],
          },
        },
      ],
    });
    const created = (await create.json()) as Record<string, unknown>;
    if (create.status !== 200) {
      console.log(`  ✗ 생성 ${create.status}:`, JSON.stringify(created).slice(0, 400));
      verdicts.push({ provider, stage: "create", ok: false, detail: `HTTP ${create.status} — wire 가정 반증` });
      continue;
    }
    console.log(`  ✓ 생성 200 — ${created["id"]} (status ${created["status"]}, raw ${created["rawStatus"]})`);

    let status = String(created["status"]);
    let polls = 0;
    for (; polls < POLLS && !["completed", "failed", "expired", "canceled"].includes(status); polls++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const poll = await app.request(`/v0/batches/${created["id"]}`);
      const body = (await poll.json()) as Record<string, unknown>;
      if (poll.status !== 200) {
        console.log(`  ✗ 폴링 ${poll.status}:`, JSON.stringify(body).slice(0, 400));
        verdicts.push({ provider, stage: "poll", ok: false, detail: `HTTP ${poll.status}` });
        status = "poll-error";
        break;
      }
      status = String(body["status"]);
      console.log(`  ✓ 폴링 ${polls + 1} — status ${status} (raw ${body["rawStatus"]})`);
    }
    if (status === "poll-error") continue;

    if (status === "completed") {
      const res = await app.request(`/v0/batches/${created["id"]}/results`);
      const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const item = body.results?.find((r) => r["customId"] === "wire-check");
      const hasMessage = Boolean((item?.["response"] as Record<string, unknown> | undefined)?.["message"]);
      console.log(`  ${res.status === 200 && hasMessage ? "✓" : "✗"} 결과 ${res.status} — customId 매핑 ${item ? "OK" : "실패"}, IR message ${hasMessage ? "OK" : "없음"}`);
      verdicts.push({
        provider,
        stage: "results",
        ok: res.status === 200 && hasMessage,
        detail: res.status === 200 && hasMessage ? "전 수명주기 실검증 (완료 경로)" : `결과 형태 불일치`,
      });
    } else if (status === "failed" || status === "expired") {
      verdicts.push({ provider, stage: "poll", ok: false, detail: `배치 ${status} — 항목/wire 점검 필요` });
    } else {
      const cancel = await app.request(`/v0/batches/${created["id"]}/cancel`, { method: "POST" });
      const body = (await cancel.json()) as Record<string, unknown>;
      console.log(`  ${cancel.status === 200 ? "✓" : "✗"} 취소 ${cancel.status} — status ${body["status"]} (raw ${body["rawStatus"]})`);
      verdicts.push({
        provider,
        stage: "cancel",
        ok: cancel.status === 200,
        detail: cancel.status === 200 ? "생성·폴링·취소 wire 실검증 (완료 경로는 미도달)" : `취소 HTTP ${cancel.status}`,
      });
    }
  } catch (err) {
    console.log(`  ✗ 예외:`, err instanceof Error ? err.message : String(err));
    verdicts.push({ provider, stage: "exception", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

console.log("\n══ 판정 요약 ══");
for (const v of verdicts) {
  console.log(`  ${v.ok ? "✓" : "✗"} ${v.provider.padEnd(10)} [${v.stage}] ${v.detail}`);
}
process.exit(verdicts.every((v) => v.ok) ? 0 : 1);
