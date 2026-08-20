import { z } from "zod";

// ir-v0 §11 (ADR-0007) — usage(사실)와 billing(금액)의 분리.
export const BillingLineItemSchema = z.strictObject({
  kind: z.enum(["tokens", "server_tool", "iterations", "cache_storage", "search"]),
  sku: z.string().min(1), // 예: "anthropic:claude-opus-5:input:cache_read:1h"
  quantity: z.number().nonnegative(),
  unitCost: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  markup: z.number().optional(), // 리셀 마진 예약 (ADR-0007 §5 — v0는 필드만)
});

export const BillingSchema = z.strictObject({
  lineItems: z.array(BillingLineItemSchema),
  total: z.number().nonnegative(),
  currency: z.literal("USD"), // v0 고정 — 환산은 정산 리포트에서
});
export type Billing = z.infer<typeof BillingSchema>;
