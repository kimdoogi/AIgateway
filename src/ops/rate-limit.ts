import type { VirtualKey } from "../state/types.js";
import { GatewayError } from "../gateway/errors.js";

// 요청 빈도 제한 (리뷰 2026-08-22 #14).
// 예산(ADR-0007 §3)은 **지출 발생 후** 평가라 순간 폭주를 막지 못한다 — 루프 버그가 초당
// 수백 요청을 넣으면 예산이 따라잡기 전에 프로바이더 비용이 이미 발생한다.
// 레이트리밋은 그 앞단에서 호출 횟수 자체를 막는다.
//
// 집계는 처음부터 공유 저장소 계약으로 둔다 — 예산에서 겪은 "프로세스 로컬이라 레플리카
// 수만큼 곱해지는" 실패를 반복하지 않기 위해서다.

export interface RateVerdict {
  allowed: boolean;
  /** 창 내 남은 허용량 (거부 시 0) */
  remaining: number;
  /** 거부 시 재시도까지 남은 초 */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** 고정 창 카운터. 호출 자체가 1건을 소비한다 (거부된 요청도 창 카운트에 포함) */
  hit(keyId: string, limit: number, windowSeconds: number, now: Date): Promise<RateVerdict>;
}

/** 창 시작 시각(초) — 고정 창 경계 */
export function windowStart(now: Date, windowSeconds: number): number {
  return Math.floor(now.getTime() / 1000 / windowSeconds) * windowSeconds;
}

/** 단일 프로세스 전용 — 다중 레플리카에서는 RedisRateLimiter를 써야 한도가 성립한다 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, { window: number; count: number }>();

  async hit(keyId: string, limit: number, windowSeconds: number, now: Date): Promise<RateVerdict> {
    const start = windowStart(now, windowSeconds);
    // 만료 창 정리 — 항목 영구 보존은 무인증 메모리 팽창 벡터 (감사 #47)
    // ponytail: 크기 임계 도달 시 전량 스윕 O(n) — 키 수가 문제되면 LRU로
    if (this.counters.size > 10_000) {
      for (const [k, e] of this.counters) {
        if (e.window < start) this.counters.delete(k);
      }
    }
    const entry = this.counters.get(keyId);
    const count = entry && entry.window === start ? entry.count + 1 : 1;
    this.counters.set(keyId, { window: start, count });
    return verdict(count, limit, start, windowSeconds, now);
  }
}

/** 카운트 → 판정 (구현 공유 — 인메모리·Redis가 같은 의미론을 지키게) */
export function verdict(
  count: number,
  limit: number,
  start: number,
  windowSeconds: number,
  now: Date,
): RateVerdict {
  const resetAt = (start + windowSeconds) * 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000));
  return count > limit
    ? { allowed: false, remaining: 0, retryAfterSeconds }
    : { allowed: true, remaining: limit - count, retryAfterSeconds };
}

/** 429 — 게이트웨이 자체 한도 (프로바이더 429와 구분: provider.key = "gateway") */
export function rateLimitedError(keyId: string, limit: number, v: RateVerdict): GatewayError {
  return new GatewayError({
    category: "rate_limit",
    httpStatus: 429,
    message: `요청 빈도 한도 초과 — 분당 ${limit}건 (키 ${keyId}). ${v.retryAfterSeconds}초 후 재시도`,
    retryAfter: v.retryAfterSeconds,
    fallbackEligible: false, // 게이트웨이 한도는 타깃을 바꿔도 그대로다 — 폴백 무의미
    billed: false,
    provider: { key: "gateway", code: "rate-limited" },
  });
}

/** 키에 설정된 분당 한도 (미설정 = 무제한) */
export function limitOf(key: VirtualKey): number | undefined {
  const rpm = key.rateLimit?.requestsPerMinute;
  return typeof rpm === "number" && rpm > 0 ? rpm : undefined;
}
