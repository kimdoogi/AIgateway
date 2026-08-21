import type { OutboundAdapter } from "../types.js";
import { transformRequest } from "./request.js";
import { transformResponse } from "./response.js";
import { createStreamTransformer } from "./stream.js";
import { mapGeminiError } from "./errors.js";

// Gemini 아웃바운드 어댑터 (ADR-0003) — v1은 generateContent 단일 표면.
// Interactions 표면(2차)을 위한 표면 축은 예약: provider "google"에 어댑터를 추가 등록하면 된다.
export const geminiAdapter: OutboundAdapter = {
  provider: "google",
  surface: "generate-content",
  transformRequest,
  transformResponse,
  createStreamTransformer,
  mapHttpError: mapGeminiError,
};
