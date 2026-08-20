import type { OutboundAdapter } from "../types.js";
import { transformRequest } from "./request.js";
import { transformResponse } from "./response.js";
import { createStreamTransformer } from "./stream.js";
import { mapAnthropicError } from "./errors.js";

// Anthropic Messages 아웃바운드 어댑터 (v1 코어 — 커버리지 매트릭스는 로드맵 5에서 CI화)
export const anthropicAdapter: OutboundAdapter = {
  provider: "anthropic",
  surface: "messages",
  transformRequest,
  transformResponse,
  createStreamTransformer,
  mapHttpError: mapAnthropicError,
};
