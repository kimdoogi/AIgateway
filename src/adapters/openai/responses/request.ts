import type { JSONObject, JSONValue } from "../../../ir/json.js";
import type { Block, FileBlock, ToolResultBlock } from "../../../ir/blocks.js";
import type { Warning } from "../../../ir/common.js";
import type { IRRequest } from "../../../ir/request.js";
import type { RequestContext, TransformedRequest } from "../../types.js";
import { z } from "zod";
import {
  AdapterInvalidRequestError,
  dropUnsupportedParams,
  gateEffort,
  gateUnsupportedParams,
  makeWarning,
  partitionProviderOptions,
} from "../../shared.js";
import { overrideWarning, parseOpenAIRequestOptions, readItem } from "../options.js";
import { ResponsesWireRequestSchema } from "./wire.js";

// 툴 레벨 providerOptions.openai — 함수 툴 신필드 (인벤토리 §1, 감사 openai #3).
// D5 미지 키 정책은 partitionProviderOptions 공통 (감사 #17 — 툴 레벨도 2급 시민 금지)
const ToolLevelOptionsSchema = z.object({
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  allowedCallers: z.array(z.string()).optional(),
  deferLoading: z.boolean().optional(),
});

// IR → OpenAI Responses wire (ADR-0002, 인벤토리 §A/§B, ir-v0 §13).
// 순수 함수. 핵심 계약: store:false 강제(명시 PO는 §2 규칙으로 override + warning),
// reasoning/서버툴 item은 PO openai.item 원문 우선 복원 ("item 무변경 재전송" — §4.2).

const RESERVED_BODY_KEYS = new Set([
  "model", "instructions", "input", "reasoning", "text", "temperature", "top_p", "top_logprobs",
  "max_output_tokens", "max_tool_calls", "tools", "tool_choice", "parallel_tool_calls", "include",
  "store", "previous_response_id", "conversation", "background", "stream", "stream_options",
  "service_tier", "truncation", "prompt", "prompt_cache_key", "prompt_cache_options",
  "prompt_cache_retention", "safety_identifier", "metadata", "context_management", "moderation",
]);

