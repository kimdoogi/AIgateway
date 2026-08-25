import type { JSONObject, JSONValue } from "../../../ir/json.js";
import type { Block, FileBlock, ToolResultBlock } from "../../../ir/blocks.js";
import type { Warning } from "../../../ir/common.js";
import type { IRRequest } from "../../../ir/request.js";
import type { RequestContext, TransformedRequest } from "../../types.js";
import {
  AdapterInvalidRequestError,
  dropUnsupportedParams,
  gateUnsupportedParams,
  makeWarning,
} from "../../shared.js";
import { overrideWarning, parseOpenAIRequestOptions } from "../options.js";
import { clampEffort } from "../responses/request.js";
import { ChatWireRequestSchema } from "./wire.js";

// IR → OpenAI Chat Completions wire (ADR-0002 §4 보조 경로 — audio/predicted outputs/
// seed·penalties·stop 등 CC 전용 기능용. reasoning 보존 불가는 구조적 — warning으로 보고).
// xAI 어댑터(로드맵 5)가 이 형태를 base로 상속한다 (ADR-0004).

const RESERVED_BODY_KEYS = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p",
  "max_completion_tokens", "stop", "seed", "presence_penalty", "frequency_penalty", "logit_bias",
  "logprobs", "top_logprobs", "n", "response_format", "reasoning_effort", "prediction", "audio",
  "modalities", "web_search_options", "service_tier", "prompt_cache_key", "safety_identifier",
  "user", "metadata", "store", "stream", "stream_options",
]);

const DEFAULT_EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// CC 오디오 포맷 — mediaType에서 유도 (인벤토리 §G audio in)
const AUDIO_FORMATS: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
};

function fileToPart(block: FileBlock, path: string): JSONObject {
  if (block.mediaType.startsWith("image/")) {
    let url: string;
    switch (block.data.type) {
      case "url":
        url = block.data.url;
        break;
      case "base64":
        url = `data:${block.mediaType};base64,${block.data.data}`;
        break;
      default:
        throw new AdapterInvalidRequestError(`CC image는 url/base64만 지원 (${path}) — 재타게팅 필요 (D6-8)`);
    }
    return { type: "image_url", image_url: { url } };
  }
  if (block.mediaType.startsWith("audio/")) {
    if (block.data.type !== "base64") {
      throw new AdapterInvalidRequestError(`CC input_audio는 base64만 지원 (${path})`);
    }
    const format = AUDIO_FORMATS[block.mediaType];
    if (!format) {
      throw new AdapterInvalidRequestError(`CC input_audio 미지원 포맷 ${block.mediaType} (${path}) — wav/mp3만`);
    }
    return { type: "input_audio", input_audio: { data: block.data.data, format } };
  }
  if (block.data.type === "text") return { type: "text", text: block.data.text };
  // 문서 — file part (file_id 또는 base64 file_data)
  const file: JSONObject = {};
  switch (block.data.type) {
    case "reference": {
      const fileId = block.data.refs["openai"];
      if (!fileId) {
        throw new AdapterInvalidRequestError(`file reference에 openai file_id가 없습니다 (${path}) — 재타게팅 필요`);
      }
      file["file_id"] = fileId;
      break;
    }
    case "base64":
      file["file_data"] = `data:${block.mediaType};base64,${block.data.data}`;
      if (block.filename) file["filename"] = block.filename;
      break;
    case "url":
      throw new AdapterInvalidRequestError(`CC file part는 url을 지원하지 않습니다 (${path}) — 재타게팅 필요`);
  }
  return { type: "file", file };
}

function toolResultContent(block: ToolResultBlock, warnings: Warning[], path: string): string {
  const out = block.output;
  switch (out.type) {
    case "text":
      return out.text;
    case "json":
      return JSON.stringify(out.value);
    case "content":
    case "errorContent": // §4.4 직교 — CC에는 에러 슬롯이 없어 내용만 직렬화
      warnings.push(makeWarning("compatibility", "block-dropped", "멀티모달 툴 결과를 문자열로 직렬화 (D6-5)", path));
      return JSON.stringify(out.blocks);
    case "errorText":
      return out.text;
    case "errorJson":
      return JSON.stringify(out.value);
    case "executionDenied":
      return `execution denied${out.reason ? `: ${out.reason}` : ""}`;
  }
}

