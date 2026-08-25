import type { JSONObject } from "../../ir/json.js";
import type { Warning } from "../../ir/common.js";
import type { IRRequest } from "../../ir/request.js";
import type {
  OutboundAdapter,
  RequestContext,
  StreamContext,
  StreamTransformer,
  SurfaceSelector,
  TransformedRequest,
} from "../types.js";
import { makeWarning } from "../shared.js";
import { openaiChatAdapter, openaiResponsesAdapter } from "../openai/index.js";
import { mapXAIError } from "./errors.js";
import { eventFromBase, requestToBase, responseFromBase, relabelWarning, stripBodyKeys } from "./remap.js";

// xAI 아웃바운드 (ADR-0004) — openai-compat base 상속(D8): 네임스페이스 리맵으로 openai
// 어댑터를 통과시키고, 인벤토리 "오버라이드 목록 14"의 wire 차이만 여기서 보정한다.
// 주 표면 = chat-completions (OpenAI와 반대 — xAI CC는 reasoning_content가 있어 결격 없음),
// 기능 트리거 시 responses 스위칭 + store:false 강제(base가 수행).

/** xAI가 400으로 거부하는 OpenAI 파라미터 (오버라이드 #2 — 무시가 아니라 거부라 strip 필수) */
// 2026-08-21 실측: store는 400 거부가 아니라 200 묵살로 드리프트(problem log) — strip은
// ADR-0004 store:false 정책 근거로 유지. 나머지 키의 400 여부는 미재검증.
const XAI_REJECTED_CC_KEYS = ["store", "metadata", "modalities", "audio", "prediction", "safety_identifier"] as const;
const XAI_REJECTED_RESPONSES_KEYS = ["metadata", "safety_identifier", "prompt_cache_options", "prompt_cache_retention", "truncation", "moderation"] as const;

/**
 * xGrokConvId는 헤더 전용(오버라이드 #7) — base로 넘기면 openai 스키마의 미지 키라
 * 기본 4xx, opt-in 시엔 wire body로 누출된다 (감사 2026-08-24 #6). base 전달 전 제거,
 * 헤더 주입은 postprocess가 원본 req에서 읽는다.
 */
function withoutConvId(req: IRRequest): IRRequest {
  const ns = req.providerOptions?.["xai"];
  if (!ns || ns["xGrokConvId"] === undefined) return req;
  const { xGrokConvId: _c, ...rest } = ns;
  const po = { ...req.providerOptions };
  if (Object.keys(rest).length > 0) po["xai"] = rest;
  else delete po["xai"];
  const out = { ...req };
  if (Object.keys(po).length > 0) out.providerOptions = po;
  else delete out.providerOptions;
  return out;
}

function postprocess(
  base: TransformedRequest,
  req: IRRequest,
  rejected: readonly string[],
): TransformedRequest {
  const warnings: Warning[] = base.warnings.map(relabelWarning);
  const body = { ...base.request.body };
  stripBodyKeys(body, rejected, warnings, (key) =>
    makeWarning("unsupported", "parameter-dropped", `xai 미지원 파라미터 ${key} 제거 (400 거부 방지 — 인벤토리 B2-7)`, key),
  );
  // metadata.userId → user (xAI는 safety_identifier 미지원, user 지원)
  if (body["user"] === undefined && typeof req.metadata?.["userId"] === "string") {
    body["user"] = req.metadata["userId"];
  }
  // 캐시 라우팅 헤더 (오버라이드 #7): providerOptions.xai.xGrokConvId → x-grok-conv-id
  const headers = { ...base.request.headers };
  const convId = req.providerOptions?.["xai"]?.["xGrokConvId"];
  if (typeof convId === "string" && convId.length > 0) headers["x-grok-conv-id"] = convId;

  return { request: { ...base.request, headers, body: body as JSONObject }, warnings };
}

function wrapStream(makeBase: (ctx: StreamContext) => StreamTransformer): (ctx: StreamContext) => StreamTransformer {
  return (ctx) => {
    const base = makeBase(ctx);
    return {
      framing: base.framing,
      onEvent: (name, data) => base.onEvent(name, data).map(eventFromBase),
      onStreamEnd: () => base.onStreamEnd().map(eventFromBase),
    };
  };
}

export const xaiChatAdapter: OutboundAdapter = {
  provider: "xai",
  surface: "chat-completions",
  transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
    return postprocess(openaiChatAdapter.transformRequest(requestToBase(withoutConvId(req)), ctx), req, XAI_REJECTED_CC_KEYS);
  },
  transformResponse: (body, ctx) => responseFromBase(openaiChatAdapter.transformResponse(body, ctx)),
  createStreamTransformer: wrapStream(openaiChatAdapter.createStreamTransformer),
  mapHttpError: mapXAIError,
};

export const xaiResponsesAdapter: OutboundAdapter = {
  provider: "xai",
  surface: "responses",
  transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
    return postprocess(
      openaiResponsesAdapter.transformRequest(requestToBase(withoutConvId(req)), ctx),
      req,
      XAI_REJECTED_RESPONSES_KEYS,
    );
  },
  transformResponse: (body, ctx) => responseFromBase(openaiResponsesAdapter.transformResponse(body, ctx)),
  createStreamTransformer: wrapStream(openaiResponsesAdapter.createStreamTransformer),
  mapHttpError: mapXAIError,
};

/** 첫 원소 = 기본 표면: chat-completions (ADR-0004 — OpenAI와 반대) */
export const xaiAdapters: readonly OutboundAdapter[] = [xaiChatAdapter, xaiResponsesAdapter];

/**
 * 표면 선택자 (ADR-0004 §2): 서버측 에이전트 툴·encrypted reasoning·stateful 기능이
 * 요청되면 responses 강제, 그 외 기본 chat-completions (sticky는 레지스트리 공통 규칙).
 */
export const selectXAISurface: SurfaceSelector = ({ request }) => {
  if (request.tools?.some((t) => t.type === "provider" && t.id.startsWith("xai."))) {
    return { surface: "responses", required: true, reason: "xai 서버측 에이전트 툴은 responses 전용" };
  }
  const po = request.providerOptions?.["xai"] ?? {};
  const responsesOnly = ["store", "previousResponseId", "include", "background", "contextManagement", "reasoning", "textVerbosity"];
  for (const key of responsesOnly) {
    if (po[key] !== undefined) {
      return { surface: "responses", required: true, reason: `providerOptions.xai.${key}는 responses 전용` };
    }
  }
  // 히스토리의 xai encrypted reasoning은 responses로만 왕복 가능 (인벤토리 C-3)
  for (const msg of request.messages) {
    for (const block of msg.blocks) {
      if (block.type === "reasoning" && block.opaqueState?.provider === "xai") {
        return { surface: "responses", required: true, reason: "xai encrypted reasoning 왕복은 responses 전용" };
      }
    }
  }
  return { surface: "chat-completions" }; // 기본 — CC 주 경로 (ADR-0004 §1)
};
