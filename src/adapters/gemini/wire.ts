import { z } from "zod";

// Gemini generateContent 요청 wire 스키마 (D4 요청 방향 검증).
// looseObject: passthrough(opt-in extra, passthroughParams, 신필드)로 들어온 미지 키는
// 허용하되(D10 day-1), 어댑터가 조립하는 알려진 필드는 타입 검증한다.
// parse 부수 효과: 알려진 키가 shape 정의 순서로 재배열되어 직렬화 결정론(§1)에 기여.

export const GeminiWireRequestSchema = z.looseObject({
  contents: z.array(
    z.looseObject({
      role: z.enum(["user", "model"]),
      parts: z.array(z.record(z.string(), z.unknown())).min(1),
    }),
  ),
  systemInstruction: z
    .looseObject({ parts: z.array(z.record(z.string(), z.unknown())).min(1) })
    .optional(),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  toolConfig: z.record(z.string(), z.unknown()).optional(),
  safetySettings: z.array(z.record(z.string(), z.unknown())).optional(),
  generationConfig: z.record(z.string(), z.unknown()).optional(),
  cachedContent: z.string().optional(),
  serviceTier: z.string().optional(),
  store: z.boolean().optional(),
});
export type GeminiWireRequest = z.infer<typeof GeminiWireRequestSchema>;
