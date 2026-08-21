import type { IRError } from "../ir/error.js";

// 리트라이 정책 v0 (walking-skeleton 7단계) — 단일 target, Retry-After 존중 + 총 상한.
// 폴백 트리(타깃 교체)는 로드맵 4 — 여기는 같은 타깃 재시도만.

export interface RetryPolicy {
  maxAttempts: number;
  /** Retry-After 부재 시 백오프 밑수 (attempt^2 * base) */
  baseDelayMs: number;
  /** 단일 대기 상한 — Retry-After가 커도 이 이상 기다리지 않고 포기 */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 10_000 };

/** 재시도 적격: 프로바이더 귀책 + 일시적 (rate_limit / overloaded / provider_error / timeout) */
function isRetryable(error: IRError): boolean {
  if (!error.fallbackEligible) return false;
  return ["rate_limit", "overloaded", "provider_error", "timeout"].includes(error.category);
}

/** 다음 시도까지 대기 ms. null = 재시도 포기 (상한 초과·시도 소진) */
export function retryDelayMs(error: IRError, attempt: number, policy: RetryPolicy): number | null {
  if (attempt >= policy.maxAttempts || !isRetryable(error)) return null;
  if (error.retryAfter !== undefined) {
    const delay = error.retryAfter * 1000;
    return delay > policy.maxDelayMs ? null : delay; // Retry-After가 상한 초과면 즉시 포기 (대기 낭비 금지)
  }
  // 백오프 공식은 상한 클램프 — 포기시키면 maxAttempts가 무력화된다 (리뷰 A7-r4)
  return Math.min(policy.baseDelayMs * attempt * attempt, policy.maxDelayMs);
}
