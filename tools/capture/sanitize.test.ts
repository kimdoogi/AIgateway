import { describe, expect, it } from "vitest";
import { findResidualIds, sanitizeText } from "./sanitize.js";

describe("sanitizeText", () => {
  it("API 키 흔적을 제거한다", () => {
    expect(sanitizeText('{"key":"sk-ant-api03-AbCdEf123456789"}')).toBe('{"key":"sk-ant-REDACTED"}');
    expect(sanitizeText("Authorization: Bearer abcdef1234567890")).toBe("Authorization: Bearer REDACTED");
    // Google 키 (AIza + 35자) — 에러 body 에코·URL 쿼리 방어 (리뷰 2026-08-21)
    expect(sanitizeText("?key=AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe("?key=AIza-REDACTED");
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

  it("xai `접두사_UUID` id를 통째로 치환한다 (2026-08-21 실측)", () => {
    const idMap = new Map<string, string>();
    const out = sanitizeText(
      '{"a":"rs_d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99","b":"tco_d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99"}',
      idMap,
    );
    expect(out).toBe('{"a":"rs_fixture0001","b":"tco_fixture0002"}');
    // 같은 id 재등장 → 같은 자리표시자
    expect(sanitizeText('"rs_d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99"', idMap)).toBe('"rs_fixture0001"');
  });

  it("bare UUID id(xai CC·responses body.id)는 uuid_ 자리표시자로 치환한다", () => {
    expect(sanitizeText('{"id":"d6034b93-94a3-99b5-a347-7b198e443f89"}')).toBe('{"id":"uuid_fixture0001"}');
  });

  it("xai CC tool call id(call-UUID-n)와 서버툴 복합 id를 통째로 치환한다", () => {
    const idMap = new Map<string, string>();
    const out = sanitizeText(
      '{"a":"call-72fb0fa5-9d09-4785-ad9c-d6fc82c9e425-0","b":"ws_f975c967-1af4-9856-8e64-a68fcab9a46c_call-e9a4188d-80a4-4850-a8a6-c90b738c6fbe-1"}',
      idMap,
    );
    expect(out).toBe('{"a":"call_fixture0001","b":"ws_fixture0002"}');
  });

  it("gemini responseId — 키 스코프 앵커로 치환 (bare base64url, 2026-08-21 실측)", () => {
    const idMap = new Map<string, string>();
    const out = sanitizeText('{"responseId": "QE6IapGOBdux1e8P4uj0KA","other":"QE6IapGOBdux1e8P4uj0KA"}', idMap);
    // 키 스코프 밖의 동일 문자열은 건드리지 않는다 (서명 오염 방지)
    expect(out).toBe('{"responseId": "responseId_fixture0001","other":"QE6IapGOBdux1e8P4uj0KA"}');
    expect(sanitizeText(out, idMap)).toBe(out); // 멱등
  });

  it("UUID 치환은 멱등 — 재실행해도 자리표시자 유지", () => {
    const once = sanitizeText('{"id":"rs_d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99"}');
    expect(sanitizeText(once)).toBe(once);
  });

  it("findResidualIds — 문자열 내부 잔류 UUID도 검출한다", () => {
    expect(findResidualIds('{"m":"see item d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99 later"}')).toEqual([
      "d7116326-ec9d-9a4a-bfd8-e61a6e3dbb99",
    ]);
  });
});
