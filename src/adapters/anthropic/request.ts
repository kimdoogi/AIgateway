import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block, FileBlock, ToolResultBlock } from "../../ir/blocks.js";
import type { NS, Warning } from "../../ir/common.js";
import type { IRRequest } from "../../ir/request.js";
import type { RequestContext, TransformedRequest } from "../types.js";
import { AdapterInvalidRequestError, dropUnsupportedParams, makeWarning } from "../shared.js";
import { parseAnthropicRequestOptions, readBlockCacheControl, readBlockWireType } from "./options.js";
import { AnthropicWireRequestSchema } from "./wire.js";

// IR → Anthropic Messages wire (ir-v0 §13, docs/research/2026-08-20-anthropic-api-coverage.md)
// 순수 함수. 재타게팅 패스가 히스토리를 이 타깃에 맞게 정규화했다는 전제이되,
// 방어적으로: 타깃 불일치 요소는 조용히 넘기지 않고 드롭+warning 또는 명시적 에러 (D5).

const DEFAULT_MAX_TOKENS = 4096; // 레지스트리 이관 대상 — ctx.capabilities.defaultMaxTokens가 우선 (리뷰 A6)
const DEFAULT_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

// 어댑터가 조립하는 핵심 필드 — passthrough/extra가 이미 설정된 값을 덮어쓰면 명시적 에러 (리뷰 R5)
const RESERVED_BODY_KEYS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "output_config",
  "metadata",
  "thinking",
  "service_tier",
  "stream",
]);

type RetargetReasoning = "drop" | "demote-to-text" | "strip-and-annotate";

interface ConvertCtx {
  warnings: Warning[];
  retargetReasoning: RetargetReasoning;
}

function withCache(obj: JSONObject, providerOptions: NS | undefined): JSONObject {
  const cc = readBlockCacheControl(providerOptions);
  return cc ? { ...obj, cache_control: cc } : obj;
}

function fileToWire(block: FileBlock, path: string): JSONObject {
  const isImage = block.mediaType.startsWith("image/");
  let source: JSONObject;
  switch (block.data.type) {
    case "base64":
      source = { type: "base64", media_type: block.mediaType, data: block.data.data };
      break;
    case "url":
      source = { type: "url", url: block.data.url };
      break;
    case "reference": {
      const fileId = block.data.refs["anthropic"];
      if (!fileId) {
        // D6-8: 타깃 불일치 reference는 재타게팅이 해결했어야 함 — 조용한 드롭 대신 명시적 에러
        throw new AdapterInvalidRequestError(
          `file reference에 anthropic file_id가 없습니다 (${path}) — 재타게팅 필요 (D6-8)`,
        );
      }
      source = { type: "file", file_id: fileId };
      break;
    }
    case "text":
      source = { type: "text", media_type: "text/plain", data: block.data.text };
      break;
  }
  if (isImage) return withCache({ type: "image", source }, block.providerOptions);
  const doc: JSONObject = { type: "document", source };
  if (block.title) doc["title"] = block.title;
  if (block.context) doc["context"] = block.context;
  if (block.citationsEnabled !== undefined) doc["citations"] = { enabled: block.citationsEnabled };
  return withCache(doc, block.providerOptions);
}

