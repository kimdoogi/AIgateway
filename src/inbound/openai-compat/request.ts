import { z } from "zod";
import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import { BlockSchema } from "../../ir/blocks.js";
import type { Message } from "../../ir/message.js";
import type { IRRequest } from "../../ir/request.js";
import { IRRequestSchema } from "../../ir/request.js";
import type { Tool } from "../../ir/tools.js";
import type { Warning } from "../../ir/common.js";
import { makeWarning } from "../../adapters/shared.js";
import { GatewayError, irError } from "../../gateway/errors.js";

// openai-compat CC 인바운드: wire 요청 → IRRequest + warnings (부록 (a) §3.1).
// 미지 최상위 키는 4xx (D5). assistant gateway.ir은 복원 1순위 (§13.4-2).
// warnings는 호출측(app.ts)이 preWarnings로 병합 — 인바운드 강등도 D5 보고 대상
// (감사 2026-08-24 관통 패턴 #1: 채널 부재로 강등이 구조적 무증상이었다)

const KNOWN_TOP_KEYS = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p",
  "max_tokens", "max_completion_tokens", "stop", "seed", "presence_penalty", "frequency_penalty",
  "logit_bias", "logprobs", "top_logprobs", "n", "response_format", "reasoning_effort",
  "prediction", "audio", "modalities", "web_search_options", "service_tier", "prompt_cache_key",
  "safety_identifier", "user", "metadata", "store", "stream", "stream_options",
]);

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function invalid(message: string): GatewayError {
  return new GatewayError(irError("invalid_request", 400, message));
}

function fileFromImageUrl(url: string): Block {
  const m = DATA_URL.exec(url);
  if (m) return { type: "file", mediaType: m[1]!, data: { type: "base64", data: m[2]! } };
  return { type: "file", mediaType: "image/*", data: { type: "url", url } };
}

function partToBlock(part: Record<string, unknown>, path: string): Block {
  const type = part["type"];
  if (type === "text") return { type: "text", text: String(part["text"] ?? "") };
  if (type === "image_url") {
    const img = (part["image_url"] ?? {}) as Record<string, unknown>;
    const url = typeof img === "string" ? img : String(img["url"] ?? "");
    if (!url) throw invalid(`${path}: image_url.url 필요`);
    return fileFromImageUrl(url);
  }
  if (type === "input_audio") {
    const audio = (part["input_audio"] ??
      {}) as Record<string, unknown>;
    const format = String(audio["format"] ?? "wav");
    return {
      type: "file",
      mediaType: format === "mp3" ? "audio/mp3" : "audio/wav",
      data: { type: "base64", data: String(audio["data"] ?? "") },
    };
  }
  if (type === "file") {
    const file = (part["file"] ?? {}) as Record<string, unknown>;
    if (typeof file["file_id"] === "string") {
      return { type: "file", mediaType: "application/octet-stream", data: { type: "reference", refs: { openai: file["file_id"] } } };
    }
    if (typeof file["file_data"] === "string") {
      const m = DATA_URL.exec(file["file_data"]);
      if (!m) throw invalid(`${path}: file_data는 data URL이어야 합니다`);
      return {
        type: "file",
        mediaType: m[1]!,
        ...(typeof file["filename"] === "string" ? { filename: file["filename"] } : {}),
        data: { type: "base64", data: m[2]! },
      };
    }
    throw invalid(`${path}: file.file_id 또는 file_data 필요`);
  }
  throw invalid(`${path}: 미지의 content part type '${String(type)}'`);
}

function contentToBlocks(content: unknown, path: string): Block[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.map((p, i) => partToBlock((p ?? {}) as Record<string, unknown>, `${path}.content[${i}]`));
  }
  return [];
}

function toolCallsToBlocks(toolCalls: unknown, path: string, warnings: Warning[]): Block[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((raw, i) => {
    const tc = (raw ?? {}) as Record<string, unknown>;
    const fn = (tc["function"] ?? {}) as Record<string, unknown>;
    const name = String(fn["name"] ?? "");
    if (!name) throw invalid(`${path}.tool_calls[${i}]: function.name 필요`);
    const args = String(fn["arguments"] ?? "");
    let input: { type: "json"; value: JSONValue } | { type: "text"; text: string };
    // 빈 문자열은 '인자 없음'의 CC 관례 → {} (부록 (a) §3.1 명문화 — 날조가 아니라 등가 표현)
    try {
      input = { type: "json", value: (args.length > 0 ? JSON.parse(args) : {}) as JSONValue };
    } catch {
      // §4.3: 파싱 불가 → text 강등 + 보고 ('{}' 삽입 금지). 무경고 강등은 D5 위반 (감사 #29)
      input = { type: "text", text: args };
      warnings.push(
        makeWarning("compatibility", "tool-input-demoted", `tool_calls arguments가 유효 JSON이 아님 — text 강등 (${name})`, `${path}.tool_calls[${i}]`),
      );
    }
    return {
      type: "toolCall",
      toolCallId: String(tc["id"] ?? `call_inbound_${i}`),
      toolName: name,
      input,
    };
  });
}

