import { z } from "zod";
import { JSONObjectSchema, JSONValueSchema } from "./json.js";
import { EffortSchema, NSSchema } from "./common.js";
import { MessageSchema } from "./message.js";
import { ToolChoiceSchema, ToolSchema } from "./tools.js";

// ir-v0 §6 — 요청 envelope. strictObject: 미지의 최상위 키는 4xx (D5).
// 필드 정의 순서 = canonical wire 키 순서.

export const ResponseFormatSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text") }),
  z.strictObject({
    type: z.literal("json"),
    schema: JSONObjectSchema.optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    strict: z.boolean().optional(),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

// D6-2 — reasoning 이식 정책 (요청 단위, 전역 플래그 금지)
export const RetargetReasoningSchema = z.enum(["drop", "demote-to-text", "strip-and-annotate"]);

export const IRRequestSchema = z.strictObject({
  version: z.literal("0"),
  model: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
  tools: z.array(ToolSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  parallelToolCalls: z.boolean().optional(), // 기본 true

  // sampling — 모델 게이트로 사전 검증(D10-4), 클램프/드롭은 warning(D5)
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().int().optional(),
  stopSequences: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  presencePenalty: z.number().optional(),
  frequencyPenalty: z.number().optional(),

  responseFormat: ResponseFormatSchema.optional(),
  reasoning: z.strictObject({ effort: EffortSchema.optional() }).optional(),
  metadata: z
    .looseObject({ userId: z.string().optional() })
    .catchall(JSONValueSchema)
    .optional(),

  stream: z.boolean().optional(),
  streamOptions: z
    .strictObject({
      includeRaw: z.boolean().optional(),
      heartbeatSeconds: z.number().int().positive().optional(),
    })
    .optional(),

  retarget: z.strictObject({ reasoning: RetargetReasoningSchema.optional() }).optional(),
  strictParameters: z.boolean().optional(), // D5 strict 모드: 드롭+warning 대신 4xx
  allowUnknownProviderOptions: z.boolean().optional(), // D5 opt-in

  providerOptions: NSSchema.optional(),
  // G1/D10-1 — compat passthrough 경로 전용
  passthroughParams: z
    .strictObject({
      provider: z.string().min(1),
      params: JSONObjectSchema,
      headers: z.record(z.string(), z.string()).optional(),
      pinned: z.boolean().optional(), // true면 해당 provider 외 폴백 타깃은 skipped
    })
    .optional(),
});
export type IRRequest = z.infer<typeof IRRequestSchema>;
