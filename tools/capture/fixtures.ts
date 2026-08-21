import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JSONObject } from "../../src/ir/json.js";

// 골든셋 픽스처 IO. 명명 규약: `{기능}.{모델스냅샷}.{녹화일}` (walking-skeleton 4단계)
//   text.claude-haiku-4-5-20251001.2026-08-21.json        ← 비스트림 body + 메타
//   text-stream.claude-haiku-4-5-20251001.2026-08-21.json ← 스트림 메타 (body 없음)
//   text-stream.claude-haiku-4-5-20251001.2026-08-21.chunks.txt ← raw SSE
// 경로는 저장소 루트 기준 — 하네스/테스트 모두 루트에서 실행한다.

export const FIXTURE_ROOT = "fixtures";

export interface FixtureMeta {
  case: string;
  recordedAt: string;
  /** 응답이 보고한 모델 스냅샷 (에러 픽스처는 요청 모델) */
  model: string;
  stream: boolean;
  request: { path: string; body: JSONObject; headers?: Record<string, string> };
  status: number;
  headers: Record<string, string>;
  /** 비스트림 응답 body (새니타이즈됨) */
  body?: unknown;
  /** 스트림 청크 파일명 */
  chunksFile?: string;
}

export function providerDir(provider: string): string {
  return join(FIXTURE_ROOT, provider);
}

/** 케이스명으로 픽스처 메타 파일명을 찾는다 (최신 녹화일 우선) */
export function findFixtures(provider: string, caseName: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(providerDir(provider));
  } catch {
    return [];
  }
  const date = (f: string): string => f.split(".").at(-2) ?? "";
  const mtime = (f: string): number => {
    try {
      return statSync(join(providerDir(provider), f)).mtimeMs;
    } catch {
      return 0;
    }
  };
  return entries
    .filter((f) => f.endsWith(".json") && f.startsWith(`${caseName}.`))
    // 녹화일 내림차순, 동일자는 mtime — 파일명 사전순은 모델 세그먼트가 날짜·시간을 이긴다 (리뷰 F4/SW3-r3)
    .sort((a, b) => date(b).localeCompare(date(a)) || mtime(b) - mtime(a) || b.localeCompare(a));
}

export function readFixture(
  provider: string,
  caseName: string,
): { meta: FixtureMeta; chunks?: string } | null {
  const [file] = findFixtures(provider, caseName);
  if (!file) return null;
  const meta = JSON.parse(readFileSync(join(providerDir(provider), file), "utf8")) as FixtureMeta;
  const chunks = meta.chunksFile
    ? readFileSync(join(providerDir(provider), meta.chunksFile), "utf8")
    : undefined;
  return { meta, ...(chunks !== undefined ? { chunks } : {}) };
}
