import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { Message } from "../../ir/message.js";
import type { IRRequest } from "../../ir/request.js";
import { IRRequestSchema } from "../../ir/request.js";
import type { Tool } from "../../ir/tools.js";
import { OriginSchema, type Warning } from "../../ir/common.js";
import { makeWarning } from "../../adapters/shared.js";
import { GatewayError, irError } from "../../gateway/errors.js";
import type { InboundConversion } from "../openai-compat/request.js";

// anthropic-compat Messages 인바운드: wire 요청 → IRRequest + warnings (부록 (a) §3.2).
// 블록 구조가 IR과 1:1 — cache_control은 PO.anthropic으로, thinking signature는 opaqueState로.

const KNOWN_TOP_KEYS = new Set([
  "model", "max_tokens", "system", "messages", "tools", "tool_choice", "temperature", "top_p",
  "top_k", "stop_sequences", "output_config", "metadata", "thinking", "service_tier", "stream",
]);

function invalid(message: string): GatewayError {
  return new GatewayError(irError("invalid_request", 400, message));
}

function withCachePO(block: Block, raw: Record<string, unknown>): Block {
  const cc = raw["cache_control"];
  if (!cc || typeof cc !== "object") return block;
  return { ...block, providerOptions: { anthropic: { cacheControl: cc as JSONObject } } };
}

type FileData = (Block & { type: "file" })["data"];
function sourceToFileData(source: Record<string, unknown>, path: string): { mediaType: string; data: FileData } {
  const type = source["type"];
  if (type === "base64") {
    return {
      mediaType: String(source["media_type"] ?? "application/octet-stream"),
      data: { type: "base64", data: String(source["data"] ?? "") },
    };
  }
  if (type === "url") return { mediaType: "application/octet-stream", data: { type: "url", url: String(source["url"] ?? "") } };
  if (type === "file") return { mediaType: "application/octet-stream", data: { type: "reference", refs: { anthropic: String(source["file_id"] ?? "") } } };
  if (type === "text") return { mediaType: String(source["media_type"] ?? "text/plain"), data: { type: "text", text: String(source["data"] ?? "") } };
  throw invalid(`${path}: 미지의 source type '${String(type)}'`);
}

export function wireBlockToIRBlock(raw: Record<string, unknown>, path: string): Block {
  const type = raw["type"];
  switch (type) {
    case "text":
      return withCachePO({ type: "text", text: String(raw["text"] ?? "") }, raw);
    case "image": {
      const { mediaType, data } = sourceToFileData((raw["source"] ?? {}) as Record<string, unknown>, path);
      return withCachePO({ type: "file", mediaType: mediaType === "application/octet-stream" ? "image/*" : mediaType, data }, raw);
    }
    case "document": {
      const { mediaType, data } = sourceToFileData((raw["source"] ?? {}) as Record<string, unknown>, path);
      const citations = (raw["citations"] ?? {}) as Record<string, unknown>;
      return withCachePO(
        {
          type: "file",
          mediaType,
          data,
          ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
          ...(typeof raw["context"] === "string" ? { context: raw["context"] } : {}),
          ...(typeof citations["enabled"] === "boolean" ? { citationsEnabled: citations["enabled"] } : {}),
        },
        raw,
      );
    }
    case "tool_use": {
      // 비표준 키(PTC caller 등)는 wireExtras로 보존 — 아웃바운드가 재병합 (부록 (a) §3.2, 리뷰 G6)
      const { type: _t, id: _id, name: _name, input: _input, cache_control: _cc, ...toolUseRest } = raw;
      const block: Block = {
        type: "toolCall",
        toolCallId: String(raw["id"] ?? ""),
        toolName: String(raw["name"] ?? ""),
        input: { type: "json", value: (raw["input"] ?? {}) as JSONValue },
      };
      const withCC = withCachePO(block, raw);
      if (Object.keys(toolUseRest).length === 0) return withCC;
      const prevNS = (withCC.providerOptions?.["anthropic"] ?? {}) as JSONObject;
      return { ...withCC, providerOptions: { anthropic: { ...prevNS, wireExtras: toolUseRest as JSONObject } } };
    }
    case "tool_result": {
      const content = raw["content"];
      let output: (Block & { type: "toolResult" })["output"];
      if (typeof content === "string") output = { type: "text", text: content };
      else if (Array.isArray(content)) {
        output = {
          type: "content",
          blocks: content.map((c, i) => wireBlockToIRBlock((c ?? {}) as Record<string, unknown>, `${path}.content[${i}]`)) as never,
        };
      } else output = { type: "json", value: (content ?? null) as JSONValue };
      // is_error는 content 형태와 직교 (§4.4) — text만 승격하면 배열/json의 실패가 성공으로 둔갑 (감사 #1)
      if (raw["is_error"] === true) {
        if (output.type === "text") output = { type: "errorText", text: output.text };
        else if (output.type === "json") output = { type: "errorJson", value: output.value };
        else if (output.type === "content") output = { type: "errorContent", blocks: output.blocks };
      }
      return withCachePO(
        {
          type: "toolResult",
          toolCallId: String(raw["tool_use_id"] ?? ""),
          toolName: "tool", // wire에 이름 없음 — IR 필수 필드는 스텁 (재타게팅 시 toolCall에서 복원 가능)
          output,
        },
        raw,
      );
    }
    case "thinking": {
      const sig = raw["signature"];
      return {
        type: "reasoning",
        text: String(raw["thinking"] ?? ""),
        ...(typeof sig === "string" && sig.length > 0 ? { opaqueState: { provider: "anthropic", data: sig } } : {}),
      };
    }
    case "redacted_thinking":
      return { type: "reasoning", text: "", redacted: true, opaqueState: { provider: "anthropic", data: String(raw["data"] ?? "") } };
    case "search_result":
      return { type: "custom", kind: "anthropic.search_result", payload: raw as JSONValue };
    default:
      // 미지 블록 — passthrough 수납 (§13.4-3 최선 복원, G1)
      return { type: "passthrough", provider: "anthropic", raw: raw as JSONValue };
  }
}

