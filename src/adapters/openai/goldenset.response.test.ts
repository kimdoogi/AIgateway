import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tools/capture/fixtures.js";
import { replayOpenAIStream } from "../../../tools/capture/replay.js";
import { openaiChatAdapter, openaiResponsesAdapter } from "./index.js";

// 골든셋 ② — 실 API 픽스처 재생 → IR 스냅샷 (D9). fixtures/openai/ 자동 발견.
// 표면 판별은 픽스처 메타의 요청 path (responses vs chat/completions).
// 녹화 전이면 스킵 — OPENAI_API_KEY 설정 후 `pnpm capture oai-...`로 채운다.

function discoverCases(): string[] {
  const names = new Set<string>();
  try {
    for (const file of readdirSync("fixtures/openai")) {
      if (file.endsWith(".json")) names.add(file.split(".")[0]!);
    }
  } catch {
    /* 녹화 전 */
  }
  return [...names].sort();
}

const cases = discoverCases();

describe("골든셋 ② openai 픽스처 → IR", () => {
  if (cases.length === 0) {
    // 녹화 전 자리표시 — 하네스·케이스는 준비됨. 녹화 완료 시 자동으로 실케이스로 대체된다
    it.todo("픽스처 없음 — OPENAI_API_KEY 설정 후 pnpm capture로 oai-* 녹화 (DoD 전 필수)");
  }

  for (const name of cases) {
    it(name, () => {
      const fixture = readFixture("openai", name);
      expect(fixture).not.toBeNull();
      const { meta, chunks } = fixture!;
      const isChat = meta.request.path.includes("/chat/completions");
      const adapter = isChat ? openaiChatAdapter : openaiResponsesAdapter;

      if (meta.status !== 200) {
        expect(adapter.mapHttpError(meta.status, meta.body, meta.headers)).toMatchSnapshot();
        return;
      }
      if (meta.stream) {
        expect(chunks).toBeDefined();
        expect(
          replayOpenAIStream(chunks!, { modelId: meta.request.body["model"] as string }, meta.request.path),
        ).toMatchSnapshot();
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
