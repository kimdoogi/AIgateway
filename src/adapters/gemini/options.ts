import { z } from "zod";
import type { JSONObject } from "../../ir/json.js";
import type { NS, Warning } from "../../ir/common.js";
import { partitionProviderOptions } from "../shared.js";

// providerOptions.google — 알려진 키는 스키마(strip) 검증, 미지 키는 D5 공통 정책(shared).
// 인벤토리 §K providerOptions.google 후보 중 generateContent v1 범위만 — 나머지는 opt-in extra.

const KnownOptionsSchema = z.object({
  // 표면 오버라이드 (registry 공통 규칙이 소비 — wire로 나가지 않는다. interactions 추가 시 확장)
  surface: z.enum(["generate-content"]).optional(),
  safetySettings: z.array(z.record(z.string(), z.unknown())).optional(),
  cachedContent: z.string().optional(), // explicit caching 참조 (cachedContents/...)
  thinkingConfig: z.record(z.string(), z.unknown()).optional(), // includeThoughts/thinkingBudget/thinkingLevel wire 원문
  responseModalities: z.array(z.string()).optional(),
  speechConfig: z.record(z.string(), z.unknown()).optional(),
  mediaResolution: z.string().optional(),
  toolConfig: z.record(z.string(), z.unknown()).optional(), // functionCallingConfig 등 wire 원문
  serviceTier: z.string().optional(),
  store: z.boolean().optional(), // 로깅 오버라이드 (2026 신규)
});

export interface ParsedGoogleOptions {
  surface?: "generate-content";
  safetySettings?: JSONObject[];
  cachedContent?: string;
  thinkingConfig?: JSONObject;
  responseModalities?: string[];
  speechConfig?: JSONObject;
  mediaResolution?: string;
  toolConfig?: JSONObject;
  serviceTier?: string;
  store?: boolean;
  /** opt-in으로 통과시킨 미지 키 (body 병합 — 예약 키 충돌은 request.ts가 검사) */
  extra: JSONObject;
}

export function parseGoogleRequestOptions(
  providerOptions: NS | undefined,
  allowUnknown: boolean,
  warnings: Warning[],
): ParsedGoogleOptions {
  const { known, extra } = partitionProviderOptions(
    providerOptions,
    "google",
    KnownOptionsSchema,
    allowUnknown,
    warnings,
  );
  return { ...(known as ParsedGoogleOptions), extra } as ParsedGoogleOptions;
}

/** 블록 PO/PM에서 wire part 원문 키 복원용 (custom 블록 외의 부속 — videoMetadata 등) */
export function readPartExtras(providerOptions: NS | undefined): JSONObject | undefined {
  const v = providerOptions?.["google"]?.["partExtras"];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JSONObject) : undefined;
}
