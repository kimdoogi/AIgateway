import type { z } from "zod";

// ir-v0 §1 — 직렬화 결정론 (D10): 동일 IR 값 → 바이트 동일 JSON.
// 원리: zod strictObject.parse는 결과 객체를 스키마 shape 정의 순서로 구성하므로,
// "parse 후 JSON.stringify"가 곧 canonical 직렬화다. 자유형 JSON(providerOptions 내부 등)은
// 입력 키 순서를 보존한다 — 동일 입력이면 동일 바이트 (스펙 §1과 일치).
// 이 성질은 canonical.test.ts가 회귀 검증한다 — zod 동작 변경 시 테스트가 잡는다.
//
// 성능 주의(리뷰 EF3): 이미 parse된 값에 재적용하면 이중 순회 — 신뢰 경계(인바운드)에서
// 1회 parse 후에는 순수 JSON.stringify를 쓸 것 (브랜드 타입 도입은 게이트웨이 단계에서).

export function stringifyCanonical<T>(schema: z.ZodType<T>, value: unknown): string {
  return JSON.stringify(schema.parse(value));
}
