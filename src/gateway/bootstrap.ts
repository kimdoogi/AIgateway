import { anthropicAdapter } from "../adapters/anthropic/index.js";
import { geminiAdapter } from "../adapters/gemini/index.js";
import { openaiAdapters, selectOpenAISurface } from "../adapters/openai/index.js";
import { selectXAISurface, xaiAdapters } from "../adapters/xai/index.js";
import { registerProvider } from "./registry.js";

// 조립 루트 — 프로바이더 등록은 여기서만 (코어 모듈은 어댑터를 import하지 않는다, D4).
// import 시 네트워크/외부 의존 없음 (D9) — 등록만 수행.

export function bootstrapProviders(): void {
  registerProvider({
    adapters: [anthropicAdapter],
    baseUrl: "https://api.anthropic.com",
    auth: { envVar: "ANTHROPIC_API_KEY", header: "x-api-key" },
  });
  registerProvider({
    // 첫 원소 = 기본 표면 (ADR-0002: Responses 주 경로)
    adapters: openaiAdapters,
    baseUrl: "https://api.openai.com",
    auth: { envVar: "OPENAI_API_KEY", header: "authorization", prefix: "Bearer " },
    selectSurface: selectOpenAISurface,
  });
  registerProvider({
    // 첫 원소 = 기본 표면 (ADR-0004: CC 주 경로 — OpenAI와 반대)
    adapters: xaiAdapters,
    baseUrl: "https://api.x.ai",
    auth: { envVar: "XAI_API_KEY", header: "authorization", prefix: "Bearer " },
    selectSurface: selectXAISurface,
  });
  registerProvider({
    // v1 단일 표면 (ADR-0003: generateContent — Interactions는 2차 승격 트리거 대기)
    adapters: [geminiAdapter],
    baseUrl: "https://generativelanguage.googleapis.com",
    auth: { envVar: "GEMINI_API_KEY", header: "x-goog-api-key" },
  });
}
