import { z } from "zod";
import { JSONObjectSchema, JSONValueSchema } from "./json.js";
import { CitationSchema, NSSchema, OpaqueStateSchema, OriginSchema } from "./common.js";

// ir-v0 §4 — 블록 union 8종.
// 필드 정의 순서 = canonical wire 키 순서 (ir-v0 §1 직렬화 결정론).
// 공통 꼬리 필드: origin / opaqueState / providerOptions / providerMetadata (§4.0).

const base = {
  id: z.string().optional(),
  origin: OriginSchema.optional(),
  opaqueState: OpaqueStateSchema.optional(),
  providerOptions: NSSchema.optional(),
  providerMetadata: NSSchema.optional(),
};

// §4.1
export const TextBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  citations: z.array(CitationSchema).optional(),
  ...base,
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

// §4.2 — 서명/암호화 상태는 opaqueState에. OpenAI reasoning item 원문 구조는
// providerMetadata.openai에 통째 보존 후 동일 타깃 재전송 시 우선 복원 (무손실 규칙).
export const ReasoningBlockSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  redacted: z.literal(true).optional(),
  ...base,
});
export type ReasoningBlock = z.infer<typeof ReasoningBlockSchema>;

// §4.3 — toolCallId는 필수(G5, 미발급 프로바이더는 §13.2 결정론적 합성).
// input.type=text는 비JSON 툴 입력(OpenAI custom/grammar 등). JSON 파싱 실패 시
// 어댑터가 text로 강등 + warning(tool-input-demoted) — 조용한 날조 금지.
export const ToolCallInputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("json"), value: JSONValueSchema }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
]);

export const ToolCallBlockSchema = z.strictObject({
  type: z.literal("toolCall"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: ToolCallInputSchema,
  providerExecuted: z.literal(true).optional(),
  ...base,
});
export type ToolCallBlock = z.infer<typeof ToolCallBlockSchema>;

// §4.5 — 미디어·문서 (입력/출력 공용). 별도 image 블록 없음 — mediaType으로 구분.
export const FileDataSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("base64"), data: z.string() }),
  z.strictObject({ type: z.literal("url"), url: z.string() }),
  // 프로바이더별 file id (openai file_id, anthropic file_id, google fileUri).
  // 재타게팅 시 타깃 불일치면 인라인 전환 또는 명시적 4xx (D6-8).
  z.strictObject({ type: z.literal("reference"), refs: z.record(z.string(), z.string()) }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
]);

export const FileBlockSchema = z.strictObject({
  type: z.literal("file"),
  mediaType: z.string().min(1),
  filename: z.string().optional(),
  data: FileDataSchema,
  title: z.string().optional(),
  context: z.string().optional(),
  citationsEnabled: z.boolean().optional(),
  ...base,
});
export type FileBlock = z.infer<typeof FileBlockSchema>;

// §4.7 — 게이트웨이가 아는 프로바이더 고유 블록 (라운드트립 보장, 예: anthropic.compaction)
export const CustomBlockSchema = z.strictObject({
  type: z.literal("custom"),
  kind: z.string().regex(/^[^.\s]+\.[^\s]+$/, "kind는 '{provider}.{type}' 형식"),
  payload: JSONValueSchema,
  ...base,
});
export type CustomBlock = z.infer<typeof CustomBlockSchema>;

// §4.4 — 멀티모달 툴 결과. content variant의 Custom은 Anthropic tool_result 내
// search_result 등 (D10).
export const ToolResultOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("json"), value: JSONValueSchema }),
  z.strictObject({
    type: z.literal("content"),
    blocks: z.array(z.discriminatedUnion("type", [TextBlockSchema, FileBlockSchema, CustomBlockSchema])),
  }),
  z.strictObject({ type: z.literal("errorText"), text: z.string() }),
  z.strictObject({ type: z.literal("errorJson"), value: JSONValueSchema }),
  z.strictObject({ type: z.literal("executionDenied"), reason: z.string().optional() }),
]);

export const ToolResultBlockSchema = z.strictObject({
  type: z.literal("toolResult"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  output: ToolResultOutputSchema,
  providerExecuted: z.literal(true).optional(),
  ...base,
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

// §4.6 — 서버 웹서치 결과 출처 (응답 방향, 히스토리 재전송 대상 아님)
export const SourceBlockSchema = z.strictObject({
  type: z.literal("source"),
  sourceType: z.enum(["url", "document"]),
  url: z.string().optional(),
  title: z.string().optional(),
  snippet: z.string().optional(),
  ...base,
});
export type SourceBlock = z.infer<typeof SourceBlockSchema>;

// §4.9 — 게이트웨이가 모르는 블록 (G1/D10). 미터링·정책은 항상 적용(IR 우회 없음).
export const PassthroughBlockSchema = z.strictObject({
  type: z.literal("passthrough"),
  provider: z.string().min(1),
  raw: JSONValueSchema,
  ...base,
});
export type PassthroughBlock = z.infer<typeof PassthroughBlockSchema>;

export const BlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ReasoningBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
  FileBlockSchema,
  SourceBlockSchema,
  CustomBlockSchema,
  PassthroughBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;
export type BlockType = Block["type"];
