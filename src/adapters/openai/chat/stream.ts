import type { JSONValue } from "../../../ir/json.js";
import type { Origin } from "../../../ir/common.js";
import type { Usage } from "../../../ir/usage.js";
import type { AdapterStreamEvent, StreamContext, StreamTransformer } from "../../types.js";
import { makeWarning } from "../../shared.js";
import { convertUsage, mapChatFinishReason, mapInStreamError, streamTruncationError, type OpenAIWireUsage } from "../errors.js";
import { parseToolArguments } from "../responses/response.js";
import { SURFACE } from "./response.js";

// OpenAI Chat Completions 스트림 (chat.completion.chunk) → IR draft.
// 단일 이벤트 타입 — delta 필드로 판별. 툴콜 arguments 파편은 어댑터가 조립 (인벤토리 §D).
// 종료: data "[DONE]" 프레임. usage는 stream_options.include_usage로 마지막 chunk에.

interface OpenTool {
  irId: string;
  toolCallId: string;
  toolName: string;
  argsAcc: string;
}

export function createStreamTransformer(ctx: StreamContext): StreamTransformer {
  let origin: Origin & { surface: string } = { provider: "openai", model: ctx.modelId, surface: SURFACE };
  let providerRequestId: string | undefined;
  let sawChunk = false;
  let metadataEmitted = false;
  let textOpen = false;
  let refusalOpen = false;
  const tools = new Map<number, OpenTool>(); // key: tool_calls[].index
  let finishReasonRaw: string | null = null;
  let usage: Usage | undefined;
  let terminalEmitted = false;
  const warnedUnknown = new Set<string>();

  const TEXT_ID = "blk_text";
  const REFUSAL_ID = "blk_refusal";
  const REASONING_ID = "blk_reasoning";
  let reasoningOpen = false;

  function warnOnce(kindKey: string, message: string, details?: JSONValue): AdapterStreamEvent[] {
    if (warnedUnknown.has(kindKey)) return [];
    warnedUnknown.add(kindKey);
    return [
      { type: "warning", warning: makeWarning("compatibility", "unknown-block-passthrough", message, undefined, details) },
    ];
  }

  /** 열린 블록 정리 + 툴콜 완성본 방출 — 터미널 직전 공통 */
  function closeBlocks(): AdapterStreamEvent[] {
    const out: AdapterStreamEvent[] = [];
    if (textOpen) {
      out.push({ type: "text-end", id: TEXT_ID });
      textOpen = false;
    }
    if (refusalOpen) {
      out.push({ type: "text-end", id: REFUSAL_ID, providerMetadata: { openai: { refusal: true } } });
      refusalOpen = false;
    }
    if (reasoningOpen) {
      out.push({ type: "reasoning-end", id: REASONING_ID });
      reasoningOpen = false;
    }
    for (const [, tool] of [...tools.entries()].sort(([a], [b]) => a - b)) {
      out.push({ type: "tool-input-end", id: tool.irId });
      const collected: import("../../../ir/common.js").Warning[] = [];
      const input = parseToolArguments(tool.argsAcc, tool.toolName, collected);
      for (const w of collected) out.push({ type: "warning", warning: w });
      out.push({
        type: "tool-call",
        block: {
          type: "toolCall",
          id: tool.irId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          input,
          origin,
        },
      });
    }
    tools.clear();
    return out;
  }

  return {
    framing: "sse",

    onEvent(_eventName, data): AdapterStreamEvent[] {
      if (terminalEmitted) return [];

      if (data.trim() === "[DONE]") {
        terminalEmitted = true;
        const out = closeBlocks();
        out.push({
          type: "finish",
          finishReason: mapChatFinishReason(finishReasonRaw),
          usage: usage ?? convertUsage(undefined),
        });
        return out;
      }

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return [
          {
            type: "warning",
            warning: makeWarning("compatibility", "unknown-block-passthrough", "파싱 불가 CC 청크 — 원문은 details에 보존", undefined, { data }),
          },
        ];
      }

      const out: AdapterStreamEvent[] = [];
      if (ctx.includeRaw) out.push({ type: "raw", provider: "openai", value: json as JSONValue });

      // HTTP 200 스트림 내 에러 (ir-v0 §12)
      if (json["error"] !== undefined) {
        terminalEmitted = true;
        out.push({ type: "provider-error", error: { ...mapInStreamError(json), billed: sawChunk } });
        return out;
      }

      sawChunk = true;
      if (!metadataEmitted) {
        metadataEmitted = true;
        const model = String(json["model"] ?? ctx.modelId);
        origin = { provider: "openai", model, surface: SURFACE };
        if (typeof json["id"] === "string" && json["id"].length > 0) providerRequestId = json["id"];
        out.push({
          type: "response-metadata",
          model: { resolved: origin },
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }

      const wireUsage = json["usage"];
      if (wireUsage && typeof wireUsage === "object") usage = convertUsage(wireUsage as OpenAIWireUsage);

      const choices = json["choices"];
      if (!Array.isArray(choices) || choices.length === 0) return out;
      const choice = (choices[0] ?? {}) as Record<string, unknown>;
      if (typeof choice["finish_reason"] === "string") finishReasonRaw = choice["finish_reason"];
      const delta = (choice["delta"] ?? {}) as Record<string, unknown>;

      const content = delta["content"];
      if (typeof content === "string" && content.length > 0) {
        if (!textOpen) {
          textOpen = true;
          out.push({ type: "text-start", id: TEXT_ID });
        }
        out.push({ type: "text-delta", id: TEXT_ID, delta: content });
      }

      // xAI CC 확장 (base 상속): reasoning 요약 delta. OpenAI CC는 미발행
      const reasoning = delta["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningOpen) {
          reasoningOpen = true;
          out.push({ type: "reasoning-start", id: REASONING_ID });
        }
        out.push({ type: "reasoning-delta", id: REASONING_ID, delta: reasoning });
      }

      const refusal = delta["refusal"];
      if (typeof refusal === "string" && refusal.length > 0) {
        if (!refusalOpen) {
          refusalOpen = true;
          out.push({ type: "text-start", id: REFUSAL_ID });
        }
        out.push({ type: "text-delta", id: REFUSAL_ID, delta: refusal });
      }

      const toolCalls = delta["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const raw of toolCalls) {
          const tc = (raw ?? {}) as Record<string, unknown>;
          const index = typeof tc["index"] === "number" ? tc["index"] : 0;
          const fn = (tc["function"] ?? {}) as Record<string, unknown>;
          let open = tools.get(index);
          if (!open) {
            const name = typeof fn["name"] === "string" ? fn["name"] : `tool_${index}`;
            const id = typeof tc["id"] === "string" && tc["id"].length > 0 ? tc["id"] : "";
            open = {
              irId: `blk_tool_${index}`,
              toolCallId: id.length > 0 ? id : `synth:openai:${providerRequestId ?? "unknown"}:${index}:${name}`,
              toolName: name,
              argsAcc: "",
            };
            tools.set(index, open);
            out.push({ type: "tool-input-start", id: open.irId, toolCallId: open.toolCallId, toolName: open.toolName });
          }
          const argDelta = fn["arguments"];
          if (typeof argDelta === "string" && argDelta.length > 0) {
            open.argsAcc += argDelta;
            out.push({ type: "tool-input-delta", id: open.irId, delta: argDelta });
          }
        }
      }

      // 미지 delta 필드 — 보존 + 1회 보고 (§10.2)
      for (const key of Object.keys(delta)) {
        if (key === "content" || key === "refusal" || key === "tool_calls" || key === "role" || key === "reasoning_content") continue;
        out.push(
          ...warnOnce(`delta:${key}`, `미지의 CC delta 필드 '${key}' — 원문 보존`),
          { type: "passthrough", block: { type: "passthrough", provider: "openai", raw: json as JSONValue, origin } },
        );
        break;
      }
      return out;
    },

    onStreamEnd(): AdapterStreamEvent[] {
      if (terminalEmitted) return [];
      terminalEmitted = true;
      // [DONE] 없는 절단 — finish_reason을 이미 받았으면 그것으로 종결, 아니면 절단 오류
      if (finishReasonRaw !== null) {
        const out = closeBlocks();
        out.push({
          type: "finish",
          finishReason: mapChatFinishReason(finishReasonRaw),
          usage: usage ?? convertUsage(undefined),
        });
        return out;
      }
      return [
        {
          type: "provider-error",
          error: { ...streamTruncationError(SURFACE), billed: sawChunk },
          ...(usage ? { usage } : {}),
        },
      ];
    },
  };
}
