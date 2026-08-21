import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tools/capture/fixtures.js";
import { replayXAIStream } from "../../../tools/capture/replay.js";
import { xaiChatAdapter, xaiResponsesAdapter } from "./index.js";

// 골든셋 ② — 실 API 픽스처 재생 → IR 스냅샷 (D9). fixtures/xai/ 자동 발견.
// 녹화 전이면 todo — XAI_API_KEY 설정 후 `pnpm capture xai-...`로 채운다.

function discoverCases(): string[] {
  const names = new Set<string>();
  try {
    for (const file of readdirSync("fixtures/xai")) {
      if (file.endsWith(".json")) names.add(file.split(".")[0]!);
    }
  } catch { /* 녹화 전 */ }
  return [...names].sort();
}

const cases = discoverCases();

describe("골든셋 ② xai 픽스처 → IR", () => {
  if (cases.length === 0) {
    it.todo("픽스처 없음 — XAI_API_KEY 설정 후 pnpm capture로 xai-* 녹화 (DoD 전 필수)");
  }

  for (const name of cases) {
    it(name, () => {
      const fixture = readFixture("xai", name);
      expect(fixture).not.toBeNull();
      const { meta, chunks } = fixture!;
      const isChat = meta.request.path.includes("/chat/completions");
      const adapter = isChat ? xaiChatAdapter : xaiResponsesAdapter;

      if (meta.status !== 200) {
        expect(adapter.mapHttpError(meta.status, meta.body, meta.headers)).toMatchSnapshot();
        return;
      }
      if (meta.stream) {
        expect(chunks).toBeDefined();
        expect(replayXAIStream(chunks!, { modelId: meta.request.body["model"] as string }, meta.request.path)).toMatchSnapshot();
        return;
      }
      expect(
        adapter.transformResponse(meta.body, {
          requestId: "req_golden",
          modelId: meta.request.body["model"] as string,
          requestedModel: meta.request.body["model"] as string,
        }),
      ).toMatchSnapshot();
    });
  }
});
