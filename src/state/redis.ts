import { createClient, type RedisClientType } from "redis";
import type { SessionPersistence, StreamControl } from "./types.js";
import type { SpendTracker } from "../ops/budget.js";
import { verdict, windowStart, type RateLimiter, type RateVerdict } from "../ops/rate-limit.js";

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

// ── 지출 집계 (ADR-0007 §3) ─────────────────────────────────────
// 분 단위 버킷 해시. 요청당 1필드가 아니라 분당 1필드라 바쁜 키에서도 창 크기로 유계다
// (periodDays=1이면 최대 1440필드). 경계 오차는 최대 1분어치이며 **과다 집계 방향**이라
// 예산을 늦게가 아니라 이르게 막는다 — 돈 문제에서 안전한 쪽.

const SPEND_PREFIX = "spend:";
const BUCKET_MS = 60_000;
/** 버려진 키의 상한 — 최장 예산 창보다 넉넉하게 */
const SPEND_TTL_SECONDS = Number(process.env["SPEND_RETENTION_DAYS"] ?? 31) * 86_400;

export class RedisSpendTracker implements SpendTracker {
  private readonly client: RedisClientType;
  private connected: Promise<void> | undefined;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[redis-spend]", err.message));
  }

  private connect(): Promise<void> {
    this.connected ??= this.client.connect().then(
      () => undefined,
      (err) => {
        this.connected = undefined;
        throw err;
      },
    );
    return this.connected;
  }

  async add(keyId: string, usd: number, atIso: string): Promise<void> {
    await this.connect();
    const key = SPEND_PREFIX + keyId;
    await this.client.hIncrByFloat(key, bucketOf(atIso), usd);
    await this.client.expire(key, SPEND_TTL_SECONDS);
  }

  async spentSince(keyId: string, sinceIso: string): Promise<number> {
    await this.connect();
    const key = SPEND_PREFIX + keyId;
    const all = await this.client.hGetAll(key);
    const from = bucketOf(sinceIso);
    let sum = 0;
    const stale: string[] = [];
    for (const [bucket, value] of Object.entries(all)) {
      if (bucket < from || bucket.length !== from.length) {
        // 창 밖 버킷은 정리 (문자열 비교가 성립하도록 고정폭 버킷 사용)
        stale.push(bucket);
        continue;
      }
      sum += Number(value) || 0;
    }
    if (stale.length > 0) await this.client.hDel(key, stale).catch(() => undefined);
    return sum;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/** ISO → 고정폭 분 버킷 문자열 (사전순 = 시간순이어야 창 비교가 성립한다) */
function bucketOf(iso: string): string {
  return String(Math.floor(new Date(iso).getTime() / BUCKET_MS)).padStart(12, "0");
}

// ── 스트림 취소 전파 (ADR-0001 D7) ───────────────────────────────

const CANCEL_CHANNEL = "stream-cancel";

export class RedisStreamControl implements StreamControl {
  private readonly pub: RedisClientType;
  private readonly sub: RedisClientType;
  private ready: Promise<void> | undefined;

  constructor(url: string) {
    this.pub = createClient({ url });
    this.sub = this.pub.duplicate() as RedisClientType; // 구독 전용 커넥션 필수 (Redis 프로토콜 제약)
    this.pub.on("error", (err) => console.error("[redis-cancel-pub]", err.message));
    this.sub.on("error", (err) => console.error("[redis-cancel-sub]", err.message));
  }

  private connect(): Promise<void> {
    this.ready ??= Promise.all([this.pub.connect(), this.sub.connect()]).then(
      () => undefined,
      (err) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }

  async requestCancel(sessionId: string, tenant: string | undefined): Promise<void> {
    await this.connect();
    await this.pub.publish(CANCEL_CHANNEL, JSON.stringify({ sessionId, tenant: tenant ?? null }));
  }

  async subscribe(handler: (sessionId: string, tenant: string | undefined) => void): Promise<void> {
    await this.connect();
    await this.sub.subscribe(CANCEL_CHANNEL, (message) => {
      try {
        const parsed = JSON.parse(message) as { sessionId?: unknown; tenant?: unknown };
        if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return;
        handler(parsed.sessionId, typeof parsed.tenant === "string" ? parsed.tenant : undefined);
      } catch (err) {
        console.error("[redis-cancel] 파싱 불가 메시지", err instanceof Error ? err.message : err);
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.pub.quit()]);
  }
}

// ── 요청 빈도 제한 (리뷰 2026-08-22 #14) ─────────────────────────
// 고정 창 카운터. INCR은 원자적이라 레플리카가 몇 대든 한도가 하나로 성립한다.

const RATE_PREFIX = "ratelimit:";

export class RedisRateLimiter implements RateLimiter {
  private readonly client: RedisClientType;
  private connected: Promise<void> | undefined;

  constructor(url: string) {
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[redis-ratelimit]", err.message));
  }

  private connect(): Promise<void> {
    this.connected ??= this.client.connect().then(
      () => undefined,
      (err) => {
        this.connected = undefined;
        throw err;
      },
    );
    return this.connected;
  }

  async hit(keyId: string, limit: number, windowSeconds: number, now: Date): Promise<RateVerdict> {
    await this.connect();
    const start = windowStart(now, windowSeconds);
    const key = `${RATE_PREFIX}${keyId}:${start}`;
    const count = await this.client.incr(key);
    // 창 종료 후 자동 소멸 — 별도 정리 불필요 (첫 INCR에만 세팅되면 충분하나 멱등하게 매번)
    if (count === 1) await this.client.expire(key, windowSeconds + 1);
    return verdict(count, limit, start, windowSeconds, now);
  }
}
