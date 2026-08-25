// OpenAI 응답 방향 신선도 장치 — 얕은 적용 (간극 문서 H: D10-5 하드 보장은 Anthropic 한정).
// 재녹화 시 어댑터가 모르는 top-level 필드·item 타입만 검출한다. item 내부 키 전수는 비적용.

import { CLIENT_EXECUTED_CALL_TYPES, CUSTOM_ITEM_TYPES, SERVER_TOOL_CALL_TYPES } from "./responses/response.js";

const RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "id", "object", "created_at", "completed_at", "status", "incomplete_details", "error", "model",
  "output", "output_text", "usage", "instructions", "reasoning", "text", "temperature", "top_p",
  "top_logprobs", "max_output_tokens", "max_tool_calls", "tools", "tool_choice", "parallel_tool_calls",
  "store", "previous_response_id", "conversation", "background", "truncation", "service_tier",
  "metadata", "safety_identifier", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention",
  "user", "billing", "context_management", "moderation", "include", "stream_options", "frequency_penalty", "presence_penalty",
  "tool_usage", // 2026-08-21 녹화에서 검출 — 서버 툴 사용량 요약 (problem log 참조)
]);

const CC_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier",
]);

const ITEM_TYPES: ReadonlySet<string> = new Set([
  "message", "reasoning", "function_call", "function_call_output", "custom_tool_call",
  "custom_tool_call_output", "image_generation_call", "computer_call_output",
  ...SERVER_TOOL_CALL_TYPES, ...CLIENT_EXECUTED_CALL_TYPES, ...CUSTOM_ITEM_TYPES,
]);

/** 비스트림 응답 body에서 미지의 top-level 필드·item 타입 목록 (Responses/CC 형태 자동 판별) */
export function unknownResponseFields(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const wire = body as Record<string, unknown>;
  const found: string[] = [];
  const keySet = Array.isArray(wire["choices"]) ? CC_RESPONSE_KEYS : RESPONSE_KEYS;
  for (const key of Object.keys(wire)) {
    if (!keySet.has(key)) found.push(`$.${key}`);
  }
  const output = wire["output"];
  if (Array.isArray(output)) {
    output.forEach((item, i) => {
      const type = item && typeof item === "object" ? (item as Record<string, unknown>)["type"] : undefined;
      if (typeof type !== "string" || !ITEM_TYPES.has(type)) {
        found.push(`$.output[${i}]: 미지 item 타입 '${String(type)}'`);
      }
    });
  }
  return found;
}
