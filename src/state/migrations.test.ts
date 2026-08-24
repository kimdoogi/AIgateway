import { describe, expect, it } from "vitest";
import { MIGRATIONS, checksum, validateMigrationList } from "./migrations.js";
import { runMigrations, migrationStatus, type PostgresPool } from "./postgres.js";

// 마이그레이션 목록 무결성 + 러너 의미론. 러너는 가짜 클라이언트로 검증한다 —
// 실 Postgres는 D9(테스트 네트워크 금지)라 opt-in 스크립트 소관.

describe("마이그레이션 목록 무결성", () => {
  it("id 유일·정렬·형식 위반 없음", () => {
    expect(validateMigrationList()).toEqual([]);
  });

  it("목록 = baseline 4건 + 증분 (append-only 순서)", () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual([
      "0001_usage_ledger",
      "0002_ops_plane",
      "0003_gateway_files",
      "0004_gateway_batches",
      "0005_portal",
    ]);
  });

  it("baseline은 IF NOT EXISTS라 기존 배포에서 안전하게 채택된다", () => {
    // 이미 테이블이 있는 DB에 적용해도 무해해야 "적용됨"으로 기록만 하고 넘어갈 수 있다
    for (const m of MIGRATIONS) {
      const creates = m.sql.match(/CREATE TABLE (?!IF NOT EXISTS)/g);
      const alters = m.sql.match(/ADD COLUMN (?!IF NOT EXISTS)/g);
      expect(creates, `${m.id}: CREATE TABLE에 IF NOT EXISTS 누락`).toBeNull();
      expect(alters, `${m.id}: ADD COLUMN에 IF NOT EXISTS 누락`).toBeNull();
    }
  });

  it("체크섬은 공백 변화에 둔감하고 내용 변화에 민감하다", () => {
    expect(checksum("SELECT 1;")).toBe(checksum("  SELECT   1;  \n"));
    expect(checksum("SELECT 1;")).not.toBe(checksum("SELECT 2;"));
  });

  it("목록 무결성 검사가 실제로 위반을 잡는다", () => {
    expect(validateMigrationList([{ id: "bad-id", sql: "x" }])).toContainEqual(
      expect.stringContaining("id 형식 위반"),
    );
    expect(
      validateMigrationList([
        { id: "0002_b", sql: "x" },
        { id: "0001_a", sql: "x" }, // 역순
      ]),
    ).toContainEqual(expect.stringContaining("정렬 위반"));
    expect(
      validateMigrationList([
        { id: "0001_a", sql: "x" },
        { id: "0001_a", sql: "y" },
      ]),
    ).toContainEqual(expect.stringContaining("id 중복"));
  });
});

/** 가짜 Postgres — schema_migrations만 흉내내고 나머지 DDL은 성공 처리 */
function fakeDb(opts: { preApplied?: Array<{ id: string; checksum: string }>; failOn?: string } = {}) {
  const rows = [...(opts.preApplied ?? [])];
  const log: string[] = [];
  const query = async (sql: string, params?: unknown[]) => {
    log.push(sql.trim().split("\n")[0]!.slice(0, 40));
    if (sql.includes("SELECT id, checksum FROM schema_migrations")) return { rows };
    if (sql.includes("SELECT id FROM schema_migrations")) return { rows };
    if (sql.startsWith("INSERT INTO schema_migrations")) {
      rows.push({ id: String(params?.[0]), checksum: String(params?.[1]) });
      return { rows: [] };
    }
    if (opts.failOn && sql.includes(opts.failOn)) throw new Error("DDL 실패(모의)");
    return { rows: [] };
  };
  const db = {
    pool: { query },
    withLock: async <T>(_label: string, fn: (c: { query: typeof query }) => Promise<T>) => fn({ query }),
  } as unknown as PostgresPool;
  return { db, rows, log };
}

describe("runMigrations", () => {
  it("빈 DB에는 전건 적용하고 체크섬을 기록한다", async () => {
    const { db, rows } = fakeDb();
    const applied = await runMigrations(db);
    expect(applied).toEqual(MIGRATIONS.map((m) => m.id));
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(rows[0]!.checksum).toBe(checksum(MIGRATIONS[0]!.sql));
  });

  it("재실행은 무동작 (멱등)", async () => {
    const pre = MIGRATIONS.map((m) => ({ id: m.id, checksum: checksum(m.sql) }));
    const { db } = fakeDb({ preApplied: pre });
    expect(await runMigrations(db)).toEqual([]);
  });

  it("미적용분만 적용한다", async () => {
    const pre = [{ id: MIGRATIONS[0]!.id, checksum: checksum(MIGRATIONS[0]!.sql) }];
    const { db } = fakeDb({ preApplied: pre });
    expect(await runMigrations(db)).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
  });

  it("적용된 마이그레이션이 편집됐으면 **아무것도 적용하지 않고** 거부한다", async () => {
    // 조용한 스키마 드리프트는 "어떤 스키마가 떠 있는지 모르는" 상태로 직행하는 길이다
    const pre = [{ id: MIGRATIONS[0]!.id, checksum: "deadbeefdeadbeef" }];
    const { db, rows } = fakeDb({ preApplied: pre });
    await expect(runMigrations(db)).rejects.toThrow(/이미 적용된 마이그레이션이 편집됐습니다/);
    expect(rows).toHaveLength(1); // 뒤쪽 미적용분도 손대지 않았다
  });

  it("중간 실패는 ROLLBACK하고 어디서 멈췄는지 알린다", async () => {
    const { db, rows, log } = fakeDb({ failOn: "gateway_files" });
    await expect(runMigrations(db)).rejects.toThrow(/0003_gateway_files 실패/);
    expect(rows.map((r) => r.id)).toEqual(["0001_usage_ledger", "0002_ops_plane"]); // 앞 2건은 적용됨
    expect(log).toContain("ROLLBACK");
  });
});

describe("migrationStatus", () => {
  it("적용·미적용을 분리해 보고한다 (CLI·readiness 공용)", async () => {
    const pre = [{ id: MIGRATIONS[0]!.id, checksum: checksum(MIGRATIONS[0]!.sql) }];
    const { db } = fakeDb({ preApplied: pre });
    const status = await migrationStatus(db);
    expect(status.applied).toEqual(["0001_usage_ledger"]);
    expect(status.pending).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
  });
});
