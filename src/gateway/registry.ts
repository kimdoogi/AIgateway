import type { AdapterCapabilities, OutboundAdapter } from "../adapters/types.js";
import { notFoundError } from "./errors.js";

// 어댑터 레지스트리 + 모델 라우팅 v0 (walking-skeleton — 완전판 레지스트리는 로드맵 5).
// 코어는 프로바이더를 모른다 (D4) — 여기는 데이터 테이블과 조회뿐, 분기문 없음.
// 등록은 bootstrap.ts(조립 루트)가 수행한다.

export interface ProviderRuntime {
  adapter: OutboundAdapter;
  baseUrl: string;
  /** 어댑터는 비밀을 만지지 않는다 — 게이트웨이가 env에서 읽어 이 헤더로 주입 (D4) */
  auth: { envVar: string; header: string };
}

const providers = new Map<string, ProviderRuntime>();

export function registerProvider(rt: ProviderRuntime): void {
  providers.set(rt.adapter.provider, rt);
}

export function getProvider(name: string): ProviderRuntime {
  const rt = providers.get(name);
  if (!rt) throw notFoundError(`등록되지 않은 프로바이더: ${name}`);
  return rt;
}

/** 모델 라우팅 테이블 v0 — 하드코딩 데이터 (레지스트리 이관 대상, 리뷰 A3/D10-4) */
interface ModelRoute {
  pattern: RegExp;
  provider: string;
  capabilities?: AdapterCapabilities;
}

const MODEL_ROUTES: ModelRoute[] = [
  // mid-conversation system 지원: Opus 5/4.8/Fable 5 계열 (adapters/types.ts 주석 참조)
  {
    pattern: /^claude-(opus-5|opus-4-8|fable-5|mythos-5)/,
    provider: "anthropic",
    capabilities: { midConversationSystem: true },
  },
  { pattern: /^claude-/, provider: "anthropic" },
];

export interface ResolvedRoute {
  provider: string;
  modelId: string;
  capabilities?: AdapterCapabilities;
}

export function resolveModel(model: string): ResolvedRoute {
  for (const route of MODEL_ROUTES) {
    if (route.pattern.test(model)) {
      return {
        provider: route.provider,
        modelId: model,
        ...(route.capabilities ? { capabilities: route.capabilities } : {}),
      };
    }
  }
  throw notFoundError(`라우팅할 수 없는 모델: ${model}`);
}
