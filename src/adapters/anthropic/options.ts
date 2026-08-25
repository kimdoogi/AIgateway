import { z } from "zod";
import type { JSONObject } from "../../ir/json.js";
import type { NS, Warning } from "../../ir/common.js";
import { partitionProviderOptions } from "../shared.js";

// providerOptions.anthropic — 알려진 키는 스키마(strip) 검증, 미지 키는 D5 공통 정책(shared).

const KnownOptionsSchema = z.object({
  betas: z.array(z.string()).optional(),
  thinking: z.record(z.string(), z.unknown()).optional(), // {type:"adaptive"|...} wire 원문 통과
  serviceTier: z.string().optional(),
  // §14 요청 방향 서버 상태 참조 — retarget SERVER_STATE_KEYS와 정합 (감사 #3: 부재 시 기본 4xx로
  // G1 왕복 불변식 위반). wire 원문 통과 — 문자열 id 또는 객체
  container: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  // compat 인바운드가 보존한 output_config 잔여 서브키 (task_budget 등 — 감사 anthropic #1).
  // request.ts가 output_config 조립 시 재병합 (1급 필드 effort/format이 우선)
  outputConfigExtras: z.record(z.string(), z.unknown()).optional(),
  // 인벤토리 §2가 'PO'로 확정한 파라미터군 — wire 원문 통과 (감사 anthropic #8: 분류만 있고
  // 스키마에 없어 기본 4xx였다. 베타 헤더는 betas로 별도 지정). 정책 연동(캐시 키 speed 포함 등)은 후속
  contextManagement: z.record(z.string(), z.unknown()).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  cacheControl: z.record(z.string(), z.unknown()).optional(), // top-level 자동 캐싱 (블록 단위와 별개)
  inferenceGeo: z.string().optional(),
  speed: z.string().optional(),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
  // 서버측 fallbacks (ADR-0005 §3 — opt-in 통과. 위임 마킹·batches 사전 400은 후속)
  fallbacks: z.union([z.string(), z.array(z.unknown())]).optional(),
});

/** PO 키 → wire top-level 키 (원문 통과군) — request.ts 방출·coverage-matrix 교차 검증 공용 */
export const PO_WIRE_PASSTHROUGH: ReadonlyArray<[keyof ParsedAnthropicOptions & string, string]> = [
  ["contextManagement", "context_management"],
  ["mcpServers", "mcp_servers"],
  ["cacheControl", "cache_control"],
  ["inferenceGeo", "inference_geo"],
  ["speed", "speed"],
  ["diagnostics", "diagnostics"],
  ["fallbacks", "fallbacks"],
];

/** coverage-matrix 'PO 분류 → 구현 실존' 교차 검증용 (감사 관통 패턴 #4 재발 방지 장치) */
export const KNOWN_PO_KEYS: ReadonlySet<string> = new Set(Object.keys(KnownOptionsSchema.shape));

export interface ParsedAnthropicOptions {
  betas?: string[];
  thinking?: JSONObject;
  serviceTier?: string;
  container?: string | JSONObject;
  outputConfigExtras?: JSONObject;
  contextManagement?: JSONObject;
  mcpServers?: unknown[];
  cacheControl?: JSONObject;
  inferenceGeo?: string;
  speed?: string;
  diagnostics?: JSONObject;
  fallbacks?: string | unknown[];
  /** opt-in으로 통과시킨 미지 키 (body 병합 — 예약 키 충돌은 request.ts가 검사) */
  extra: JSONObject;
}

export function parseAnthropicRequestOptions(
  providerOptions: NS | undefined,
  allowUnknown: boolean,
  warnings: Warning[],
): ParsedAnthropicOptions {
  const { known, extra } = partitionProviderOptions(
    providerOptions,
    "anthropic",
    KnownOptionsSchema,
    allowUnknown,
    warnings,
  );
  return { ...(known as ParsedAnthropicOptions), extra } as ParsedAnthropicOptions;
}

/** 블록/툴 PO에서 값 읽기 — cacheControl/cache_control 양쪽 표기 허용 (Vercel 관례) */
export function readBlockCacheControl(providerOptions: NS | undefined): JSONObject | undefined {
  const ns = providerOptions?.["anthropic"];
  if (!ns) return undefined;
  const cc = ns["cacheControl"] ?? ns["cache_control"];
  if (cc && typeof cc === "object" && !Array.isArray(cc)) return cc as JSONObject;
  return undefined;
}

/**
 * compat 인바운드가 보존한 비표준 wire 키 (부록 (a) §3.2 — allowed_callers 등 PTC/신필드).
 * PM(신규 응답)·PO(히스토리 편입 후) 양쪽 조회.
 */
export function readWireExtras(
  providerOptions: NS | undefined,
  providerMetadata: NS | undefined,
): JSONObject | undefined {
  const v = providerOptions?.["anthropic"]?.["wireExtras"] ?? providerMetadata?.["anthropic"]?.["wireExtras"];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as JSONObject) : undefined;
}

/** 서버 툴 블록의 wire 타입 복원용 (G1 왕복 — 리뷰 R1). PM(신규 응답)·PO(히스토리 편입 후) 양쪽 조회 */
export function readBlockWireType(
  providerOptions: NS | undefined,
  providerMetadata: NS | undefined,
): string | undefined {
  const v = providerOptions?.["anthropic"]?.["wireType"] ?? providerMetadata?.["anthropic"]?.["wireType"];
  return typeof v === "string" ? v : undefined;
}
