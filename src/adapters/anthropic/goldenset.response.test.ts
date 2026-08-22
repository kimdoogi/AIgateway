import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tools/capture/fixtures.js";
import { replayAnthropicStream } from "../../../tools/capture/replay.js";
import { anthropicAdapter } from "./index.js";

// 골든셋 ② — 실 API 픽스처 재생 → IR 스냅샷 (D9. 네트워크 없음 — 픽스처만).
// fixtures/anthropic/ 자동 발견: 새 녹화는 자동으로 골든셋에 편입된다.
//   200 비스트림 → transformResponse, 200 스트림 → SSE 재생 → 이벤트 배열, 4xx/5xx → mapHttpError.

function discoverCases(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync("fixtures/anthropic")) {
    if (file.endsWith(".json")) names.add(file.split(".")[0]!);
  }
  return [...names].sort();
}

const cases = discoverCases();

describe("골든셋 ② anthropic 픽스처 → IR", () => {
  it("픽스처가 존재한다 (하네스 선행 — DoD 소급 방지)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    it(name, () => {
      const fixture = readFixture("anthropic", name);
      expect(fixture).not.toBeNull();
      const { meta, chunks } = fixture!;

      if (meta.status !== 200) {
        expect(anthropicAdapter.mapHttpError(meta.status, meta.body, meta.headers)).toMatchSnapshot();
        return;
      }
      if (meta.request.path.includes("count_tokens")) {
        // count_tokens 프록시 (부록 (b) §1) — 응답 형태가 messages와 달라 전용 변환
        expect(anthropicAdapter.countTokens!.transformResponse(meta.body)).toMatchSnapshot();
        return;
      }
      if (meta.stream) {
        expect(chunks).toBeDefined();
        expect(replayAnthropicStream(chunks!, { modelId: meta.request.body["model"] as string })).toMatchSnapshot();
        return;
      }
      expect(
        anthropicAdapter.transformResponse(meta.body, {
          requestId: "req_golden",
          modelId: meta.request.body["model"] as string,
          requestedModel: meta.request.body["model"] as string,
        }),
      ).toMatchSnapshot();
    });
  }

  it("스트림 재생 바이트 결정론 — 같은 픽스처 2회 재생 동일 (D10)", () => {
    for (const name of cases) {
      const fixture = readFixture("anthropic", name);
      if (!fixture?.chunks) continue;
      const ctx = { modelId: fixture.meta.request.body["model"] as string };
      expect(JSON.stringify(replayAnthropicStream(fixture.chunks, ctx))).toBe(
        JSON.stringify(replayAnthropicStream(fixture.chunks, ctx)),
      );
    }
  });
});
