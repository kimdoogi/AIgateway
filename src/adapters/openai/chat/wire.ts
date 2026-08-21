import { z } from "zod";

// OpenAI Chat Completions 요청 wire 스키마 (D4 요청 방향 검증 — 인벤토리 §1/§G).
// looseObject — 어댑터 조립 필드만 타입 검증. parse가 알려진 키를 shape 순서로 재배열 (§1 결정론).

const record = z.record(z.string(), z.unknown());

export const ChatWireRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(record),
  tools: z.array(record).optional(),
  tool_choice: z.union([z.string(), record]).optional(),
  parallel_tool_calls: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.array(z.string()).optional(),
  seed: z.number().int().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  logit_bias: z.record(z.string(), z.number()).optional(),
  logprobs: z.boolean().optional(),
  top_logprobs: z.number().int().optional(),
  n: z.number().int().optional(),
  response_format: record.optional(),
  reasoning_effort: z.string().optional(),
  prediction: record.optional(),
  audio: record.optional(),
  modalities: z.array(z.string()).optional(),
  web_search_options: record.optional(),
  service_tier: z.string().optional(),
  prompt_cache_key: z.string().optional(),
  safety_identifier: z.string().optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  store: z.boolean().optional(),
  stream: z.boolean().optional(),
  stream_options: record.optional(),
});
export type ChatWireRequest = z.infer<typeof ChatWireRequestSchema>;
