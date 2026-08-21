import { serve } from "@hono/node-server";
import { loadDotenv } from "../env.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { SessionStore } from "../gateway/session.js";
import { PostgresLedger } from "../state/postgres.js";
import { RedisSessionPersistence } from "../state/redis.js";
import { InMemoryLedger } from "../state/memory.js";
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

const ledger = databaseUrl ? new PostgresLedger(databaseUrl) : new InMemoryLedger();
const persistence = redisUrl ? new RedisSessionPersistence(redisUrl) : undefined;
const sessions = new SessionStore(persistence ? { persistence } : {});

const deps: AppDeps = { ledger, sessions, ...(persistence ? { persistence } : {}) };
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
      ledger instanceof PostgresLedger ? ledger.close() : Promise.resolve(),
      persistence?.close() ?? Promise.resolve(),
    ]).then(() => process.exit(0));
  });
}
