import { z } from "zod";
import { JSONValueSchema } from "./json.js";
import { CitationSchema, NSSchema, OpaqueStateSchema, OriginSchema, WarningSchema } from "./common.js";
import {
  CustomBlockSchema,
  FileBlockSchema,
  PassthroughBlockSchema,
  SourceBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
} from "./blocks.js";
import { FinishReasonSchema } from "./finish.js";
import { UsageInterimSchema, UsageSchema } from "./usage.js";
import { BillingSchema } from "./billing.js";
import { IRErrorSchema } from "./error.js";
import { AttemptSchema, ResolvedModelSchema } from "./response.js";

// ir-v0 §10 (ADR-0005) — 스트림 이벤트. 모든 이벤트에 seq (단조 증가, 재개 커서).
// 모든 스트림은 finish | error-final | (error-partial 후 미재시도) 로 끝난다 — 어댑터 계약.

const seq = { seq: z.number().int().nonnegative() };

// ── 수명주기 ──────────────────────────────────────────────
const StreamStart = z.strictObject({
  type: z.literal("stream-start"),
  ...seq,
  warnings: z.array(WarningSchema),
});
const ResponseMetadata = z.strictObject({
  type: z.literal("response-metadata"),
  ...seq,
  id: z.string().min(1),
  created: z.iso.datetime({ offset: true }),
  model: z.strictObject({ requested: z.string().min(1), resolved: ResolvedModelSchema }),
  providerRequestId: z.string().optional(),
  providerMetadata: NSSchema.optional(), // wire 선두 고유 메타 — Anthropic container 등 (§10.1, 2026-08-21)
});
const Finish = z.strictObject({
  type: z.literal("finish"),
  ...seq,
  finishReason: FinishReasonSchema,
  usage: UsageSchema,
  billing: BillingSchema.optional(),
  attempts: z.array(AttemptSchema).optional(),
  providerMetadata: NSSchema.optional(),
});
const ErrorFinal = z.strictObject({
  type: z.literal("error-final"),
  ...seq,
  error: IRErrorSchema,
  usage: UsageSchema.optional(), // 과금 발생 시 필수 (스키마는 optional — 산출 불가 케이스)
});
const ErrorPartial = z.strictObject({
  type: z.literal("error-partial"),
  ...seq,
  error: IRErrorSchema,
  usage: UsageSchema.optional(),
  willRetry: z.boolean(),
});

// ── 콘텐츠 (id 기반 블록 스코프) ──────────────────────────
const TextStart = z.strictObject({ type: z.literal("text-start"), ...seq, id: z.string().min(1) });
const TextDelta = z.strictObject({
  type: z.literal("text-delta"),
  ...seq,
  id: z.string().min(1),
  delta: z.string(),
});
// text-end에 opaqueState 슬롯 — Gemini "빈 text part + thoughtSignature" 대응 (스키마 검증 A-1)
const TextEnd = z.strictObject({
  type: z.literal("text-end"),
  ...seq,
  id: z.string().min(1),
  opaqueState: OpaqueStateSchema.optional(),
  providerMetadata: NSSchema.optional(),
});
const ReasoningStart = z.strictObject({
  type: z.literal("reasoning-start"),
  ...seq,
  id: z.string().min(1),
  redacted: z.literal(true).optional(),
});
// 내용 없는 delta에 opaqueState/metadata만 싣는 패턴 허용 (Anthropic signature_delta)
const ReasoningDelta = z.strictObject({
  type: z.literal("reasoning-delta"),
  ...seq,
  id: z.string().min(1),
  delta: z.string().optional(),
  opaqueState: OpaqueStateSchema.optional(),
  providerMetadata: NSSchema.optional(),
});
const ReasoningEnd = z.strictObject({
  type: z.literal("reasoning-end"),
  ...seq,
  id: z.string().min(1),
});
const ToolInputStart = z.strictObject({
  type: z.literal("tool-input-start"),
  ...seq,
  id: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  providerExecuted: z.literal(true).optional(),
});
const ToolInputDelta = z.strictObject({
  type: z.literal("tool-input-delta"),
  ...seq,
  id: z.string().min(1),
  delta: z.string(),
});
const ToolInputEnd = z.strictObject({
  type: z.literal("tool-input-end"),
  ...seq,
  id: z.string().min(1),
});
// 완성본 재전송 — 소비자는 delta를 무시하고 이것만 받아도 된다
const ToolCallEvent = z.strictObject({ type: z.literal("tool-call"), ...seq, block: ToolCallBlockSchema });
const ToolResultEvent = z.strictObject({
  type: z.literal("tool-result"),
  ...seq,
  block: ToolResultBlockSchema,
});
const FileEvent = z.strictObject({ type: z.literal("file"), ...seq, block: FileBlockSchema });
const SourceEvent = z.strictObject({ type: z.literal("source"), ...seq, block: SourceBlockSchema });
const CustomEvent = z.strictObject({ type: z.literal("custom"), ...seq, block: CustomBlockSchema });
const PassthroughEvent = z.strictObject({
  type: z.literal("passthrough"),
  ...seq,
  block: PassthroughBlockSchema,
});
const CitationDelta = z.strictObject({
  type: z.literal("citation-delta"),
  ...seq,
  id: z.string().min(1), // 대상 text 블록
  citation: CitationSchema,
});

// ── 운영 (게이트웨이 발신) ────────────────────────────────
const Heartbeat = z.strictObject({ type: z.literal("heartbeat"), ...seq });
const ProviderSwitched = z.strictObject({
  type: z.literal("provider-switched"),
  ...seq,
  from: OriginSchema,
  to: OriginSchema,
  reason: z.string(),
});
const UsageInterim = z.strictObject({
  type: z.literal("usage-interim"),
  ...seq,
  usage: UsageInterimSchema,
});
const WarningEvent = z.strictObject({ type: z.literal("warning"), ...seq, warning: WarningSchema });
const RawEvent = z.strictObject({
  type: z.literal("raw"),
  ...seq,
  provider: z.string().min(1),
  value: JSONValueSchema,
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  StreamStart,
  ResponseMetadata,
  TextStart,
  TextDelta,
  TextEnd,
  ReasoningStart,
  ReasoningDelta,
  ReasoningEnd,
  ToolInputStart,
  ToolInputDelta,
  ToolInputEnd,
  ToolCallEvent,
  ToolResultEvent,
  FileEvent,
  SourceEvent,
  CustomEvent,
  PassthroughEvent,
  CitationDelta,
  Heartbeat,
  ProviderSwitched,
  UsageInterim,
  WarningEvent,
  RawEvent,
  Finish,
  ErrorFinal,
  ErrorPartial,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type StreamEventType = StreamEvent["type"];

export const TERMINAL_EVENT_TYPES = ["finish", "error-final", "error-partial"] as const;
// 주의(로드맵 4): error-partial + willRetry:true는 논리적으로 터미널이 아니다 — 폴백 트리 구현 시
// 세션 done 처리에서 예외 필요 (problem log 2026-08-21 참조)
export const TERMINAL_EVENT_SET: ReadonlySet<string> = new Set(TERMINAL_EVENT_TYPES);
