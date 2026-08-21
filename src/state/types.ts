import type { Usage } from "../ir/usage.js";

// 상태 계층 인터페이스 (ADR-0006 §1) — 코어는 stateless, 상태는 인터페이스 뒤.
// 인메모리 구현으로 테스트가 Postgres/Redis 없이 돈다 (D9).

/** usage/billing 원장 행 — append-only, 시도별 1행 (ADR-0005 다중 시도 회계 / ADR-0007) */
export interface LedgerRow {
  requestId: string;
  attempt: number; // 1부터 — 리트라이 시 증가
  provider: string;
  model: string;
  surface: string;
  stream: boolean;
  outcome: "success" | "error" | "canceled";
  httpStatus?: number;
  finishReason?: string;
  errorCategory?: string;
  usage?: Usage;
  billed: boolean;
  /** 리트라이 행은 해당 시도 소요, 최종(성공/터미널) 행은 요청 총 소요 */
  durationMs: number;
  createdAt: string; // ISO
}

export interface UsageLedger {
  /** append-only. 실패해도 요청 처리를 막지 않는다 — 호출측이 로그로 강등 */
  record(row: LedgerRow): Promise<void>;
}

/**
 * 스트림 재개 버퍼의 프로세스 외 영속화 (ADR-0005/0006 — Redis).
 * v0 계약: write-through(인메모리가 fast path), 프로세스 재시작 후 재개는 **재생 전용**
 * (라이브 테일 없음 — grace 초과 후와 동일 의미론). 크로스노드 cancel은 problem log 예고 참조.
 */
export interface SessionPersistence {
  appendEvent(sessionId: string, seq: number, json: string): Promise<void>;
  /** afterSeq 이후 이벤트 json 배열. 미지/만료 세션은 null */
  loadEvents(sessionId: string, afterSeq: number): Promise<string[] | null>;
  /** 종료 시점 — TTL 시작 */
  markEnded(sessionId: string, ttlSeconds: number): Promise<void>;
  /** 버퍼 무효화 — append 실패로 seq↔index 정렬이 깨졌을 때 (틀린 재생 대신 410, 리뷰 F9-r4) */
  invalidate(sessionId: string): Promise<void>;
}