/** assistant gateway.ir — 복원 1순위. 검증 실패는 4xx (조용한 절반 복원 금지 — §2.1) */
function gatewayIrBlocks(message: Record<string, unknown>): Block[] | null {
  const gw = message["gateway"];
  if (!gw || typeof gw !== "object") return null;
  const ir = (gw as Record<string, unknown>)["ir"];
  if (!Array.isArray(ir)) return null;
  const parsed = z.array(BlockSchema).safeParse(ir);
  if (!parsed.success) throw invalid("gateway.ir 검증 실패 — IR Block[] 형식이어야 합니다 (§13.4-2)");
  return parsed.data;
}

export interface InboundConversion {
  request: IRRequest;
  warnings: Warning[];
}

export function compatChatToIR(wire: unknown, allowUnknown: boolean): InboundConversion {
  if (!wire || typeof wire !== "object" || Array.isArray(wire)) throw invalid("JSON 객체 body가 아닙니다");
  const w = wire as Record<string, unknown>;
  const warnings: Warning[] = [];
  if (!allowUnknown) {
    const unknown = Object.keys(w).filter((k) => !KNOWN_TOP_KEYS.has(k));
    if (unknown.length > 0) {
      throw invalid(`미지의 파라미터: ${unknown.join(", ")} (D5 — x-gateway-allow-unknown: true로 통과 가능)`);
    }
  }
  if (typeof w["n"] === "number" && w["n"] > 1) {
    throw invalid("n>1은 미지원 — v1 IR은 단일 후보 (G2, 부록 (a) §8)");
  }

  const messages: Message[] = [];
  const rawMessages = Array.isArray(w["messages"]) ? w["messages"] : [];
  rawMessages.forEach((raw, mi) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    const role = String(m["role"] ?? "");
    const path = `messages[${mi}]`;
    if (role === "system" || role === "developer") {
      // 빈 content는 메시지 자체를 생략 — user/assistant와 동일 규칙.
      // 생략하지 않으면 MessageSchema.blocks.min(1)에 걸려 OpenAI가 수용하는 요청이 400이 된다
      const blocks = contentToBlocks(m["content"], path);
      if (blocks.length === 0) return;
      messages.push({
        role: "system",
        blocks,
        ...(role === "developer" ? { providerOptions: { openai: { role: "developer" } } } : {}),
      });
      return;
    }
    if (role === "user") {
      const blocks = contentToBlocks(m["content"], path);
      if (blocks.length > 0) messages.push({ role: "user", blocks });
      return;
    }
    if (role === "assistant") {
      const restored = gatewayIrBlocks(m);
      if (restored) {
        const gw = m["gateway"] as Record<string, unknown>;
        const origin = gw["origin"];
        messages.push({
          role: "assistant",
          blocks: restored,
          ...(origin && typeof origin === "object" ? { origin: origin as Message["origin"] } : {}),
        });
        return;
      }
      const blocks: Block[] = [
        ...contentToBlocks(m["content"], path),
        ...(typeof m["refusal"] === "string" && m["refusal"].length > 0
          ? [{ type: "text", text: m["refusal"], providerMetadata: { openai: { refusal: true } } } as Block]
          : []),
        ...toolCallsToBlocks(m["tool_calls"], path, warnings),
      ];
      if (blocks.length > 0) messages.push({ role: "assistant", blocks });
      return;
    }
    if (role === "tool") {
      const contentBlocks = contentToBlocks(m["content"], path);
      const text = contentBlocks
        .map((b) => (b.type === "text" ? b.text : JSON.stringify(b)))
        .join("");
      messages.push({
        role: "tool",
        blocks: [
          {
            type: "toolResult",
            toolCallId: String(m["tool_call_id"] ?? ""),
            toolName: String(m["name"] ?? "tool"),
            output: { type: "text", text },
          },
        ],
      });
      return;
    }
    throw invalid(`${path}: 미지의 role '${role}'`);
  });

  const tools: Tool[] | undefined = Array.isArray(w["tools"])
    ? w["tools"].map((raw, i) => {
        const t = (raw ?? {}) as Record<string, unknown>;
        if (t["type"] !== "function") throw invalid(`tools[${i}]: CC 인바운드는 function 툴만`);
        const fn = (t["function"] ?? {}) as Record<string, unknown>;
        const name = String(fn["name"] ?? "");
        if (!name) throw invalid(`tools[${i}]: function.name 필요`);
        return {
          type: "function",
          name,
          ...(typeof fn["description"] === "string" ? { description: fn["description"] } : {}),
          inputSchema: (fn["parameters"] ?? { type: "object" }) as JSONObject,
          ...(typeof fn["strict"] === "boolean" ? { strict: fn["strict"] } : {}),
        };
      })
    : undefined;

  let toolChoice: IRRequest["toolChoice"];
  const tc = w["tool_choice"];
  if (tc === "auto" || tc === "required" || tc === "none") toolChoice = tc;
  else if (tc && typeof tc === "object") {
    const fn = ((tc as Record<string, unknown>)["function"] ?? {}) as Record<string, unknown>;
    if (typeof fn["name"] === "string") toolChoice = { type: "tool", toolName: fn["name"] };
  }

  let responseFormat: IRRequest["responseFormat"];
  const rf = w["response_format"];
  if (rf && typeof rf === "object") {
    const r = rf as Record<string, unknown>;
    if (r["type"] === "json_object") responseFormat = { type: "json" };
    else if (r["type"] === "json_schema") {
      const js = (r["json_schema"] ?? {}) as Record<string, unknown>;
      responseFormat = {
        type: "json",
        ...(typeof js["name"] === "string" ? { name: js["name"] } : {}),
        ...(typeof js["description"] === "string" ? { description: js["description"] } : {}),
        ...(js["schema"] !== undefined ? { schema: js["schema"] as JSONObject } : {}),
        ...(typeof js["strict"] === "boolean" ? { strict: js["strict"] } : {}),
      };
    } else if (r["type"] === "text") responseFormat = { type: "text" };
  }

  // CC 전용·고유 파라미터 → providerOptions.openai (아웃바운드 어댑터의 동일 키 — §3.1)
  const po: JSONObject = {};
  const poMap: Array<[string, string]> = [
    ["logit_bias", "logitBias"], ["logprobs", "logprobs"], ["top_logprobs", "topLogprobs"],
    ["prediction", "prediction"], ["audio", "audio"], ["modalities", "modalities"],
    ["web_search_options", "webSearchOptions"], ["service_tier", "serviceTier"],
    ["store", "store"], ["metadata", "metadata"], ["prompt_cache_key", "promptCacheKey"],
    ["safety_identifier", "safetyIdentifier"],
  ];
  for (const [wireKey, poKey] of poMap) {
    if (w[wireKey] !== undefined) po[poKey] = w[wireKey] as JSONValue;
  }

  const ir: JSONObject = {
    version: "0",
    model: String(w["model"] ?? ""),
    messages: messages as unknown as JSONValue,
  };
  if (tools) ir["tools"] = tools as unknown as JSONValue;
  if (toolChoice !== undefined) ir["toolChoice"] = toolChoice as JSONValue;
  if (typeof w["parallel_tool_calls"] === "boolean") ir["parallelToolCalls"] = w["parallel_tool_calls"];
  const maxTokens = w["max_completion_tokens"] ?? w["max_tokens"];
  if (typeof maxTokens === "number") ir["maxOutputTokens"] = maxTokens;
  for (const [wireKey, irKey] of [
    ["temperature", "temperature"], ["top_p", "topP"], ["seed", "seed"],
    ["presence_penalty", "presencePenalty"], ["frequency_penalty", "frequencyPenalty"],
  ] as const) {
    if (typeof w[wireKey] === "number") ir[irKey] = w[wireKey];
  }
  if (Array.isArray(w["stop"])) ir["stopSequences"] = w["stop"] as JSONValue;
  else if (typeof w["stop"] === "string") ir["stopSequences"] = [w["stop"]];
  if (responseFormat) ir["responseFormat"] = responseFormat as JSONValue;
  if (typeof w["reasoning_effort"] === "string") ir["reasoning"] = { effort: w["reasoning_effort"] };
  if (typeof w["user"] === "string") ir["metadata"] = { userId: w["user"] };
  if (w["stream"] === true) ir["stream"] = true;
  if (Object.keys(po).length > 0) ir["providerOptions"] = { openai: po };
  if (allowUnknown) ir["allowUnknownProviderOptions"] = true;

  const parsed = IRRequestSchema.safeParse(ir);
  if (!parsed.success) {
    throw invalid(`IR 변환 실패: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { request: parsed.data, warnings };
}
