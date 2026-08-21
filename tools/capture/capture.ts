// 골든셋 캡처 하네스 (walking-skeleton 4단계).
// 실행: pnpm capture [케이스명...] [--list] [--dry-run]
// 비용 가드 내장: 콜별 usage×단가 누적 출력 + $1.00 하드 캡 자동 중단 (계획 확정 사항).
// 새니타이즈 전 원문은 tools/capture/raw/(gitignore됨)에, 새니타이즈본은 fixtures/anthropic/에.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotenv } from "../../src/env.js";
import { CASES, selectCases, type CaptureCase } from "./cases.js";
import { findResidualIds, sanitizeHeaders, sanitizeText, type IdMap } from "./sanitize.js";
import { providerDir, type FixtureMeta } from "./fixtures.js";
import { replayAnthropicStream, usageFromEvents } from "./replay.js";
import { parseSSEText } from "../../src/stream/sse.js";
import { unknownResponseFields, unknownStreamFields } from "../../src/adapters/anthropic/known-fields.js";
import { convertUsage, type AnthropicWireUsage } from "../../src/adapters/anthropic/errors.js";
import type { Usage } from "../../src/ir/usage.js";

const BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const HARD_CAP_USD = 1.0;
const RAW_DIR = "tools/capture/raw";

// USD / 1M tokens. 캡 검증용 근사 단가 — 청구서 대체 아님.
// 캐시: write 1.25x, read 0.1x (Anthropic 5분 ephemeral 기준)
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
};

function costUSD(model: string, usage: Usage): number {
  // 응답은 스냅샷 id(claude-haiku-4-5-20251001)를 보고하므로 접두 매칭 (리뷰 F3 — 폴백 5배 과대계상 방지)
  const price =
    Object.entries(PRICING)
      .sort(([a], [b]) => b.length - a.length) // 최장 접두 우선 — 삽입 순서 의존 제거 (리뷰 F18)
      .find(([alias]) => model.startsWith(alias))?.[1] ?? { input: 5.0, output: 25.0 }; // 미지 모델은 Opus 단가
  const inputCost =
    (usage.input.noCache * price.input +
      usage.input.cacheWrite * price.input * 1.25 +
      usage.input.cacheRead * price.input * 0.1) /
    1e6;
  return inputCost + (usage.output.total * price.output) / 1e6;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface CaptureResult {
  name: string;
  status: number;
  cost: number;
  files: string[];
  warnings: string[];
}

async function captureOne(c: CaptureCase, apiKey: string): Promise<CaptureResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": API_VERSION,
    "x-api-key": c.invalidKey ? "sk-ant-invalid-fixture-key" : apiKey,
    ...c.headers,
  };
  const requestPath = "/v1/messages";
  const response = await fetch(`${BASE_URL}${requestPath}`, {
    method: "POST",
    headers,
    body: JSON.stringify(c.body),
  });

  const warnings: string[] = [];
  if (c.expectStatus !== undefined && response.status !== c.expectStatus) {
    warnings.push(`기대 status ${c.expectStatus} ≠ 실제 ${response.status} — 게이트 변동 가능성`);
  }

  const idMap: IdMap = new Map();
  const isStream = c.stream === true && response.ok;
  const rawText = await response.text(); // 스트림도 완결 후 전체 텍스트 (chunks.txt는 줄 단위 원문)
  const stamp = today();
  const model = extractModel(c, rawText, isStream); // 1회만 파스 (리뷰 F19)
  const baseName = `${c.name}.${model.replaceAll("/", "_")}.${stamp}`;
  const files: string[] = [];

  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(providerDir("anthropic"), { recursive: true });
  writeFileSync(join(RAW_DIR, `${baseName}.raw.txt`), rawText);

  // 요청을 먼저 새니타이즈 — 자리표시자 번호가 응답이 발급한 id 수에 좌우되지 않게 (리뷰 F7 결정론)
  const requestBody = JSON.parse(
    sanitizeText(JSON.stringify(c.body), idMap),
  ) as FixtureMeta["request"]["body"];
  const sanitized = sanitizeText(rawText, idMap);
  const meta: FixtureMeta = {
    case: c.name,
    recordedAt: stamp,
    model,
    stream: c.stream === true,
    request: {
      path: requestPath,
      body: requestBody,
      ...(c.headers ? { headers: c.headers } : {}),
    },
    status: response.status,
    headers: sanitizeHeaders(response.headers),
  };

  let usage: Usage | undefined;
  if (isStream) {
    const chunksFile = `${baseName}.chunks.txt`;
    // 검증 먼저 — throw 시 fixtures/에 고아 파일을 남기지 않는다 (리뷰 SW2-r3)
    const events = replayAnthropicStream(sanitized, { modelId: c.model });
    usage = usageFromEvents(events);
    warnings.push(...unknownStreamFields(parseSSEText(sanitized)).map((w) => `미지 필드: ${w}`));
    writeFileSync(join(providerDir("anthropic"), chunksFile), sanitized);
    meta.chunksFile = chunksFile;
    files.push(chunksFile);
  } else {
    const body: unknown = JSON.parse(sanitized);
    meta.body = body;
    if (response.ok) {
      const wireUsage = (body as { usage?: AnthropicWireUsage }).usage;
      if (wireUsage) usage = convertUsage(wireUsage);
      warnings.push(...unknownResponseFields(body).map((w) => `미지 필드: ${w}`));
    }
  }
  // 앵커링이 놓친 문자열 내부 잔류 id 후보 — 사람 검토 승격 (리뷰 F9-r3)
  warnings.push(...findResidualIds(sanitized).map((id) => `잔류 id 의심 (문자열 내부): ${id}`));

  const metaFile = `${baseName}.json`;
  writeFileSync(join(providerDir("anthropic"), metaFile), `${JSON.stringify(meta, null, 2)}\n`);
  files.push(metaFile);

  return {
    name: c.name,
    status: response.status,
    cost: usage ? costUSD(meta.model, usage) : 0,
    files,
    warnings,
  };
}

