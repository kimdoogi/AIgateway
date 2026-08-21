import { z } from "zod";

// OpenAI Responses 요청 wire 스키마 (D4 요청 방향 검증 — 인벤토리 §A).
// looseObject: opt-in extra/passthroughParams/신필드는 허용하되 어댑터 조립 필드는 타입 검증.
// parse 부수 효과: 알려진 키가 shape 정의 순서로 재배열 — 직렬화 결정론 (ir-v0 §1).

const record = z.record(z.string(), z.unknown());

export const ResponsesWireRequestSchema = z.looseObject({
  model: z.string().min(1),
  instructions: z.string().optional(),
  input: z.array(record),
  reasoning: record.optional(),
  text: record.optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_logprobs: z.number().int().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_tool_calls: z.number().int().positive().optional(),
  tools: z.array(record).optional(),
  tool_choice: z.union([z.string(), record]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  include: z.array(z.string()).optional(),
  store: z.boolean(),
  previous_response_id: z.string().optional(),
  conversation: z.union([z.string(), record]).optional(),
  background: z.boolean().optional(),
  stream: z.boolean().optional(),
  stream_options: record.optional(),
  service_tier: z.string().optional(),
  truncation: z.string().optional(),
  prompt: record.optional(),
  prompt_cache_key: z.string().optional(),
  prompt_cache_options: record.optional(),
  prompt_cache_retention: z.string().optional(),
  safety_identifier: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  context_management: z.array(record).optional(),
  moderation: record.optional(),
});
export type ResponsesWireRequest = z.infer<typeof ResponsesWireRequestSchema>;
