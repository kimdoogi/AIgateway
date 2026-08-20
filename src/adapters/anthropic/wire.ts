import { z } from "zod";

// Anthropic Messages 요청 wire 스키마 (D4 요청 방향 검증 — 리뷰 R5).
// looseObject: passthrough(opt-in extra, passthroughParams, 베타 신필드)로 들어온 미지 키는
// 허용하되(D10 day-1), 어댑터가 조립하는 알려진 필드는 타입 검증한다.
// parse 부수 효과: 알려진 키가 shape 정의 순서로 재배열되어 직렬화 결정론(§1)에 기여.

export const AnthropicWireRequestSchema = z.looseObject({
  model: z.string().min(1),
  max_tokens: z.number().int().positive(),
  system: z.array(z.record(z.string(), z.unknown())).optional(),
  messages: z.array(
    z.looseObject({
      role: z.enum(["user", "assistant", "system"]),
      content: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_choice: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  output_config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  thinking: z.record(z.string(), z.unknown()).optional(),
  service_tier: z.string().optional(),
  stream: z.boolean().optional(),
});
export type AnthropicWireRequest = z.infer<typeof AnthropicWireRequestSchema>;