// 인벤토리 §A — GPT-5.6 기준 전체 집합. 모델별 부분집합은 레지스트리 supportedEfforts가 좁힘
const DEFAULT_EFFORTS: readonly string[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

type RetargetReasoning = "drop" | "demote-to-text" | "strip-and-annotate";

interface ConvertCtx {
  warnings: Warning[];
  retargetReasoning: RetargetReasoning;
}

/**
 * effort 게이트 — shared.gateEffort 위임 (ir-v0 §6.3: 최근접 클램프 + on/off 경계 보존).
 * undefined 반환 = wire에 effort 미방출. CC 표면도 이 함수를 공유한다.
 */
export function clampEffort(
  effort: string,
  supported: readonly string[],
  warnings: Warning[],
  strict?: boolean,
): string | undefined {
  return gateEffort(effort, supported, { strict, label: "openai" }, warnings);
}

function fileToPart(block: FileBlock, path: string): JSONObject {
  const isImage = block.mediaType.startsWith("image/");
  if (isImage) {
    const part: JSONObject = { type: "input_image" };
    switch (block.data.type) {
      case "url":
        part["image_url"] = block.data.url;
        break;
      case "base64":
        part["image_url"] = `data:${block.mediaType};base64,${block.data.data}`;
        break;
      case "reference": {
        const fileId = block.data.refs["openai"];
        if (!fileId) {
          throw new AdapterInvalidRequestError(
            `file reference에 openai file_id가 없습니다 (${path}) — 재타게팅 필요 (D6-8)`,
          );
        }
        part["file_id"] = fileId;
        break;
      }
      case "text":
        throw new AdapterInvalidRequestError(`이미지 mediaType에 text 데이터 (${path})`);
    }
    const detail = block.providerOptions?.["openai"]?.["detail"];
    if (typeof detail === "string") part["detail"] = detail;
    return part;
  }
  // 문서류 — input_file (PDF 등). audio/*는 Responses 미지원 → 선택자가 CC로 보냈어야 함
  if (block.mediaType.startsWith("audio/")) {
    throw new AdapterInvalidRequestError(
      `Responses 표면은 오디오 입력을 지원하지 않습니다 (${path}) — chat-completions 표면 필요 (ADR-0002 §4)`,
    );
  }
  const part: JSONObject = { type: "input_file" };
  if (block.filename) part["filename"] = block.filename;
  switch (block.data.type) {
    case "url":
      part["file_url"] = block.data.url;
      break;
    case "base64":
      part["file_data"] = `data:${block.mediaType};base64,${block.data.data}`;
      break;
    case "reference": {
      const fileId = block.data.refs["openai"];
      if (!fileId) {
        throw new AdapterInvalidRequestError(
          `file reference에 openai file_id가 없습니다 (${path}) — 재타게팅 필요 (D6-8)`,
        );
      }
      part["file_id"] = fileId;
      break;
    }
    case "text":
      // 텍스트 문서 — input_text로 강등 없는 직접 표현이 없어 텍스트 파트로
      return { type: "input_text", text: block.data.text };
  }
  return part;
}

function toolResultOutput(block: ToolResultBlock): string {
  const out = block.output;
  switch (out.type) {
    case "text":
      return out.text;
    case "json":
      return JSON.stringify(out.value);
    case "content":
    case "errorContent": // §4.4 직교 — CC/Responses에는 에러 슬롯이 없어 내용만 직렬화
      // Responses function_call_output은 string — 멀티모달 파트는 직렬화 (D6-5 강등은 호출측 warning)
      return JSON.stringify(out.blocks);
    case "errorText":
      return out.text;
    case "errorJson":
      return JSON.stringify(out.value);
    case "executionDenied":
      return `execution denied${out.reason ? `: ${out.reason}` : ""}`;
  }
}

function reasoningToItem(
  block: Extract<Block, { type: "reasoning" }>,
  cctx: ConvertCtx,
  path: string,
): JSONObject | null {
  // 무손실 규칙 (§4.2): 원문 item 우선 복원. openai NS의 item 존재 자체가 openai 산 증거 —
  // opaqueState 게이트를 걸면 store:true 멀티턴(encrypted_content 부재)에서 보존된 item이
  // 외래로 강등·드롭된다 (감사 2026-08-24 #5)
  const item = readItem(block.providerOptions, block.providerMetadata);
  if (item) return item;
  if (block.opaqueState?.provider === "openai") {
    // item 소실 — encrypted_content만으로 재구성 (최선 복원)
    return {
      type: "reasoning",
      summary: block.text.length > 0 ? [{ type: "summary_text", text: block.text }] : [],
      encrypted_content: block.opaqueState.data,
    };
  }
  // 외래 reasoning — retarget 정책 (D6-2)
  switch (cctx.retargetReasoning) {
    case "demote-to-text":
      if (block.text.length > 0) {
        cctx.warnings.push(makeWarning("compatibility", "reasoning-demoted", "외래 reasoning을 텍스트로 강등", path));
        return {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: block.text }],
        };
      }
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning에 강등할 텍스트 없음 — 드롭", path),
      );
      return null;
    case "strip-and-annotate":
      cctx.warnings.push(
        makeWarning("compatibility", "reasoning-annotated", "외래 reasoning 제거 사실을 주석으로 대체", path),
      );
      return {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "[이전 턴의 추론 내용은 프로바이더 전환으로 제거되었습니다]" }],
      };
    case "drop":
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning 블록 드롭 (retarget: drop)", path),
      );
      return null;
  }
}

