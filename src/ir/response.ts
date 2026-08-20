import { z } from "zod";
import { NSSchema, OriginSchema, WarningSchema } from "./common.js";
import { BlockSchema } from "./blocks.js";
import { FinishReasonSchema } from "./finish.js";
import { UsageSchema } from "./usage.js";
import { BillingSchema } from "./billing.js";

// ir-v0 §7 — 비스트림 응답 envelope. 단일 후보 (G2 — message 단수).

export const ResolvedModelSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  surface: z.string().min(1),
});
export type ResolvedModel = z.infer<typeof ResolvedModelSchema>;

export const AttemptSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  outcome: z.enum(["success", "failed", "skipped"]),
  error: z.string().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const IRResponseSchema = z.strictObject({
  version: z.literal("0"),
  id: z.string().min(1), // 게이트웨이 요청 id (req_...)
  created: z.iso.datetime({ offset: true }),
  model: z.strictObject({
    requested: z.string().min(1),
    resolved: ResolvedModelSchema,
  }),
  message: z.strictObject({
    role: z.literal("assistant"),
    blocks: z.array(BlockSchema),
    origin: OriginSchema,
  }),
  finishReason: FinishReasonSchema,
  usage: UsageSchema,
  billing: BillingSchema.optional(),
  warnings: z.array(WarningSchema), // 항상 배열 (빈 배열 허용)
  gateway: z.strictObject({
    requestId: z.string().min(1),
    providerRequestId: z.string().optional(),
    attempts: z.array(AttemptSchema).optional(),
  }),
  providerMetadata: NSSchema.optional(),
});
export type IRResponse = z.infer<typeof IRResponseSchema>;
