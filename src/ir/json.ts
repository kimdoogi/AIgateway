import { z } from "zod";

// JSON 직렬화 가능 값 (ir-v0 §1 — wire 스키마가 진실이므로 IR 값은 전부 JSON 표현 가능해야 한다)
export type JSONPrimitive = string | number | boolean | null;
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

// zod 내장 z.json() 사용 (리뷰 CL1 — 수제 재귀 union 대체).
// 성능 주의(리뷰 EF1): union 기반 딥클론이라 깊은 JSON 핫패스에서 비용 — 게이트웨이
// 파이프라인 배선 후 non-cloning 검증기로의 교체를 재평가한다 (review-backlog E1).
export const JSONValueSchema = z.json() as unknown as z.ZodType<JSONValue>;
export const JSONObjectSchema: z.ZodType<JSONObject> = z.record(z.string(), JSONValueSchema);
