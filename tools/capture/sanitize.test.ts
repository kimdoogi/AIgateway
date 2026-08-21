import { describe, expect, it } from "vitest";
import { findResidualIds, sanitizeText } from "./sanitize.js";

describe("sanitizeText", () => {
  it("API 키 흔적을 제거한다", () => {
    expect(sanitizeText('{"key":"sk-ant-api03-AbCdEf123456789"}')).toBe('{"key":"sk-ant-REDACTED"}');
    expect(sanitizeText("Authorization: Bearer abcdef1234567890")).toBe("Authorization: Bearer REDACTED");
  });

  it("id를 결정론적으로 치환한다 — 같은 id는 같은 자리표시자", () => {
    const idMap = new Map<string, string>();
    const first = sanitizeText('{"id":"msg_01ABCdefGH","tool":"toolu_01ZZZZZZZZ"}', idMap);
    expect(first).toBe('{"id":"msg_fixture0001","tool":"toolu_fixture0002"}');
    expect(sanitizeText('"msg_01ABCdefGH"', idMap)).toBe('"msg_fixture0001"');
  });

it("밑줄 포함 id도 통째로 치환한다 — 부분 치환 금지 (리뷰 F7)", () => {
    expect(sanitizeText('{"id":"toolu_capture_seed01"}')).toBe('{"id":"toolu_fixture0001"}');
  });

  it("기존 자리표시자와 신규 id 혼재 시 번호 충돌 없음 (리뷰 A5-r3)", () => {
    const idMap = new Map<string, string>();
    const out = sanitizeText('{"a":"msg_fixture0001","b":"msg_01NEWID99"}', idMap);
    expect(out).toBe('{"a":"msg_fixture0001","b":"msg_fixture0002"}');
  });

  it("findResidualIds — 문자열 내부 잔류 id 후보를 검출한다", () => {
    expect(findResidualIds('{"message":"request req_01ABCDEF99 throttled"}')).toEqual(["req_01ABCDEF99"]);
    expect(findResidualIds('{"id":"msg_fixture0001"}')).toEqual([]);
  });

  it("signature 등 왕복에 필요한 페이로드는 건드리지 않는다", () => {
    const text = '{"signature":"ErUBCkYIBRgCIkAY0aBcDeFgHi=="}';
    expect(sanitizeText(text)).toBe(text);
  });
});
