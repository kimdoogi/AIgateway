import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tools/capture/fixtures.js";
import { replayGeminiStream } from "../../../tools/capture/replay.js";
import { geminiAdapter } from "./index.js";

// 골든셋 ② — 실 API 픽스처 재생 → IR 스냅샷 (D9). fixtures/google/ 자동 발견.
// 녹화 전이면 todo — GEMINI_API_KEY 설정 후 `pnpm capture gemini-...`로 채운다.

function discoverCases(): string[] {
  const names = new Set<string>();
  try {
    for (const file of readdirSync("fixtures/google")) {
      if (file.endsWith(".json")) names.add(file.split(".")[0]!);
    }
  } catch { /* 녹화 전 */ }
  return [...names].sort();
}

const cases = discoverCases();

describe("골든셋 ② gemini 픽스처 → IR", () => {
  if (cases.length === 0) {
    it.todo("픽스처 없음 — GEMINI_API_KEY 설정 후 pnpm capture로 gemini-* 녹화 (DoD 전 필수)");
  }

  for (const name of cases) {
    it(name, () => {
      const fixture = readFixture("google", name);
      expect(fixture).not.toBeNull();
      const { meta, chunks } = fixture!;

      if (meta.status !== 200) {
        expect(geminiAdapter.mapHttpError(meta.status, meta.body, meta.headers)).toMatchSnapshot();
        return;
      }
      if (meta.stream) {
        expect(chunks).toBeDefined();
        expect(replayGeminiStream(chunks!, { modelId: meta.model })).toMatchSnapshot();
        return;
      }
      expect(
        geminiAdapter.transformResponse(meta.body, {
          requestId: "req_golden",
          modelId: meta.model,
          requestedModel: meta.model,
        }),
      ).toMatchSnapshot();
    });
  }
});
