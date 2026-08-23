import { createClient, type RedisClientType } from "redis";
import type { SessionPersistence } from "./types.js";

// Redis 스트림 재개 버퍼 (ADR-0005/0006 — 종료 후 TTL 5분). write-through 영속화:
// 인메모리 세션이 fast path, 프로세스 재시작 후 재개는 재생 전용.
// 순서 보장은 세션의 persistTail 체인이 담당 — 여기는 명령 1회 발행만.

const KEY_PREFIX = "stream:";
const RUNNING_TTL_SECONDS = 7200; // 진행 중 고아 키 상한 — heartbeat 최대 주기(3600s)보다 커야 함 (리뷰 A4-r4)
const EXPIRE_EVERY = 64; // expire 갱신 주기 — 이벤트당 2왕복 방지 (리뷰 EF1-r4)

export class RedisSessionPersistence implements SessionPersistence {
  private readonly client: RedisClientType;
  private connected: Promise<void> | undefined;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[redis]", err.message));
  }

  private connect(): Promise<void> {
    // 실패 시 캐시 리셋 (리뷰 D2-r4)
    this.connected ??= this.client.connect().then(
      () => undefined,
      (err) => {
        this.connected = undefined;
        throw err;
      },
    );
    return this.connected;
  }

  async appendEvent(sessionId: string, seq: number, json: string): Promise<void> {
    await this.connect();
    const key = KEY_PREFIX + sessionId;
    await this.client.rPush(key, json);
    if (seq % EXPIRE_EVERY === 0) await this.client.expire(key, RUNNING_TTL_SECONDS);
  }

  async loadEvents(sessionId: string, afterSeq: number): Promise<string[] | null> {
    await this.connect();
    const key = KEY_PREFIX + sessionId;
    if (!(await this.client.exists(key))) return null;
    return this.client.lRange(key, Math.max(0, afterSeq + 1), -1);
  }

  async markEnded(sessionId: string, ttlSeconds: number): Promise<void> {
    await this.connect();
    await this.client.expire(KEY_PREFIX + sessionId, ttlSeconds);
  }

  async invalidate(sessionId: string): Promise<void> {
    await this.connect();
    await this.client.del(KEY_PREFIX + sessionId);
  }

  /** 연결 확인 — readiness 프로브용 */
  async ping(): Promise<void> {
    await this.connect();
    await this.client.ping();
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
