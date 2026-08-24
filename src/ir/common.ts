import { z } from "zod";
import { JSONObjectSchema, JSONValueSchema } from "./json.js";

// ir-v0 §2 — providerOptions(요청 방향) / providerMetadata(응답 방향).
// 어댑터는 자기 네임스페이스만 검증·소비하고 타 네임스페이스는 무시한다.
export const NSSchema = z.record(z.string(), JSONObjectSchema);
export type NS = z.infer<typeof NSSchema>;

// 확정 네임스페이스 키 (ADR-0001 §5). 상속 어댑터(bedrock 등)는 2차에 추가.
export const PROVIDER_KEYS = ["anthropic", "openai", "google", "xai"] as const;

// ir-v0 §4.0 — 블록 생성 주체. 재타게팅 판단 기준 (D6-1), 표면 sticky 판별(ADR-0002).
export const OriginSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  surface: z.string().optional(),
});
export type Origin = z.infer<typeof OriginSchema>;

// ir-v0 §4.10 — 프로바이더 종속 서명/암호화 상태의 공통 슬롯 (4사 공통 개념).
// 같은 provider 타깃 재전송 시 바이트 그대로 복원해야 한다.
export const OpaqueStateSchema = z.strictObject({
  provider: z.string().min(1),
  data: z.string(),
});
export type OpaqueState = z.infer<typeof OpaqueStateSchema>;

// ir-v0 §5 — Warning
export const WarningTypeSchema = z.enum([
  "unsupported",
  "compatibility",
  "deprecated",
  "degraded",
  "other",
]);

// ir-v0 §5 표준 코드 (초기 집합). code 필드 자체는 개방형 문자열이나, 게이트웨이가
// 발행하는 코드는 이 목록만 사용한다 (신규 코드는 스펙 §5에 먼저 등재).
export const WARNING_CODES = [
  "parameter-dropped",
  "parameter-clamped",
  "reasoning-dropped",
  "reasoning-demoted",
  "reasoning-annotated",
  "block-dropped",
  "passthrough-dropped",
  "passthrough-params-dropped",
  "signature-synthesized",
  "tool-pair-repaired",
  "tool-input-demoted",
  "surface-switched",
  "system-repositioned",
  "unknown-provider-option-passed",
  "provider-option-override",
  "unknown-block-passthrough",
  "parameter-defaulted",
  "server-state-unmanaged",
  "server-state-inapplicable",
  "cache-breakpoint-ignored",
  "budget-soft-warning",
  "budget-exhausted-next-request-blocked",
  "fallback-target-switched",
  "billing-price-estimated",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export const WarningSchema = z.strictObject({
  type: WarningTypeSchema,
  code: z.string().min(1),
  message: z.string(),
  path: z.string().optional(),
  details: JSONValueSchema.optional(),
});
export type Warning = z.infer<typeof WarningSchema>;

// ir-v0 §4.8 — 범용 인용 모델 (Anthropic citations / OpenAI·xAI annotations / Gemini groundingSupports 수용)
export const CitationSchema = z.strictObject({
  source: z.strictObject({
    type: z.enum(["url", "document", "file", "search"]),
    url: z.string().optional(),
    title: z.string().optional(),
    documentIndex: z.number().int().nonnegative().optional(),
    fileId: z.string().optional(),
  }),
  citedText: z.string().optional(),
  location: z
    .strictObject({
      type: z.enum(["char", "page", "block", "outputRange"]),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .optional(),
});
export type Citation = z.infer<typeof CitationSchema>;

// ir-v0 §6.3 — reasoning effort 합집합 (G3). 미지원 값은 모델 게이트가 클램프 + warning.
export const EffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type Effort = z.infer<typeof EffortSchema>;
