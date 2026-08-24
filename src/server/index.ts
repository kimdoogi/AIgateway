import { serve } from "@hono/node-server";
import { loadDotenv } from "../env.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { setupTracing, shutdownTracing } from "../gateway/tracing.js";
import { SessionStore } from "../gateway/session.js";
import {
  PostgresBatchStore,
  PostgresBodyLog,
  PostgresFileStore,
  PostgresKeyStore,
  PostgresLedger,
  PostgresPool,
  PostgresAccountStore,
  PostgresPortalSessionStore,
  PostgresProviderKeyStore,
  PostgresResourceStore,
  schemaProblems,
} from "../state/postgres.js";
import { RedisRateLimiter, RedisSessionPersistence, RedisSpendTracker, RedisStreamControl } from "../state/redis.js";
import {
  InMemoryAccountStore,
  InMemoryBatchStore,
  InMemoryFileStore,
  InMemoryKeyStore,
  InMemoryLedger,
  InMemoryPortalSessionStore,
  InMemoryProviderKeyStore,
  InMemoryResourceStore,
} from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { InMemoryRateLimiter } from "../ops/rate-limit.js";
import { createApp, type AppDeps } from "./app.js";

// 서버 엔트리포인트. 실행: pnpm start (빌드 후) / pnpm dev (tsx). 포트: PORT env, 기본 8787
// 상태 계층 (ADR-0006): DATABASE_URL/REDIS_URL 설정 시 Postgres 원장·Redis 재개 버퍼.
// 미설정 시: 원장은 인메모리 폴백, 재개 버퍼는 영속화 생략 — 같은 프로세스 인메모리 이중 저장은
// 재시작 복구 가치가 없다 (리뷰 A-r4 note).
loadDotenv();
bootstrapProviders();

// OTel — 수집기 엔드포인트가 있을 때만 등록 (없으면 span은 계속 no-op). 서버 기동보다 먼저
const tracingOn = setupTracing({ ...(process.env["GATEWAY_VERSION"] ? { version: process.env["GATEWAY_VERSION"] } : {}) });
console.log(
  tracingOn
    ? `[gateway] OTel 트레이싱 활성 — ${process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]}`
    : "[gateway] OTEL_EXPORTER_OTLP_ENDPOINT 미설정 — 트레이싱 비활성 (span no-op)",
);

const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];
if (!databaseUrl) console.warn("[gateway] DATABASE_URL 미설정 — usage 원장 인메모리 (재시작 시 소실)");
if (!redisUrl) console.warn("[gateway] REDIS_URL 미설정 — 재시작 후 스트림 재개 불가");

// 커넥션 풀은 프로세스당 1개 — 스토어별 분리는 레플리카당 23커넥션을 만들었다 (리뷰 2026-08-22)
const db = databaseUrl ? new PostgresPool(databaseUrl) : undefined;
const baseLedger = db ? new PostgresLedger(db) : new InMemoryLedger();
const persistence = redisUrl ? new RedisSessionPersistence(redisUrl) : undefined;
const sessions = new SessionStore(persistence ? { persistence } : {});
// Files·Batches 매핑 (부록 (b)) — 프로바이더 측 리소스는 durable하므로 인메모리 폴백 시 경고
const files = db ? new PostgresFileStore(db) : new InMemoryFileStore();
const batches = db ? new PostgresBatchStore(db) : new InMemoryBatchStore();
if (!db) console.warn("[gateway] Files/Batches 매핑 인메모리 — 재시작 시 gwf/gwb id 소실 (프로바이더 리소스는 잔존)");

