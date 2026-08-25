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
import { replayAnthropicStream, replayGeminiStream, replayOpenAIStream, replayXAIStream, usageFromEvents } from "./replay.js";
import { parseSSEText } from "../../src/stream/sse.js";
import {
  unknownResponseFields as anthropicUnknownResponse,
  unknownStreamFields as anthropicUnknownStream,
} from "../../src/adapters/anthropic/known-fields.js";
import { unknownResponseFields as openaiUnknownResponse } from "../../src/adapters/openai/known-fields.js";
import { unknownResponseFields as xaiUnknownResponse } from "../../src/adapters/xai/known-fields.js";
import {
  unknownResponseFields as geminiUnknownResponse,
  unknownStreamFields as geminiUnknownStream,
} from "../../src/adapters/gemini/known-fields.js";
import {
  convertUsage as convertAnthropicUsage,
  type AnthropicWireUsage,
} from "../../src/adapters/anthropic/errors.js";
import { convertUsage as convertOpenAIUsage, type OpenAIWireUsage } from "../../src/adapters/openai/errors.js";
import { convertUsage as convertGeminiUsage, type GeminiWireUsage } from "../../src/adapters/gemini/errors.js";
import { estimateCostUSD } from "../../src/gateway/pricing.js";
import type { AdapterStreamEvent } from "../../src/adapters/types.js";
import type { Usage } from "../../src/ir/usage.js";

const HARD_CAP_USD = 1.0;
const RAW_DIR = "tools/capture/raw";

// ── 프로바이더 구성 (데이터 테이블 — 하네스 본문에 프로바이더 분기 없음) ──
interface ProviderConfig {
  baseUrl: string;
  envVar: string;
  defaultPath: string;
  authHeaders(apiKey: string, invalid: boolean): Record<string, string>;
  replay(text: string, modelId: string, path: string): AdapterStreamEvent[];
  unknownResponse(body: unknown): string[];
  unknownStream?(text: string): string[];
  usageFromBody(body: unknown): Usage | undefined;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    defaultPath: "/v1/messages",
    authHeaders: (apiKey, invalid) => ({
      "anthropic-version": "2023-06-01",
      "x-api-key": invalid ? "sk-ant-invalid-fixture-key" : apiKey,
    }),
    replay: (text, modelId) => replayAnthropicStream(text, { modelId }),
    unknownResponse: anthropicUnknownResponse,
    unknownStream: (text) => anthropicUnknownStream(parseSSEText(text)),
    usageFromBody: (body) => {
      const wireUsage = (body as { usage?: AnthropicWireUsage }).usage;
      return wireUsage ? convertAnthropicUsage(wireUsage) : undefined;
    },
  },
  openai: {
    baseUrl: "https://api.openai.com",
    envVar: "OPENAI_API_KEY",
    defaultPath: "/v1/responses",
    authHeaders: (apiKey, invalid) => ({
      authorization: `Bearer ${invalid ? "sk-proj-invalid-fixture-key-0000000000" : apiKey}`,
    }),
    replay: (text, modelId, path) => replayOpenAIStream(text, { modelId }, path),
    unknownResponse: openaiUnknownResponse, // 얕은 적용 (D10-5 하드 보장은 Anthropic 한정)
    usageFromBody: (body) => {
      const wireUsage = (body as { usage?: OpenAIWireUsage }).usage;
      return wireUsage ? convertOpenAIUsage(wireUsage) : undefined;
    },
  },
  xai: {
    baseUrl: "https://api.x.ai",
    envVar: "XAI_API_KEY",
    defaultPath: "/v1/chat/completions", // ADR-0004 — CC 주 표면
    authHeaders: (apiKey, invalid) => ({
      authorization: `Bearer ${invalid ? "xai-invalid-fixture-key-0000000000" : apiKey}`,
    }),
    replay: (text, modelId, path) => replayXAIStream(text, { modelId }, path),
    // openai 감지기 상속 + xAI 고유 인지 필드 오버레이 (request_id·citations·output_files — 감사 xai #4)
    unknownResponse: xaiUnknownResponse,
    usageFromBody: (body) => {
      const wireUsage = (body as { usage?: OpenAIWireUsage }).usage; // usage 구조 OpenAI 호환 (§F)
      return wireUsage ? convertOpenAIUsage(wireUsage) : undefined;
    },
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com",
    envVar: "GEMINI_API_KEY",
    defaultPath: "/v1beta/models/gemini-3.7-flash:generateContent", // 모델이 경로에 — 케이스가 path 지정
    authHeaders: (apiKey, invalid) => ({
      "x-goog-api-key": invalid ? "AIza-invalid-fixture-key-0000000000" : apiKey,
    }),
    replay: (text, modelId) => replayGeminiStream(text, { modelId }),
    unknownResponse: geminiUnknownResponse,
    unknownStream: (text) => geminiUnknownStream(parseSSEText(text).map((f) => f.data)),
    usageFromBody: (body) => {
      const wireUsage = (body as { usageMetadata?: GeminiWireUsage }).usageMetadata;
      return wireUsage ? convertGeminiUsage(wireUsage) : undefined;
    },
  },
};

