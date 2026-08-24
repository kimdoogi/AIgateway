import type { Warning } from "../ir/common.js";
import type { IRRequest } from "../ir/request.js";
import type { AdapterCapabilities, OutboundAdapter, SurfaceSelector } from "../adapters/types.js";
import { makeWarning } from "../adapters/shared.js";
import { GatewayError, irError, notFoundError } from "./errors.js";

// 어댑터 레지스트리 + 모델 라우팅 v0 (완전판 레지스트리는 로드맵 5).
// 코어는 프로바이더를 모른다 (D4) — 여기는 데이터 테이블·조회·표면 해석 골격뿐, 프로바이더 분기문 없음.
// 표면(surface)은 1급 축이다 (ADR-0002 결과 절): provider당 어댑터 복수 등록 + 프로바이더가
// 소유한 선택자. sticky·capability 게이트·warning 조립은 여기(코어) 공통 규칙.

export interface ProviderRegistration {
  /** 첫 원소의 surface가 프로바이더 기본 표면 */
  adapters: readonly OutboundAdapter[];
  baseUrl: string;
  /** 어댑터는 비밀을 만지지 않는다 — 게이트웨이가 env에서 읽어 이 헤더로 주입 (D4) */
  auth: { envVar: string; header: string; prefix?: string };
  /** 이중 표면 프로바이더만 제공. 없으면 항상 기본 표면 */
  selectSurface?: SurfaceSelector;
}

export interface ProviderRuntime {
  provider: string;
  adapters: ReadonlyMap<string, OutboundAdapter>;
  defaultSurface: string;
  baseUrl: string;
  auth: { envVar: string; header: string; prefix?: string };
  selectSurface?: SurfaceSelector;
}

const providers = new Map<string, ProviderRuntime>();

export function registerProvider(reg: ProviderRegistration): void {
  const first = reg.adapters[0];
  if (!first) throw new Error("registerProvider: adapters가 비어 있습니다");
  const provider = first.provider;
  const adapters = new Map<string, OutboundAdapter>();
  for (const adapter of reg.adapters) {
    if (adapter.provider !== provider) {
      throw new Error(`registerProvider: 서로 다른 provider 혼합 (${provider} vs ${adapter.provider})`);
    }
    if (adapters.has(adapter.surface)) {
      throw new Error(`registerProvider: 표면 중복 등록 (${provider}/${adapter.surface})`);
    }
    adapters.set(adapter.surface, adapter);
  }
  providers.set(provider, {
    provider,
    adapters,
    defaultSurface: first.surface,
    baseUrl: reg.baseUrl,
    auth: reg.auth,
    ...(reg.selectSurface ? { selectSurface: reg.selectSurface } : {}),
  });
}

export function getProvider(name: string): ProviderRuntime {
  const rt = providers.get(name);
  if (!rt) throw notFoundError(`등록되지 않은 프로바이더: ${name}`);
  return rt;
}

/** 테스트/재등록용 — 등록은 bootstrap(조립 루트)이 수행한다 */
export function clearProviders(): void {
  providers.clear();
}

/** 등록된 프로바이더 키 목록 — 등록 완전성 검사(provider-registration.test)의 기준 축 */
export function registeredProviders(): string[] {
  return [...providers.keys()];
}

/** 모델 라우팅 테이블 v0 — 하드코딩 데이터 (레지스트리 이관 대상, 리뷰 A3/D10-4) */
export interface ModelRoute {
  pattern: RegExp;
  provider: string;
  /**
   * 이 라우트를 대표하는 실제 모델 id. 필수 — 등록 완전성 검사가 이것으로
   * ① 정규식이 정말 자기 모델을 잡는지 ② 앞 라우트에 가려지지 않는지
   * ③ 가격표에 단가가 있는지를 검증한다 (리뷰 2026-08-22: 등록 9곳 완전성 미강제).
   */
  sample: string;
  capabilities?: AdapterCapabilities;
}

// OpenAI reasoning 모델이 400으로 거부하는 IR 표준 파라미터 (인벤토리 §H)
const OPENAI_REASONING_REJECTS = ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty"] as const;
const OPENAI_GPT56_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const; // minimal 없음