type WireMessage = JSONObject;

export function transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
  const warnings: Warning[] = [];
  const retargetReasoning = req.retarget?.reasoning ?? "drop";
  const opts = parseOpenAIRequestOptions(req.providerOptions, req.allowUnknownProviderOptions ?? false, warnings);
  const body: JSONObject = { model: ctx.modelId };
  const messages: WireMessage[] = [];

  req.messages.forEach((msg, mi) => {
    const basePath = `messages[${mi}]`;
    if (msg.role === "system") {
      const role = msg.providerOptions?.["openai"]?.["role"] === "developer" ? "developer" : "system";
      const text = msg.blocks
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      if (msg.blocks.some((b) => b.type !== "text")) {
        warnings.push(makeWarning("unsupported", "block-dropped", "CC system은 텍스트만 — 비텍스트 블록 드롭", basePath));
      }
      messages.push({ role, content: text });
      return;
    }

    if (msg.role === "tool") {
      for (const [bi, b] of msg.blocks.entries()) {
        if (b.type === "toolResult") {
          messages.push({
            role: "tool",
            tool_call_id: b.toolCallId,
            content: toolResultContent(b, warnings, `${basePath}.blocks[${bi}]`),
          });
        } else if (b.type === "passthrough" && b.provider === "openai") {
          messages.push(b.raw as JSONObject);
        } else {
          warnings.push(
            makeWarning("unsupported", "block-dropped", `tool 역할의 ${b.type} 블록 — CC 표현 없음, 드롭`, `${basePath}.blocks[${bi}]`),
          );
        }
      }
      return;
    }

    if (msg.role === "user") {
      const parts: JSONObject[] = [];
      msg.blocks.forEach((b, bi) => {
        const path = `${basePath}.blocks[${bi}]`;
        switch (b.type) {
          case "text":
            parts.push({ type: "text", text: b.text });
            return;
          case "file":
            parts.push(fileToPart(b, path));
            return;
          case "toolResult":
            // 인바운드 포맷에 따라 user에 실린 tool 결과 — tool 메시지로 분리
            messages.push({
              role: "tool",
              tool_call_id: b.toolCallId,
              content: toolResultContent(b, warnings, path),
            });
            return;
          case "passthrough":
            if (b.provider === "openai") {
              parts.push(b.raw as JSONObject);
              return;
            }
            warnings.push(makeWarning("unsupported", "passthrough-dropped", "타 프로바이더 passthrough — 드롭", path));
            return;
          default:
            warnings.push(makeWarning("unsupported", "block-dropped", `user 역할의 ${b.type} 블록 드롭`, path));
        }
      });
      if (parts.length > 0) messages.push({ role: "user", content: parts });
      return;
    }

    // assistant
    const textParts: string[] = [];
    const toolCalls: JSONObject[] = [];
    msg.blocks.forEach((b, bi) => {
      const path = `${basePath}.blocks[${bi}]`;
      switch (b.type) {
        case "text":
          textParts.push(b.text);
          return;
        case "reasoning":
          // CC는 reasoning 재전송 표면이 없다 (ADR-0002 근거 1 — 구조적) → retarget 정책
          if (retargetReasoning === "demote-to-text" && b.text.length > 0) {
            warnings.push(makeWarning("compatibility", "reasoning-demoted", "reasoning을 텍스트로 강등 (CC)", path));
            textParts.push(b.text);
          } else {
            warnings.push(
              makeWarning("unsupported", "reasoning-dropped", "CC는 reasoning 왕복 불가 — 드롭 (ADR-0002 §4)", path),
            );
          }
          return;
        case "toolCall": {
          if (b.providerExecuted) {
            warnings.push(makeWarning("unsupported", "block-dropped", `서버 툴 호출(${b.toolName}) — CC 표현 없음, 드롭`, path));
            return;
          }
          toolCalls.push({
            id: b.toolCallId,
            type: "function",
            function: {
              name: b.toolName,
              arguments: b.input.type === "json" ? JSON.stringify(b.input.value) : b.input.text,
            },
          });
          return;
        }
        case "toolResult":
          messages.push({ role: "tool", tool_call_id: b.toolCallId, content: toolResultContent(b, warnings, path) });
          return;
        case "source":
          return;
        case "passthrough":
          if (b.provider === "openai") {
            messages.push(b.raw as JSONObject);
            return;
          }
          warnings.push(makeWarning("unsupported", "passthrough-dropped", "타 프로바이더 passthrough — 드롭", path));
          return;
        default:
          warnings.push(makeWarning("unsupported", "block-dropped", `assistant ${b.type} 블록 — CC 표현 없음, 드롭`, path));
      }
    });
    if (textParts.length > 0 || toolCalls.length > 0) {
      const m: WireMessage = { role: "assistant" };
      if (textParts.length > 0) m["content"] = textParts.join("");
      if (toolCalls.length > 0) m["tool_calls"] = toolCalls;
      messages.push(m);
    }
  });
  body["messages"] = messages;

  // ── tools ──
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      if (t.type === "function") {
        const fn: JSONObject = { name: t.name, parameters: t.inputSchema };
        if (t.description) fn["description"] = t.description;
        if (t.strict !== undefined) fn["strict"] = t.strict;
        return { type: "function", function: fn };
      }
      throw new AdapterInvalidRequestError(
        `provider 툴 ${t.id}은 chat-completions 표면에서 사용 불가 — responses 표면 필요 (ADR-0002 §4)`,
      );
    });
  }
  if (req.toolChoice !== undefined) {
    body["tool_choice"] =
      typeof req.toolChoice === "string"
        ? req.toolChoice
        : { type: "function", function: { name: req.toolChoice.toolName } };
  }
  if (opts.toolChoice !== undefined) {
    if (body["tool_choice"] !== undefined) warnings.push(overrideWarning("tool_choice", "toolChoice"));
    body["tool_choice"] = opts.toolChoice as JSONValue;
  }
  if (req.parallelToolCalls !== undefined) body["parallel_tool_calls"] = req.parallelToolCalls;

  // ── sampling — 모델 capability 게이트 (레지스트리 공급) ──
  const gated = gateUnsupportedParams(
    {
      temperature: req.temperature,
      topP: req.topP,
      presencePenalty: req.presencePenalty,
      frequencyPenalty: req.frequencyPenalty,
      stopSequences: req.stopSequences, // xAI reasoning 모델은 stop도 400 거부 (base 상속 — 레지스트리 공급)
    },
    ctx.capabilities?.unsupportedParams,
    req.strictParameters,
    "openai",
    warnings,
  );
  if (gated["temperature"] !== undefined) body["temperature"] = gated["temperature"];
  if (gated["topP"] !== undefined) body["top_p"] = gated["topP"];
  if (gated["presencePenalty"] !== undefined) body["presence_penalty"] = gated["presencePenalty"];
  if (gated["frequencyPenalty"] !== undefined) body["frequency_penalty"] = gated["frequencyPenalty"];
  if (req.maxOutputTokens !== undefined) body["max_completion_tokens"] = req.maxOutputTokens;
  if (gated["stopSequences"] !== undefined) body["stop"] = gated["stopSequences"];
  if (req.seed !== undefined) body["seed"] = req.seed;
  dropUnsupportedParams({ topK: req.topK }, req.strictParameters, "openai chat-completions", warnings);

  // ── reasoning effort (CC는 단일 필드 — 인벤토리 §1) ──
  if (req.reasoning?.effort) {
    const supported = ctx.capabilities?.supportedEfforts ?? DEFAULT_EFFORTS;
    const effort = clampEffort(req.reasoning.effort, supported, warnings, req.strictParameters);
    if (effort !== undefined) body["reasoning_effort"] = effort;
  }

  // ── 구조화 출력 ──
  if (req.responseFormat && req.responseFormat.type === "json") {
    if (req.responseFormat.schema) {
      const js: JSONObject = { name: req.responseFormat.name ?? "response", schema: req.responseFormat.schema };
      if (req.responseFormat.description) js["description"] = req.responseFormat.description;
      if (req.responseFormat.strict !== undefined) js["strict"] = req.responseFormat.strict;
      body["response_format"] = { type: "json_schema", json_schema: js };
    } else {
      body["response_format"] = { type: "json_object" };
    }
  }

  // ── CC 전용 PO ──
  if (opts.logitBias) body["logit_bias"] = opts.logitBias;
  if (opts.logprobs !== undefined) body["logprobs"] = opts.logprobs;
  if (opts.topLogprobs !== undefined) body["top_logprobs"] = opts.topLogprobs;
  if (opts.n !== undefined) {
    // G2 — v1 IR은 단일 후보. n>1은 drop+warning (ADR-0002 §4)
    warnings.push(makeWarning("unsupported", "parameter-dropped", "n>1은 v1 미지원 (G2 단일 후보) — 드롭", "providerOptions.openai.n"));
  }
  if (opts.prediction) body["prediction"] = opts.prediction as JSONValue;
  if (opts.audio) body["audio"] = opts.audio as JSONValue;
  if (opts.modalities) body["modalities"] = opts.modalities;
  if (opts.webSearchOptions) body["web_search_options"] = opts.webSearchOptions as JSONValue;
  if (opts.serviceTier) body["service_tier"] = opts.serviceTier;
  if (opts.promptCacheKey) body["prompt_cache_key"] = opts.promptCacheKey;
  if (opts.safetyIdentifier !== undefined) body["safety_identifier"] = opts.safetyIdentifier;
  if (opts.user !== undefined) body["user"] = opts.user;
  if (opts.store !== undefined) body["store"] = opts.store; // CC 기본 false — 강제 불요

  // Responses 전용 PO가 여기 도달 — 드롭 + 보고
  dropUnsupportedParams(
    {
      "openai.include": opts.include,
      "openai.reasoning": opts.reasoning,
      "openai.textVerbosity": opts.textVerbosity,
      "openai.truncation": opts.truncation,
      "openai.maxToolCalls": opts.maxToolCalls,
      "openai.contextManagement": opts.contextManagement,
      "openai.background": opts.background,
      "openai.previousResponseId": opts.previousResponseId,
      "openai.conversation": opts.conversation,
      "openai.prompt": opts.prompt,
      "openai.instructions": opts.instructions,
    },
    req.strictParameters,
    "openai chat-completions",
    warnings,
  );

  // ── metadata ──
  if (req.metadata) {
    const { userId, ...restMeta } = req.metadata;
    if (userId && body["safety_identifier"] === undefined) body["safety_identifier"] = userId;
    const metaEntries = Object.entries(restMeta).filter(([, v]) => typeof v === "string");
    if (metaEntries.length > 0) body["metadata"] = Object.fromEntries(metaEntries);
  }
  if (opts.metadata !== undefined) {
    if (body["metadata"] !== undefined) warnings.push(overrideWarning("metadata", "metadata"));
    body["metadata"] = opts.metadata;
  }

  if (req.stream) {
    body["stream"] = true;
    body["stream_options"] = { include_usage: true }; // usage는 최종 chunk에만 (인벤토리 §D)
  }

  for (const [k, v] of Object.entries(opts.extra)) {
    if (RESERVED_BODY_KEYS.has(k) && body[k] !== undefined) {
      throw new AdapterInvalidRequestError(`providerOptions.openai(opt-in)의 '${k}'가 조립 필드와 충돌합니다`);
    }
    body[k] = v;
  }
  if (req.passthroughParams) {
    if (req.passthroughParams.provider !== "openai") {
      throw new AdapterInvalidRequestError(
        "타 프로바이더 passthroughParams가 openai 어댑터에 도달 — 정책 레이어 필터 누락",
        { gatewayException: true },
      );
    }
    for (const [k, v] of Object.entries(req.passthroughParams.params)) {
      if (RESERVED_BODY_KEYS.has(k) && body[k] !== undefined) {
        throw new AdapterInvalidRequestError(`passthroughParams의 '${k}'가 조립 필드와 충돌합니다`);
      }
      body[k] = v;
    }
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(req.passthroughParams?.headers ?? {})) headers[k] = v;

  const validated = ChatWireRequestSchema.parse(body) as unknown as JSONObject;
  return { request: { method: "POST", path: "/v1/chat/completions", headers, body: validated }, warnings };
}