function toolResultToWire(block: ToolResultBlock, cctx: ConvertCtx, path: string): JSONObject | null {
  // 서버 툴 결과 (providerExecuted): G1 왕복 — wireType이 있으면 원문 wire 블록 복원 (리뷰 R1)
  if (block.providerExecuted) {
    const wireType = readBlockWireType(block.providerOptions, block.providerMetadata);
    if (wireType && block.output.type === "json") {
      return { type: wireType, tool_use_id: block.toolCallId, content: block.output.value };
    }
    // 타 프로바이더 산(또는 wireType 소실) 서버 툴 결과 → D6-6: 텍스트 강등 + warning
    cctx.warnings.push(
      makeWarning(
        "compatibility",
        "block-dropped",
        `복원 불가한 서버 툴 결과(${block.toolName}) — 텍스트 강등 (D6-6)`,
        path,
      ),
    );
    return {
      type: "text",
      text: `[서버 툴 ${block.toolName} 결과]\n${JSON.stringify(
        block.output.type === "json" ? block.output.value : block.output,
      )}`,
    };
  }

  const out = block.output;
  let content: JSONValue;
  let isError = false;
  switch (out.type) {
    case "text":
      content = out.text;
      break;
    case "json":
      content = JSON.stringify(out.value);
      break;
    case "content":
      content = out.blocks.map((b, i) => {
        if (b.type === "text") return { type: "text", text: b.text } as JSONObject;
        if (b.type === "file") return fileToWire(b, `${path}.content[${i}]`);
        // custom (예: anthropic.search_result) — payload가 wire 블록 원문
        return b.payload as JSONObject;
      });
      break;
    case "errorText":
      content = out.text;
      isError = true;
      break;
    case "errorJson":
      content = JSON.stringify(out.value);
      isError = true;
      break;
    case "executionDenied":
      content = `execution denied${out.reason ? `: ${out.reason}` : ""}`;
      isError = true;
      break;
  }
  const wire: JSONObject = { type: "tool_result", tool_use_id: block.toolCallId, content };
  if (isError) wire["is_error"] = true;
  return withCache(wire, block.providerOptions);
}

function reasoningToWire(block: Extract<Block, { type: "reasoning" }>, cctx: ConvertCtx, path: string): JSONObject | null {
  if (block.opaqueState?.provider === "anthropic") {
    if (block.redacted) return { type: "redacted_thinking", data: block.opaqueState.data };
    return { type: "thinking", thinking: block.text, signature: block.opaqueState.data };
  }
  // 외래(서명 없는) reasoning — retarget 정책 적용 (D6-2, 리뷰 R6)
  switch (cctx.retargetReasoning) {
    case "demote-to-text":
      if (block.text.length > 0) {
        cctx.warnings.push(
          makeWarning("compatibility", "reasoning-demoted", "외래 reasoning을 텍스트로 강등", path),
        );
        return { type: "text", text: block.text };
      }
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning에 강등할 텍스트 없음 — 드롭", path),
      );
      return null;
    case "strip-and-annotate":
      cctx.warnings.push(
        makeWarning("compatibility", "reasoning-annotated", "외래 reasoning 제거 사실을 주석으로 대체", path),
      );
      return { type: "text", text: "[이전 턴의 추론 내용은 프로바이더 전환으로 제거되었습니다]" };
    case "drop":
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning 블록 드롭 (retarget: drop)", path),
      );
      return null;
  }
}

function blockToWire(block: Block, cctx: ConvertCtx, path: string): JSONObject | null {
  switch (block.type) {
    case "text":
      return withCache({ type: "text", text: block.text }, block.providerOptions);
    case "reasoning":
      return reasoningToWire(block, cctx, path);
    case "toolCall": {
      if (block.input.type === "text") {
        throw new AdapterInvalidRequestError(
          `Anthropic 클라이언트 툴은 비JSON 입력을 지원하지 않습니다 (${path}) — 재타게팅 필요`,
        );
      }
      // 서버 실행 툴 호출: wireType 복원 (server_tool_use/mcp_tool_use — G1 왕복, 리뷰 R1)
      if (block.providerExecuted) {
        const wireType =
          readBlockWireType(block.providerOptions, block.providerMetadata) ?? "server_tool_use";
        return {
          type: wireType,
          id: block.toolCallId,
          name: block.toolName,
          input: block.input.value,
        };
      }
      return withCache(
        { type: "tool_use", id: block.toolCallId, name: block.toolName, input: block.input.value },
        block.providerOptions,
      );
    }
    case "toolResult":
      return toolResultToWire(block, cctx, path);
    case "file":
      return fileToWire(block, path);
    case "source":
      return null; // §4.6 — 히스토리 재전송 대상 아님 (스펙 명시라 warning 없음)
    case "custom": {
      if (block.kind.startsWith("anthropic.")) return block.payload as JSONObject;
      cctx.warnings.push(
        makeWarning("unsupported", "block-dropped", `타 프로바이더 custom 블록(${block.kind}) — 드롭`, path),
      );
      return null;
    }
    case "passthrough": {
      if (block.provider === "anthropic") return block.raw as JSONObject;
      cctx.warnings.push(
        makeWarning("unsupported", "passthrough-dropped", "타 프로바이더 passthrough 블록 — 드롭", path),
      );
      return null;
    }
  }
}