export const MODEL_ROUTES: ModelRoute[] = [
  // ── Anthropic ──
  // mid-conversation system 지원: Opus 5/4.8/Fable 5 계열 (adapters/types.ts 주석 참조)
  {
    pattern: /^claude-(opus-5|opus-4-8|fable-5|mythos-5)/,
    sample: "claude-opus-5",
    provider: "anthropic",
    capabilities: { midConversationSystem: true },
  },
  { pattern: /^claude-/, sample: "claude-haiku-4-5", provider: "anthropic" },

  // ── OpenAI ── (인벤토리 §H — pro/computer-use/deep-research는 Responses 전용, audio는 CC 전용)
  {
    pattern: /^(gpt-5(\.\d+)?-pro|o\d+-pro)/,
    sample: "gpt-5.6-pro",
    provider: "openai",
    capabilities: { surfaces: ["responses"], unsupportedParams: OPENAI_REASONING_REJECTS },
  },
  {
    pattern: /^(computer-use|.*-deep-research)/,
    sample: "computer-use-preview",
    provider: "openai",
    capabilities: { surfaces: ["responses"] },
  },
  {
    pattern: /^gpt-(audio|realtime)/,
    sample: "gpt-audio",
    provider: "openai",
    capabilities: { surfaces: ["chat-completions"] },
  },
  {
    pattern: /^gpt-5\.6/,
    sample: "gpt-5.6-luna",
    provider: "openai",
    capabilities: { supportedEfforts: OPENAI_GPT56_EFFORTS, unsupportedParams: OPENAI_REASONING_REJECTS },
  },
  {
    pattern: /^(gpt-5|o[1-9])/,
    sample: "gpt-5.4",
    provider: "openai",
    capabilities: { unsupportedParams: OPENAI_REASONING_REJECTS },
  },
  { pattern: /^(gpt-|chatgpt-|o\d)/, sample: "gpt-4.1", provider: "openai" },

  // ── Google Gemini ── (인벤토리 §I — thinkingLevel은 3세대, 2.5는 thinkingBudget(PO 경유))
  {
    pattern: /^gemini-3\.1-pro/,
    sample: "gemini-3.1-pro",
    provider: "google",
    capabilities: { supportedEfforts: ["low", "medium", "high"] }, // minimal 미지원 (§I)
  },
  {
    pattern: /^gemini-3/,
    sample: "gemini-3.7-flash",
    provider: "google",
    capabilities: { supportedEfforts: ["minimal", "low", "medium", "high"] },
  },
  {
    pattern: /^gemini-2\.5/,
    sample: "gemini-2.5-flash",
    provider: "google",
    capabilities: { supportedEfforts: [] }, // thinkingLevel 미지원 세대 — effort는 드롭 + warning
  },
  {
    pattern: /^gemini-/,
    sample: "gemini-2.0-flash",
    provider: "google",
    // 안전측 기본값: 미지 세대(2.0/1.5 등)에 3세대 thinkingLevel을 보내면 400 — 드롭+warning이 안전
    capabilities: { supportedEfforts: [] },
  },

  // ── xAI ── (인벤토리 §G — reasoning 모델은 penalty/stop 400 거부, effort 집합 모델별)
  {
    pattern: /^grok-4\.6/,
    sample: "grok-4.6",
    provider: "xai",
    capabilities: {
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      unsupportedParams: ["presencePenalty", "frequencyPenalty", "stopSequences"],
    },
  },
  {
    pattern: /^grok-4\.5/,
    sample: "grok-4.5",
    provider: "xai",
    capabilities: {
      supportedEfforts: ["low", "medium", "high"],
      unsupportedParams: ["presencePenalty", "frequencyPenalty", "stopSequences"],
    },
  },
  {
    pattern: /^grok-.*non-reasoning/,
    sample: "grok-4.3-non-reasoning",
    provider: "xai",
  },
  {
    pattern: /^grok-/,
    sample: "grok-4.3",
    provider: "xai",
    capabilities: { unsupportedParams: ["presencePenalty", "frequencyPenalty", "stopSequences"] },
  },
];

export interface ResolvedRoute {
  provider: string;
  modelId: string;
  capabilities?: AdapterCapabilities;
}

/** 첫 매칭 라우트 (순서 의존) — 테스트가 가려짐(shadowing)을 검사할 수 있게 라우트 자체를 반환 */
export function matchRoute(model: string): ModelRoute | undefined {
  return MODEL_ROUTES.find((route) => route.pattern.test(model));
}

export function resolveModel(model: string): ResolvedRoute {
  const route = matchRoute(model);
  if (!route) throw notFoundError(`라우팅할 수 없는 모델: ${model}`);
  return {
    provider: route.provider,
    modelId: model,
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
  };
}

