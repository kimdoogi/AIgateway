import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { Citation } from "../../ir/common.js";
import type { IRError } from "../../ir/error.js";
import type { FinishReason } from "../../ir/finish.js";
import type { IRResponse } from "../../ir/response.js";
import type { Usage } from "../../ir/usage.js";

// IRResponse → anthropic-compat Messages 응답 (부록 (a) §4.2/§5/§6.2).
// origin.provider가 anthropic이면 raw 값 우선 복원 (무손실 — §0-2).

export function toMessagesStopReason(fr: FinishReason, originIsAnthropic: boolean): { stop_reason: string; raw?: string } {
  if (originIsAnthropic && fr.raw.length > 0) return { stop_reason: fr.raw }; // raw 우선 (stop_sequence 등 보존)
  switch (fr.unified) {
    case "stop": return { stop_reason: "end_turn" };
    case "length": return { stop_reason: "max_tokens" };
    case "tool_call": return { stop_reason: "tool_use" };
    case "refusal": return { stop_reason: "refusal" };
    case "paused": return { stop_reason: "pause_turn" };
    default: return { stop_reason: "end_turn", raw: fr.raw };
  }
}

export function toMessagesUsage(usage: Usage, originIsAnthropic: boolean): JSONObject {
  // 원문 우선 복원 (§0-2, 리뷰 G3) — cache_creation TTL 내역(5m/1h) 등 정규화 밖 필드 보존.
  // raw 형태 2종: 비스트림 = wire usage 원문 / 스트림 = {message_start, message_delta} 합성 (§8)
  if (originIsAnthropic && usage.raw && typeof usage.raw === "object" && !Array.isArray(usage.raw)) {
    const raw = usage.raw as JSONObject;
    if (typeof raw["input_tokens"] === "number") return raw;
    const start = raw["message_start"];
    const delta = raw["message_delta"];
    if (start || delta) {
      return {
        ...(start && typeof start === "object" ? (start as JSONObject) : {}),
        ...(delta && typeof delta === "object" ? (delta as JSONObject) : {}),
      };
    }
  }
  return {
    input_tokens: usage.input.noCache,
    cache_creation_input_tokens: usage.input.cacheWrite,
    cache_read_input_tokens: usage.input.cacheRead,
    output_tokens: usage.output.total,
  };
}

function citationToWire(c: Citation): JSONObject {
  const wire: JSONObject = {};
  if (c.source.type === "url") {
    wire["type"] = "web_search_result_location";
    if (c.source.url) wire["url"] = c.source.url;
    if (c.source.title) wire["title"] = c.source.title;
  } else {
    const locType = c.location?.type;
    wire["type"] =
      locType === "page" ? "page_location" : locType === "block" ? "content_block_location" : "char_location";
    if (c.source.title) wire["document_title"] = c.source.title;
    if (c.source.documentIndex !== undefined) wire["document_index"] = c.source.documentIndex;
    if (c.location) {
      const [startKey, endKey] =
        locType === "page"
          ? ["start_page_number", "end_page_number"]
          : locType === "block"
            ? ["start_block_index", "end_block_index"]
            : ["start_char_index", "end_char_index"];
      wire[startKey!] = c.location.start;
      wire[endKey!] = c.location.end;
    }
  }
  if (c.citedText) wire["cited_text"] = c.citedText;
  return wire;
}

/** IR 블록 → anthropic-compat wire 블록. 표현 없는 블록은 null (드롭 — gateway.origin이 보완) */
export function blockToWire(block: Block): JSONObject | null {
  switch (block.type) {
    case "text": {
      const wire: JSONObject = { type: "text", text: block.text };
      if (block.citations && block.citations.length > 0) wire["citations"] = block.citations.map(citationToWire);
      return wire;
    }
    case "reasoning": {
      if (block.redacted) {
        return { type: "redacted_thinking", data: block.opaqueState?.data ?? "" };
      }
      const wire: JSONObject = { type: "thinking", thinking: block.text };
      // 서명은 anthropic 산일 때만 wire 슬롯에 — 타사 opaque는 gateway 확장으로만 (§2.2)
      if (block.opaqueState?.provider === "anthropic") wire["signature"] = block.opaqueState.data;
      return wire;
    }
    case "toolCall": {
      if (block.providerExecuted) {
        const wireType = block.providerMetadata?.["anthropic"]?.["wireType"];
        return {
          type: typeof wireType === "string" ? wireType : "server_tool_use",
          id: block.toolCallId,
          name: block.toolName,
          input: block.input.type === "json" ? block.input.value : block.input.text,
        };
      }
      return {
        type: "tool_use",
        id: block.toolCallId,
        name: block.toolName,
        input: block.input.type === "json" ? block.input.value : block.input.text,
      };
    }
    case "toolResult": {
      const wireType = block.providerMetadata?.["anthropic"]?.["wireType"];
      return {
        type: typeof wireType === "string" ? wireType : "tool_result",
        tool_use_id: block.toolCallId,
        content: block.output.type === "json" ? block.output.value : JSON.stringify(block.output),
      };
    }
    case "custom":
      if (block.kind.startsWith("anthropic.")) return block.payload as JSONObject;
      return null;
    case "passthrough":
      if (block.provider === "anthropic") return block.raw as JSONObject;
      return null;
    case "file":
    case "source":
      return null; // Messages 응답 wire에 대응 없음
  }
}

export function toMessagesResponse(response: IRResponse, strict: boolean): JSONObject {
  const origin = response.message.origin;
  const { stop_reason, raw } = toMessagesStopReason(response.finishReason, origin.provider === "anthropic");
  const content = response.message.blocks.map(blockToWire).filter((b): b is JSONObject => b !== null);
  const gateway: JSONObject = {};
  if (!strict) {
    gateway["origin"] = origin as unknown as JSONValue;
    // D5 — 드롭·클램프 보고가 출구에서 소멸하면 조용한 변조가 된다 (리뷰 G2)
    if (response.warnings.length > 0) gateway["warnings"] = response.warnings as unknown as JSONValue;
  }
  if (raw !== undefined) gateway["finish_reason_raw"] = raw;
  // container 복원 (부록 (a) §2.2 — 샌드박스 재사용 계약. §14 커버리지)
  const container = response.providerMetadata?.["anthropic"]?.["container"];
  // stop_sequence 복원 — raw stop_reason:"stop_sequence"를 내보내면서 짝 필드가 null인
  // 자기모순 wire 방지 (감사 #28 — 어댑터가 PM anthropic.stopSequence로 보존)
  const stopSeq = response.providerMetadata?.["anthropic"]?.["stopSequence"];
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: response.model.resolved.model,
    content,
    stop_reason,
    stop_sequence: typeof stopSeq === "string" ? stopSeq : null,
    ...(container !== undefined ? { container } : {}),
    usage: toMessagesUsage(response.usage, origin.provider === "anthropic"),
    ...(Object.keys(gateway).length > 0 ? { gateway } : {}),
  };
}

/** IRError → anthropic-compat 에러 body (§7) */
export function toMessagesError(error: IRError): JSONObject {
  const type =
    error.category === "invalid_request" || error.category === "not_found" ? "invalid_request_error"
    : error.category === "auth" ? "authentication_error"
    : error.category === "permission" ? "permission_error"
    : error.category === "rate_limit" || error.category === "quota_exhausted" ? "rate_limit_error"
    : error.category === "content_too_large" ? "request_too_large"
    : error.category === "overloaded" ? "overloaded_error"
    : "api_error";
  return { type: "error", error: { type, message: error.message } };
}