// ── 운영 평면 (ops-plane) — GATEWAY_ADMIN_KEY 설정 시 가상 키 인증 활성 (사용자 결정 D1) ──
const opsEnabled = Boolean(process.env["GATEWAY_ADMIN_KEY"]);
// 예산 집계·취소 전파는 Redis가 있어야 다중 레플리카에서 성립한다 (ADR-0007 §3 / ADR-0001 D7)
const spendTracker = redisUrl ? new RedisSpendTracker(redisUrl) : new InMemorySpendTracker();
const streamControl = redisUrl ? new RedisStreamControl(redisUrl) : undefined;
const rateLimiter = redisUrl ? new RedisRateLimiter(redisUrl) : new InMemoryRateLimiter();
const ledger = withSpendTracking(baseLedger, spendTracker);
const keys = opsEnabled ? (db ? new PostgresKeyStore(db) : new InMemoryKeyStore()) : undefined;
const providerKeys = opsEnabled ? (db ? new PostgresProviderKeyStore(db) : new InMemoryProviderKeyStore()) : undefined;
const resources = db ? new PostgresResourceStore(db) : new InMemoryResourceStore();
const bodyLog = db ? new PostgresBodyLog(db) : undefined; // 기본 on은 durable sink 전제 (ADR-0008)
// 셀프 가입 포털 — 인증 모드에서만 (개방 모드에는 키·테넌트 개념이 없다)
const accounts = opsEnabled ? (db ? new PostgresAccountStore(db) : new InMemoryAccountStore()) : undefined;
const portalSessions = opsEnabled ? (db ? new PostgresPortalSessionStore(db) : new InMemoryPortalSessionStore()) : undefined;
if (accounts) {
  const invite = Boolean(process.env["PORTAL_INVITE_CODE"]);
  console.log(`[gateway] 셀프 가입 포털 활성 — /portal ${invite ? "(초대 코드 필요)" : "(공개 가입)"}`);
  if (!invite) {
    console.warn("[gateway] 포털이 공개 가입 모드입니다 — 인터넷 노출 시 PORTAL_INVITE_CODE 설정을 권장 (남용 방어)");
  }
}
if (!opsEnabled) console.warn("[gateway] GATEWAY_ADMIN_KEY 미설정 — 개방 모드 (가상 키 인증·관리 API 비활성)");

// 다중 레플리카 정합성은 Redis 유무로 갈린다 (리뷰 2026-08-22 #1/#12)
if (!redisUrl) {
  console.warn(
    "[gateway] REDIS_URL 미설정 — 예산 집계·스트림 취소가 프로세스 로컬입니다. " +
      "다중 레플리카에서는 hard 예산이 레플리카 수만큼 곱해지고 취소가 다른 파드로 가면 무시됩니다",
  );
}

// 원격 취소 수신 — 권한 판정은 세션을 가진 이쪽에서만 가능하다 (메시지의 tenant는 발신자 주장)
if (streamControl) {
  void streamControl
    .subscribe((sessionId, tenant) => {
      const session = sessions.get(sessionId);
      if (!session || !session.ownedBy(tenant) || session.isDone) return;
      console.log(`[gateway] 원격 취소 수신 — ${sessionId}`);
      session.cancel();
    })
    .catch((err: unknown) => console.error("[stream-control] 구독 실패", err));
}

// readiness 프로브 — 설정된 의존성만 검사 (미설정 = 인메모리 폴백이라 검사 대상 아님)
const readiness: Array<{ name: string; check: () => Promise<void> }> = [];
if (db) {
  readiness.push({ name: "postgres", check: () => db.ping() });
  // 스키마가 뒤처진 파드는 트래픽을 받으면 안 된다 — 마이그레이션 잡보다 먼저 뜬 경우
  readiness.push({
    name: "schema",
    check: async () => {
      const problems = await schemaProblems(db);
      if (problems.length > 0) throw new Error(problems.join(", "));
    },
  });
}
if (persistence) readiness.push({ name: "redis", check: () => persistence.ping() });

let draining = false;

