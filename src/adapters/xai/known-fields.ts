// xAI 응답 방향 신선도 장치 — openai base 오버레이 (감사 xai #4).
// base(CC/Responses 자동 판별) 위에 xAI 고유 인지 필드만 추가:
// - request_id: deferred completions 핸들 (부록 (b) §4 — 2026-08-25 실측 {request_id} 단독 응답)
// - citations / output_files: CC 최상위 확장 (인벤토리 B2 — IR 승격은 감사 xai #4 후속)

import { unknownResponseFields as baseUnknownResponseFields } from "../openai/known-fields.js";

const XAI_EXTRA_RESPONSE_KEYS: ReadonlySet<string> = new Set(["request_id", "citations", "output_files"]);

export function unknownResponseFields(body: unknown): string[] {
  return baseUnknownResponseFields(body).filter((entry) => {
    const key = entry.startsWith("$.") ? entry.slice(2) : entry;
    return !XAI_EXTRA_RESPONSE_KEYS.has(key);
  });
}