type WireMessage = { role: "user" | "assistant" | "system"; content: JSONObject[] };

/** body에 외부 키(opt-in extra / passthroughParams)를 병합 — 예약 키 충돌은 명시적 에러 (리뷰 R5) */
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
  const body: JSONObject = { model: ctx.modelId };

  // max_tokens는 Anthropic wire 필수 — 기본값 주입은 반드시 보고 (리뷰 A6)
  if (req.maxOutputTokens !== undefined) {
    body["max_tokens"] = req.maxOutputTokens;
  } else {
    const def = ctx.capabilities?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    body["max_tokens"] = def;
    warnings.push(
      makeWarning(
        "compatibility",
        "parameter-defaulted",
        `maxOutputTokens 미지정 — 기본값 ${def} 주입 (anthropic max_tokens 필수)`,
        "maxOutputTokens",
      ),
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };

  // ── system: 선두 연속 system → top-level. 중간 system은 capability 게이트 (리뷰 R4):
  //    지원 모델이면 messages 내 role system, 아니면 user 변환 + warning (D6-4 기본 정책)
  const system: JSONObject[] = [];
  let leading = true;
  const wireMessages: WireMessage[] = [];
  const midSystemSupported = ctx.capabilities?.midConversationSystem === true;

  req.messages.forEach((msg, mi) => {
    if (leading && msg.role === "system") {
      for (const b of msg.blocks) {
        const wireB = blockToWire(b, cctx, `messages[${mi}]`);
        if (wireB) system.push(wireB);
      }
      return;
    }
    leading = false;

    let role: WireMessage["role"];
    if (msg.role === "system") {
      if (midSystemSupported) {
        role = "system";
      } else {
        role = "user";
        warnings.push(
          makeWarning(
            "compatibility",
            "system-repositioned",
            "중간 system 메시지를 user 턴으로 변환 (모델이 mid-conversation system 미지원)",
            `messages[${mi}]`,
          ),
        );
      }
    } else {
      role = msg.role === "tool" ? "user" : msg.role;
    }

    const content: JSONObject[] = [];
    msg.blocks.forEach((b, bi) => {
      const wireB = blockToWire(b, cctx, `messages[${mi}].blocks[${bi}]`);
      if (wireB) content.push(wireB);
    });
    if (content.length === 0) return;
    const prev = wireMessages[wireMessages.length - 1];
    if (prev && prev.role === role && role !== "system") {
      prev.content.push(...content);
    } else {
      wireMessages.push({ role, content });
    }
  });
  if (system.length > 0) body["system"] = system;
  body["messages"] = wireMessages; // type alias라 구조적 대입 (리뷰 C7 — 캐스트 불필요)

  // ── tools ──
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => {
      if (t.type === "function") {
        const def: JSONObject = { name: t.name, input_schema: t.inputSchema };
        if (t.description) def["description"] = t.description;
        if (t.strict !== undefined) def["strict"] = t.strict;
        if (t.inputExamples) def["input_examples"] = t.inputExamples;
        return withCache(def, t.providerOptions);
      }
      // provider 툴: id = "anthropic.web_search" 등. args가 wire 정의 원문 (type 필수)
      if (!t.id.startsWith("anthropic.")) {
        throw new AdapterInvalidRequestError(`타 프로바이더 툴 ${t.id}은 anthropic 타깃에서 사용 불가`);
      }
      const args = t.args ?? {};
      if (typeof args["type"] !== "string") {
        throw new AdapterInvalidRequestError(`provider 툴 ${t.id}의 args.type(버전 문자열)이 필요합니다`);
      }
      return { name: t.id.slice("anthropic.".length), ...args };
    });
  }
  if (req.toolChoice !== undefined) {
    const tc: JSONObject =
      req.toolChoice === "auto"
        ? { type: "auto" }
        : req.toolChoice === "required"
          ? { type: "any" }
          : req.toolChoice === "none"
            ? { type: "none" }
            : { type: "tool", name: req.toolChoice.toolName };
    body["tool_choice"] = tc;
  }
  if (req.parallelToolCalls === false) {
    const tc = (body["tool_choice"] as JSONObject | undefined) ?? { type: "auto" };
    if (tc["type"] === "none") {
      // 'none'과의 조합은 wire 유효성 불확실 (리뷰 P4 — 골든셋 녹화 시 실검증) → 드롭 + 보고
      warnings.push(
        makeWarning(
          "unsupported",
          "parameter-dropped",
          "parallelToolCalls:false는 toolChoice 'none'과 조합 불가 — 드롭",
          "parallelToolCalls",
        ),
      );
    } else {
      body["tool_choice"] = { ...tc, disable_parallel_tool_use: true };
    }
  }

  // ── sampling ──
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.topK !== undefined) body["top_k"] = req.topK;
  if (req.stopSequences) body["stop_sequences"] = req.stopSequences;
  dropUnsupportedParams(
    { seed: req.seed, presencePenalty: req.presencePenalty, frequencyPenalty: req.frequencyPenalty },
    req.strictParameters,
    "anthropic",
    warnings,
  );

  // ── reasoning effort → output_config.effort (capability 게이트 — 리뷰 A3) ──
  const outputConfig: JSONObject = {};
  if (req.reasoning?.effort) {
    const supported = ctx.capabilities?.supportedEfforts ?? DEFAULT_EFFORTS;
    let effort: string = req.reasoning.effort;
    if (!supported.includes(effort)) {
      warnings.push(
        makeWarning("compatibility", "parameter-clamped", `effort '${effort}' → 'low' 클램프`, "reasoning.effort"),
      );
      effort = "low";
    }
    outputConfig["effort"] = effort;
  }
  if (req.responseFormat && req.responseFormat.type === "json") {
    // TODO(녹화 검증): output_config.format wire 형태를 골든셋 녹화에서 확정
    const fmt: JSONObject = { type: "json_schema" };
    if (req.responseFormat.schema) fmt["schema"] = req.responseFormat.schema;
    if (req.responseFormat.name) fmt["name"] = req.responseFormat.name;
    if (req.responseFormat.description) fmt["description"] = req.responseFormat.description;
    if (req.responseFormat.strict !== undefined) fmt["strict"] = req.responseFormat.strict;
    outputConfig["format"] = fmt;
  }
  if (Object.keys(outputConfig).length > 0) body["output_config"] = outputConfig;

  // ── metadata: userId 매핑, 그 외 키는 드롭 + 보고 (리뷰 R6c) ──
  if (req.metadata) {
    const { userId, ...restMeta } = req.metadata;
    if (userId) body["metadata"] = { user_id: userId };
    for (const k of Object.keys(restMeta)) {
      warnings.push(
        makeWarning("unsupported", "parameter-dropped", `anthropic 미지원 metadata.${k} 드롭`, `metadata.${k}`),
      );
    }
  }

  // ── providerOptions.anthropic (D5 — shared 공통 정책) ──
  const opts = parseAnthropicRequestOptions(req.providerOptions, req.allowUnknownProviderOptions ?? false, warnings);
  if (opts.thinking) body["thinking"] = opts.thinking;
  if (opts.serviceTier) body["service_tier"] = opts.serviceTier;
  if (opts.betas && opts.betas.length > 0) headers["anthropic-beta"] = opts.betas.join(",");
  mergeExternal(body, opts.extra, "providerOptions.anthropic(opt-in)");

  // ── passthroughParams (D10-1). 타깃 불일치는 정책 레이어가 걸렀어야 함 (리뷰 A5) ──
  if (req.passthroughParams) {
    if (req.passthroughParams.provider !== "anthropic") {
      throw new AdapterInvalidRequestError(
        "타 프로바이더 passthroughParams가 anthropic 어댑터에 도달 — 정책 레이어 필터 누락",
        { gatewayException: true },
      );
    }
    mergeExternal(body, req.passthroughParams.params, "passthroughParams");
    for (const [k, v] of Object.entries(req.passthroughParams.headers ?? {})) headers[k] = v;
  }

  if (req.stream) body["stream"] = true;

  // ── D4 요청 방향 wire 검증 (리뷰 R5). parse 부수 효과: 알려진 키 canonical 재배열 ──
  const validated = AnthropicWireRequestSchema.parse(body) as unknown as JSONObject;

  return { request: { method: "POST", path: "/v1/messages", headers, body: validated }, warnings };
}
