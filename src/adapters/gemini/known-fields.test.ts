import { describe, expect, it } from "vitest";
import { unknownResponseFields, unknownStreamFields } from "./known-fields.js";

// 신선도 장치 (D10-5) — 재녹화 시 프로바이더가 추가한 wire 필드를 드러낸다.
// google은 리뷰 2026-08-22 전까지 감지기가 아예 없었다 (#15).

const base = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "hi" }, { thought: true, text: "음", thoughtSignature: "sig" }] },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  modelVersion: "gemini-3.7-flash",
  responseId: "resp_1",
};

describe("unknownResponseFields (gemini)", () => {
  it("알려진 응답은 빈 배열", () => {
    expect(unknownResponseFields(base)).toEqual([]);
  });

  it("top-level·usage·candidate·part의 신필드를 각각 검출", () => {
    const drifted = structuredClone(base) as Record<string, any>;
    drifted["safetySignals"] = { x: 1 };
    drifted["usageMetadata"]["reasoningTokenCount"] = 2;
    drifted["candidates"][0]["provenance"] = "x";
    drifted["candidates"][0]["content"]["parts"][0]["audioTimestamp"] = 1;
    const found = unknownResponseFields(drifted);
    expect(found).toContain("$.safetySignals");
    expect(found).toContain("$.usageMetadata.reasoningTokenCount");
    expect(found).toContain("$.candidates[0].provenance");
    expect(found).toContain("$.candidates[0].content.parts[0].audioTimestamp");
  });

  it("content의 parts/role 외 신키도 검출", () => {
    const drifted = structuredClone(base) as Record<string, any>;
    drifted["candidates"][0]["content"]["modality"] = "AUDIO";
    expect(unknownResponseFields(drifted)).toContain("$.candidates[0].content.modality");
  });

  it("스트림은 청크 합집합 — 뒤쪽 청크에서 처음 나오는 필드도 잡는다", () => {
    const chunks = [JSON.stringify(base), JSON.stringify({ ...base, newTopLevel: 1 })];
    expect(unknownStreamFields(chunks)).toEqual(["$.newTopLevel"]);
  });

  it("파싱 불가 청크는 건너뛴다 (어댑터가 warning으로 보존하는 영역)", () => {
    expect(unknownStreamFields(["not json", JSON.stringify(base)])).toEqual([]);
  });
});
