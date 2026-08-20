import { describe, expect, it } from "vitest";
import { stringifyCanonical } from "./canonical.js";
import { IRRequestSchema } from "./request.js";
import { BlockSchema } from "./blocks.js";

// ir-v0 §1 / D10 — 동일 IR → 바이트 동일 JSON. 프로바이더 프롬프트 캐시 프리픽스 보존의 전제.

describe("직렬화 결정론", () => {
  it("입력 키 순서가 달라도 canonical 바이트는 동일하다", () => {
    const a = {
      version: "0",
      model: "claude-opus-5",
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 10,
    };
    // 같은 값, 다른 키 순서
    const b = {
      maxOutputTokens: 10,
      messages: [{ blocks: [{ text: "hi", type: "text" }], role: "user" }],
      model: "claude-opus-5",
      version: "0",
    };
    expect(stringifyCanonical(IRRequestSchema, a)).toBe(stringifyCanonical(IRRequestSchema, b));
  });

  it("두 번 직렬화해도 동일 (멱등)", () => {
    const block = {
      type: "toolCall",
      toolCallId: "t1",
      toolName: "f",
      input: { type: "json", value: { b: 1, a: 2 } },
      origin: { provider: "anthropic", model: "m" },
    };
    const once = stringifyCanonical(BlockSchema, block);
    const twice = stringifyCanonical(BlockSchema, JSON.parse(once));
    expect(twice).toBe(once);
  });

  it("생략 필드는 키 자체가 출력되지 않는다", () => {
    const s = stringifyCanonical(BlockSchema, { type: "text", text: "x" });
    expect(s).toBe('{"type":"text","text":"x"}');
  });

  it("자유형 JSON(providerOptions 내부)은 입력 순서 보존 — 동일 입력 = 동일 바이트", () => {
    const req = {
      version: "0",
      model: "m",
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      providerOptions: { anthropic: { z: 1, a: 2 } },
    };
    expect(stringifyCanonical(IRRequestSchema, req)).toBe(stringifyCanonical(IRRequestSchema, req));
    expect(stringifyCanonical(IRRequestSchema, req)).toContain('{"z":1,"a":2}');
  });
});
