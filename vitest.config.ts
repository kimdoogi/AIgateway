import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // 골든셋/유닛 테스트는 네트워크·외부 의존 금지 (D9). 라이브 스모크는 별도 opt-in 스크립트.
  },
});
