import { Buffer } from "node:buffer";
import type { StreamEvent } from "../ir/stream.js";
import { TERMINAL_EVENT_SET } from "../ir/stream.js";
import { irError } from "./errors.js";
import type { IRError } from "../ir/error.js";
import type { SessionPersistence } from "../state/types.js";

// 스트림 세션 — 재개 버퍼 + 단선/취소 의미론 (ADR-0005 §1, ir-v0 §10.4).
// 인메모리 구현 (ADR-0006 인터페이스 — Redis 교체 시 append/get 비동기화·cancel 크로스노드
// 시그널 필요: problem log 2026-08-21 구현 예고 참조).
//   · seq 단일 발급자: draft가 들어오고 push가 스탬프 (ir-v0 §13.1 — seq는 게이트웨이 envelope 소유)
//   · abort 3계열(cancel/grace/backpressure)은 전부 abort-only — 터미널은 펌프가
//     어댑터 회계(usage/billed)와 함께 적재하고, abortReason으로 라벨링 (리뷰 F4-r3).
//     펌프 부재/실패 시 end()의 방어 터미널이 최후 보루
//   · 백프레셔 8MB(바이트) 초과: abort (터미널·회계는 펌프 소관)
//   · TTL: 종료 후 5분 보관, 만료 조회는 410

/** append 입력 — seq는 세션이 발급하므로 draft에는 없다 (분배 Omit) */
export type StreamEventDraft = StreamEvent extends infer E
  ? E extends StreamEvent
    ? Omit<E, "seq">
    : never
  : never;

/** 직렬화는 push에서 1회 — SSE 방출·재생·byteSize가 같은 문자열을 쓴다 (리뷰 EF2) */
export interface StoredEvent {
  seq: number;
  type: string;
  json: string;
}

export type AbortReason = "cancel" | "grace" | "backpressure";

export interface SessionOptions {
  graceMs?: number;
  ttlMs?: number;
  maxBufferBytes?: number;
  /** 프로세스 외 영속화 (Redis — ADR-0006). write-through, 실패는 로그 강등 */
  persistence?: SessionPersistence;
}

const DEFAULTS = { graceMs: 30_000, ttlMs: 300_000, maxBufferBytes: 8 * 1024 * 1024 };

export class StreamSession {
  readonly id: string;
  private readonly events: StoredEvent[] = [];
  private byteSize = 0;
  private done = false;
  private waiters: Array<() => void> = [];
  private readonly abortController: AbortController;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private attached = 0;
  private readonly opts: { graceMs: number; ttlMs: number; maxBufferBytes: number };
  private readonly persistence: SessionPersistence | undefined;
  /** 영속화 순서 직렬화 체인 — expire 경합(터미널 TTL 역전) 방지 (리뷰 A2-r4) */
  private persistTail: Promise<void> = Promise.resolve();
  /** append 실패 후에는 틀린 재생 대신 재생 포기 — 버퍼 무효화 (리뷰 F9-r4) */
  private persistBroken = false;

  /** abort 사유 — 펌프가 터미널 라벨링(499 취소/grace vs 507 백프레셔)에 사용 */
  abortReason: AbortReason | undefined;

  constructor(id: string, abortController: AbortController, opts: SessionOptions = {}) {
    this.id = id;
    this.abortController = abortController;
    const { persistence, ...rest } = opts;
    this.persistence = persistence;
    this.opts = { ...DEFAULTS, ...rest };
  }

  get upstreamSignal(): AbortSignal {
    return this.abortController.signal;
  }

  get isDone(): boolean {
    return this.done;
  }

  /** abort 사유에 맞는 터미널용 IRError — 펌프의 error-partial 조립에 사용 */
  abortError(): IRError {
    if (this.abortReason === "backpressure") {
      return irError(
        "gateway_error",
        507,
        `스트림 버퍼 상한 ${this.opts.maxBufferBytes}B 초과 — 업스트림 취소 (ADR-0005 백프레셔)`,
      );
    }
    return irError("gateway_error", 499, "업스트림 취소 (명시적 abort 또는 grace 만료 — ADR-0005)");
  }

  /** seq 스탬프 + 적재 + 리스너 깨움. 상한 초과 시 abort (터미널은 펌프가 — 리뷰 F4-r3) */
  append(draft: StreamEventDraft): void {
    this.push(draft);
    if (this.byteSize > this.opts.maxBufferBytes && !this.done && this.abortReason === undefined) {
      this.abort("backpressure");
    }
  }

  appendHeartbeat(): void {
    this.append({ type: "heartbeat" }); // 캡·seq 등 append 정책 일관 적용 (리뷰 F11)
  }

