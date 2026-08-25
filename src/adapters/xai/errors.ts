import type { JSONValue } from "../../ir/json.js";
import type { IRError, IRErrorCategory } from "../../ir/error.js";
import { extractErrorBody as extractOpenAIError, mapOpenAIError } from "../openai/errors.js";

// xAI 에러 모델 (인벤토리 §E, 오버라이드 #1) — 평면 {"code":"400","error":"..."} 포맷.
// OpenAI 중첩 포맷도 병존 가능성이 있어(문서 세대 혼재) 이중 파싱: 평면 우선, 중첩 폴백.

export const XAI_PROVIDER = "xai";

interface FlatError {
  code?: string;
  message?: string;
}

function extractFlat(body: unknown): FlatError {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  // 평면: {"code": "400", "error": "메시지"}
  if (typeof b["error"] === "string") {
    return {
      ...(typeof b["code"] === "string" ? { code: b["code"] } : {}),
      message: b["error"],
    };
  }
  return {};
}

function categorize(status: number, message: string): { category: IRErrorCategory; fallbackEligible: boolean } {
  // 실측(#2): 인증 오류가 400으로 오는 사례 — 상태코드만으로 판정하지 않는다
  if (/api key|authenticat/i.test(message)) return { category: "auth", fallbackEligible: false };
  if (status === 401) return { category: "auth", fallbackEligible: false };
  if (status === 403) return { category: "permission", fallbackEligible: false };
  if (status === 404) return { category: "not_found", fallbackEligible: false };
  if (status === 410) return { category: "invalid_request", fallbackEligible: false }; // 폐기 API (Live Search — #18)
  if (status === 413 || status === 422) return { category: "invalid_request", fallbackEligible: false };
  if (status === 429) return { category: "rate_limit", fallbackEligible: true };
  if (status === 503) return { category: "overloaded", fallbackEligible: true };
  if (status >= 500) return { category: "provider_error", fallbackEligible: true };
  return { category: "invalid_request", fallbackEligible: false };
}

export function mapXAIError(status: number, body: unknown, headers?: Record<string, string>): IRError {
  const flat = extractFlat(body);
  if (flat.message === undefined) {
    // 중첩(OpenAI형) 폴백 — 파서만 빌리고 provider 키는 xai로
    const nested = extractOpenAIError(body);
    if (nested.message !== undefined || nested.type !== undefined) {
      const viaOpenAI = mapOpenAIError(status, body, headers);
      return { ...viaOpenAI, provider: { ...(viaOpenAI.provider ?? { key: XAI_PROVIDER }), key: XAI_PROVIDER } };
    }
  }
  const message = flat.message ?? `xai error (HTTP ${status})`;
  const { category, fallbackEligible } = categorize(status, message);
  const retryAfterRaw = headers?.["retry-after"];
  const retryAfter = retryAfterRaw != null ? Number(retryAfterRaw) : undefined;
  return {
    category,
    httpStatus: status,
    // 단정형 → 추정형 (감사 xai #9: 최신 레퍼런스에 search_parameters 잔존 — 라이브 probe로 확정 전까지)
    message: status === 410 ? `${message} (폐기 추정 API — Live Search는 agent tools 이관 추정, 미확정)` : message,
    ...(retryAfter != null && Number.isFinite(retryAfter) ? { retryAfter } : {}),
    fallbackEligible,
    billed: false,
    provider: {
      key: XAI_PROVIDER,
      status,
      ...(flat.code ? { code: flat.code } : {}),
      ...(body !== undefined ? { raw: body as JSONValue } : {}),
    },
  };
}
