import type { JSONValue } from "../../ir/json.js";
import type { IRError, IRErrorCategory } from "../../ir/error.js";
import type { FinishReason } from "../../ir/finish.js";
import type { Usage } from "../../ir/usage.js";

// OpenAI 공통(양 표면) — 에러 모델(인벤토리 §E), usage 정규화(§F/ir-v0 §8), finishReason(§9).

export const OPENAI_PROVIDER = "openai";

// ── usage ────────────────────────────────────────────────
// Responses: input_tokens(+details.cached_tokens) / output_tokens(+details.reasoning_tokens)
// CC:        prompt_tokens(+details) / completion_tokens(+details)
// ir-v0 §8 OpenAI 행: input.total = input_tokens, noCache = input − cached, cacheWrite = 0
//   (OpenAI는 캐시 **쓰기** 카운트를 노출하지 않는다 — 정산 한계는 problem log 2026-08-21 참조)

export interface OpenAIWireUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [k: string]: unknown };
  output_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
  prompt_tokens_details?: { cached_tokens?: number; [k: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
  [k: string]: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function convertUsage(wire: OpenAIWireUsage | undefined): Usage {
  const w = wire ?? {};
  const inputTotal = num(w.input_tokens ?? w.prompt_tokens);
  const cacheRead = num(w.input_tokens_details?.cached_tokens ?? w.prompt_tokens_details?.cached_tokens);
  // cache_write_tokens: 2026-08-21 실 API에서 확인 (구 인벤토리의 "쓰기 미관측" 전제 폐기 — problem log)
  const cacheWrite = num(w.input_tokens_details?.cache_write_tokens);
  const outputTotal = num(w.output_tokens ?? w.completion_tokens);
  const reasoning = num(
    w.output_tokens_details?.reasoning_tokens ?? w.completion_tokens_details?.reasoning_tokens,
  );
  const noCache = Math.max(0, inputTotal - cacheRead - cacheWrite);
  const text = Math.max(0, outputTotal - reasoning);
  return {
    input: { total: inputTotal, noCache, cacheRead, cacheWrite },
    output: { total: outputTotal, text, reasoning },
    totalTokens: inputTotal + outputTotal,
    raw: w as JSONValue,
  };
}

// ── finishReason ─────────────────────────────────────────
// Responses: status(completed/incomplete/failed) + incomplete_details.reason
// CC:        finish_reason(stop/length/tool_calls/content_filter/function_call)

const CC_FINISH_MAP: Record<string, FinishReason["unified"]> = {
  stop: "stop",
  length: "length",
  end_turn: "stop", // xAI CC (base 상속 — ADR-0004 D8. OpenAI는 미발행)
  tool_calls: "tool_call",
  function_call: "tool_call",
  content_filter: "content_filter",
};

export function mapChatFinishReason(raw: string | null | undefined): FinishReason {
  if (raw == null) return { unified: "other", raw: "" };
  return { unified: CC_FINISH_MAP[raw] ?? "other", raw };
}

export interface ResponsesStatusInput {
  status?: string | null;
  incompleteReason?: string | null;
  /** 출력에 function_call/custom_tool_call이 있는가 (완료 상태의 tool_call 판정) */
  hasToolCall?: boolean;
  /** 출력에 refusal 파트가 있는가 */
  hasRefusal?: boolean;
}

export function mapResponsesFinishReason(input: ResponsesStatusInput): FinishReason {
  const status = input.status ?? "";
  if (status === "incomplete") {
    const reason = input.incompleteReason ?? "";
    const unified: FinishReason["unified"] =
      reason === "max_output_tokens"
        ? "length"
        : reason === "content_filter"
          ? "content_filter"
          : "other";
    return { unified, raw: reason.length > 0 ? `incomplete:${reason}` : "incomplete" };
  }
  if (status === "failed") return { unified: "error", raw: "failed" };
  if (status === "cancelled") return { unified: "other", raw: "cancelled" };
  if (input.hasRefusal) return { unified: "refusal", raw: status || "completed" };
  if (input.hasToolCall) return { unified: "tool_call", raw: status || "completed" };
  if (status === "completed" || status === "") return { unified: "stop", raw: status || "completed" };
  return { unified: "other", raw: status };
}

// ── 에러 (인벤토리 §E) ────────────────────────────────────
interface ErrorMapEntry {
  category: IRErrorCategory;
  fallbackEligible: boolean;
  status: number;
}

/** error.type 기준 */
const ERROR_TYPE_MAP: Record<string, ErrorMapEntry> = {
  invalid_request_error: { category: "invalid_request", fallbackEligible: false, status: 400 },
  invalid_prompt: { category: "invalid_request", fallbackEligible: false, status: 400 },
  authentication_error: { category: "auth", fallbackEligible: false, status: 401 },
  permission_error: { category: "permission", fallbackEligible: false, status: 403 },
  not_found_error: { category: "not_found", fallbackEligible: false, status: 404 },
  rate_limit_error: { category: "rate_limit", fallbackEligible: true, status: 429 },
  insufficient_quota: { category: "quota_exhausted", fallbackEligible: true, status: 429 },
  server_error: { category: "provider_error", fallbackEligible: true, status: 500 },
  api_error: { category: "provider_error", fallbackEligible: true, status: 500 },
  timeout: { category: "timeout", fallbackEligible: true, status: 408 },
};

/** error.code 기준 (type보다 구체적 — quota/context 구분에 필요) */
const ERROR_CODE_MAP: Record<string, ErrorMapEntry> = {
  context_length_exceeded: { category: "content_too_large", fallbackEligible: false, status: 400 },
  string_above_max_length: { category: "content_too_large", fallbackEligible: false, status: 400 },
  credit_balance_exhausted: { category: "quota_exhausted", fallbackEligible: true, status: 429 },
  organization_spend_limit_exceeded: { category: "quota_exhausted", fallbackEligible: true, status: 429 },
  project_spend_limit_exceeded: { category: "quota_exhausted", fallbackEligible: true, status: 429 },
  insufficient_quota: { category: "quota_exhausted", fallbackEligible: true, status: 429 },
  rate_limit_exceeded: { category: "rate_limit", fallbackEligible: true, status: 429 },
  previous_response_not_found: { category: "not_found", fallbackEligible: false, status: 404 },
  model_not_found: { category: "not_found", fallbackEligible: false, status: 404 },
  unsupported_parameter: { category: "invalid_request", fallbackEligible: false, status: 400 },
  unsupported_value: { category: "invalid_request", fallbackEligible: false, status: 400 },
};

function statusFallback(status: number): ErrorMapEntry {
  if (status === 401) return { category: "auth", fallbackEligible: false, status };
  if (status === 403) return { category: "permission", fallbackEligible: false, status };
  if (status === 404) return { category: "not_found", fallbackEligible: false, status };
  if (status === 408) return { category: "timeout", fallbackEligible: true, status };
  if (status === 409) return { category: "invalid_request", fallbackEligible: false, status };
  if (status === 413) return { category: "content_too_large", fallbackEligible: false, status };
  if (status === 422) return { category: "invalid_request", fallbackEligible: false, status };
  if (status === 429) return { category: "rate_limit", fallbackEligible: true, status };
  if (status === 503) return { category: "overloaded", fallbackEligible: true, status };
  if (status >= 500) return { category: "provider_error", fallbackEligible: true, status };
  return { category: "invalid_request", fallbackEligible: false, status };
}

interface ParsedErrorBody {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
}

export function extractErrorBody(body: unknown): ParsedErrorBody {
  if (typeof body !== "object" || body === null) return {};
  const root = body as Record<string, unknown>;
  const errRaw = root["error"] ?? root; // 스트림 error 이벤트는 error 래퍼 없이 오기도 한다
  if (typeof errRaw !== "object" || errRaw === null) return {};
  const e = errRaw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  return {
    ...(str("type") !== undefined ? { type: str("type")! } : {}),
    ...(str("code") !== undefined ? { code: str("code")! } : {}),
    ...(str("message") !== undefined ? { message: str("message")! } : {}),
    ...(str("param") !== undefined ? { param: str("param")! } : {}),
  };
}

export function mapOpenAIError(status: number, body: unknown, headers?: Record<string, string>): IRError {
  const { type, code, message, param } = extractErrorBody(body);
  const entry =
    (code !== undefined ? ERROR_CODE_MAP[code] : undefined) ??
    (type !== undefined ? ERROR_TYPE_MAP[type] : undefined) ??
    statusFallback(status);
  const retryAfterRaw = headers?.["retry-after"];
  const retryAfter = retryAfterRaw != null ? Number(retryAfterRaw) : undefined;
  // 429는 무과금 (인벤토리 §E), 그 외 HTTP 에러도 생성 없음 = 무과금.
  return {
    category: entry.category,
    httpStatus: status,
    message: message ?? `openai error (HTTP ${status})`,
    ...(retryAfter != null && Number.isFinite(retryAfter) ? { retryAfter } : {}),
    fallbackEligible: entry.fallbackEligible,
    billed: false,
    provider: {
      key: OPENAI_PROVIDER,
      status,
      ...(code ?? type ? { code: code ?? type! } : {}),
      ...(param ? { param } : {}),
      ...(body !== undefined ? { raw: body as JSONValue } : {}),
    },
  };
}

/** HTTP 200 스트림 내 error 이벤트 / response.failed 승격 (ir-v0 §12) */
export function mapInStreamError(body: unknown): IRError {
  const { type, code } = extractErrorBody(body);
  const entry =
    (code !== undefined ? ERROR_CODE_MAP[code] : undefined) ??
    (type !== undefined ? ERROR_TYPE_MAP[type] : undefined);
  return mapOpenAIError(entry?.status ?? 502, body);
}

/** 종료 신호(response.completed/failed) 없는 스트림 절단 */
export function streamTruncationError(surface: string): IRError {
  return {
    category: "provider_error",
    httpStatus: 502,
    message: `openai ${surface} 스트림이 종료 이벤트 없이 끊김`,
    fallbackEligible: true,
    billed: false, // 호출측이 usage 유무에 따라 재설정
    provider: { key: OPENAI_PROVIDER },
  };
}
