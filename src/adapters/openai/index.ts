import type { OutboundAdapter, SurfaceSelector } from "../types.js";
import { mapOpenAIError } from "./errors.js";
import { transformRequest as responsesRequest } from "./responses/request.js";
import { transformResponse as responsesResponse, SURFACE as RESPONSES } from "./responses/response.js";
import { createStreamTransformer as responsesStream } from "./responses/stream.js";
import { transformRequest as chatRequest } from "./chat/request.js";
import { transformResponse as chatResponse, SURFACE as CHAT } from "./chat/response.js";
import { createStreamTransformer as chatStream } from "./chat/stream.js";

// OpenAI 아웃바운드 — 이중 표면 (ADR-0002): responses(주) + chat-completions(보조).
// 표면 선택 기준은 프로바이더 지식이므로 여기(어댑터 패키지)가 소유한다 (D4).

export const openaiResponsesAdapter: OutboundAdapter = {
  provider: "openai",
  surface: RESPONSES,
  transformRequest: responsesRequest,
  transformResponse: responsesResponse,
  createStreamTransformer: responsesStream,
  mapHttpError: mapOpenAIError,
};

export const openaiChatAdapter: OutboundAdapter = {
  provider: "openai",
  surface: CHAT,
  transformRequest: chatRequest,
  transformResponse: chatResponse,
  createStreamTransformer: chatStream,
  mapHttpError: mapOpenAIError,
};

/** 첫 원소 = 기본 표면 (레지스트리 계약) */
export const openaiAdapters: readonly OutboundAdapter[] = [openaiResponsesAdapter, openaiChatAdapter];

/**
 * 표면 선택자 (ADR-0002 §4) — 요청 기능 기반 자동 선택.
 * Responses 전용 기능 > CC 전용 기능 > 기본 responses. sticky·오버라이드·capability
 * 게이트는 레지스트리 공통 규칙이 처리한다 (registry.selectSurface).
 */
export const selectOpenAISurface: SurfaceSelector = ({ request }) => {
  const po = request.providerOptions?.["openai"] ?? {};

  // ── Responses 전용 트리거 (인벤토리 §1 대조표 — reasoning 왕복·빌트인 툴·서버 상태) ──
  if (request.tools?.some((t) => t.type === "provider" && t.id.startsWith("openai."))) {
    return { surface: RESPONSES, required: true, reason: "빌트인 툴은 Responses 전용" };
  }
  // textVerbosity는 CC도 지원(top-level verbosity — 감사 openai #5)이라 표면 강제 사유 아님
  const responsesOnly = ["include", "reasoning", "truncation", "maxToolCalls",
    "contextManagement", "background", "previousResponseId", "conversation", "prompt", "moderation"];
  for (const key of responsesOnly) {
    if (po[key] !== undefined) {
      return { surface: RESPONSES, required: true, reason: `providerOptions.openai.${key}는 Responses 전용` };
    }
  }
  // 히스토리에 openai reasoning(opaqueState)이 있으면 보존을 위해 Responses 강제 (ADR-0002 근거 1)
  for (const msg of request.messages) {
    for (const block of msg.blocks) {
      if (block.type === "reasoning" && block.opaqueState?.provider === "openai") {
        return { surface: RESPONSES, required: true, reason: "openai reasoning 왕복은 Responses 전용" };
      }
    }
  }

  // ── CC 전용 트리거 (ADR-0002 §4 — audio/predicted outputs/CC 전용 파라미터) ──
  // CC 없이는 기능 자체가 성립 안 하는 것만 required — 진짜 CC 전용 기능
  const ccRequired = ["prediction", "audio", "modalities"];
  for (const key of ccRequired) {
    if (po[key] !== undefined) {
      return { surface: CHAT, required: true, reason: `providerOptions.openai.${key}는 chat-completions 전용` };
    }
  }
  // 강등 가능한 파라미터는 선호일 뿐 — required로 강제하면 responses 전용 모델(pro 등)에서
  // capability 게이트와 충돌해 하드 400이 난다. 소프트 선호면 게이트가 responses로 전환 +
  // 어댑터가 드롭 + warning (감사 #24)
  const ccPreferred = ["logitBias", "logprobs", "webSearchOptions"];
  for (const key of ccPreferred) {
    if (po[key] !== undefined) {
      return { surface: CHAT, reason: `providerOptions.openai.${key}는 chat-completions 전용 (강등 가능 — 소프트 선호)` };
    }
  }
  if (request.seed !== undefined || request.presencePenalty !== undefined ||
      request.frequencyPenalty !== undefined || request.stopSequences !== undefined) {
    return { surface: CHAT, reason: "seed/penalties/stop은 chat-completions 전용 (강등 가능 — 소프트 선호)" };
  }
  for (const msg of request.messages) {
    for (const block of msg.blocks) {
      if (block.type === "file" && block.mediaType.startsWith("audio/")) {
        return { surface: CHAT, required: true, reason: "오디오 입력은 chat-completions 전용" };
      }
    }
  }

  return { surface: RESPONSES }; // 기본 — sticky가 이길 수 있음 (required 아님)
};