/**
 * 히스토리에서 같은 프로바이더의 직전 표면을 읽는다 — 표면 sticky의 stateless 판별
 * (ADR-0002 결과 절, ir-v0 §4.0). 메시지 origin 우선, 없으면 블록 origin.
 */
export function previousSurface(req: IRRequest, provider: string): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const origins = [msg.origin, ...msg.blocks.map((b) => b.origin)];
    for (const origin of origins) {
      if (origin?.provider === provider && origin.surface) return origin.surface;
    }
  }
  return undefined;
}

export interface SelectedSurface {
  adapter: OutboundAdapter;
  warnings: Warning[];
}

/**
 * 표면 결정 (코어 공통 규칙 — 프로바이더 분기문 없음):
 *   1. 명시 오버라이드 `providerOptions.<provider>.surface`
 *   2. 선택자가 required로 표시한 표면 (요청 기능이 강제)
 *   3. sticky — 직전 assistant 턴의 같은 프로바이더 표면
 *   4. 선택자 권고 / 기본 표면
 * 마지막에 모델 capability(`surfaces`) 게이트: 접근 불가 표면이면 강제 요구는 4xx,
 * 그 외에는 접근 가능한 표면으로 전환 + warning(surface-switched).
 */
export function selectSurface(rt: ProviderRuntime, req: IRRequest, route: ResolvedRoute): SelectedSurface {
  const warnings: Warning[] = [];
  const prev = previousSurface(req, rt.provider);
  const allowed = route.capabilities?.surfaces;

  const overrideRaw = req.providerOptions?.[rt.provider]?.["surface"];
  const override = typeof overrideRaw === "string" ? overrideRaw : undefined;
  const choice = rt.selectSurface?.({
    request: req,
    modelId: route.modelId,
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
  });

  let surface: string;
  let switchReason: string | undefined;
  if (override) {
    surface = override;
    if (prev && prev !== surface) switchReason = "명시 오버라이드(providerOptions.surface)";
  } else if (choice?.required) {
    surface = choice.surface;
    if (prev && prev !== surface) switchReason = choice.reason ?? "요청 기능이 표면을 강제";
  } else if (prev && rt.adapters.has(prev)) {
    surface = prev; // sticky — 캐시·reasoning 연속성 보존 (ADR-0002)
  } else {
    surface = choice?.surface ?? rt.defaultSurface;
  }

  if (allowed && !allowed.includes(surface)) {
    const fallback = allowed.find((s) => rt.adapters.has(s));
    if (choice?.required && !override) {
      throw new GatewayError(
        irError(
          "invalid_request",
          400,
          `모델 ${route.modelId}은 ${surface} 표면을 지원하지 않습니다 (요구 사유: ${choice.reason ?? "요청 기능"})`,
        ),
      );
    }
    if (!fallback) {
      throw new GatewayError(
        irError("invalid_request", 400, `모델 ${route.modelId}이 지원하는 표면이 등록되어 있지 않습니다`),
      );
    }
    switchReason = `모델 ${route.modelId}은 ${surface} 미지원`;
    surface = fallback;
  }

  const adapter = rt.adapters.get(surface);
  if (!adapter) {
    throw new GatewayError(
      irError("invalid_request", 400, `${rt.provider}에 등록되지 않은 표면: ${surface}`, {
        gatewayException: override === undefined,
      }),
    );
  }
  // 전환 보고 (D5 조용한 변조 금지) — 두 사실은 별개이므로 각각 보고한다.
  // ① 클라이언트가 명시 지목한 표면이 무시됨: prev 유무와 무관하게 반드시 보고해야 한다
  //    (신규 대화에는 prev가 없어, prev 조건에 묶어두면 조용히 무시됐다 — 리뷰 2026-08-22)
  if (override !== undefined && override !== surface) {
    warnings.push(
      makeWarning(
        "compatibility",
        "surface-switched",
        `명시 표면 ${override} → ${surface} 전환 (${switchReason ?? "표면 게이트"}) — providerOptions.surface 지시가 적용되지 않음`,
        `providerOptions.${rt.provider}.surface`,
      ),
    );
  }
  // ② 직전 턴 표면(sticky)이 깨짐 — 캐시 미스·reasoning 연속성 소실
  if (switchReason && prev && prev !== surface) {
    warnings.push(
      makeWarning(
        "compatibility",
        "surface-switched",
        `표면 전환 ${prev} → ${surface} (${switchReason}) — 프롬프트 캐시 미스·reasoning 연속성 소실 가능`,
      ),
    );
  }
  return { adapter, warnings };
}
