import type { JSONObject, JSONValue } from "../../ir/json.js";
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
import { AdapterInvalidRequestError, makeWarning } from "../shared.js";
import { openaiChatAdapter, openaiResponsesAdapter } from "../openai/index.js";
import { mapXAIError } from "./errors.js";
import { eventFromBase, requestToBase, responseFromBase, relabelWarning, stripBodyKeys } from "./remap.js";

// xAI 아웃바운드 (ADR-0004) — openai-compat base 상속(D8): 네임스페이스 리맵으로 openai
// 어댑터를 통과시키고, 인벤토리 "오버라이드 목록 14"의 wire 차이만 여기서 보정한다.
// 주 표면 = chat-completions (OpenAI와 반대 — xAI CC는 reasoning_content가 있어 결격 없음),
// 기능 트리거 시 responses 스위칭 + store:false 강제(base가 수행).

/** xAI가 수용하지 않는 OpenAI 파라미터 — strip + warning (거부/묵살 방지) */
// 2026-08-25 키별 실측 (B2-7 표 확정): CC의 metadata·modalities·audio·prediction·
// safety_identifier는 전부 **200 묵살** (400 아님 — 사용자 기대와 다르게 조용히 무시되므로
// strip+warning 유지가 D5에 부합). store도 200 묵살(2026-08-21) — strip은 ADR-0004
// store:false 정책 근거. responses의 background는 400 실측 ("Argument not supported").
const XAI_REJECTED_CC_KEYS = ["store", "metadata", "modalities", "audio", "prediction", "safety_identifier"] as const;
const XAI_REJECTED_RESPONSES_KEYS = ["metadata", "safety_identifier", "prompt_cache_options", "prompt_cache_retention", "truncation", "moderation", "background"] as const;
// 'Not Actively Used' 실측 (2026-08-25): logprobs/top_logprobs는 200 묵살 — 방출은 유지하되
// 결과가 오지 않음을 보고 (거부는 아니라 strip 불요)
const XAI_IGNORED_CC_KEYS = ["logprobs", "top_logprobs"] as const;

/**
 * xai 전용 키(xGrokConvId·deferred)는 base로 넘기면 openai 스키마의 미지 키라 기본 4xx,
 * opt-in 시엔 wire body로 누출된다 (감사 2026-08-24 #6). base 전달 전 제거하고
 * postprocess가 원본 req에서 읽어 헤더/전용 body 필드로 주입한다.
 */
const XAI_SPECIAL_KEYS = ["xGrokConvId", "deferred"] as const;

function withoutXaiSpecials(req: IRRequest): IRRequest {
  const ns = req.providerOptions?.["xai"];
  if (!ns || XAI_SPECIAL_KEYS.every((k) => ns[k] === undefined)) return req;
  const rest = { ...ns };
  for (const k of XAI_SPECIAL_KEYS) delete rest[k];
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
    makeWarning("unsupported", "parameter-dropped", `xai 미지원 파라미터 ${key} 제거 (거부/묵살 방지 — B2-7 실측 2026-08-25)`, key),
  );
  // 묵살 확정 키 — 방출은 유지, 결과 미제공을 보고 (실측 2026-08-25: 200 + 필드 무응답)
  for (const key of XAI_IGNORED_CC_KEYS) {
    if (body[key] !== undefined) {
      warnings.push(
        makeWarning("degraded", "parameter-dropped", `xai는 ${key}를 묵살(200, 결과 미제공 — 실측 2026-08-25) — 값은 전달되나 효과 없음`, key),
      );
    }
  }
  // metadata.userId → user (xAI는 safety_identifier 미지원, user 지원)
  if (body["user"] === undefined && typeof req.metadata?.["userId"] === "string") {
    body["user"] = req.metadata["userId"];
  }
  // 캐시 라우팅 헤더 (오버라이드 #7): providerOptions.xai.xGrokConvId → x-grok-conv-id
  const headers = { ...base.request.headers };
  const convId = req.providerOptions?.["xai"]?.["xGrokConvId"];
  if (typeof convId === "string" && convId.length > 0) headers["x-grok-conv-id"] = convId;

  // 타사(openai) NS는 base 진입 시 중립 라벨로 밀려 미소비 — 무경고 소실 금지 (감사 xai #1, 부록 (a):84)
  const foreign = req.providerOptions?.["openai"];
  if (foreign && Object.keys(foreign).length > 0) {
    warnings.push(
      makeWarning(
        "compatibility",
        "parameter-dropped",
        `타사(openai) providerOptions는 xai 타깃에서 미소비 — 드롭: ${Object.keys(foreign).join(", ")} (통과시키려면 xai NS로 명시)`,
        "providerOptions.openai",
      ),
    );
  }

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
    const out = postprocess(openaiChatAdapter.transformRequest(requestToBase(withoutXaiSpecials(req)), ctx), req, XAI_REJECTED_CC_KEYS);
    // deferred completions — 부록 (b) §4 PO 통과 계약 (감사 xai #5). CC 전용, stream과 상호배타
    if (req.providerOptions?.["xai"]?.["deferred"] === true) {
      if (req.stream) {
        throw new AdapterInvalidRequestError("xai.deferred는 stream과 동시 지정 불가 — 핸들 응답에는 스트림이 없다");
      }
      out.request.body["deferred"] = true;
    }
    return out;
  },
  transformResponse: (body, ctx) => {
    // deferred 핸들 응답 {request_id} 단독 분기 — 콘텐츠 없는 정상 수리, 핸들은 PM으로 (부록 (b) §4)
    const b = body as Record<string, unknown> | null;
    if (b && typeof b["request_id"] === "string" && b["choices"] === undefined) {
      return {
        blocks: [],
        origin: { provider: "xai", model: ctx.modelId, surface: "chat-completions" },
        finishReason: { unified: "other", raw: "deferred" },
        usage: {
          input: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          output: { total: 0, text: 0, reasoning: 0 },
          totalTokens: 0,
          raw: body as JSONValue,
        },
        providerRequestId: b["request_id"],
        providerMetadata: { xai: { requestId: b["request_id"] as JSONValue } },
        warnings: [],
      };
    }
    return responseFromBase(openaiChatAdapter.transformResponse(body, ctx));
  },
  createStreamTransformer: wrapStream(openaiChatAdapter.createStreamTransformer),
  mapHttpError: mapXAIError,
};

export const xaiResponsesAdapter: OutboundAdapter = {
  provider: "xai",
  surface: "responses",
  transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
    const out = postprocess(
      openaiResponsesAdapter.transformRequest(requestToBase(withoutXaiSpecials(req)), ctx),
      req,
      XAI_REJECTED_RESPONSES_KEYS,
    );
    // deferred는 CC 전용 (부록 (b) §4) — responses 도달 시 드롭 + warning
    if (req.providerOptions?.["xai"]?.["deferred"] === true) {
      out.warnings.push(
        makeWarning("unsupported", "parameter-dropped", "xai.deferred는 chat-completions 전용 — responses에서 드롭", "providerOptions.xai.deferred"),
      );
    }
    return out;
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
