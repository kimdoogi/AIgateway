import { z } from "zod";
import { JSONValueSchema } from "./json.js";

// ir-v0 §8 — 프로바이더별 정규화 공식은 어댑터 계약 (G4):
//   Anthropic: input.total = input_tokens + cache_read + cache_creation (합성)
//   OpenAI:    input.noCache = input_tokens − cached_tokens (역산)
//   Gemini:    output.total = candidatesTokenCount + thoughtsTokenCount (합산)
//   xAI:       OpenAI형
// 산식: totalTokens = input.total + output.total (게이트웨이 산식 — raw 전사가 아님)
//        output.text = output.total − output.reasoning

const nonneg = z.number().int().nonnegative();

export const UsageSchema = z.strictObject({
  input: z.strictObject({
    total: nonneg,
    noCache: nonneg,
    cacheRead: nonneg,
    cacheWrite: nonneg,
  }),
  output: z.strictObject({
    total: nonneg,
    text: nonneg,
    reasoning: nonneg,
  }),
  totalTokens: nonneg,
  raw: JSONValueSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

// 스트림 usage-interim 용 부분 usage (ir-v0 §10.3)
export const UsageInterimSchema = z.strictObject({
  input: z
    .strictObject({
      total: nonneg.optional(),
      noCache: nonneg.optional(),
      cacheRead: nonneg.optional(),
      cacheWrite: nonneg.optional(),
    })
    .optional(),
  output: z
    .strictObject({
      total: nonneg.optional(),
      text: nonneg.optional(),
      reasoning: nonneg.optional(),
    })
    .optional(),
  totalTokens: nonneg.optional(),
});
export type UsageInterim = z.infer<typeof UsageInterimSchema>;
