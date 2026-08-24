import { loadDotenv } from "../src/env.js";
import { PostgresPool, migrationStatus, runMigrations } from "../src/state/postgres.js";

// 스키마 마이그레이션 CLI — 앱 기동과 분리해 돌리기 위한 경로 (오케스트레이터 initContainer/Job).
//   pnpm migrate          미적용분 적용
//   pnpm migrate --status 적용 현황만 출력 (변경 없음)
//
// 앱은 MIGRATE_ON_BOOT=false일 때 스키마가 최신인지 **검사만** 하고 미적용이면 기동을 거부한다 —
// 마이그레이션 주체를 하나로 두는 것이 목적 (여러 파드가 동시에 스키마를 바꾸지 않게).

loadDotenv();

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL 미설정 — 마이그레이션할 대상이 없습니다");
  process.exit(2);
}

const db = new PostgresPool(url, 2);
try {
  const before = await migrationStatus(db);
  if (process.argv.includes("--status")) {
    console.log(`적용됨 ${before.applied.length}건: ${before.applied.join(", ") || "(없음)"}`);
    console.log(`미적용 ${before.pending.length}건: ${before.pending.join(", ") || "(없음)"}`);
    if (before.drifted.length > 0) console.error(`체크섬 불일치: ${before.drifted.join(", ")}`);
    process.exit(before.pending.length > 0 || before.drifted.length > 0 ? 1 : 0);
  }

  // 미적용분이 없어도 **항상** 러너를 태운다 — 체크섬 드리프트 검사가 거기 있고,
  // 정작 그 검사가 필요한 때가 "전부 적용된 것처럼 보이는" 상태다 (실 DB 검증에서 검출)
  if (before.pending.length > 0) {
    console.log(`미적용 ${before.pending.length}건 적용 중: ${before.pending.join(", ")}`);
  }
  const done = await runMigrations(db);
  if (done.length > 0) {
    console.log(`완료 — ${done.join(", ")}`);
  } else if (before.pending.length > 0) {
    // 락 대기 중 다른 프로세스가 먼저 끝냈다 (다중 레플리카 동시 기동)
    console.log("완료 — 다른 프로세스가 먼저 적용함 (중복 적용 없음)");
  } else {
    console.log(`스키마 최신 — 적용됨 ${before.applied.length}건, 변경 없음`);
  }
} catch (err) {
  console.error("마이그레이션 실패:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.close();
}
