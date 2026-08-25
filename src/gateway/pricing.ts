import type { Usage } from "../ir/usage.js";

// 레지스트리 가격표 v0 (ADR-0007 §2 — billing 엔진·캡처 비용 가드 공용).
// USD / 1M tokens, 근사 — 청구서 대체 아님. 다단계 구간(long context)·서버 툴 호출당
// 과금·TTL별 캐시 단가는 billing 엔진(운영 평면)에서 라인아이템으로 확장한다.
// 캐시 배수: write 1.25x, read 0.1x (Anthropic 5분 ephemeral / OpenAI GPT-5.6 기준 근사).

export interface ModelPrice {
  input: number;
  output: number;
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
}

const DEFAULT_MULTIPLIERS = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 };

/** 접두 매칭 테이블 — 응답이 스냅샷 id(claude-haiku-4-5-20251001 등)를 보고하므로 접두로 조회 */
export const PRICE_TABLE: Array<{ prefix: string; price: ModelPrice }> = [
  { prefix: "claude-haiku-4-5", price: { input: 1.0, output: 5.0, ...DEFAULT_MULTIPLIERS } },
  { prefix: "claude-sonnet-4-6", price: { input: 3.0, output: 15.0, ...DEFAULT_MULTIPLIERS } },
  { prefix: "gpt-5.6", price: { input: 5.0, output: 30.0, ...DEFAULT_MULTIPLIERS } }, // sol 단가를 상한으로 — luna/terra는 그 이하
  { prefix: "grok-4.6", price: { input: 2.0, output: 6.0, ...DEFAULT_MULTIPLIERS } }, // 인벤토리 §G (200k 초과 프리미엄 미반영)
  { prefix: "gemini-3.7-flash", price: { input: 1.0, output: 5.0, ...DEFAULT_MULTIPLIERS } }, // 상한 근사 (flash급 실단가는 이하)
];

/** 미지 모델 폴백 — Opus급 상한 근사 (캡 가드가 과소평가하지 않게 보수적으로) */
const FALLBACK_PRICE: ModelPrice = { input: 5.0, output: 25.0, ...DEFAULT_MULTIPLIERS };

/**
 * 접두 매칭 제외 — 접두보다 특수하고 단가가 그 접두를 넘는(또는 미확정) 모델.
 * 여기 등재되면 미가격 모델로 취급된다: FALLBACK 근사 + billing-price-estimated warning.
 * (감사 2026-08-24 #32: gpt-5.6 접두가 gpt-5.6-pro까지 매칭해 과소 과금 + warning 억제.
 *  pro 실단가 확보 시 이 목록에서 빼고 PRICE_TABLE에 정식 행 추가)
 */
const PREFIX_EXCLUDES = ["gpt-5.6-pro"];

// 최장 접두 우선 — 삽입 순서 의존 제거 (리뷰 F18). 정렬은 모듈 로드 시 1회:
// lookupPrice는 시도마다·응답마다 불린다 (recordAttempt·buildBilling)
const PRICE_BY_LONGEST_PREFIX = [...PRICE_TABLE].sort((a, b) => b.prefix.length - a.prefix.length);

function excluded(model: string): boolean {
  return PREFIX_EXCLUDES.some((p) => model.startsWith(p));
}

export function lookupPrice(model: string): ModelPrice {
  if (excluded(model)) return FALLBACK_PRICE;
  return PRICE_BY_LONGEST_PREFIX.find((e) => model.startsWith(e.prefix))?.price ?? FALLBACK_PRICE;
}

/**
 * 가격표에 실단가가 있는 모델인가 (리뷰 2026-08-22 #5).
 * false면 costUsd·billing 라인아이템이 FALLBACK_PRICE 근사다 — 라우팅 가능 모델 집합이
 * 가격표보다 넓으므로(예: claude-opus-5는 MODEL_ROUTES에 있으나 가격표엔 없다) 흔히 발생한다.
 * 돈의 근사를 조용히 하면 D5 위반이라 호출측이 warning을 발행해야 한다.
 */
export function isPricedModel(model: string): boolean {
  if (excluded(model)) return false;
  return PRICE_BY_LONGEST_PREFIX.some((e) => model.startsWith(e.prefix));
}

/** usage → 근사 비용 (캡처 하드 캡·예산 소프트 집계용 — 정산은 billing 라인아이템으로) */
export function estimateCostUSD(model: string, usage: Usage): number {
  const price = lookupPrice(model);
  const inputCost =
    (usage.input.noCache * price.input +
      usage.input.cacheWrite * price.input * price.cacheWriteMultiplier +
      usage.input.cacheRead * price.input * price.cacheReadMultiplier) /
    1e6;
  return inputCost + (usage.output.total * price.output) / 1e6;
}
