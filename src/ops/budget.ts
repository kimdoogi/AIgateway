import type { Warning } from "../ir/common.js";
import type { LedgerRow, UsageLedger, VirtualKey } from "../state/types.js";
import { makeWarning } from "../adapters/shared.js";
import { GatewayError } from "../gateway/errors.js";

// 예산 집행 (ADR-0007 §3, ir-v0 §10.4) — 평가는 요청당 1회(PreRequest), hard 초과는
// "현재 스트림 완료 + 다음 요청 차단". 실시간 집계는 v0 인메모리 트래커 — Redis 이관은
// 인터페이스 뒤 (ADR-0006 §1 정신). 확정치는 원장이 진실.

export interface SpendTracker {
  add(keyId: string, usd: number, atIso: string): void;
  /** sinceIso 이후 누적 지출 (USD) */
  spentSince(keyId: string, sinceIso: string): number;
}

export class InMemorySpendTracker implements SpendTracker {
  private readonly entries = new Map<string, Array<{ at: string; usd: number }>>();
  add(keyId: string, usd: number, atIso: string): void {
    const list = this.entries.get(keyId) ?? [];
    list.push({ at: atIso, usd });
    this.entries.set(keyId, list);
  }
  spentSince(keyId: string, sinceIso: string): number {
    return (this.entries.get(keyId) ?? []).filter((e) => e.at >= sinceIso).reduce((s, e) => s + e.usd, 0);
  }
}

/** 원장 데코레이터 — 행 적재와 동시에 지출 트래커 갱신 (코어 무수정 배선점). aggregate는 위임 보존 */
export function withSpendTracking(inner: UsageLedger | undefined, tracker: SpendTracker): UsageLedger {
  const queryable = inner as { aggregate?: (...args: unknown[]) => unknown } | undefined;
  return {
    async record(row: LedgerRow): Promise<void> {
      if (row.keyId && typeof row.costUsd === "number" && row.costUsd > 0) {
        tracker.add(row.keyId, row.costUsd, row.createdAt);
      }
      await inner?.record(row);
    },
    // QueryableLedger 위임 — 데코레이터가 정산 리포트 경로를 끊지 않게 (ADR-0007 §4)
    ...(typeof queryable?.aggregate === "function"
      ? { aggregate: (...args: unknown[]) => queryable.aggregate!(...args) }
      : {}),
  } as UsageLedger;
}

export interface BudgetVerdict {
  /** hard 초과 — 이 요청을 402로 차단 */
  blocked: boolean;
  /** soft 초과 — stream-start/응답 warnings로 전달 */
  warning?: Warning;
  spentUsd: number;
}

export function evaluateBudget(key: VirtualKey, tracker: SpendTracker, now: Date): BudgetVerdict {
  if (!key.budget) return { blocked: false, spentUsd: 0 };
  const since = new Date(now.getTime() - key.budget.periodDays * 86_400_000).toISOString();
  const spent = tracker.spentSince(key.keyId, since);
  if (key.budget.hardUsd !== undefined && spent >= key.budget.hardUsd) {
    return { blocked: true, spentUsd: spent };
  }
  if (key.budget.softUsd !== undefined && spent >= key.budget.softUsd) {
    return {
      blocked: false,
      spentUsd: spent,
      warning: makeWarning(
        "other",
        "budget-soft-warning",
        `예산 소프트 한도 도달 — ${key.budget.periodDays}일 지출 $${spent.toFixed(4)} ≥ $${key.budget.softUsd}`,
      ),
    };
  }
  return { blocked: false, spentUsd: spent };
}

export function budgetExceededError(key: VirtualKey, spentUsd: number): GatewayError {
  return new GatewayError({
    category: "budget_exceeded",
    httpStatus: 402,
    message: `예산 하드 한도 초과 — ${key.budget!.periodDays}일 지출 $${spentUsd.toFixed(4)} ≥ $${key.budget!.hardUsd} (§10.4: 다음 요청부터 차단)`,
    fallbackEligible: false,
    billed: false,
    provider: { key: "gateway", code: "budget-exhausted-next-request-blocked" },
  });
}