function contentToBlocks(content: unknown, path: string): Block[] {
  // 빈 문자열 content는 메시지 생략 대상 — §3.4 (감사 #10/#15: openai-compat과 비대칭이었다)
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.map((c, i) => wireBlockToIRBlock((c ?? {}) as Record<string, unknown>, `${path}[${i}]`));
  return [];
}

export function compatMessagesToIR(
  wire: unknown,
  allowUnknown: boolean,
  betaHeader?: string,
): InboundConversion {
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) throw invalid("JSON 객체 body가 아닙니다");
  const w = wire as Record<string, unknown>;
  const warnings: Warning[] = [];
  // 미지 top-level 키는 원문 통과 (부록 (a) §3.2 2026-08-21 개정 — D10-1 compat passthrough 경로).
  // anthropic-compat는 D10 100% 커버리지 대상: container·context_management·mcp_servers·베타
  // 신필드를 게이트웨이가 몰라도 죽이지 않는다. pinned → 폴백 시 타 프로바이더는 skipped.
  // (allowUnknown은 top-level에 더 이상 관여하지 않음 — PO 네임스페이스 내부 미지 키(D5)에만 유효)
  const passthroughParams: JSONObject = {};
  for (const k of Object.keys(w)) {
    if (!KNOWN_TOP_KEYS.has(k)) passthroughParams[k] = w[k] as JSONValue;
  }

  const messages: Message[] = [];
  if (w["system"] !== undefined) {
    // §3.4: 빈 system은 생략 — Anthropic은 수용하는데 게이트웨이만 400 내는 비대칭 방지 (감사 #15)
    const systemBlocks = contentToBlocks(w["system"], "system");
    if (systemBlocks.length > 0) messages.push({ role: "system", blocks: systemBlocks });
  }
  const rawMessages = Array.isArray(w["messages"]) ? w["messages"] : [];
  rawMessages.forEach((raw, mi) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const role = String(m["role"] ?? "");
    if (role !== "user" && role !== "assistant" && role !== "system") throw invalid(`messages[${mi}]: 미지의 role '${role}'`);
    const blocks = contentToBlocks(m["content"], `messages[${mi}].content`);
    if (blocks.length === 0) return;
    const msg: Message = { role, blocks };
    // gateway.origin — 표면 sticky 복원 (§2.2)
    const gw = m["gateway"];
    if (gw && typeof gw === "object") {
      const origin = OriginSchema.safeParse((gw as Record<string, unknown>)["origin"]);
      if (origin.success) msg.origin = origin.data;
    }
    messages.push(msg);
  });

  const tools: Tool[] | undefined = Array.isArray(w["tools"])
    ? w["tools"].map((raw) => {
        const t = (raw ?? {}) as Record<string, unknown>;
        const name = String(t["name"] ?? "");
        if (t["input_schema"] !== undefined) {
          const { name: _n, description, input_schema, strict, input_examples, cache_control, ...rest } = t;
          const tool: Tool = {
            type: "function",
            name,
            ...(typeof description === "string" ? { description } : {}),
            inputSchema: input_schema as JSONObject,
            ...(typeof strict === "boolean" ? { strict } : {}),
            ...(Array.isArray(input_examples) ? { inputExamples: input_examples as JSONObject[] } : {}),
          };
          // 비표준 키(allowed_callers 등 PTC/신필드)는 PO로 보존 — 아웃바운드가 wire 재병합
          // (부록 (a) §3.2, 2026-08-21). cacheControl은 기존 규약 키 유지.
          const extraPO: JSONObject = { ...(rest as JSONObject) };
          const po: JSONObject = {
            ...(cache_control && typeof cache_control === "object" ? { cacheControl: cache_control as JSONObject } : {}),
            ...(Object.keys(extraPO).length > 0 ? { wireExtras: extraPO } : {}),
          };
          return Object.keys(po).length > 0 ? { ...tool, providerOptions: { anthropic: po } } : tool;
        }
        // 서버 툴 정의 ({type: "web_search_20250305", name: "web_search", ...}) → provider 툴
        const { name: _n2, ...args } = t;
        return { type: "provider", id: `anthropic.${name}`, args: args as JSONObject };
      })
    : undefined;

  let toolChoice: IRRequest["toolChoice"];
  let parallelToolCalls: boolean | undefined;
  const tc = w["tool_choice"];
  if (tc && typeof tc === "object") {
    const t = tc as Record<string, unknown>;
    if (t["disable_parallel_tool_use"] === true) parallelToolCalls = false;
    if (t["type"] === "auto") toolChoice = "auto";
    else if (t["type"] === "any") toolChoice = "required";
    else if (t["type"] === "none") toolChoice = "none";
    else if (t["type"] === "tool" && typeof t["name"] === "string") toolChoice = { type: "tool", toolName: t["name"] };
    else {
      // 미지 type 조용한 드롭 금지 (D5 — 감사 anthropic #10)
      warnings.push(
        makeWarning("unsupported", "parameter-dropped", `미지의 tool_choice type '${String(t["type"])}' — 드롭`, "tool_choice"),
      );
    }
  }

  const po: JSONObject = {};
  if (w["thinking"] !== undefined) po["thinking"] = w["thinking"] as JSONValue;
  if (typeof w["service_tier"] === "string") po["serviceTier"] = w["service_tier"];
  if (betaHeader) po["betas"] = betaHeader.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const outputConfig = (w["output_config"] ?? {}) as Record<string, unknown>;
  // effort/format 외 잔여 서브키(task_budget 등) 보존 — 부분 소비가 나머지를 조용히 소멸시키면
  // §8-1 보존 통과 계약 위반 (감사 anthropic #1). 아웃바운드가 output_config에 재병합.
  {
    const { effort: _e, format: _f, ...ocExtras } = outputConfig;
    if (Object.keys(ocExtras).length > 0) po["outputConfigExtras"] = ocExtras as JSONObject;
  }

  const ir: JSONObject = { version: "0", model: String(w["model"] ?? ""), messages: messages as unknown as JSONValue };
  if (tools) ir["tools"] = tools as unknown as JSONValue;
  if (toolChoice !== undefined) ir["toolChoice"] = toolChoice as JSONValue;
  if (parallelToolCalls !== undefined) ir["parallelToolCalls"] = parallelToolCalls;
  if (typeof w["max_tokens"] === "number") ir["maxOutputTokens"] = w["max_tokens"];
  for (const [wireKey, irKey] of [["temperature", "temperature"], ["top_p", "topP"], ["top_k", "topK"]] as const) {
    if (typeof w[wireKey] === "number") ir[irKey] = w[wireKey];
  }
  if (Array.isArray(w["stop_sequences"])) ir["stopSequences"] = w["stop_sequences"] as JSONValue;
  if (typeof outputConfig["effort"] === "string") ir["reasoning"] = { effort: outputConfig["effort"] };
  const fmt = outputConfig["format"];
  if (fmt && typeof fmt === "object") {
    const f = fmt as Record<string, unknown>;
    ir["responseFormat"] = {
      type: "json",
      ...(f["schema"] !== undefined ? { schema: f["schema"] as JSONValue } : {}),
      ...(typeof f["name"] === "string" ? { name: f["name"] } : {}),
      ...(typeof f["description"] === "string" ? { description: f["description"] } : {}),
      ...(typeof f["strict"] === "boolean" ? { strict: f["strict"] } : {}),
    };
  }
  const meta = (w["metadata"] ?? {}) as Record<string, unknown>;
  if (typeof meta["user_id"] === "string") ir["metadata"] = { userId: meta["user_id"] };
  if (w["stream"] === true) ir["stream"] = true;
  if (Object.keys(po).length > 0) ir["providerOptions"] = { anthropic: po };
  if (Object.keys(passthroughParams).length > 0) {
    ir["passthroughParams"] = { provider: "anthropic", params: passthroughParams, pinned: true };
  }
  if (allowUnknown) ir["allowUnknownProviderOptions"] = true;

  const parsed = IRRequestSchema.safeParse(ir);
  if (!parsed.success) {
    throw invalid(`IR 변환 실패: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { request: parsed.data, warnings };
}