const deps: AppDeps = {
  ledger,
  sessions,
  files,
  batches,
  resources,
  spendTracker,
  rateLimiter,
  readiness,
  isDraining: () => draining,
  ...(process.env["GATEWAY_VERSION"] ? { version: process.env["GATEWAY_VERSION"] } : {}),
  ...(keys ? { keys } : {}),
  ...(providerKeys ? { providerKeys } : {}),
  ...(bodyLog ? { bodyLog } : {}),
  ...(persistence ? { persistence } : {}),
  ...(streamControl ? { streamControl } : {}),
  ...(accounts ? { accounts } : {}),
  ...(portalSessions ? { portalSessions } : {}),
};
// 스키마 준비 — MIGRATE_ON_BOOT=false면 적용하지 않고 미적용 여부만 검사한다(기동 거부).
// 기동을 막지는 않되(일시 DB 장애로 파드가 죽는 것보다 /ready 503이 낫다) 결과는 크게 남긴다
if (db) {
  void db
    .ensureSchema()
    .then(() => console.log("[gateway] 스키마 준비 완료"))
    .catch((err: unknown) =>
      console.error("[gateway] 스키마 준비 실패 — /ready가 503을 유지합니다:", err instanceof Error ? err.message : err),
    );
}

const port = Number(process.env["PORT"] ?? 8787);
const server = serve({ fetch: createApp(deps).fetch, port }, (info) => {
  console.log(`ai-gateway v0 — listening on :${info.port}`);
});

// ── graceful shutdown (오케스트레이터 배포 — 리뷰 2026-08-22 #2) ────────────────
// 순서가 핵심이다: ① /ready 503으로 LB 이탈 유도 → ② 신규 수용 중단 →
// ③ 진행 중 스트림 완주 대기 → ④ 남은 것 취소(회계 터미널 적재 기회) → ⑤ 커넥션 종료.
// 앞 단계를 건너뛰고 pool.end()·process.exit()을 하면 진행 중 스트림이 끊기고
// 그 시점 과금 원장 write가 유실된다.
const DRAIN_DELAY_MS = Number(process.env["SHUTDOWN_DRAIN_DELAY_MS"] ?? 5_000); // LB가 /ready 실패를 관측할 여유
const DRAIN_TIMEOUT_MS = Number(process.env["SHUTDOWN_DRAIN_TIMEOUT_MS"] ?? 25_000); // 스트림 완주 상한
const HARD_EXIT_MS = Number(process.env["SHUTDOWN_HARD_EXIT_MS"] ?? 40_000); // 최후 방어

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // SIGTERM 후 SIGINT 등 중복 신호 무시
  shuttingDown = true;
  draining = true;
  console.log(`[gateway] ${signal} — draining (ready=503, 진행 중 스트림 ${sessions.activeCount}건)`);

  // 최후 방어: 어떤 단계가 멈춰도 이 시한에는 반드시 죽는다 (오케스트레이터 SIGKILL보다 먼저)
  const hardExit = setTimeout(() => {
    console.error("[gateway] shutdown 시한 초과 — 강제 종료");
    process.exit(1);
  }, HARD_EXIT_MS);
  hardExit.unref?.();

  await sleep(DRAIN_DELAY_MS);
  server.close();

  const remaining = await sessions.drain(DRAIN_TIMEOUT_MS);
  if (remaining > 0) {
    // 회계 유실 가시화 — 취소하면 펌프가 abort 터미널을 원장에 적재할 기회를 갖는다
    console.error(`[gateway] drain 시한 초과 — 진행 중 스트림 ${remaining}건 취소`);
    sessions.cancelAll();
    await sleep(1_000);
  }

  await Promise.allSettled([
    shutdownTracing(), // 잔여 span 플러시 — 마지막 요청의 트레이스 유실 방지
    db?.close() ?? Promise.resolve(),
    persistence?.close() ?? Promise.resolve(),
    streamControl?.close() ?? Promise.resolve(),
    spendTracker instanceof RedisSpendTracker ? spendTracker.close() : Promise.resolve(),
  ]);
  console.log("[gateway] shutdown 완료");
  clearTimeout(hardExit);
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown(sig));
}

// 미포착 예외는 로그 남기고 죽는다 — 반쯤 죽은 프로세스가 트래픽을 받는 것이 더 위험하다
process.on("unhandledRejection", (reason) => {
  console.error("[gateway] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[gateway] uncaughtException — 종료", err);
  void shutdown("uncaughtException");
});