/** assistant/user 메시지 → Responses input item 배열 (블록 순서 보존 — §B 왕복 규칙) */
function messageToItems(
  role: "user" | "assistant" | "system" | "developer",
  blocks: readonly Block[],
  cctx: ConvertCtx,
  basePath: string,
): JSONObject[] {
  const items: JSONObject[] = [];
  let pendingParts: JSONObject[] = [];
  const partType =
    role === "assistant" ? "output_text" : "input_text"; // system/developer도 input_text

  const flush = (): void => {
    if (pendingParts.length === 0) return;
    items.push({ type: "message", role, content: pendingParts });
    pendingParts = [];
  };

  blocks.forEach((block, bi) => {
    const path = `${basePath}.blocks[${bi}]`;
    switch (block.type) {
      case "text": {
        // 파트 레벨 명시적 캐시 (인벤토리 §1 input_text — 감사 openai #2: explicit 모드 결합 시
        // 브레이크포인트 표현 불가면 조용한 캐시 전멸)
        const bp = block.providerOptions?.["openai"]?.["promptCacheBreakpoint"];
        pendingParts.push({ type: partType, text: block.text, ...(bp !== undefined ? { prompt_cache_breakpoint: bp as JSONValue } : {}) });
        return;
      }
      case "file": {
        if (role === "assistant") {
          // 출력 방향 file 재전송 표현 없음 — 드롭 + 보고
          cctx.warnings.push(
            makeWarning("unsupported", "block-dropped", "assistant file 블록은 Responses 재전송 불가 — 드롭", path),
          );
          return;
        }
        const filePart = fileToPart(block, path);
        const bp = block.providerOptions?.["openai"]?.["promptCacheBreakpoint"];
        if (bp !== undefined) filePart["prompt_cache_breakpoint"] = bp as JSONValue;
        pendingParts.push(filePart);
        return;
      }
      case "reasoning": {
        flush();
        const item = reasoningToItem(block, cctx, path);
        if (item) items.push(item);
        return;
      }
      case "toolCall": {
        flush();
        const preserved = readItem(block.providerOptions, block.providerMetadata);
        if (preserved && block.origin?.provider === "openai") {
          items.push(preserved); // 원문 item 무변경 재전송
          return;
        }
        if (block.providerExecuted) {
          // 서버 실행 툴 호출은 원문 item 없이는 재구성 불가 — 드롭 + 보고 (D6-6)
          cctx.warnings.push(
            makeWarning("unsupported", "block-dropped", `서버 툴 호출(${block.toolName}) 원문 소실 — 드롭`, path),
          );
          return;
        }
        if (block.input.type === "text") {
          items.push({
            type: "custom_tool_call",
            call_id: block.toolCallId,
            name: block.toolName,
            input: block.input.text,
          });
          return;
        }
        items.push({
          type: "function_call",
          call_id: block.toolCallId,
          name: block.toolName,
          arguments: JSON.stringify(block.input.value),
        });
        return;
      }
      case "toolResult": {
        flush();
        if (block.providerExecuted) {
          // 서버 툴 결과는 *_call item에 내장 — 별도 재전송 대상 아님 (원문 item이 담당)
          return;
        }
        if (block.output.type === "content") {
          cctx.warnings.push(
            makeWarning("compatibility", "block-dropped", "멀티모달 툴 결과를 문자열로 직렬화 (D6-5)", path),
          );
        }
        items.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: toolResultOutput(block),
        });
        return;
      }
      case "source":
        return; // §4.6 — 재전송 대상 아님
      case "custom": {
        flush();
        if (block.kind.startsWith("openai.")) {
          items.push(block.payload as JSONObject);
          return;
        }
        cctx.warnings.push(
          makeWarning("unsupported", "block-dropped", `타 프로바이더 custom 블록(${block.kind}) — 드롭`, path),
        );
        return;
      }
      case "passthrough": {
        flush();
        if (block.provider === "openai") {
          items.push(block.raw as JSONObject);
          return;
        }
        cctx.warnings.push(
          makeWarning("unsupported", "passthrough-dropped", "타 프로바이더 passthrough 블록 — 드롭", path),
        );
        return;
      }
    }
  });
  flush();
  return items;
}

function mergeExternal(body: JSONObject, entries: JSONObject, label: string): void {
  for (const [k, v] of Object.entries(entries)) {
    if (RESERVED_BODY_KEYS.has(k) && body[k] !== undefined) {
      throw new AdapterInvalidRequestError(`${label}의 '${k}'가 어댑터가 조립한 핵심 필드와 충돌합니다`);
    }
    body[k] = v;
  }
}

