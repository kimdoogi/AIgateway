import type { JSONValue } from "../../ir/json.js";
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
  // 부록 (b) §1 — 동기 변환 재사용: count_tokens wire = messages body − max_tokens/stream
  countTokens: {
    transformRequest(req, ctx) {
      // maxOutputTokens를 임시 충전해 기본값 주입 warning 억제 (count에는 max_tokens 무의미 — 부록 (b) §1)
      const base = transformRequest({ ...req, maxOutputTokens: req.maxOutputTokens ?? 1, stream: undefined }, ctx);
      const body = { ...base.request.body };
      delete body["max_tokens"];
      delete body["stream"];
      return { request: { ...base.request, path: "/v1/messages/count_tokens", body }, warnings: base.warnings };
    },
    transformResponse(body) {
      const tokens = (body as { input_tokens?: number })?.input_tokens;
      return { inputTokens: typeof tokens === "number" ? tokens : 0, raw: body as JSONValue };
    },
  },
};
