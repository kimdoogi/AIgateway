import type { JSONValue } from "../../ir/json.js";
import type { IRError, IRErrorCategory } from "../../ir/error.js";
import type { FinishReason } from "../../ir/finish.js";
import type { Usage } from "../../ir/usage.js";

// ── finishReason 매핑 (ir-v0 §9 — 개방형: 미지 값은 other + raw 보존. 인벤토리 F-3) ──
const FINISH_REASON_MAP: Record<string, FinishReason["unified"]> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  IMAGE_SAFETY: "content_filter",
  IMAGE_PROHIBITED_CONTENT: "content_filter",
  IMAGE_RECITATION: "content_filter",
  LANGUAGE: "content_filter",
  MALFORMED_FUNCTION_CALL: "tool_error",
  MALFORMED_TOOL_CALL: "tool_error",
  UNEXPECTED_TOOL_CALL: "tool_error",
  TOO_MANY_TOOL_CALLS: "tool_error",
  MISSING_THOUGHT_SIGNATURE: "tool_error",
};

/**
 * Gemini는 함수 호출 종료도 STOP으로 보고한다 (전용 finish 값 없음 — 인벤토리 F-3) →
 * 클라이언트 툴콜 존재 시 unified만 tool_call로 승격 (raw 보존).
 */
export function mapFinishReason(raw: string | null | undefined, hasClientToolCall: boolean): FinishReason {
  if (raw == null) return { unified: "other", raw: "" };
  const unified = FINISH_REASON_MAP[raw] ?? "other";
  if (unified === "stop" && hasClientToolCall) return { unified: "tool_call", raw };
  return { unified, raw };
}

// ── usage 정규화 (ir-v0 §8 표 — Gemini 행) ─────────────────
// promptTokenCount는 캐시 포함, cachedContentTokenCount는 부분집합, thoughts는 별도 필드.
// toolUsePromptTokenCount는 정규화 필드 밖 — raw로만 추적 (§8 산식 주석).
export interface GeminiWireUsage {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
  [k: string]: unknown;
}

export function convertUsage(wire: GeminiWireUsage): Usage {
  const inputTotal = wire.promptTokenCount ?? 0;
  const cacheRead = wire.cachedContentTokenCount ?? 0;
  const text = wire.candidatesTokenCount ?? 0;
  const reasoning = wire.thoughtsTokenCount ?? 0;
  const outputTotal = text + reasoning; // §8 공식: candidates + thoughts 합산
  return {
    input: { total: inputTotal, noCache: Math.max(0, inputTotal - cacheRead), cacheRead, cacheWrite: 0 },
    output: { total: outputTotal, text, reasoning },
    totalTokens: inputTotal + outputTotal,
    raw: wire as JSONValue,
  };
}

// ── HTTP 에러 매핑 (ir-v0 §12, 인벤토리 §G) ─────────────────
// google.rpc 스타일: {"error": {"code": 429, "message", "status": "RESOURCE_EXHAUSTED", "details": [...]}}
// Retry-After 헤더 없음 → details의 RetryInfo.retryDelay에서 추출.
// 429는 분당(rate_limit — 백오프 유효) vs 일일(quota_exhausted — 백오프 무의미) 구분.
interface ErrorMapEntry {
  category: IRErrorCategory;
  fallbackEligible: boolean;
}

const STATUS_MAP: Record<string, ErrorMapEntry> = {
  INVALID_ARGUMENT: { category: "invalid_request", fallbackEligible: false },
  FAILED_PRECONDITION: { category: "permission", fallbackEligible: false }, // 결제 미설정 등
  UNAUTHENTICATED: { category: "auth", fallbackEligible: false },
  PERMISSION_DENIED: { category: "permission", fallbackEligible: false },
  NOT_FOUND: { category: "not_found", fallbackEligible: false },
  RESOURCE_EXHAUSTED: { category: "rate_limit", fallbackEligible: true }, // 일일 쿼터는 아래서 승격
  INTERNAL: { category: "provider_error", fallbackEligible: true },
  UNAVAILABLE: { category: "overloaded", fallbackEligible: true },
  DEADLINE_EXCEEDED: { category: "timeout", fallbackEligible: true },
};

const HTTP_FALLBACK: Record<number, ErrorMapEntry> = {
  400: { category: "invalid_request", fallbackEligible: false },
  401: { category: "auth", fallbackEligible: false },
  403: { category: "permission", fallbackEligible: false },
  404: { category: "not_found", fallbackEligible: false },
  413: { category: "content_too_large", fallbackEligible: false },
  429: { category: "rate_limit", fallbackEligible: true },
  500: { category: "provider_error", fallbackEligible: true },
  503: { category: "overloaded", fallbackEligible: true },
  504: { category: "timeout", fallbackEligible: true },
};

