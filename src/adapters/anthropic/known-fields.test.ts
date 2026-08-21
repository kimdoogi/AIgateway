import { describe, expect, it } from "vitest";
import { parseSSEText } from "../../stream/sse.js";
import { unknownResponseFields, unknownStreamFields } from "./known-fields.js";

describe("unknownResponseFields (신선도 장치 D10-5)", () => {
  const base = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it("알려진 형태는 빈 배열", () => {
    expect(unknownResponseFields(base)).toEqual([]);
  });

  it("신규 top-level·usage·블록 필드를 검출한다", () => {
    const drifted = {
      ...base,
      brand_new_field: 1,
      usage: { input_tokens: 1, novel_counter: 2 },
      content: [{ type: "text", text: "hi", shiny: true }, { type: "hologram" }],
    };
    const found = unknownResponseFields(drifted);
    expect(found).toContain("$.brand_new_field");
    expect(found).toContain("$.usage.novel_counter");
    expect(found).toContain("$.content[0].shiny");
    expect(found.some((f) => f.includes("hologram"))).toBe(true);
  });
});

describe("unknownStreamFields", () => {
  it("미지 이벤트·델타 타입을 검출한다", () => {
    const text = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1}}}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"quantum_delta"}}\n',
      'event: message_teleport\ndata: {"type":"message_teleport"}\n',
    ].join("\n");
    const found = unknownStreamFields(parseSSEText(text));
    expect(found).toContain("delta: 미지 델타 타입 'quantum_delta'");
    expect(found).toContain("event: 미지 이벤트 'message_teleport'");
  });
});
