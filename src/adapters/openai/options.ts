import { z } from "zod";
import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { NS, Warning } from "../../ir/common.js";
import { makeWarning, partitionProviderOptions } from "../shared.js";

// providerOptions.openai — 요청 envelope 레벨 (Responses·Chat Completions 공용).
// 알려진 키는 스키마(strip) 검증, 미지 키는 D5 공통 정책(shared). 인벤토리 §A/§G가 원본.

const looseRecord = z.record(z.string(), z.unknown());

const KnownOptionsSchema = z.object({
  /** 표면 명시 오버라이드 — wire로 나가지 않는다 (레지스트리 selectSurface가 소비) */
  surface: z.enum(["responses", "chat-completions"]).optional(),

  // ── 서버 상태 (기본 store:false 강제 — ADR-0002 §2. 명시 지정은 §2 PO 우선 + warning) ──
  store: z.boolean().optional(),
  previousResponseId: z.string().optional(),
  conversation: z.union([z.string(), looseRecord]).optional(),
  background: z.boolean().optional(),

  // ── Responses 고유 ──
  include: z.array(z.string()).optional(),
  reasoning: z
    .object({
      summary: z.enum(["auto", "concise", "detailed"]).optional(),
      context: z.enum(["auto", "current_turn", "all_turns"]).optional(),
      mode: z.enum(["standard", "pro"]).optional(),
    })
    .optional(),
  textVerbosity: z.enum(["low", "medium", "high"]).optional(),
  truncation: z.enum(["auto", "disabled"]).optional(),
  maxToolCalls: z.number().int().positive().optional(),
  contextManagement: z.array(looseRecord).optional(),
  moderation: looseRecord.optional(),
  prompt: looseRecord.optional(), // 저장 템플릿 {id, version, variables} — 2026-11-30 셧다운 예정
  instructions: z.string().optional(), // system 메시지 대신 직접 지정 (§2 충돌 시 PO 우선)
  streamOptions: z.object({ includeObfuscation: z.boolean().optional() }).optional(),

  // ── 양 표면 공용 ──
  serviceTier: z.string().optional(),
  promptCacheKey: z.string().optional(),
  promptCacheOptions: looseRecord.optional(),
  promptCacheRetention: z.string().optional(),
  safetyIdentifier: z.string().max(64).optional(),
  topLogprobs: z.number().int().min(0).max(20).optional(),
  toolChoice: z.union([z.string(), looseRecord]).optional(), // allowed_tools/mcp 등 확장 형태
  metadata: z.record(z.string(), z.string()).optional(),

  // ── Chat Completions 전용 (인벤토리 §1 대조표) ──
  logitBias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  n: z.number().int().positive().optional(),
  prediction: looseRecord.optional(),
  audio: looseRecord.optional(),
  modalities: z.array(z.string()).optional(),
  webSearchOptions: looseRecord.optional(),
  user: z.string().optional(), // deprecated — safetyIdentifier/promptCacheKey 권장
});

export type KnownOpenAIOptions = z.infer<typeof KnownOptionsSchema>;

export interface ParsedOpenAIOptions extends KnownOpenAIOptions {
  /** opt-in으로 통과시킨 미지 키 (body 병합 — 예약 키 충돌은 request가 검사) */
  extra: JSONObject;
}

export function parseOpenAIRequestOptions(
  providerOptions: NS | undefined,
  allowUnknown: boolean,
  warnings: Warning[],
): ParsedOpenAIOptions {
  const { known, extra } = partitionProviderOptions(
    providerOptions,
    "openai",
    KnownOptionsSchema,
    allowUnknown,
    warnings,
  );
  return { ...(known as KnownOpenAIOptions), extra };
}

/** ir-v0 §2 — PO가 표준 필드와 같은 wire 슬롯을 덮어쓸 때는 반드시 보고 */
export function overrideWarning(slot: string, poPath: string, detail?: string): Warning {
  return makeWarning(
    "compatibility",
    "provider-option-override",
    `providerOptions.openai.${poPath}가 표준 필드의 wire 슬롯 '${slot}'을 덮어씀${detail ? ` (${detail})` : ""}`,
    poPath,
  );
}

// ── 블록/메시지/툴 레벨 PO 조회 ────────────────────────────────
// 응답 방향 PM → 히스토리 편입 시 PO로 복사되므로(§13.1) 양쪽을 본다.

function ns(providerOptions: NS | undefined, providerMetadata: NS | undefined): Record<string, unknown> {
  return { ...(providerMetadata?.["openai"] ?? {}), ...(providerOptions?.["openai"] ?? {}) };
}

/** reasoning·서버툴 item의 wire 원문 (무손실 왕복 — ir-v0 §4.2) */
export function readItem(
  providerOptions: NS | undefined,
  providerMetadata: NS | undefined,
): JSONObject | undefined {
  const v = ns(providerOptions, providerMetadata)["item"];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JSONObject) : undefined;
}

/** 서버 실행 툴 결과 블록 표식 — 복원 시 중복 방지용 (item 안에 결과가 이미 있음) */
export function isItemEcho(providerOptions: NS | undefined, providerMetadata: NS | undefined): boolean {
  return ns(providerOptions, providerMetadata)["itemEcho"] === true;
}

export function readString(
  providerOptions: NS | undefined,
  providerMetadata: NS | undefined,
  key: string,
): string | undefined {
  const v = ns(providerOptions, providerMetadata)[key];
  return typeof v === "string" ? v : undefined;
}

export function readValue(
  providerOptions: NS | undefined,
  providerMetadata: NS | undefined,
  key: string,
): JSONValue | undefined {
  const v = ns(providerOptions, providerMetadata)[key];
  return v === undefined ? undefined : (v as JSONValue);
}