interface WireError {
  status?: string;
  message?: string;
  details?: unknown[];
}

function extractErrorBody(body: unknown): WireError {
  if (typeof body === "object" && body !== null) {
    const err = (body as Record<string, unknown>)["error"];
    if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      return {
        status: typeof e["status"] === "string" ? e["status"] : undefined,
        message: typeof e["message"] === "string" ? e["message"] : undefined,
        details: Array.isArray(e["details"]) ? e["details"] : undefined,
      };
    }
  }
  return {};
}

/** details[]의 RetryInfo.retryDelay ("3.5s" 또는 {seconds, nanos}) → 초 (proto3 zero-omission 유의) */
function extractRetryAfter(details: unknown[] | undefined): number | undefined {
  for (const d of details ?? []) {
    if (typeof d !== "object" || d === null) continue;
    const detail = d as Record<string, unknown>;
    if (typeof detail["@type"] !== "string" || !detail["@type"].endsWith("RetryInfo")) continue;
    const delay = detail["retryDelay"];
    if (typeof delay === "string") {
      const trimmed = delay.replace(/s$/, "");
      if (trimmed.length === 0) continue; // ""·"s" → 0으로 오인 금지 (Number("")===0)
      const secs = Number(trimmed);
      if (Number.isFinite(secs) && secs >= 0) return secs;
    }
    if (typeof delay === "object" && delay !== null) {
      const rec = delay as Record<string, unknown>;
      if (rec["seconds"] === undefined && rec["nanos"] === undefined) continue; // 빈 객체 → 0 오인 금지
      const secs = Number(rec["seconds"] ?? 0) + Number(rec["nanos"] ?? 0) / 1e9; // nanos 합산 (seconds 생략 = 서브초)
      if (Number.isFinite(secs) && secs >= 0) return secs;
    }
  }
  return undefined;
}

/** 429 하위 구분: QuotaFailure/메시지에 일일 쿼터 흔적이 있으면 quota_exhausted (D7) */
function isDailyQuota(wire: WireError): boolean {
  const text = JSON.stringify([wire.message ?? "", wire.details ?? []]);
  return /PerDay|per day|daily/i.test(text);
}

export function mapGeminiError(
  status: number,
  body: unknown,
  _headers?: Record<string, string>,
): IRError {
  const wire = extractErrorBody(body);
  let entry =
    (wire.status !== undefined ? STATUS_MAP[wire.status] : undefined) ??
    HTTP_FALLBACK[status] ??
    (status >= 500
      ? STATUS_MAP["INTERNAL"]!
      : STATUS_MAP["INVALID_ARGUMENT"]!);
  if (entry.category === "rate_limit" && isDailyQuota(wire)) {
    entry = { category: "quota_exhausted", fallbackEligible: true };
  }
  const retryAfter = extractRetryAfter(wire.details);
  return {
    category: entry.category,
    httpStatus: status,
    message: wire.message ?? `gemini error (HTTP ${status})`,
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    fallbackEligible: entry.fallbackEligible,
    billed: false, // HTTP 에러는 생성 없음 = 무과금. mid-stream 과금은 provider-error.usage로 전달
    provider: {
      key: "google",
      status,
      ...(wire.status ? { code: wire.status } : {}),
      ...(body !== undefined ? { raw: body as JSONValue } : {}),
    },
  };
}

/**
 * HTTP 200 soft-block (promptFeedback.blockReason + 빈 candidates) 승격용 IRError (ir-v0 §12).
 * 프롬프트가 정책 차단됨 — 같은 프롬프트는 재시도해도 차단이라 폴백 부적격.
 * billed:true — 200 수신 = 프롬프트 처리됨 (비스트림 원장 규칙 F2-r4와 정합, 리뷰 라운드에서 3원 모순 해소).
 */
export function promptBlockedError(blockReason: string, body: unknown): IRError {
  return {
    category: "invalid_request",
    httpStatus: 400,
    message: `gemini가 프롬프트를 차단함 (promptFeedback.blockReason: ${blockReason}) — HTTP 200 soft-block 승격`,
    fallbackEligible: false,
    billed: true,
    provider: { key: "google", status: 200, code: `prompt_blocked:${blockReason}`, raw: body as JSONValue },
  };
}

/** 종료 신호(finishReason) 없는 스트림 절단 */
export function streamTruncationError(): IRError {
  return {
    category: "provider_error",
    httpStatus: 502,
    message: "gemini 스트림이 finishReason 없이 종료됨",
    fallbackEligible: true,
    billed: false, // 호출측이 usage 유무에 따라 재설정
    provider: { key: "google" },
  };
}
