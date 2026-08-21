import { describe, expect, it } from "vitest";
import { mapGeminiError } from "./errors.js";

// RetryInfo proto3 엣지 (리뷰 2026-08-21) — Retry-After 헤더 부재라 details가 유일한 백오프 소스.

function err429(retryDelay: unknown) {
  return {
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message: "rate limited",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }],
    },
  };
}

describe("gemini mapGeminiError retryAfter", () => {
  it("문자열 '3.5s' → 3.5", () => {
    expect(mapGeminiError(429, err429("3.5s")).retryAfter).toBe(3.5);
  });

  it("proto3 seconds 생략 + nanos만 → 서브초 합산 (0 오인 금지)", () => {
    expect(mapGeminiError(429, err429({ nanos: 800000000 })).retryAfter).toBeCloseTo(0.8);
  });

  it("빈 문자열·빈 객체 → retryAfter 미설정 (Number('')===0 함정)", () => {
    expect(mapGeminiError(429, err429("")).retryAfter).toBeUndefined();
    expect(mapGeminiError(429, err429({})).retryAfter).toBeUndefined();
  });

  it("일일 쿼터 흔적은 quota_exhausted로 승격 (D7)", () => {
    const body = { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for requests per day" } };
    expect(mapGeminiError(429, body).category).toBe("quota_exhausted");
  });
});
