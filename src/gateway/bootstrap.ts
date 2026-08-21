import { anthropicAdapter } from "../adapters/anthropic/index.js";
import { registerProvider } from "./registry.js";

// 조립 루트 — 프로바이더 등록은 여기서만 (코어 모듈은 어댑터를 import하지 않는다, D4).
// import 시 네트워크/외부 의존 없음 (D9) — 등록만 수행.

export function bootstrapProviders(): void {
  registerProvider({
    adapter: anthropicAdapter,
    baseUrl: "https://api.anthropic.com",
    auth: { envVar: "ANTHROPIC_API_KEY", header: "x-api-key" },
  });
}
