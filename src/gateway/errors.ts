import type { IRError, IRErrorCategory } from "../ir/error.js";

/** IRError를 싣고 던지는 게이트웨이 예외 — 서버가 httpStatus로 응답 (ir-v0 §12) */
export class GatewayError extends Error {
  /** 리트라이 루프가 소진한 시도 수 — 원장 최종 행의 attempt (dispatchWithRetry가 세팅) */
  attempt?: number;
  /** 클라이언트 노출용 시도 이력 (ir-v0 §7) */
  attempts?: import("../ir/response.js").Attempt[];
  constructor(readonly irError: IRError) {
    super(irError.message);
    this.name = "GatewayError";
  }
}

/**
 * 게이트웨이 발신 IRError 단일 조립점 (리뷰 RU2).
 * gatewayException은 §12 정의상 "게이트웨이 내부 결함"에만 — 클라이언트 귀책(400·410·499)은
 * 기본 false (리뷰 F3-r3: 결함 메트릭 오염 방지).
 */
export function irError(
  category: IRErrorCategory,
  httpStatus: number,
  message: string,
  opts?: { gatewayException?: boolean },
): IRError {
  return {
    category,
    httpStatus,
    message,
    fallbackEligible: false,
    billed: false,
    ...(opts?.gatewayException ? { gatewayException: true } : {}),
  };
}

/** 프로바이더 귀책 오류 — 폴백 적격 (리뷰 RU1-r3: 4개 사이트 통합) */
export function providerError(message: string, providerKey?: string, status?: number): IRError {
  return {
    category: "provider_error",
    httpStatus: 502,
    message,
    fallbackEligible: true,
    billed: false,
    ...(providerKey ? { provider: { key: providerKey, ...(status !== undefined ? { status } : {}) } } : {}),
  };
}

/** 임의 예외 → IRError 정규화. 예상외 예외 = 게이트웨이 내부 결함 (gatewayException:true) */
export function toIRError(err: unknown): IRError {
  if (err instanceof GatewayError) return err.irError;
  return irError("gateway_error", 500, err instanceof Error ? err.message : String(err), {
    gatewayException: true,
  });
}

export function notFoundError(message: string): GatewayError {
  return new GatewayError(irError("not_found", 404, message));
}
