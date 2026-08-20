import { z } from "zod";

// ir-v0 §9 (G7) — unified는 닫힌 enum, raw는 프로바이더 원문 보존.
// 어댑터 규칙: 미지의 raw 값은 unified 'other'로 접는다 (개방형 파싱 — 닫힌 enum 파싱 금지).
export const FinishReasonUnifiedSchema = z.enum([
  "stop",
  "length",
  "tool_call",
  "content_filter",
  "refusal",
  "paused",
  "tool_error",
  "error",
  "other",
]);
export type FinishReasonUnified = z.infer<typeof FinishReasonUnifiedSchema>;

export const FinishReasonSchema = z.strictObject({
  unified: FinishReasonUnifiedSchema,
  raw: z.string(),
});
export type FinishReason = z.infer<typeof FinishReasonSchema>;
