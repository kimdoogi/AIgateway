import { describe, expect, it } from "vitest";
import { parseSSEText } from "./sse.js";

describe("parseSSEText", () => {
  it("event/data 쌍을 프레임으로 분리한다", () => {
    const text = "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: ping\ndata: {}\n\n";
    expect(parseSSEText(text)).toEqual([
      { event: "message_start", data: '{"type":"message_start"}' },
      { event: "ping", data: "{}" },
    ]);
  });

  it("주석 줄은 무시하고 여러 data 줄은 개행으로 결합한다", () => {
    const text = ": heartbeat\nevent: e\ndata: a\ndata: b\n\n";
    expect(parseSSEText(text)).toEqual([{ event: "e", data: "a\nb" }]);
  });

  it("CRLF와 빈 줄 없이 끝난 마지막 프레임을 모두 처리한다 (절단 스트림)", () => {
    const text = "event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2";
    expect(parseSSEText(text)).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("data 값의 선행 공백 1개만 제거한다", () => {
    expect(parseSSEText("data:  x\n\n")).toEqual([{ data: " x" }]);
  });
});

// ── 증분 파서: 완결 파서와 프레임 집합 동일성 (경계 분할 전수) ─────────────
import { parseSSEStream } from "./sse.js";

async function* chunked(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

async function collect(text: string, size: number) {
  const frames = [];
  for await (const f of parseSSEStream(chunked(text, size))) frames.push(f);
  return frames;
}

describe("parseSSEStream (증분)", () => {
  const SAMPLES = [
    "event: a\ndata: 1\n\nevent: b\ndata: 2\n\n",
    "event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n", // CRLF (경계가 청크에 걸침)
    "data: hello\n\r\ndata: world\n\r\n", // 혼합 개행 (LF 줄 + CRLF 빈 줄)
    "data: a\r\rdata: b\r\r", // CR 단독
    ": comment\nevent: e\ndata: x\ndata: y\n\ndata: tail", // 주석·다중 data·절단 말미
    "id: 3\nevent: e\ndata: z\n\n", // id 필드
  ];

  it("모든 샘플 × 청크 크기 1..7에서 완결 파서와 동일", async () => {
    const { parseSSEText } = await import("./sse.js");
    for (const text of SAMPLES) {
      const whole = parseSSEText(text);
      for (let size = 1; size <= 7; size++) {
        expect(await collect(text, size), `text=${JSON.stringify(text)} size=${size}`).toEqual(whole);
      }
    }
  });

  it("멀티바이트 문자가 청크 경계에 걸려도 손실 없다", async () => {
    const text = "data: 한글🎉\n\n";
    for (let size = 1; size <= 5; size++) {
      expect(await collect(text, size)).toEqual([{ data: "한글🎉" }]);
    }
  });
});
