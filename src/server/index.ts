import { serve } from "@hono/node-server";
import { loadDotenv } from "../env.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { SessionStore } from "../gateway/session.js";
import {
  PostgresBatchStore,
  PostgresBodyLog,
  PostgresFileStore,
  PostgresKeyStore,
  PostgresLedger,
  PostgresProviderKeyStore,
  PostgresResourceStore,
} from "../state/postgres.js";
import { RedisSessionPersistence } from "../state/redis.js";
import {
  InMemoryBatchStore,
  InMemoryFileStore,
  InMemoryKeyStore,
  InMemoryLedger,
  InMemoryProviderKeyStore,
  InMemoryResourceStore,
} from "../state/memory.js";
import { InMemorySpendTracker, withSpendTracking } from "../ops/budget.js";
import { createApp, type AppDeps } from "./app.js";

// 서버 엔트리포인트. 실행: pnpm dev (포트: PORT env, 기본 8787)
// 상태 계층 (ADR-0006): DATABASE_URL/REDIS_URL 설정 시 Postgres 원장·Redis 재개 버퍼.
// 미설정 시: 원장은 인메모리 폴백, 재개 버퍼는 영속화 생략 — 같은 프로세스 인메모리 이중 저장은
// 재시작 복구 가치가 없다 (리뷰 A-r4 note).
loadDotenv();
bootstrapProviders();

const databaseUrl = process.env["DATABASE_URL"];
const redisUrl = process.env["REDIS_URL"];
if (!databaseUrl) console.warn("[gateway] DATABASE_URL 미설정 — usage 원장 인메모리 (재시작 시 소실)");
if (!redisUrl) console.warn("[gateway] REDIS_URL 미설정 — 재시작 후 스트림 재개 불가");

const baseLedger = databaseUrl ? new PostgresLedger(databaseUrl) : new InMemoryLedger();
const persistence = redisUrl ? new RedisSessionPersistence(redisUrl) : undefined;
const sessions = new SessionStore(persistence ? { persistence } : {});
// Files·Batches 매핑 (부록 (b)) — 프로바이더 측 리소스는 durable하므로 인메모리 폴백 시 경고
const files = databaseUrl ? new PostgresFileStore(databaseUrl) : new InMemoryFileStore();
const batches = databaseUrl ? new PostgresBatchStore(databaseUrl) : new InMemoryBatchStore();
if (!databaseUrl) console.warn("[gateway] Files/Batches 매핑 인메모리 — 재시작 시 gwf/gwb id 소실 (프로바이더 리소스는 잔존)");

// ── 운영 평면 (ops-plane) — GATEWAY_ADMIN_KEY 설정 시 가상 키 인증 활성 (사용자 결정 D1) ──
const opsEnabled = Boolean(process.env["GATEWAY_ADMIN_KEY"]);
const spendTracker = new InMemorySpendTracker(); // Redis 이관은 인터페이스 뒤 (ADR-0007 §3)
const ledger = withSpendTracking(baseLedger, spendTracker);
const keys = opsEnabled ? (databaseUrl ? new PostgresKeyStore(databaseUrl) : new InMemoryKeyStore()) : undefined;
const providerKeys = opsEnabled
  ? databaseUrl
    ? new PostgresProviderKeyStore(databaseUrl)
    : new InMemoryProviderKeyStore()
  : undefined;
const resources = databaseUrl ? new PostgresResourceStore(databaseUrl) : new InMemoryResourceStore();
const bodyLog = databaseUrl ? new PostgresBodyLog(databaseUrl) : undefined; // 기본 on은 durable sink 전제 (ADR-0008)
if (!opsEnabled) console.warn("[gateway] GATEWAY_ADMIN_KEY 미설정 — 개방 모드 (가상 키 인증·관리 API 비활성)");

const deps: AppDeps = {
  ledger,
  sessions,
  files,
  batches,
  resources,
  spendTracker,
  ...(keys ? { keys } : {}),
  ...(providerKeys ? { providerKeys } : {}),
  ...(bodyLog ? { bodyLog } : {}),
  ...(persistence ? { persistence } : {}),
};
const port = Number(process.env["PORT"] ?? 8787);
const server = serve({ fetch: createApp(deps).fetch, port }, (info) => {
  console.log(`ai-gateway v0 — listening on :${info.port}`);
});

// graceful shutdown — 커넥션 정리 (in-flight 스트림 drain은 로드맵 5)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[gateway] ${sig} — shutting down`);
    server.close();
    void Promise.allSettled([
      baseLedger instanceof PostgresLedger ? baseLedger.close() : Promise.resolve(),
      files instanceof PostgresFileStore ? files.close() : Promise.resolve(),
      batches instanceof PostgresBatchStore ? batches.close() : Promise.resolve(),
      keys instanceof PostgresKeyStore ? keys.close() : Promise.resolve(),
      providerKeys instanceof PostgresProviderKeyStore ? providerKeys.close() : Promise.resolve(),
      resources instanceof PostgresResourceStore ? resources.close() : Promise.resolve(),
      bodyLog instanceof PostgresBodyLog ? bodyLog.close() : Promise.resolve(),
      persistence?.close() ?? Promise.resolve(),
    ]).then(() => process.exit(0));
  });
}
