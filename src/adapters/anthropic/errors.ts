import type { JSONValue } from "../../ir/json.js";
import type { IRError, IRErrorCategory } from "../../ir/error.js";
import type { FinishReason } from "../../ir/finish.js";
import type { Usage } from "../../ir/usage.js";

// ── stop_reason 매핑 (ir-v0 §9 — 개방형: 미지 값은 other + raw 보존) ──
const STOP_REASON_MAP: Record<string, FinishReason["unified"]> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  tool_use: "tool_call",
  pause_turn: "paused", // 항상 노출 (ADR-0005 §2)
  refusal: "refusal",
};

export function mapStopReason(raw: string | null | undefined): FinishReason {
  if (raw == null) return { unified: "other", raw: "" };
  return { unified: STOP_REASON_MAP[raw] ?? "other", raw };
}

// ── usage 정규화 (ir-v0 §8 G4 공식) ─────────────────────────
// Anthropic input_tokens는 non-cached만 → total은 합성
export interface AnthropicWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export function convertUsage(wire: AnthropicWireUsage): Usage {
  const noCache = wire.input_tokens ?? 0;
  const cacheRead = wire.cache_read_input_tokens ?? 0;
  const cacheWrite = wire.cache_creation_input_tokens ?? 0;
  const inputTotal = noCache + cacheRead + cacheWrite;
  const outputTotal = wire.output_tokens ?? 0;
  return {
    input: { total: inputTotal, noCache, cacheRead, cacheWrite },
    // Anthropic은 reasoning 토큰 분리 미제공 → reasoning 0, text = total (ir-v0 §8 표)
    output: { total: outputTotal, text: outputTotal, reasoning: 0 },
    totalTokens: inputTotal + outputTotal,
    raw: wire as JSONValue,
  };
}

// ── HTTP/wire 에러 매핑 (ir-v0 §12) ────────────────────────
interface ErrorMapEntry {
  category: IRErrorCategory;
  fallbackEligible: boolean;
  /** in-stream(HTTP 200) 에러 승격 시 부여할 status (리뷰 P7 — category와 정합) */
  status: number;
}

const ERROR_TYPE_MAP: Record<string, ErrorMapEntry> = {
  invalid_request_error: { category: "invalid_request", fallbackEligible: false, status: 400 },
  authentication_error: { category: "auth", fallbackEligible: false, status: 401 },
  permission_error: { category: "permission", fallbackEligible: false, status: 403 },
  not_found_error: { category: "not_found", fallbackEligible: false, status: 404 },
  request_too_large: { category: "content_too_large", fallbackEligible: false, status: 413 },
  rate_limit_error: { category: "rate_limit", fallbackEligible: true, status: 429 },
  api_error: { category: "provider_error", fallbackEligible: true, status: 500 },
  overloaded_error: { category: "overloaded", fallbackEligible: true, status: 529 },
};

function extractErrorBody(body: unknown): { type?: string; message?: string } {
  if (typeof body === "object" && body !== null) {
    const err = (body as Record<string, unknown>)["error"];
    if (typeof err === "object" && err !== null) {
      const e = err as Record<string, unknown>;
      return {
        type: typeof e["type"] === "string" ? e["type"] : undefined,
        message: typeof e["message"] === "string" ? e["message"] : undefined,
      };
    }
  }
  return {};
}

export function mapAnthropicError(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): IRError {
  const { type, message } = extractErrorBody(body);
  const entry =
    (type !== undefined ? ERROR_TYPE_MAP[type] : undefined) ??
    (status === 429
      ? ERROR_TYPE_MAP["rate_limit_error"]!
      : status === 529
        ? ERROR_TYPE_MAP["overloaded_error"]!
        : status >= 500
          ? ERROR_TYPE_MAP["api_error"]!
          : ERROR_TYPE_MAP["invalid_request_error"]!);
  const retryAfterRaw = headers?.["retry-after"];
  const retryAfter = retryAfterRaw != null ? Number(retryAfterRaw) : undefined;
  return {
    category: entry.category,
    httpStatus: status,
    message: message ?? `anthropic error (HTTP ${status})`,
    ...(retryAfter != null && Number.isFinite(retryAfter) ? { retryAfter } : {}),
    fallbackEligible: entry.fallbackEligible,
    billed: false, // HTTP 에러는 생성 없음 = 무과금. mid-stream 과금은 provider-error.usage로 전달
    provider: {
      key: "anthropic",
      status,
      ...(type ? { code: type } : {}),
      ...(body !== undefined ? { raw: body as JSONValue } : {}),
    },
  };
}

/**
 * HTTP 200 스트림 내 error 이벤트 승격 — type별 정합 status 부여 (invalid_request→400 등,
 * overloaded→529는 Vercel first-chunk 프로브 패턴). 미지 타입은 502 provider_error.
 */
export function mapInStreamError(errType: string | undefined, message: string | undefined): IRError {
  const status = (errType !== undefined ? ERROR_TYPE_MAP[errType]?.status : undefined) ?? 502;
  return mapAnthropicError(status, { error: { type: errType, message } });
}

/** 종료 신호 없는 스트림 절단 (리뷰 C3 — IRError 규약의 단일 소스 유지) */
export function streamTruncationError(): IRError {
  return {
    category: "provider_error",
    httpStatus: 502,
    message: "anthropic 스트림이 message_stop 없이 종료됨",
    fallbackEligible: true,
    billed: false, // 호출측이 usage 유무에 따라 재설정
    provider: { key: "anthropic" },
  };
}
