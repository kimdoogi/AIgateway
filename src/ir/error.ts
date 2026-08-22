import { z } from "zod";
import { JSONValueSchema } from "./json.js";

// ir-v0 §12 — 구조화 에러.
// rate_limit(분당 — 백오프 유효) vs quota_exhausted(일일 — 백오프 무의미, 폴백 적격) 구분 (D7).
// HTTP 200 속 에러(Anthropic in-stream overloaded, Gemini promptFeedback)는 어댑터가 이 모델로 승격.
export const IRErrorCategorySchema = z.enum([
  "invalid_request",
  "auth",
  "permission",
  "not_found",
  "rate_limit",
  "quota_exhausted",
  "content_too_large",
  "overloaded",
  "provider_error",
  "timeout",
  "budget_exceeded",
  "gateway_error",
]);
export type IRErrorCategory = z.infer<typeof IRErrorCategorySchema>;

export const IRErrorSchema = z.strictObject({
  category: IRErrorCategorySchema,
  httpStatus: z.number().int(),
  message: z.string(),
  retryAfter: z.number().nonnegative().optional(), // 초
  fallbackEligible: z.boolean(),
  billed: z.boolean(),
  // 게이트웨이 내부 결함 마킹 — 폴백 트리를 타지 않는다 (폴백 경합 매트릭스)
  gatewayException: z.boolean().optional(),
  provider: z
    .strictObject({
      key: z.string(),
      status: z.number().int().optional(),
      code: z.string().optional(),
      param: z.string().optional(), // 프로바이더가 지목한 문제 필드 (OpenAI/xAI error.param)
      raw: JSONValueSchema.optional(),
    })
    .optional(),
});
export type IRError = z.infer<typeof IRErrorSchema>;
