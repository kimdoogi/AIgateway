// Gemini 응답 방향 신선도 장치 (ADR-0001 §5, D10-5 — 리뷰 2026-08-22 #15).
// 이전에는 anthropic만 완전, openai는 얕게, google·xai는 전무했다 — 4사 중 절반이
// wire 드리프트에 무감각했다는 뜻이다. 재녹화 시 어댑터가 모르는 필드를 경고로 승격한다.
//
// 목록의 기준: 어댑터가 **인지**하는 필드 (소비 여부와 무관 — passthrough로 보존만 하는 것도 포함).
// 소스는 response.ts·stream.ts·errors.ts가 실제로 읽는 키 + 인벤토리 문서(§I).

const RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "candidates",
  "usageMetadata",
  "modelVersion",
  "responseId",
  "promptFeedback",
  "error", // 스트림 중간 에러 청크 (인벤토리 F-2)
]);

const CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  "content",
  "finishReason",
  "index",
  "safetyRatings",
  "citationMetadata",
  "groundingMetadata",
  "urlContextMetadata",
  "tokenCount",
  "avgLogprobs",
  "logprobsResult",
  "finishMessage",
]);

/** part는 타입 태그가 없는 union — 키 조합으로 판별하므로 키 집합 자체가 계약이다 */
const PART_KEYS: ReadonlySet<string> = new Set([
  "text",
  "thought",
  "thoughtSignature",
  "functionCall",
  "functionResponse",
  "inlineData",
  "fileData",
  "executableCode",
  "codeExecutionResult",
  "videoMetadata",
]);

const USAGE_KEYS: ReadonlySet<string> = new Set([
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "thoughtsTokenCount",
  "cachedContentTokenCount",
  "toolUsePromptTokenCount",
  "promptTokensDetails",
  "candidatesTokensDetails",
  "cacheTokensDetails",
  "toolUsePromptTokensDetails",
]);

function unknownIn(obj: unknown, known: ReadonlySet<string>, path: string, found: string[]): void {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (!known.has(key)) found.push(`${path}.${key}`);
  }
}

/** 비스트림 응답(또는 스트림 청크 1건)에서 미지 필드 목록 — 빈 배열 = 드리프트 없음 */
export function unknownResponseFields(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const wire = body as Record<string, unknown>;
  const found: string[] = [];
  unknownIn(wire, RESPONSE_KEYS, "$", found);
  unknownIn(wire["usageMetadata"], USAGE_KEYS, "$.usageMetadata", found);

  const candidates = Array.isArray(wire["candidates"]) ? wire["candidates"] : [];
  candidates.forEach((candidate, ci) => {
    unknownIn(candidate, CANDIDATE_KEYS, `$.candidates[${ci}]`, found);
    const content = (candidate as Record<string, unknown> | null)?.["content"];
    const parts = Array.isArray((content as Record<string, unknown> | undefined)?.["parts"])
      ? ((content as Record<string, unknown>)["parts"] as unknown[])
      : [];
    parts.forEach((part, pi) => {
      unknownIn(part, PART_KEYS, `$.candidates[${ci}].content.parts[${pi}]`, found);
    });
    // content.parts 외의 키 (role 등)는 상위 unknownIn이 아니라 여기서 별도 판정
    if (content && typeof content === "object") {
      for (const key of Object.keys(content as Record<string, unknown>)) {
        if (key !== "parts" && key !== "role") found.push(`$.candidates[${ci}].content.${key}`);
      }
    }
  });
  return found;
}

/** SSE 스트림 전체(청크별 완전 응답)에서 미지 필드 — 청크마다 같은 스키마라 합집합 */
export function unknownStreamFields(chunks: readonly string[]): string[] {
  const found = new Set<string>();
  for (const chunk of chunks) {
    let json: unknown;
    try {
      json = JSON.parse(chunk);
    } catch {
      continue; // 파싱 불가 청크는 어댑터가 warning으로 보존한다 — 여기 관심사 아님
    }
    for (const key of unknownResponseFields(json)) found.add(key);
  }
  return [...found];
}