  private push(draft: StreamEventDraft): void {
    if (this.done) return; // done 게이트는 여기 한 곳 (리뷰 Simp4-r3)
    // 키 순서 canonical: type, seq 선두 (D10). seq 밀반입은 파괴적 제거 (리뷰 D1-r3)
    const { type, seq: _smuggled, ...rest } = draft as StreamEventDraft & { seq?: number };
    const stamped = { type, seq: this.events.length, ...rest } as StreamEvent;
    const json = JSON.stringify(stamped);
    this.byteSize += Buffer.byteLength(json);
    this.events.push({ seq: stamped.seq, type, json });
    // write-through 영속화 — 재시작 후 재개는 재생 전용 (state/types.ts 계약).
    // persistTail 체인으로 순서 보장. 실패 시 seq↔index 정렬이 깨지므로 버퍼 무효화 (틀린 재생 → 410)
    if (this.persistence && !this.persistBroken) {
      const persistence = this.persistence;
      this.persistTail = this.persistTail
        .then(() => persistence.appendEvent(this.id, stamped.seq, json))
        .catch((err) => {
          if (this.persistBroken) return;
          this.persistBroken = true;
          console.error(`[session-persistence] append 실패 — 버퍼 무효화 (${this.id})`, err);
          persistence.invalidate(this.id).catch(() => {});
        });
    }
    // error-partial(willRetry:true)는 논리적 터미널이 아니다 — 폴백 트리가 다음 타깃으로 이어간다
    // (ir-v0 §6.4 / 폴백 매트릭스 2026-08-22 행 — problem log 2026-08-21 예고의 해소)
    const retrying = draft.type === "error-partial" && draft.willRetry === true;
    if (TERMINAL_EVENT_SET.has(type) && !retrying) this.markDone();
    this.wake();
  }

  /** 펌프 종료 시 호출. 터미널 없이 끝났으면 방어 터미널 적재 (터미널 보장 — 리뷰 F1/E4) */
  end(): void {
    if (!this.done) {
      // 정상 경로 도달 불가 — 도달 = 게이트웨이/어댑터 결함. 원장 미기록(회계 무데이터) — 로그로 가시화
      console.error(`[session] ${this.id} 터미널 없이 종료 — 방어 터미널 적재 (원장 미기록)`);
      this.push({
        type: "error-partial",
        error: irError("gateway_error", 502, "스트림이 터미널 이벤트 없이 종료됨 — 게이트웨이 방어 터미널", {
          gatewayException: true, // 정상 경로에선 도달 불가 — 도달 = 게이트웨이/어댑터 결함
        }),
        willRetry: false,
      });
    }
  }

  /** 명시적 취소 (D7) — 즉시 업스트림 abort. 터미널은 펌프가 회계와 함께 적재 */
  cancel(): void {
    this.abort("cancel");
  }

  private abort(reason: AbortReason): void {
    if (this.abortReason === undefined) this.abortReason = reason;
    this.abortController.abort();
  }

  /** SSE 연결 부착 — grace 타이머 해제 */
  attach(): void {
    this.attached += 1;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  /** 연결 이탈(비정상 단선 포함) — 마지막 연결이 떠나면 grace 30초 후 업스트림 취소 */
  detach(): void {
    this.attached -= 1;
    if (this.attached > 0 || this.done) return;
    this.graceTimer = setTimeout(() => this.abort("grace"), this.opts.graceMs);
    this.graceTimer.unref?.();
  }

  /**
   * afterSeq 이후 재생 + 라이브 테일. seq == 배열 인덱스 (단일 스탬퍼, heartbeat 포함 전 이벤트
   * 저장·필터 없음 — 필터하면 seq≠index) — 직행 (리뷰 EF1)
   */
  async *read(afterSeq: number, signal?: AbortSignal): AsyncGenerator<StoredEvent> {
    let wakeUp: (() => void) | undefined;
    const onAbort = (): void => wakeUp?.();
    signal?.addEventListener("abort", onAbort);
    try {
      let cursor = Math.max(0, afterSeq + 1);
      for (;;) {
        while (cursor < this.events.length) yield this.events[cursor++]!;
        if (this.done || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wakeUp = resolve;
          this.waiters.push(resolve);
        });
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** 스토어가 주입 — 종료 시점부터 TTL 카운트 시작 (스펙: 종료 후 5분 보관) */
  onDone: (() => void) | undefined;

  private markDone(): void {
    if (this.done) return;
    this.done = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.persistence && !this.persistBroken) {
      const persistence = this.persistence;
      this.persistTail = this.persistTail
        .then(() => persistence.markEnded(this.id, Math.ceil(this.opts.ttlMs / 1000)))
        .catch((err) => console.error("[session-persistence]", err));
    }
    this.onDone?.();
  }

  private wake(): void {
    if (this.waiters.length === 0) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/** 인메모리 세션 스토어 — TTL 만료 후 조회는 null (서버가 410으로 변환) */
export class SessionStore {
  private readonly sessions = new Map<string, StreamSession>();
  constructor(private readonly opts: SessionOptions = {}) {}

  create(id: string): StreamSession {
    const session = new StreamSession(id, new AbortController(), this.opts);
    this.sessions.set(id, session);
    session.onDone = () => {
      const ttl = setTimeout(() => this.sessions.delete(id), this.opts.ttlMs ?? DEFAULTS.ttlMs);
      ttl.unref?.();
    };
    return session;
  }

  get(id: string): StreamSession | null {
    return this.sessions.get(id) ?? null;
  }
}
