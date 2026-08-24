import { GatewayError } from "./errors.js";

// 업스트림 호출 공통 정책 (리뷰 2026-08-22 #6).
// 이전에는 타임아웃·취소 전파가 execute.dispatch에만 있었고 count_tokens·Files·Batches·
// 리소스 스윕(총 24개 호출 지점)은 생 fetch였다 — 프로바이더가 응답을 안 주면 핸들러가
// 무한정 점유되고, 클라이언트가 끊어도 업스트림이 계속 돌았다.
// 정책을 함수 하나로 모아 fetch 데코레이터로 주입한다 — 호출 지점을 고치지 않아도 적용된다.

/** 접속 타임아웃 기본값 — 헤더 수신까지. body 스트리밍에는 적용되지 않는다 */
export const UPSTREAM_TIMEOUT_MS = Number(process.env["UPSTREAM_TIMEOUT_MS"] ?? 120_000);

export interface UpstreamFetchOptions {
  /** 미지정 시 UPSTREAM_TIMEOUT_MS */
  timeoutMs?: number;
  /** 클라이언트 취소 등 상위 신호 — 전파되면 업스트림도 끊는다 */
  signal?: AbortSignal | undefined;
  /** 에러 메시지에 실릴 호출 맥락 (예: "anthropic 파일 업로드") */
  label: string;
}

/**
 * fetch 데코레이터 — 접속 타임아웃 + 상위 취소 신호를 강제한다.
 * 타임아웃은 504 GatewayError(폴백 적격)로 승격하고, 상위 취소는 원래 예외를 그대로 던진다
 * (취소는 폴백 대상이 아니다 — 폴백 경합 매트릭스).
 */
export function withUpstreamTimeout(inner: typeof fetch, opts: UpstreamFetchOptions): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs);
    timer.unref?.();
    const signals: AbortSignal[] = [timeoutCtrl.signal];
    if (opts.signal) signals.push(opts.signal);
    if (init?.signal) signals.push(init.signal);
    try {
      return await inner(input, { ...init, signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals) });
    } catch (err) {
      // 타임아웃만 승격 — 상위 취소가 원인이면 호출측의 취소 처리 경로를 타야 한다
      if (timeoutCtrl.signal.aborted && !opts.signal?.aborted) {
        throw new GatewayError({
          category: "timeout",
          httpStatus: 504,
          message: `업스트림 접속 타임아웃 (${opts.label}, ${timeoutMs}ms)`,
          fallbackEligible: true,
          billed: false,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}