// 단가는 레지스트리 가격표가 단일 소스 (src/gateway/pricing.ts — ADR-0007 §2 승격, 2026-08-21)
const costUSD = estimateCostUSD;

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
  const provider = c.provider ?? "anthropic";
  const cfg = PROVIDERS[provider]!;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...cfg.authHeaders(apiKey, c.invalidKey === true),
    ...c.headers,
  };
  const requestPath = c.path ?? cfg.defaultPath;
  const response = await fetch(`${cfg.baseUrl}${requestPath}`, {
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
  mkdirSync(providerDir(provider), { recursive: true });
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
    const events = cfg.replay(sanitized, c.model, requestPath);
    usage = usageFromEvents(events);
    if (cfg.unknownStream) warnings.push(...cfg.unknownStream(sanitized).map((w) => `미지 필드: ${w}`));
    writeFileSync(join(providerDir(provider), chunksFile), sanitized);
    meta.chunksFile = chunksFile;
    files.push(chunksFile);
  } else {
    const body: unknown = JSON.parse(sanitized);
    meta.body = body;
    if (response.ok) {
      usage = cfg.usageFromBody(body);
      warnings.push(...cfg.unknownResponse(body).map((w) => `미지 필드: ${w}`));
    }
  }
  // 앵커링이 놓친 문자열 내부 잔류 id 후보 — 사람 검토 승격 (리뷰 F9-r3)
  warnings.push(...findResidualIds(sanitized).map((id) => `잔류 id 의심 (문자열 내부): ${id}`));

  const metaFile = `${baseName}.json`;
  writeFileSync(join(providerDir(provider), metaFile), `${JSON.stringify(meta, null, 2)}\n`);
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
  // 응답이 보고한 스냅샷 id 우선 (명명 규약 — 신선도 장치의 전제).
  // 위치는 프로바이더별로 다르다: anthropic message_start.message.model /
  // openai responses response.created.response.model / openai CC 첫 chunk.model
  const pick = (json: Record<string, unknown>): string | undefined => {
    for (const holder of [json, json["message"], json["response"]]) {
      if (holder && typeof holder === "object") {
        const m = (holder as Record<string, unknown>)["model"];
        if (typeof m === "string" && m.length > 0) return m;
      }
    }
    return undefined;
  };
  try {
    if (isStream) {
      for (const frame of parseSSEText(rawText)) {
        if (frame.data.trim() === "[DONE]") continue;
        const model = pick(JSON.parse(frame.data) as Record<string, unknown>);
        if (model) return model;
      }
    } else {
      const model = pick(JSON.parse(rawText) as Record<string, unknown>);
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
  const neededVars = new Set(cases.map((c) => PROVIDERS[c.provider ?? "anthropic"]!.envVar));
  if (!dryRun) {
    const missing = [...neededVars].filter((v) => !process.env[v]);
    if (missing.length > 0) {
      console.error(`${missing.join(", ")} 필요 (.env 또는 환경변수) — 해당 프로바이더 케이스는 키가 있어야 실행 가능`);
      process.exit(1);
    }
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
      const result = await captureOne(c, process.env[PROVIDERS[c.provider ?? "anthropic"]!.envVar] as string);
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
