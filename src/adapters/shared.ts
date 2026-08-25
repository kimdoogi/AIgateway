import type { z } from "zod";
import type { JSONObject, JSONValue } from "../ir/json.js";
import type { NS, Warning, WarningCode } from "../ir/common.js";
import type { IRError } from "../ir/error.js";
import type { Message } from "../ir/message.js";

// 어댑터 공통 유틸 (리뷰 A1/A2/C2) — 프로바이더별로 다른 것은 네임스페이스 키·스키마뿐,
// 정책 골격(D5 미지 키 처리, 미지원 파라미터 드롭, warning 조립)은 전 어댑터 공유.

/** 어댑터가 던지는 클라이언트 오류 — 게이트웨이가 IRError로 응답 (계약 레벨 타입) */
export class AdapterInvalidRequestError extends Error {
  readonly irError: IRError;
  constructor(
    message: string,
    opts?: {
      gatewayException?: boolean;
      /** HTTP 200 soft-error 승격용 (Gemini promptFeedback 등 — ir-v0 §12) 필드 오버라이드 */
      irError?: Partial<IRError>;
    },
  ) {
    super(message);
    this.name = "AdapterInvalidRequestError";
    this.irError = {
      category: "invalid_request",
      httpStatus: 400,
      message,
      fallbackEligible: false,
      billed: false,
      ...(opts?.gatewayException ? { gatewayException: true } : {}),
      ...opts?.irError,
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
/**
 * 블록·메시지 레벨 providerOptions D5 게이트 (ir-v0 §2 — 감사 #17: envelope만 검사받고
 * 블록/메시지 PO는 무검증 조회만 받는 2급 시민이었다). 자기 네임스페이스 안의 인지 키 밖
 * 키는 기본 4xx, opt-in이면 warning(블록 레벨은 통과 좌석이 없어 무시됨을 명시).
 * 인지 키 집합 = 어댑터가 실제 소비하는 PO 키 ∪ 블록 레벨로 방출하는 PM 키
 * (§13.1 히스토리 편입이 PM→PO 전량 복사하므로 — G1 왕복 불변식).
 * 툴 레벨은 각 어댑터의 partitionProviderOptions 호출이 담당.
 */
export function gateBlockLevelOptions(
  messages: readonly Message[],
  nsKey: string,
  blockKnown: ReadonlySet<string>,
  messageKnown: ReadonlySet<string>,
  allowUnknown: boolean | undefined,
  warnings: Warning[],
): void {
  const check = (po: NS | undefined, known: ReadonlySet<string>, path: string): void => {
    const ns = po?.[nsKey];
    if (!ns) return;
    const unknown = Object.keys(ns).filter((k) => !known.has(k));
    if (unknown.length === 0) return;
    if (!allowUnknown) {
      throw new AdapterInvalidRequestError(
        `${path}.providerOptions.${nsKey}에 알 수 없는 키: ${unknown.join(", ")} (allowUnknownProviderOptions로 통과 가능 — D5)`,
      );
    }
    for (const k of unknown) {
      warnings.push(
        makeWarning(
          "compatibility",
          "unknown-provider-option-passed",
          `미지 providerOptions.${nsKey}.${k} — 블록/메시지 레벨 통과 좌석 없음, 무시 (opt-in)`,
          `${path}.providerOptions.${nsKey}.${k}`,
        ),
      );
    }
  };
  messages.forEach((m, mi) => {
    check(m.providerOptions, messageKnown, `messages[${mi}]`);
    m.blocks.forEach((b, bi) => check(b.providerOptions, blockKnown, `messages[${mi}].blocks[${bi}]`));
  });
}

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

// ir-v0 §6.3 — effort 강도 순서. 클램프 거리 계산의 canonical 축 (전 어댑터 공유)
export const EFFORT_ORDER: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 모델 effort 게이트 (ir-v0 §6.3): 지원 집합 밖의 값은 **최근접** 지원 레벨로 클램프한다.
 * 단 on/off 경계는 클램프하지 않는다 — 'none'(추론 비활성)을 위로 올리면 "끄기" 요청이
 * "켜기 + 추론 토큰 과금"으로 반전되므로, 표현 불가 시 설정 미방출 + 드롭 보고.
 * 반환 undefined = wire에 effort를 싣지 않는다 (모델 기본 동작).
 * 드롭은 strictParameters면 4xx, 클램프는 warning만 (D5).
 */
export function gateEffort(
  effort: string,
  supported: readonly string[],
  opts: { strict?: boolean | undefined; label: string; noneMessage?: string; emptyMessage?: string },
  warnings: Warning[],
): string | undefined {
  if (supported.includes(effort)) return effort;
  const drop = (message: string): undefined => {
    if (opts.strict) throw new AdapterInvalidRequestError(`${message} (strictParameters)`);
    warnings.push(makeWarning("unsupported", "parameter-dropped", message, "reasoning.effort"));
    return undefined;
  };
  if (supported.length === 0) {
    return drop(opts.emptyMessage ?? `${opts.label} 모델이 reasoning effort를 지원하지 않음 — effort 드롭`);
  }
  if (effort === "none") {
    return drop(
      opts.noneMessage ??
        `${opts.label} 모델이 추론 비활성(effort 'none')을 표현할 수 없음 — thinking 설정 미방출 (모델 기본 동작)`,
    );
  }
  // 'none'은 클램프 **대상**도 아니다 — 'minimal'을 최근접으로 내리면 켜기 요청이 끄기로 반전된다.
  // 정확 일치일 때만 'none'이 선택된다 (위 분기에서 이미 처리).
  const candidates = supported.filter((s) => s !== "none");
  if (candidates.length === 0) {
    return drop(opts.emptyMessage ?? `${opts.label} 모델이 추론 활성(effort '${effort}')을 표현할 수 없음 — effort 드롭`);
  }
  const want = EFFORT_ORDER.indexOf(effort);
  let best = candidates[0]!;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of candidates) {
    const dist = Math.abs(EFFORT_ORDER.indexOf(s) - want);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  warnings.push(
    makeWarning("compatibility", "parameter-clamped", `effort '${effort}' → '${best}' 최근접 클램프`, "reasoning.effort"),
  );
  return best;
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
