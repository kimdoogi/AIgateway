import pg from "pg";
import type { LedgerRow, UsageLedger } from "./types.js";

// Postgres usage 원장 (ADR-0006 — durable, append-only). 스키마는 초기화 시 생성
// (마이그레이션 도구는 운영 평면 확장 시 — 로드맵 5).

const DDL = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  id            BIGSERIAL PRIMARY KEY,
  request_id    TEXT        NOT NULL,
  attempt       INT         NOT NULL,
  provider      TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  surface       TEXT        NOT NULL,
  stream        BOOLEAN     NOT NULL,
  outcome       TEXT        NOT NULL,
  http_status   INT,
  finish_reason TEXT,
  error_category TEXT,
  input_tokens  BIGINT,
  input_no_cache BIGINT,
  input_cache_read BIGINT,
  input_cache_write BIGINT,
  output_tokens BIGINT,
  output_reasoning BIGINT,
  total_tokens  BIGINT,
  usage_raw     JSONB,
  billed        BOOLEAN     NOT NULL,
  duration_ms   INT         NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_ledger_request_idx ON usage_ledger (request_id);
CREATE INDEX IF NOT EXISTS usage_ledger_created_idx ON usage_ledger (created_at);
`;

export class PostgresLedger implements UsageLedger {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
    // 유휴 커넥션 단절은 'error' 이벤트로 온다 — 무리스너면 프로세스 크래시 (리뷰 SW1-r4)
    this.pool.on("error", (err) => console.error("[ledger-pool]", err.message));
  }

  private init(): Promise<void> {
    // 실패 시 캐시 리셋 — 일시 장애가 영구 불능이 되지 않게 (리뷰 D1-r4)
    this.ready ??= this.pool.query(DDL).then(
      () => undefined,
      (err) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }

  async record(row: LedgerRow): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO usage_ledger (request_id, attempt, provider, model, surface, stream, outcome,
         http_status, finish_reason, error_category,
         input_tokens, input_no_cache, input_cache_read, input_cache_write,
         output_tokens, output_reasoning, total_tokens, usage_raw,
         billed, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        row.requestId, row.attempt, row.provider, row.model, row.surface, row.stream, row.outcome,
        row.httpStatus ?? null, row.finishReason ?? null, row.errorCategory ?? null,
        row.usage?.input.total ?? null, row.usage?.input.noCache ?? null,
        row.usage?.input.cacheRead ?? null, row.usage?.input.cacheWrite ?? null,
        row.usage?.output.total ?? null, row.usage?.output.reasoning ?? null,
        row.usage?.totalTokens ?? null, row.usage ? JSON.stringify(row.usage.raw) : null,
        row.billed, row.durationMs, row.createdAt,
      ],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
