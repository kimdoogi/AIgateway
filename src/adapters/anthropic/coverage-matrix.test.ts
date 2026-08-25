import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "./index.js";
import { KNOWN_PO_KEYS } from "./options.js";

// 커버리지 매트릭스 CI (ADR-0001 D10 — "체크리스트×어댑터").
// 기준 문서(research/2026-08-20-anthropic-api-coverage.md)가 곧 매트릭스다: 각 행의 마지막
// 커버리지 열이 처리 방식 분류. 이 테스트는 ① 전 행이 인지된 분류를 갖고 ② "미결"이 0건이며
// ③ 섹션별 행수가 스냅샷과 일치(신규 행 = 스냅샷 diff = 강제 리뷰)함을 보장한다.
// "체크리스트×실제 API" 드리프트는 별도 장치(known-fields, D10-5)가 담당.

const DOC = "docs/research/2026-08-20-anthropic-api-coverage.md";

/** 커버리지 분류 키워드 (문서 범례 §0 + 관례) — 하나 이상 포함해야 "분류됨" */
const MECHANISMS = ["IR", "PO", "PT", "EP", "정책", "2차", "어댑터 소유", "정규화", "블록"] as const;

interface Row {
  section: string;
  key: string;
  coverage: string;
}

function parseRows(): Row[] {
  const lines = readFileSync(DOC, "utf8").split("\n");
  const rows: Row[] = [];
  let section = "";
  let inLegend = false;
  for (const line of lines) {
    const h = line.match(/^##+ (.+)/);
    if (h) {
      section = h[1]!;
      // §9는 모델×파라미터 게이트 표(커버리지 열 없음), §10은 결정 현황 산문 — 매트릭스 대상 아님
      inLegend = section.startsWith("범례") || section.startsWith("9.") || section.startsWith("10.");
      continue;
    }
    if (inLegend || !line.startsWith("| ")) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, arr) => i > 0 && i < arr.length - 1);
    if (cells.length < 2) continue;
    if (cells[0]!.startsWith("---") || cells.every((c) => /^-+$/.test(c))) continue;
    if (cells[cells.length - 1] === "커버리지") continue; // 헤더 행 (커버리지 열 제목으로 판별)
    rows.push({ section, key: cells[0]!, coverage: cells[cells.length - 1]! });
  }
  return rows;
}

describe("커버리지 매트릭스 (D10 — 체크리스트×어댑터)", () => {
  const rows = parseRows();

  it("체크리스트가 비어 있지 않다", () => {
    expect(rows.length).toBeGreaterThan(60);
  });

  it("전 행이 인지된 커버리지 분류를 갖는다 (신규 행의 무분류 추가 차단)", () => {
    const unclassified = rows.filter(
      (r) => r.coverage.length === 0 || !MECHANISMS.some((m) => r.coverage.includes(m)),
    );
    expect(unclassified.map((r) => `${r.section} :: ${r.key} :: ${r.coverage}`)).toEqual([]);
  });

  it("미결 항목 0건 — v1 범위 결정 완료 상태 유지 (신규 미결은 결정 라운드 필요)", () => {
    const undecided = rows.filter((r) => r.coverage.includes("미결"));
    expect(undecided.map((r) => r.key)).toEqual([]);
  });

  it("섹션별 행수 스냅샷 — 체크리스트 증감은 diff 리뷰를 거친다 (살아있는 문서 규약)", () => {
    const bySection: Record<string, number> = {};
    for (const r of rows) bySection[r.section] = (bySection[r.section] ?? 0) + 1;
    expect(bySection).toMatchSnapshot();
  });

  it("§2 'PO' 분류 행의 키가 KnownOptionsSchema에 실존한다 (감사 관통 패턴 #4 — 분류 문자열만으론 드리프트를 못 잡는다)", () => {
    // §2 행 중 커버리지가 PO를 포함하는 것 — wire 키를 camelCase PO 키로 변환해 스키마 대조
    const toCamel = (s: string): string => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    /** 스키마 키 밖에서 소비되는 §2 PO 행 — 사유 명기 (완전성 강제 패턴) */
    const CONSUMED_ELSEWHERE: Record<string, string> = {
      output_config: "잔여 서브키는 outputConfigExtras로 보존·재병합 (감사 anthropic #1)",
      compaction: "요청 파라미터가 아니라 재전송 블록 계약 — IR 수납은 §6 재전송 행 소관",
      tools: "tools[{type:mcp_toolset}]는 IR provider 툴 경로 — mcpServers PO와 별개",
    };
    const missing = rows
      .filter((r) => r.section.startsWith("2.") && /(^|[^A-Z])PO(?![A-Za-z(])/.test(r.coverage))
      .map((r) => {
        const m = r.key.match(/`?([a-z][a-z0-9_]*)/);
        return m ? m[1]! : r.key;
      })
      .filter((wireKey) => !KNOWN_PO_KEYS.has(toCamel(wireKey)) && !CONSUMED_ELSEWHERE[wireKey]);
    expect(
      missing,
      `문서가 'PO'로 분류했는데 KnownOptionsSchema에 없다 — 스키마 등재 또는 CONSUMED_ELSEWHERE 사유: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("EP v1 확정 항목은 구현체가 존재한다 (count_tokens·Batches·Files — 부록 (b))", async () => {
    expect(anthropicAdapter.countTokens).toBeDefined();
    // 브리지 모듈 존재 검증 (import 시 네트워크 없음 — D9)
    const batches = await import("../../bridge/batches.js");
    const files = await import("../../bridge/files.js");
    expect(typeof batches.createBatch).toBe("function");
    expect(typeof files.uploadFile).toBe("function");
  });
});
