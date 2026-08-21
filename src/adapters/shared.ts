import type { z } from "zod";
import type { JSONObject, JSONValue } from "../ir/json.js";
import type { NS, Warning, WarningCode } from "../ir/common.js";
import type { IRError } from "../ir/error.js";

// 어댑터 공통 유틸 (리뷰 A1/A2/C2) — 프로바이더별로 다른 것은 네임스페이스 키·스키마뿐,
// 정책 골격(D5 미지 키 처리, 미지원 파라미터 드롭, warning 조립)은 전 어댑터 공유.

/** 어댑터가 던지는 클라이언트 오류 — 게이트웨이가 IRError로 응답 (계약 레벨 타입) */
export class AdapterInvalidRequestError extends Error {
  readonly irError: IRError;
  constructor(message: string, opts?: { gatewayException?: boolean }) {
    super(message);
    this.name = "AdapterInvalidRequestError";
    this.irError = {
      category: "invalid_request",
      httpStatus: 400,
      message,
      fallbackEligible: false,
      billed: false,
      ...(opts?.gatewayException ? { gatewayException: true } : {}),
    };
  }
}

/** 표준 warning 조립 — code는 WARNING_CODES로 컴파일 타임 강제 (ir-v0 §5) */
export function makeWarning(
  type: Warning["type"],
  code: WarningCode,
  message: string,
  path?: string,
  details?: JSONValue,
): Warning {
  return {
    type,
    code,
    message,
    ...(path !== undefined ? { path } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * providerOptions.<nsKey>의 D5 처리: 알려진 키는 스키마(strip 모드) 검증,
 * 미지 키는 기본 4xx 거부 / opt-in이면 extra로 통과 + warning.
 */
export function partitionProviderOptions<S extends z.ZodObject>(
  providerOptions: NS | undefined,
  nsKey: string,
  schema: S,
  allowUnknown: boolean,
  warnings: Warning[],
): { known: z.infer<S>; extra: JSONObject } {
  const ns = providerOptions?.[nsKey];
  if (!ns) return { known: schema.parse({}), extra: {} };

  const knownKeys = new Set(Object.keys(schema.shape));
  const extra: JSONObject = {};
  const unknownKeys = Object.keys(ns).filter((k) => !knownKeys.has(k));
  if (unknownKeys.length > 0) {
    if (!allowUnknown) {
      throw new AdapterInvalidRequestError(
        `providerOptions.${nsKey}에 알 수 없는 키: ${unknownKeys.join(", ")} ` +
          `(allowUnknownProviderOptions로 통과 가능 — D5)`,
      );
    }
    for (const k of unknownKeys) {
      extra[k] = ns[k] as JSONValue;
      warnings.push(
        makeWarning(
          "compatibility",
          "unknown-provider-option-passed",
          `미지 providerOptions.${nsKey}.${k} 통과 (opt-in)`,
          `providerOptions.${nsKey}.${k}`,
        ),
      );
    }
  }
  return { known: schema.parse(ns), extra }; // strip 모드 — 미지 키는 parse 결과에서 제외
}

/**
 * 모델 capability 게이트 (레지스트리 공급 `unsupportedParams`) — 값이 있는데 모델이 거부하는
 * 파라미터를 드롭하고 보고한다. strictParameters면 4xx (D5). 프로바이더 지식 없음 —
 * 목록은 레지스트리가 공급하므로 코어/어댑터 어디서 불러도 분기문이 생기지 않는다.
 */
export function gateUnsupportedParams<T extends Record<string, unknown>>(
  values: T,
  unsupported: readonly string[] | undefined,
  strict: boolean | undefined,
  providerLabel: string,
  warnings: Warning[],
): T {
  if (!unsupported || unsupported.length === 0) return values;
  const out = { ...values };
  for (const key of unsupported) {
    if (out[key] === undefined) continue;
    if (strict) {
      throw new AdapterInvalidRequestError(
        `${providerLabel} 모델이 ${key}를 지원하지 않습니다 (strictParameters)`,
      );
    }
    warnings.push(
      makeWarning(
        "unsupported",
        "parameter-dropped",
        `${providerLabel} 모델이 ${key}를 거부 — 드롭 (모델 capability 게이트)`,
        key,
      ),
    );
    delete out[key];
  }
  return out;
}

/** 프로바이더 미지원 파라미터의 D5 처리: strict면 4xx, 아니면 드롭 + warning */
export function dropUnsupportedParams(
  values: Record<string, unknown>,
  strict: boolean | undefined,
  providerLabel: string,
  warnings: Warning[],
): void {
  for (const [key, val] of Object.entries(values)) {
    if (val === undefined) continue;
    if (strict) {
      throw new AdapterInvalidRequestError(`${providerLabel}은(는) ${key}를 지원하지 않습니다 (strictParameters)`);
    }
    warnings.push(
      makeWarning("unsupported", "parameter-dropped", `${providerLabel} 미지원 파라미터 ${key} 드롭`, key),
    );
  }
}
