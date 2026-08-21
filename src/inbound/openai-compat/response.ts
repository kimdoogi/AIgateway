import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { IRError } from "../../ir/error.js";
import type { FinishReason } from "../../ir/finish.js";
import type { IRResponse } from "../../ir/response.js";
import type { Usage } from "../../ir/usage.js";

// IRResponse → openai-compat CC 응답 (부록 (a) §4.1/§5). gateway 확장(§2.1)은 strict 모드 제외.

/** unified → CC finish_reason (§4.1). 대응 없는 값은 stop + raw 병기 */
export function toChatFinishReason(fr: FinishReason): { finish_reason: string; raw?: string } {
  switch (fr.unified) {
    case "stop": return { finish_reason: "stop" };
    case "length": return { finish_reason: "length" };
    case "tool_call": return { finish_reason: "tool_calls" };
    case "content_filter": return { finish_reason: "content_filter" };
    case "refusal": return { finish_reason: "stop", raw: fr.raw };
    case "paused": return { finish_reason: "paused", raw: fr.raw }; // 비표준 노출 (ir-v0 §9)
    default: return { finish_reason: "stop", raw: fr.raw };
  }
}

export function toChatUsage(usage: Usage): JSONObject {
  return {
    prompt_tokens: usage.input.total,
    completion_tokens: usage.output.total,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.input.cacheRead },
    completion_tokens_details: { reasoning_tokens: usage.output.reasoning },
  };
}

/** IR 블록 → CC message 필드 (content/refusal/tool_calls). 표현 없는 블록은 gateway.ir로만 */
export function blocksToChatMessage(blocks: readonly Block[]): JSONObject {
  const textParts: string[] = [];
  const refusalParts: string[] = [];
  const toolCalls: JSONObject[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      if (b.providerMetadata?.["openai"]?.["refusal"] === true) refusalParts.push(b.text);
      else textParts.push(b.text);
    } else if (b.type === "toolCall" && !b.providerExecuted) {
      toolCalls.push({
        id: b.toolCallId,
        type: "function",
        function: {
          name: b.toolName,
          arguments: b.input.type === "json" ? JSON.stringify(b.input.value) : b.input.text,
        },
      });
    }
    // reasoning/file/source/custom/passthrough — CC 무표현, gateway.ir이 보존 (§6.1)
  }
  const message: JSONObject = { role: "assistant", content: textParts.length > 0 ? textParts.join("") : null };
  if (refusalParts.length > 0) message["refusal"] = refusalParts.join("");
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  return message;
}

export function toChatResponse(response: IRResponse, strict: boolean): JSONObject {
  const { finish_reason, raw } = toChatFinishReason(response.finishReason);
  const message = blocksToChatMessage(response.message.blocks);
  const gateway: JSONObject = {};
  if (!strict) {
    gateway["ir"] = response.message.blocks as unknown as JSONValue;
    gateway["origin"] = response.message.origin as unknown as JSONValue;
    // D5 — 드롭 보고 소멸 금지 (리뷰 G2). container 등 응답 레벨 PM도 CC엔 자리가 없어 여기로 (리뷰 G4)
    if (response.warnings.length > 0) gateway["warnings"] = response.warnings as unknown as JSONValue;
    if (response.providerMetadata) gateway["providerMetadata"] = response.providerMetadata as unknown as JSONValue;
  }
  if (raw !== undefined) gateway["finish_reason_raw"] = raw;
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.parse(response.created) / 1000),
    model: response.model.resolved.model,
    choices: [{ index: 0, message, finish_reason }],
    usage: toChatUsage(response.usage),
    ...(Object.keys(gateway).length > 0 ? { gateway } : {}),
  };
}

/** IRError → CC 에러 body (§7) */
export function toChatError(error: IRError): JSONObject {
  const type =
    error.category === "invalid_request" || error.category === "not_found" ? "invalid_request_error"
    : error.category === "auth" ? "authentication_error"
    : error.category === "permission" ? "permission_error"
    : error.category === "rate_limit" ? "rate_limit_error"
    : error.category === "quota_exhausted" ? "insufficient_quota"
    : "server_error";
  return { error: { message: error.message, type, code: error.provider?.code ?? null } };
}
