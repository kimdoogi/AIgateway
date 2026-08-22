import pg from "pg";
import type {
  BatchJob,
  BatchStore,
  BodyLogEntry,
  BodyLogSink,
  FileMapping,
  FileStore,
  KeyStore,
  LedgerRow,
  ProviderKeyStore,
  QueryableLedger,
  ResourceStore,
  ServerResource,
  TenantProviderKey,
  UsageAggregate,
  VirtualKey,
} from "./types.js";

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
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS tenant TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS key_source TEXT;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;
`;

export class PostgresLedger implements QueryableLedger {
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
         billed, duration_ms, created_at, tenant, key_id, key_source, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        row.requestId, row.attempt, row.provider, row.model, row.surface, row.stream, row.outcome,
        row.httpStatus ?? null, row.finishReason ?? null, row.errorCategory ?? null,
        row.usage?.input.total ?? null, row.usage?.input.noCache ?? null,
        row.usage?.input.cacheRead ?? null, row.usage?.input.cacheWrite ?? null,
        row.usage?.output.total ?? null, row.usage?.output.reasoning ?? null,
        row.usage?.totalTokens ?? null, row.usage ? JSON.stringify(row.usage.raw) : null,
        row.billed, row.durationMs, row.createdAt,
        row.tenant ?? null, row.keyId ?? null, row.keySource ?? null, row.costUsd ?? null,
      ],
    );
  }

  async aggregate(opts: {
    from: string;
    to: string;
    groupBy: "model" | "provider" | "keyId" | "tenant";
    tenant?: string;
  }): Promise<UsageAggregate[]> {
    await this.init();
    const col = { model: "model", provider: "provider", keyId: "key_id", tenant: "tenant" }[opts.groupBy];
    const params: unknown[] = [opts.from, opts.to];
    let where = "created_at >= $1 AND created_at <= $2";
    if (opts.tenant !== undefined) {
      params.push(opts.tenant);
      where += ` AND tenant = $${params.length}`;
    }
    const r = await this.pool.query(
      `SELECT COALESCE(${col}, '(none)') AS grp,
              COUNT(*)::bigint AS requests,
              COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
              COALESCE(SUM(cost_usd), 0)::double precision AS cost_usd
       FROM usage_ledger WHERE ${where} GROUP BY grp ORDER BY grp`,
      params,
    );
    return r.rows.map((row) => ({
      group: row.grp,
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens),
      costUsd: Number(row.cost_usd),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── 운영 평면 스토어 (ADR-0006/0007 — 2026-08-21) ──────────────

const OPS_DDL = `
CREATE TABLE IF NOT EXISTS virtual_keys (
  key_id           TEXT PRIMARY KEY,
  tenant           TEXT NOT NULL,
  name             TEXT,
  key_hash         TEXT NOT NULL UNIQUE,
  disabled         BOOLEAN NOT NULL DEFAULT FALSE,
  budget           JSONB,
  body_log_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_provider_keys (
  tenant        TEXT NOT NULL,
  provider      TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant, provider)
);
CREATE TABLE IF NOT EXISTS server_resources (
  provider          TEXT NOT NULL,
  resource_type     TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  tenant            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ,
  created_by_key_id TEXT,
  PRIMARY KEY (provider, resource_type, external_id)
);
CREATE TABLE IF NOT EXISTS body_logs (
  id         BIGSERIAL PRIMARY KEY,
  request_id TEXT NOT NULL,
  tenant     TEXT,
  direction  TEXT NOT NULL,
  body       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS body_logs_request_idx ON body_logs (request_id);
`;

class OpsPool {
  readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;
  constructor(connectionString: string, label: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
    this.pool.on("error", (err) => console.error(`[${label}]`, err.message));
  }
  init(): Promise<void> {
    this.ready ??= this.pool.query(OPS_DDL).then(
      () => undefined,
      (err) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class PostgresKeyStore implements KeyStore {
  private readonly db: OpsPool;
  constructor(connectionString: string) {
    this.db = new OpsPool(connectionString, "key-store-pool");
  }
  private rowToKey(row: Record<string, unknown>): VirtualKey {
    return {
      keyId: row["key_id"] as string,
      tenant: row["tenant"] as string,
      ...(row["name"] ? { name: row["name"] as string } : {}),
      keyHash: row["key_hash"] as string,
      ...(row["disabled"] ? { disabled: true } : {}),
      ...(row["budget"] ? { budget: row["budget"] as VirtualKey["budget"] } : {}),
      ...(row["body_log_opt_out"] ? { bodyLogOptOut: true } : {}),
      createdAt: new Date(row["created_at"] as string).toISOString(),
    };
  }
  async put(key: VirtualKey): Promise<void> {
    await this.db.init();
    await this.db.pool.query(
      `INSERT INTO virtual_keys (key_id, tenant, name, key_hash, disabled, budget, body_log_opt_out, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key_id) DO UPDATE SET disabled = EXCLUDED.disabled, budget = EXCLUDED.budget, name = EXCLUDED.name`,
      [
        key.keyId, key.tenant, key.name ?? null, key.keyHash, key.disabled ?? false,
        key.budget ? JSON.stringify(key.budget) : null, key.bodyLogOptOut ?? false, key.createdAt,
      ],
    );
  }
  async getByHash(keyHash: string): Promise<VirtualKey | null> {
    await this.db.init();
    const r = await this.db.pool.query(`SELECT * FROM virtual_keys WHERE key_hash = $1`, [keyHash]);
    return r.rows[0] ? this.rowToKey(r.rows[0]) : null;
  }
  async get(keyId: string): Promise<VirtualKey | null> {
    await this.db.init();
    const r = await this.db.pool.query(`SELECT * FROM virtual_keys WHERE key_id = $1`, [keyId]);
    return r.rows[0] ? this.rowToKey(r.rows[0]) : null;
  }
  async list(): Promise<VirtualKey[]> {
    await this.db.init();
    const r = await this.db.pool.query(`SELECT * FROM virtual_keys ORDER BY created_at`);
    return r.rows.map((row) => this.rowToKey(row));
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

export class PostgresProviderKeyStore implements ProviderKeyStore {
  private readonly db: OpsPool;
  constructor(connectionString: string) {
    this.db = new OpsPool(connectionString, "provider-key-pool");
  }
  async put(key: TenantProviderKey): Promise<void> {
    await this.db.init();
    await this.db.pool.query(
      `INSERT INTO tenant_provider_keys (tenant, provider, encrypted_key, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant, provider) DO UPDATE SET encrypted_key = EXCLUDED.encrypted_key, created_at = EXCLUDED.created_at`,
      [key.tenant, key.provider, key.encryptedKey, key.createdAt],
    );
  }
  async get(tenant: string, provider: string): Promise<TenantProviderKey | null> {
    await this.db.init();
    const r = await this.db.pool.query(
      `SELECT * FROM tenant_provider_keys WHERE tenant = $1 AND provider = $2`,
      [tenant, provider],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      tenant: row.tenant,
      provider: row.provider,
      encryptedKey: row.encrypted_key,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }
  async delete(tenant: string, provider: string): Promise<void> {
    await this.db.init();
    await this.db.pool.query(`DELETE FROM tenant_provider_keys WHERE tenant = $1 AND provider = $2`, [tenant, provider]);
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

export class PostgresResourceStore implements ResourceStore {
  private readonly db: OpsPool;
  constructor(connectionString: string) {
    this.db = new OpsPool(connectionString, "resource-pool");
  }
  async register(r: ServerResource): Promise<void> {
    await this.db.init();
    await this.db.pool.query(
      `INSERT INTO server_resources (provider, resource_type, external_id, tenant, created_at, expires_at, created_by_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provider, resource_type, external_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [r.provider, r.resourceType, r.externalId, r.tenant, r.createdAt, r.expiresAt ?? null, r.createdByKeyId ?? null],
    );
  }
  async ownerOf(provider: string, resourceType: string, externalId: string): Promise<string | null> {
    await this.db.init();
    const r = await this.db.pool.query(
      `SELECT tenant FROM server_resources WHERE provider = $1 AND resource_type = $2 AND external_id = $3`,
      [provider, resourceType, externalId],
    );
    return r.rows[0]?.tenant ?? null;
  }
  async listExpired(nowIso: string): Promise<ServerResource[]> {
    await this.db.init();
    const r = await this.db.pool.query(
      `SELECT * FROM server_resources WHERE expires_at IS NOT NULL AND expires_at <= $1`,
      [nowIso],
    );
    return r.rows.map((row) => ({
      provider: row.provider,
      resourceType: row.resource_type,
      externalId: row.external_id,
      tenant: row.tenant,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
      ...(row.created_by_key_id ? { createdByKeyId: row.created_by_key_id } : {}),
    }));
  }
  async delete(provider: string, resourceType: string, externalId: string): Promise<void> {
    await this.db.init();
    await this.db.pool.query(
      `DELETE FROM server_resources WHERE provider = $1 AND resource_type = $2 AND external_id = $3`,
      [provider, resourceType, externalId],
    );
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

export class PostgresBodyLog implements BodyLogSink {
  private readonly db: OpsPool;
  constructor(connectionString: string) {
    this.db = new OpsPool(connectionString, "body-log-pool");
  }
  async record(entry: BodyLogEntry): Promise<void> {
    await this.db.init();
    await this.db.pool.query(
      `INSERT INTO body_logs (request_id, tenant, direction, body, created_at) VALUES ($1,$2,$3,$4,$5)`,
      [entry.requestId, entry.tenant ?? null, entry.direction, JSON.stringify(entry.body), entry.createdAt],
    );
  }
  async close(): Promise<void> {
    await this.db.close();
  }
}

// ── Files / Batches (부록 (b) §2·§3, ADR-0006 §1) ─────────────────

const FILES_DDL = `
CREATE TABLE IF NOT EXISTS gateway_files (
  tenant           TEXT NOT NULL,
  gateway_file_id  TEXT NOT NULL,
  provider         TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  media_type       TEXT NOT NULL,
  size_bytes       BIGINT NOT NULL,
  filename         TEXT,
  created_at       TIMESTAMPTZ NOT NULL,
  expires_at       TIMESTAMPTZ,
  PRIMARY KEY (tenant, gateway_file_id)
);
`;

export class PostgresFileStore implements FileStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
    this.pool.on("error", (err) => console.error("[file-store-pool]", err.message));
  }
  private init(): Promise<void> {
    this.ready ??= this.pool.query(FILES_DDL).then(
      () => undefined,
      (err) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }
  async put(m: FileMapping): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO gateway_files (tenant, gateway_file_id, provider, provider_file_id, media_type, size_bytes, filename, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.tenant, m.gatewayFileId, m.provider, m.providerFileId, m.mediaType, m.sizeBytes, m.filename ?? null, m.createdAt, m.expiresAt ?? null],
    );
  }
  async get(tenant: string, gatewayFileId: string): Promise<FileMapping | null> {
    await this.init();
    const r = await this.pool.query(
      `SELECT * FROM gateway_files WHERE tenant = $1 AND gateway_file_id = $2`,
      [tenant, gatewayFileId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      tenant: row.tenant, gatewayFileId: row.gateway_file_id, provider: row.provider,
      providerFileId: row.provider_file_id, mediaType: row.media_type, sizeBytes: Number(row.size_bytes),
      ...(row.filename ? { filename: row.filename } : {}),
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
    };
  }
  async delete(tenant: string, gatewayFileId: string): Promise<void> {
    await this.init();
    await this.pool.query(`DELETE FROM gateway_files WHERE tenant = $1 AND gateway_file_id = $2`, [tenant, gatewayFileId]);
  }
  async list(tenant: string): Promise<FileMapping[]> {
    await this.init();
    const r = await this.pool.query(`SELECT gateway_file_id FROM gateway_files WHERE tenant = $1 ORDER BY created_at`, [tenant]);
    const out: FileMapping[] = [];
    for (const row of r.rows) {
      const m = await this.get(tenant, row.gateway_file_id);
      if (m) out.push(m);
    }
    return out;
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

const BATCHES_DDL = `
CREATE TABLE IF NOT EXISTS gateway_batches (
  tenant            TEXT NOT NULL,
  gateway_batch_id  TEXT NOT NULL,
  provider          TEXT NOT NULL,
  provider_batch_id TEXT NOT NULL,
  bridge_state      JSONB,
  status            TEXT NOT NULL,
  raw_status        TEXT,
  counts            JSONB NOT NULL,
  item_models       JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ,
  PRIMARY KEY (tenant, gateway_batch_id)
);
`;

export class PostgresBatchStore implements BatchStore {
  private readonly pool: pg.Pool;
  private ready: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
    this.pool.on("error", (err) => console.error("[batch-store-pool]", err.message));
  }
  private init(): Promise<void> {
    this.ready ??= this.pool.query(BATCHES_DDL).then(
      () => undefined,
      (err) => {
        this.ready = undefined;
        throw err;
      },
    );
    return this.ready;
  }
  async put(j: BatchJob): Promise<void> {
    await this.init();
    await this.pool.query(
      `INSERT INTO gateway_batches (tenant, gateway_batch_id, provider, provider_batch_id, bridge_state, status, raw_status, counts, item_models, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant, gateway_batch_id) DO UPDATE SET
         bridge_state = EXCLUDED.bridge_state, status = EXCLUDED.status, raw_status = EXCLUDED.raw_status, counts = EXCLUDED.counts`,
      [
        j.tenant, j.gatewayBatchId, j.provider, j.providerBatchId,
        j.bridgeState ? JSON.stringify(j.bridgeState) : null, j.status, j.rawStatus ?? null,
        JSON.stringify(j.counts), JSON.stringify(j.itemModels), j.createdAt, j.expiresAt ?? null,
      ],
    );
  }
  async get(tenant: string, gatewayBatchId: string): Promise<BatchJob | null> {
    await this.init();
    const r = await this.pool.query(
      `SELECT * FROM gateway_batches WHERE tenant = $1 AND gateway_batch_id = $2`,
      [tenant, gatewayBatchId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      tenant: row.tenant, gatewayBatchId: row.gateway_batch_id, provider: row.provider,
      providerBatchId: row.provider_batch_id,
      ...(row.bridge_state ? { bridgeState: row.bridge_state } : {}),
      status: row.status, ...(row.raw_status ? { rawStatus: row.raw_status } : {}),
      counts: row.counts, itemModels: row.item_models,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.expires_at ? { expiresAt: new Date(row.expires_at).toISOString() } : {}),
    };
  }
  async list(tenant: string): Promise<BatchJob[]> {
    await this.init();
    const r = await this.pool.query(`SELECT gateway_batch_id FROM gateway_batches WHERE tenant = $1 ORDER BY created_at`, [tenant]);
    const out: BatchJob[] = [];
    for (const row of r.rows) {
      const j = await this.get(tenant, row.gateway_batch_id);
      if (j) out.push(j);
    }
    return out;
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
