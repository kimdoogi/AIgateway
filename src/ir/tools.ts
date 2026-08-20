import { z } from "zod";
import { JSONObjectSchema } from "./json.js";
import { NSSchema } from "./common.js";

// ir-v0 §6.2 — 툴 정의.
export const FunctionToolSchema = z.strictObject({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: JSONObjectSchema, // JSON Schema — 프로바이더별 subset 차이는 어댑터가 검증·다운컨버트(+warning)
  strict: z.boolean().optional(),
  inputExamples: z.array(JSONObjectSchema).optional(),
  providerOptions: NSSchema.optional(), // cache_control, defer_loading, eager_input_streaming 등
});
export type FunctionTool = z.infer<typeof FunctionToolSchema>;

// 서버 실행/프로바이더 정의 툴. 재타게팅 불가가 기본 — 타깃 상이 시 명시적 실패 또는 제거+warning.
export const ProviderToolSchema = z.strictObject({
  type: z.literal("provider"),
  id: z.string().regex(/^[^.\s]+\.[^\s]+$/, "id는 '{provider}.{tool}' 형식"),
  args: JSONObjectSchema.optional(),
  providerOptions: NSSchema.optional(),
});
export type ProviderTool = z.infer<typeof ProviderToolSchema>;

export const ToolSchema = z.discriminatedUnion("type", [FunctionToolSchema, ProviderToolSchema]);
export type Tool = z.infer<typeof ToolSchema>;

export const ToolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("required"),
  z.literal("none"),
  z.strictObject({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;
