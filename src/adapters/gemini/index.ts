import type { JSONValue } from "../../ir/json.js";
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
  // 부록 (b) §1 — generateContentRequest 변형이 contents 단독보다 tools·system 충실
  countTokens: {
    transformRequest(req, ctx) {
      const base = transformRequest({ ...req, stream: undefined }, ctx);
      return {
        request: {
          ...base.request,
          path: `/v1beta/models/${ctx.modelId}:countTokens`,
          body: { generateContentRequest: { model: `models/${ctx.modelId}`, ...base.request.body } },
        },
        warnings: base.warnings,
      };
    },
    transformResponse(body) {
      const wire = body as { totalTokens?: number; cachedContentTokenCount?: number };
      return {
        inputTokens: typeof wire?.totalTokens === "number" ? wire.totalTokens : 0,
        ...(typeof wire?.cachedContentTokenCount === "number"
          ? { providerMetadata: { google: { cachedContentTokenCount: wire.cachedContentTokenCount } } }
          : {}),
        raw: body as JSONValue,
      };
    },
  },
};