export function transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
  const warnings: Warning[] = [];
  const cctx: ConvertCtx = { warnings, retargetReasoning: req.retarget?.reasoning ?? "drop" };
  const opts = parseOpenAIRequestOptions(req.providerOptions, req.allowUnknownProviderOptions ?? false, warnings);
  const body: JSONObject = { model: ctx.modelId };

  // ── system: 선두 연속 system → instructions. 중간 system은 input message role system ──
  const instructionParts: string[] = [];
  let leading = true;
  const input: JSONObject[] = [];

  req.messages.forEach((msg, mi) => {
    const basePath = `messages[${mi}]`;
    if (leading && msg.role === "system") {
      for (const b of msg.blocks) {
        if (b.type === "text") instructionParts.push(b.text);
        else
          warnings.push(
            makeWarning("unsupported", "block-dropped", "instructions는 텍스트만 — 비텍스트 system 블록 드롭", basePath),
          );
      }
      return;
    }
    leading = false;
    let role: "user" | "assistant" | "system" | "developer";
    if (msg.role === "system") {
      role = msg.providerOptions?.["openai"]?.["role"] === "developer" ? "developer" : "system";
    } else if (msg.role === "tool") {
      role = "user"; // tool 역할 블록은 function_call_output item으로 나가고 잔여 텍스트만 user
    } else {
      role = msg.role;
    }
    input.push(...messageToItems(role, msg.blocks, cctx, basePath));
  });

  if (instructionParts.length > 0) body["instructions"] = instructionParts.join("\n\n");
  if (opts.instructions !== undefined) {
    if (body["instructions"] !== undefined) warnings.push(overrideWarning("instructions", "instructions"));
    body["instructions"] = opts.instructions;
  }
  body["input"] = input;

  // ── tools ──
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      if (t.type === "function") {
        const def: JSONObject = { type: "function", name: t.name, parameters: t.inputSchema };
        if (t.description) def["description"] = t.description;
        if (t.strict !== undefined) def["strict"] = t.strict;
        if (t.inputExamples) {
          warnings.push(
            makeWarning("unsupported", "parameter-dropped", `openai 미지원 inputExamples 드롭 (${t.name})`, "tools"),
          );
        }
        // 툴 레벨 PO — output_schema·allowed_callers·defer_loading 방출 + D5 미지 키 정책
        // (감사 openai #3/#17: 어댑터가 툴 PO를 아예 읽지 않아 신필드가 도달 불가였다)
        const toolPO = partitionProviderOptions(
          t.providerOptions,
          "openai",
          ToolLevelOptionsSchema,
          req.allowUnknownProviderOptions ?? false,
          warnings,
        );
        if (toolPO.known.outputSchema) def["output_schema"] = toolPO.known.outputSchema as JSONValue;
        if (toolPO.known.allowedCallers) def["allowed_callers"] = toolPO.known.allowedCallers;
        if (toolPO.known.deferLoading !== undefined) def["defer_loading"] = toolPO.known.deferLoading;
        for (const [k, v] of Object.entries(toolPO.extra)) def[k] = v; // opt-in 통과분 (warning 동반)
        return def;
      }
      // provider 툴: "openai.web_search" 등 — args가 wire 정의 원문
      if (!t.id.startsWith("openai.")) {
        throw new AdapterInvalidRequestError(`타 프로바이더 툴 ${t.id}은 openai 타깃에서 사용 불가`);
      }
      const wireType = t.id.slice("openai.".length);
      if (wireType === "image_generation") {
        // 이미지 출력 블록은 v0 범위 밖 (ir-v0 §15) — 명시적 거부
        throw new AdapterInvalidRequestError("openai.image_generation은 v0 범위 밖입니다 (이미지 출력 블록 미지원)");
      }
      return { type: wireType, ...(t.args ?? {}) };
    });
  }
  if (req.toolChoice !== undefined) {
    body["tool_choice"] =
      typeof req.toolChoice === "string" ? req.toolChoice : { type: "function", name: req.toolChoice.toolName };
  }
  if (opts.toolChoice !== undefined) {
    if (body["tool_choice"] !== undefined) warnings.push(overrideWarning("tool_choice", "toolChoice"));
    body["tool_choice"] = opts.toolChoice as JSONValue;
  }
  if (req.parallelToolCalls !== undefined) body["parallel_tool_calls"] = req.parallelToolCalls;

  // ── sampling — 모델 capability 게이트(레지스트리 공급) 후 표면 게이트 ──
  const gated = gateUnsupportedParams(
    { temperature: req.temperature, topP: req.topP },
    ctx.capabilities?.unsupportedParams,
    req.strictParameters,
    "openai",
    warnings,
  );
  if (gated["temperature"] !== undefined) body["temperature"] = gated["temperature"];
  if (gated["topP"] !== undefined) body["top_p"] = gated["topP"];
  if (req.maxOutputTokens === 0) {
    // 0(캐시 프리워밍)은 anthropic 전용 의미론 — openai는 미지원, 드롭 + warning (ir-v0 §6)
    warnings.push(makeWarning("unsupported", "parameter-dropped", "maxOutputTokens 0(프리워밍)은 openai 미지원 — 드롭", "maxOutputTokens"));
  } else if (req.maxOutputTokens !== undefined) body["max_output_tokens"] = req.maxOutputTokens;
  // Responses 표면 미지원 IR 표준 파라미터 (인벤토리 §1 — CC 전용). 선택자가 CC로 못 보낸 경우 드롭+보고
  dropUnsupportedParams(
    {
      topK: req.topK,
      seed: req.seed,
      presencePenalty: req.presencePenalty,
      frequencyPenalty: req.frequencyPenalty,
      stopSequences: req.stopSequences,
    },
    req.strictParameters,
    "openai responses",
    warnings,
  );

  // ── reasoning ──
  const reasoning: JSONObject = {};
  if (req.reasoning?.effort) {
    const supported = ctx.capabilities?.supportedEfforts ?? DEFAULT_EFFORTS;
    const effort = clampEffort(req.reasoning.effort, supported, warnings, req.strictParameters);
    if (effort !== undefined) reasoning["effort"] = effort;
  }
  if (opts.reasoning?.summary) reasoning["summary"] = opts.reasoning.summary;
  if (opts.reasoning?.context) reasoning["context"] = opts.reasoning.context;
  if (opts.reasoning?.mode) reasoning["mode"] = opts.reasoning.mode;
  if (Object.keys(reasoning).length > 0) body["reasoning"] = reasoning;

  // ── text (verbosity + 구조화 출력) ──
  const text: JSONObject = {};
  if (opts.textVerbosity) text["verbosity"] = opts.textVerbosity;
  if (req.responseFormat && req.responseFormat.type === "json") {
    if (req.responseFormat.schema) {
      const fmt: JSONObject = {
        type: "json_schema",
        name: req.responseFormat.name ?? "response",
        schema: req.responseFormat.schema,
      };
      if (req.responseFormat.description) fmt["description"] = req.responseFormat.description;
      if (req.responseFormat.strict !== undefined) fmt["strict"] = req.responseFormat.strict;
      text["format"] = fmt;
    } else {
      text["format"] = { type: "json_object" };
    }
  }
  if (Object.keys(text).length > 0) body["text"] = text;

  // ── 서버 상태 — store:false 강제 (ADR-0002 §2). 명시 PO는 §2 override + warning ──
  body["store"] = false;
  if (opts.store !== undefined) {
    if (opts.store) {
      warnings.push(overrideWarning("store", "store", "게이트웨이 기본 store:false를 opt-in으로 해제"));
      warnings.push(
        makeWarning(
          "other",
          "server-state-unmanaged",
          "store:true — 서버측 상태는 게이트웨이 관리 밖 (리소스 레지스트리는 로드맵 5)",
        ),
      );
    }
    body["store"] = opts.store;
  }
  if (opts.previousResponseId !== undefined) {
    body["previous_response_id"] = opts.previousResponseId;
    warnings.push(
      makeWarning("other", "server-state-unmanaged", "previous_response_id passthrough — 서버측 상태 참조"),
    );
  }
  if (opts.conversation !== undefined) {
    body["conversation"] = opts.conversation as JSONValue;
    warnings.push(makeWarning("other", "server-state-unmanaged", "conversation passthrough — 서버측 상태 참조"));
  }
  if (opts.background !== undefined) {
    body["background"] = opts.background;
    if (opts.background) {
      warnings.push(
        makeWarning("other", "server-state-unmanaged", "background:true — 비동기 핸들은 부록 (b) 범위, passthrough만"),
      );
    }
  }

  // ── include: store:false면 encrypted reasoning 왕복 보장 (하위호환 명시 — 인벤토리 §0) ──
  const include = new Set(opts.include ?? []);
  if (body["store"] === false) include.add("reasoning.encrypted_content");
  if (include.size > 0) body["include"] = [...include].sort();

  // ── 기타 PO ──
  if (opts.topLogprobs !== undefined) body["top_logprobs"] = opts.topLogprobs;
  if (opts.maxToolCalls !== undefined) body["max_tool_calls"] = opts.maxToolCalls;
  if (opts.serviceTier) body["service_tier"] = opts.serviceTier;
  if (opts.truncation) body["truncation"] = opts.truncation;
  if (opts.prompt) body["prompt"] = opts.prompt as JSONValue;
  if (opts.promptCacheKey) body["prompt_cache_key"] = opts.promptCacheKey;
  if (opts.promptCacheOptions) {
    body["prompt_cache_options"] = opts.promptCacheOptions as JSONValue;
    // explicit 모드인데 파트 브레이크포인트 0개 = 캐시 전멸 함정 — 보고 (감사 openai #2)
    if (
      (opts.promptCacheOptions as Record<string, unknown>)["mode"] === "explicit" &&
      !req.messages.some((m) => m.blocks.some((b) => b.providerOptions?.["openai"]?.["promptCacheBreakpoint"] !== undefined))
    ) {
      warnings.push(
        makeWarning("degraded", "cache-breakpoint-ignored", "prompt_cache_options.mode=explicit인데 파트 브레이크포인트(promptCacheBreakpoint) 0개 — 캐시 미적중", "providerOptions.openai.promptCacheOptions"),
      );
    }
  }
  if (opts.promptCacheRetention) body["prompt_cache_retention"] = opts.promptCacheRetention;
  if (opts.contextManagement) body["context_management"] = opts.contextManagement as JSONValue;
  if (opts.moderation) body["moderation"] = opts.moderation as JSONValue;

  // ── metadata: userId → safety_identifier (user는 deprecated — 인벤토리 §A), 나머지 → metadata ──
  if (req.metadata) {
    const { userId, ...restMeta } = req.metadata;
    if (userId) body["safety_identifier"] = userId;
    const metaEntries = Object.entries(restMeta).filter(([, v]) => typeof v === "string");
    if (metaEntries.length > 0) body["metadata"] = Object.fromEntries(metaEntries);
    for (const [k, v] of Object.entries(restMeta)) {
      if (typeof v !== "string") {
        warnings.push(
          makeWarning("unsupported", "parameter-dropped", `openai metadata는 string 값만 — metadata.${k} 드롭`, `metadata.${k}`),
        );
      }
    }
  }
  if (opts.safetyIdentifier !== undefined) {
    if (body["safety_identifier"] !== undefined) warnings.push(overrideWarning("safety_identifier", "safetyIdentifier"));
    body["safety_identifier"] = opts.safetyIdentifier;
  }
  if (opts.metadata !== undefined) {
    if (body["metadata"] !== undefined) warnings.push(overrideWarning("metadata", "metadata"));
    body["metadata"] = opts.metadata;
  }

  // ── stream ──
  if (req.stream) body["stream"] = true;
  if (opts.streamOptions?.includeObfuscation !== undefined) {
    body["stream_options"] = { include_obfuscation: opts.streamOptions.includeObfuscation };
  }

  // ── CC 전용 PO가 여기 도달 — 선택자가 못 보낸 경우 드롭 + 보고 (ADR-0002 §4) ──
  dropUnsupportedParams(
    {
      "openai.logitBias": opts.logitBias,
      "openai.logprobs": opts.logprobs,
      "openai.n": opts.n,
      "openai.prediction": opts.prediction,
      "openai.audio": opts.audio,
      "openai.modalities": opts.modalities,
      "openai.webSearchOptions": opts.webSearchOptions,
      "openai.user": opts.user,
    },
    req.strictParameters,
    "openai responses",
    warnings,
  );

  mergeExternal(body, opts.extra, "providerOptions.openai(opt-in)");

  if (req.passthroughParams) {
    if (req.passthroughParams.provider !== "openai") {
      throw new AdapterInvalidRequestError(
        "타 프로바이더 passthroughParams가 openai 어댑터에 도달 — 정책 레이어 필터 누락",
        { gatewayException: true },
      );
    }
    mergeExternal(body, req.passthroughParams.params, "passthroughParams");
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(req.passthroughParams?.headers ?? {})) headers[k] = v;

  const validated = ResponsesWireRequestSchema.parse(body) as unknown as JSONObject;
  return { request: { method: "POST", path: "/v1/responses", headers, body: validated }, warnings };
}
