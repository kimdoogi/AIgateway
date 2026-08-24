import { createHash } from "node:crypto";

// 스키마 마이그레이션 (리뷰 2026-08-22 후속 — 버전 관리 부재 해소).
//
// 이전에는 각 스토어가 첫 쿼리에서 CREATE/ALTER를 idempotent하게 돌렸다. 동시 부팅 락 경합은
// advisory lock으로 막았지만 남는 문제가 있었다:
//   · 어떤 스키마 버전이 배포돼 있는지 **알 방법이 없다** (롤백·감사 경로 부재)
//   · 스키마가 코드 배포 순서에 종속 — 마이그레이션을 먼저 돌릴 수단이 없었다
//   · 이미 적용된 DDL을 나중에 편집해도 아무도 모른다
//
// 계약:
//   · 마이그레이션은 **순서 있는 append-only 목록**. 적용된 항목의 sql은 절대 편집하지 않는다
//     (체크섬이 어긋나면 실행을 거부한다 — 조용한 스키마 드리프트 금지)
//   · 새 변경은 목록 **끝에 추가**만 한다
//   · 각 항목은 트랜잭션 1개로 적용된다 (Postgres DDL은 트랜잭션 가능)
//
// baseline(0001~0004)은 기존 idempotent DDL을 그대로 옮긴 것이다 — 이미 테이블이 있는
// 배포에서도 IF NOT EXISTS라 무해하게 "적용됨"으로 기록되고 채택(adopt)된다.

export interface Migration {
  /** 정렬 키 겸 식별자. 0001_snake_case 형식, 한번 배포되면 불변 */
  id: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  // usage 원장 (ADR-0006/0007)
  {
    id: "0001_usage_ledger",
    sql: `
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
`,
  },
  // 운영 평면 — 가상 키·BYO 키·리소스 레지스트리·본문 로그
  {
    id: "0002_ops_plane",
    sql: `
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
-- 보관 정책 스윕용 (리뷰 2026-08-22 #11 — 무제한 증가 방어)
CREATE INDEX IF NOT EXISTS body_logs_created_idx ON body_logs (created_at);
ALTER TABLE virtual_keys ADD COLUMN IF NOT EXISTS rate_limit JSONB;
`,
  },
  // Files 브리지 매핑 (부록 (b) §2)
  {
    id: "0003_gateway_files",
    sql: `
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
`,
  },
  // Batches 브리지 잡 (부록 (b) §3)
  {
    id: "0004_gateway_batches",
    sql: `
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
`,
  },
  // 셀프 가입 포털 — 계정·세션 (2026-08-24)
  {
    id: "0005_portal",
    sql: `
CREATE TABLE IF NOT EXISTS portal_accounts (
  account_id TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  tenant     TEXT NOT NULL UNIQUE,
  disabled   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON portal_sessions (expires_at);
`,
  },
];

/** 적용된 마이그레이션의 sql 변조 검출용 — 공백 정규화 후 sha256 */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** 목록 자체의 무결성 (id 유일·정렬·형식) — 테스트와 러너가 공유 */
export function validateMigrationList(list: readonly Migration[] = MIGRATIONS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const m of list) {
    if (!/^\d{4}_[a-z0-9_]+$/.test(m.id)) problems.push(`id 형식 위반: ${m.id} (0001_snake_case)`);
    if (seen.has(m.id)) problems.push(`id 중복: ${m.id}`);
    seen.add(m.id);
    if (m.id <= previous) problems.push(`정렬 위반: ${m.id}이 ${previous} 뒤에 온다`);
    previous = m.id;
    if (m.sql.trim().length === 0) problems.push(`빈 sql: ${m.id}`);
  }
  return problems;
}