function extractModel(c: CaptureCase, rawText: string, isStream: boolean): string {
  // 응답이 보고한 스냅샷 id 우선 (명명 규약 — 신선도 장치의 전제)
  try {
    if (isStream) {
      const frame = parseSSEText(rawText).find((f) => f.event === "message_start");
      if (frame) {
        const message = (JSON.parse(frame.data) as { message?: { model?: string } }).message;
        if (message?.model) return message.model;
      }
    } else {
      const model = (JSON.parse(rawText) as { model?: string }).model;
      if (model) return model;
    }
  } catch {
    /* 에러 응답 등 — 요청 모델로 폴백 */
  }
  return c.model;
}


async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const c of CASES) {
      console.log(
        `${c.name.padEnd(28)} ${c.model}${c.stream ? " [stream]" : ""}${c.manual ? " [manual]" : ""}${c.note ? ` — ${c.note}` : ""}`,
      );
    }
    return;
  }
  const dryRun = args.includes("--dry-run");
  const cases = selectCases(args.filter((a) => !a.startsWith("--")));

  loadDotenv();
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey && !dryRun) {
    console.error("ANTHROPIC_API_KEY 필요 (.env 또는 환경변수)");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`실행 대상 ${cases.length}건:`);
    for (const c of cases) console.log(`  ${c.name} (${c.model}${c.stream ? ", stream" : ""})`);
    return;
  }

  let totalCost = 0;
  let failed = 0;
  for (const c of cases) {
    if (totalCost >= HARD_CAP_USD) {
      console.error(`\n하드 캡 $${HARD_CAP_USD.toFixed(2)} 도달 — 중단. 남은 케이스는 이름 지정으로 재개.`);
      process.exit(2);
    }
    try {
      const result = await captureOne(c, apiKey as string);
      totalCost += result.cost;
      console.log(
        `${result.name.padEnd(28)} ${String(result.status).padEnd(4)} $${result.cost.toFixed(4)}  누적 $${totalCost.toFixed(4)}`,
      );
      for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    } catch (err) {
      failed += 1;
      console.error(`${c.name.padEnd(28)} 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n총 비용 ≈ $${totalCost.toFixed(4)} (근사 — 청구서 아님)${failed ? `, 실패 ${failed}건` : ""}`);
  if (failed > 0) process.exit(1);
}

await main();
