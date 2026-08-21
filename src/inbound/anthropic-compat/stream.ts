import type { JSONObject } from "../../ir/json.js";
import type { StreamEvent } from "../../ir/stream.js";
import { blockToWire, toMessagesError, toMessagesStopReason, toMessagesUsage } from "./response.js";

// IR 스트림 → anthropic-compat SSE 재합성 (부록 (a) §6.2).
// 블록 인덱스: IR 블록 id 등장 순서대로 0부터 재부여 (Anthropic wire는 index 기반).

export interface MessagesSSEFrame {
  event: string;
  data: string;
}

export function createMessagesDownconverter(strict: boolean): (event: StreamEvent) => MessagesSSEFrame[] {
  const blockIndex = new Map<string, number>();
  let nextIndex = 0;
  let started = false;
  let requestId = "";
  let model = "";
  let originProvider = "";

  const frame = (event: string, data: JSONObject): MessagesSSEFrame => ({ event, data: JSON.stringify({ type: event, ...data }) });
  const indexOf = (id: string): number => {
    let i = blockIndex.get(id);
    if (i === undefined) {
      i = nextIndex++;
      blockIndex.set(id, i);
    }
    return i;
  };

  return (event: StreamEvent): MessagesSSEFrame[] => {
    switch (event.type) {
      case "stream-start":
        return [];
      case "response-metadata": {
        requestId = event.id;
        model = event.model.resolved.model;
        originProvider = event.model.resolved.provider;
        if (started) return [];
        started = true;
        return [
          frame("message_start", {
            message: {
              id: requestId, type: "message", role: "assistant", model, content: [],
              stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 }, // 최종 usage는 message_delta (§6.2)
            },
          }),
        ];
      }
      case "text-start":
        return [frame("content_block_start", { index: indexOf(event.id), content_block: { type: "text", text: "" } })];
      case "text-delta":
        return [frame("content_block_delta", { index: indexOf(event.id), delta: { type: "text_delta", text: event.delta } })];
      case "text-end":
        return [frame("content_block_stop", { index: indexOf(event.id) })];
      case "reasoning-start":
        return [
          frame("content_block_start", {
            index: indexOf(event.id),
            content_block: event.redacted ? { type: "redacted_thinking", data: "" } : { type: "thinking", thinking: "" },
          }),
        ];
      case "reasoning-delta": {
        const frames: MessagesSSEFrame[] = [];
        const index = indexOf(event.id);
        if (event.delta !== undefined && event.delta.length > 0) {
          frames.push(frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: event.delta } }));
        }
        // anthropic 산 서명만 wire 슬롯으로 — 타사 opaque는 compat wire에 자리 없음 (§2.2)
        if (event.opaqueState?.provider === "anthropic") {
          frames.push(frame("content_block_delta", { index, delta: { type: "signature_delta", signature: event.opaqueState.data } }));
        }
        return frames;
      }
      case "reasoning-end":
        return [frame("content_block_stop", { index: indexOf(event.id) })];
      case "tool-input-start":
        return [
          frame("content_block_start", {
            index: indexOf(event.id),
            content_block: {
              type: event.providerExecuted ? "server_tool_use" : "tool_use",
              id: event.toolCallId, name: event.toolName, input: {},
            },
          }),
        ];
      case "tool-input-delta":
        return [frame("content_block_delta", { index: indexOf(event.id), delta: { type: "input_json_delta", partial_json: event.delta } })];
      case "tool-input-end":
        return [frame("content_block_stop", { index: indexOf(event.id) })];
      case "tool-call":
        return []; // start/delta/stop으로 재현 완료 — 완성본 재방출은 compat wire에 없음
      case "citation-delta":
        return [
          frame("content_block_delta", {
            index: indexOf(event.id),
            delta: { type: "citations_delta", citation: { cited_text: event.citation.citedText ?? "" } },
          }),
        ];
      case "tool-result":
      case "custom":
      case "passthrough": {
        // anthropic 원문 복원 가능하면 블록으로, 아니면 드롭 (§6.2)
        const wire = blockToWire(event.block);
        if (!wire) return [];
        const id = event.block.id ?? `restored_${nextIndex}`;
        const index = indexOf(id);
        return [
          frame("content_block_start", { index, content_block: wire }),
          frame("content_block_stop", { index }),
        ];
      }
      case "file":
      case "source":
      case "usage-interim":
      case "warning":
      case "provider-switched":
      case "raw":
        return [];
      case "heartbeat":
        return [frame("ping", {})];
      case "finish": {
        const { stop_reason, raw } = toMessagesStopReason(event.finishReason, originProvider === "anthropic");
        const deltaBody: JSONObject = {
          delta: { stop_reason, stop_sequence: null },
          usage: toMessagesUsage(event.usage),
        };
        if (!strict && raw !== undefined) deltaBody["gateway"] = { finish_reason_raw: raw };
        return [frame("message_delta", deltaBody), frame("message_stop", {})];
      }
      case "error-partial":
      case "error-final":
        return [frame("error", { error: (toMessagesError(event.error)["error"] ?? {}) as JSONObject })];
      default:
        return [];
    }
  };
}
