import type { Billing } from "../ir/billing.js";
import type { Usage } from "../ir/usage.js";
import { lookupPrice } from "../gateway/pricing.js";

// billing 라인아이템 (ADR-0007 §1-2) — usage(사실) → 금액 환산. 가격표는 레지스트리 소유.
// 서버 툴 호출당·TTL별 캐시·long context 구간 SKU는 가격표 확장과 함께 2차 — v0는 토큰 4종.

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function buildBilling(
  provider: string,
  model: string,
  usage: Usage,
  opts?: { batch?: boolean },
): Billing {
  const price = lookupPrice(model);
  const batchSeg = opts?.batch ? ":batch" : ""; // 배치 할인 SKU 세그먼트 (부록 (b) §3.4)
  // 배치 50% 할인 근사 (ADR-0007 — 정밀 단가는 가격표 확장 시)
  const discount = opts?.batch ? 0.5 : 1;
  const items = [
    { sku: `${provider}:${model}:input${batchSeg}`, quantity: usage.input.noCache, unit: price.input * discount },
    { sku: `${provider}:${model}:input:cache_read${batchSeg}`, quantity: usage.input.cacheRead, unit: price.input * price.cacheReadMultiplier * discount },
    { sku: `${provider}:${model}:input:cache_write${batchSeg}`, quantity: usage.input.cacheWrite, unit: price.input * price.cacheWriteMultiplier * discount },
    { sku: `${provider}:${model}:output${batchSeg}`, quantity: usage.output.total, unit: price.output * discount },
  ];
  const lineItems = items
    .filter((i) => i.quantity > 0)
    .map((i) => ({
      kind: "tokens" as const,
      sku: i.sku,
      quantity: i.quantity,
      unitCost: i.unit,
      cost: round6((i.quantity * i.unit) / 1e6),
    }));
  return {
    lineItems,
    total: round6(lineItems.reduce((s, i) => s + i.cost, 0)),
    currency: "USD",
  };
}
