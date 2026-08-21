import type { LedgerRow, SessionPersistence, UsageLedger } from "./types.js";

// 인메모리 구현체 — 단위 테스트·상태 계층 미설정 시 폴백 (ADR-0006 §1)

export class InMemoryLedger implements UsageLedger {
  readonly rows: LedgerRow[] = [];
  async record(row: LedgerRow): Promise<void> {
    this.rows.push(row);
  }
}

export class InMemorySessionPersistence implements SessionPersistence {
  private readonly events = new Map<string, string[]>();

  async appendEvent(sessionId: string, _seq: number, json: string): Promise<void> {
    const list = this.events.get(sessionId) ?? [];
    list.push(json);
    this.events.set(sessionId, list);
  }

  async loadEvents(sessionId: string, afterSeq: number): Promise<string[] | null> {
    const list = this.events.get(sessionId);
    if (!list) return null;
    return list.slice(Math.max(0, afterSeq + 1)); // seq == index (세션 단일 스탬퍼 불변식)
  }

  async markEnded(sessionId: string, ttlSeconds: number): Promise<void> {
    const timer = setTimeout(() => this.events.delete(sessionId), ttlSeconds * 1000);
    timer.unref?.();
  }

  async invalidate(sessionId: string): Promise<void> {
    this.events.delete(sessionId);
  }
}
