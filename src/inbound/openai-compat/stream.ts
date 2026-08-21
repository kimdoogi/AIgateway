import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { StreamEvent } from "../../ir/stream.js";
import { toChatError, toChatFinishReason, toChatUsage } from "./response.js";

// IR 스트림 → CC chat.completion.chunk 재합성 (부록 (a) §6.1).
// 상태: 툴콜 index 부여 + gateway.ir용 블록 累積(비-strict). reasoning은 CC 무표현 — 드롭.

export interface ChatSSEFrame {
  data: string;
  /** SSE 주석 (heartbeat) — data 대신 방출 */
  comment?: string;
}

export function createChatDownconverter(strict: boolean): (event: StreamEvent) => ChatSSEFrame[] {
  let id = "";
  let model = "";
  let created = 0;
  let roleSent = false;
  const toolIndex = new Map<string, number>(); // IR 블록 id → CC tool_calls index
  // gateway.ir 조립 — 텍스트/추론은 delta 누적, 완성본 이벤트(tool-call 등)는 그대로
  const blocks = new Map<string, Block>();
  const order: string[] = [];

  const acc = (blockId: string, make: () => Block): Block => {
    let b = blocks.get(blockId);
    if (!b) {
      b = make();
      blocks.set(blockId, b);
      order.push(blockId);
    }
    return b;
  };

  const chunk = (payload: JSONObject): ChatSSEFrame => ({
    data: JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...payload }),
  });
  const deltaChunk = (delta: JSONObject, finish: string | null = null): ChatSSEFrame =>
    chunk({ choices: [{ index: 0, delta, finish_reason: finish }] });

  return (event: StreamEvent): ChatSSEFrame[] => {
    switch (event.type) {
      case "stream-start":
        return [];
      case "response-metadata": {
        id = event.id;
        model = event.model.resolved.model;
        created = Math.floor(Date.parse(event.created) / 1000);
        if (roleSent) return [];
        roleSent = true;
        return [deltaChunk({ role: "assistant" })];
      }
      case "text-delta": {
        const b = acc(event.id, () => ({ type: "text", text: "", id: event.id }));
        if (b.type === "text") b.text += event.delta;
        // refusal 강등 블록 여부는 end에서만 알 수 있다 — CC 스트림은 content로 방출 (v0 근사)
        return [deltaChunk({ content: event.delta })];
      }
      case "text-end": {
        const b = blocks.get(event.id);
        if (b && event.providerMetadata) b.providerMetadata = event.providerMetadata;
        if (b && event.opaqueState) b.opaqueState = event.opaqueState;
        return [];
      }
      case "reasoning-start":
        acc(event.id, () => ({ type: "reasoning", text: "", id: event.id, ...(event.redacted ? { redacted: true } : {}) }));
        return []; // §6.1 — CC 무표현, gateway.ir로만
      case "reasoning-delta": {
        const b = acc(event.id, () => ({ type: "reasoning", text: "", id: event.id }));
        if (b.type === "reasoning") {
          if (event.delta) b.text += event.delta;
          if (event.opaqueState) b.opaqueState = event.opaqueState;
          if (event.providerMetadata) b.providerMetadata = { ...b.providerMetadata, ...event.providerMetadata };
        }
        return [];
      }
      case "reasoning-end":
        return [];
      case "tool-input-start": {
        const index = toolIndex.size;
        toolIndex.set(event.id, index);
        return [
          deltaChunk({
            tool_calls: [{ index, id: event.toolCallId, type: "function", function: { name: event.toolName, arguments: "" } }],
          }),
        ];
      }
      case "tool-input-delta": {
        const index = toolIndex.get(event.id);
        if (index === undefined) return [];
        return [deltaChunk({ tool_calls: [{ index, function: { arguments: event.delta } }] })];
      }
      case "tool-input-end":
        return [];
      case "tool-call": {
        const key = event.block.id ?? `tool_${order.length}`;
        if (!blocks.has(key)) order.push(key);
        blocks.set(key, event.block); // 완성본이 delta 누적을 대체
        return []; // wire 재현은 delta로 완료 (§6.1)
      }
      case "tool-result":
      case "file":
      case "source":
      case "custom":
      case "passthrough": {
        const key = event.block.id ?? `blk_${order.length}`;
        blocks.set(key, event.block);
        if (!order.includes(key)) order.push(key);
        return [];
      }
      case "citation-delta":
        return []; // v0 드롭 — gateway.ir 텍스트 블록 citations는 비스트림 경로에서만 (§6.1)
      case "heartbeat":
        return [{ data: "", comment: "ping" }];
      case "usage-interim":
      case "warning":
      case "provider-switched":
      case "raw":
        return [];
      case "finish": {
        const { finish_reason, raw } = toChatFinishReason(event.finishReason);
        const frames: ChatSSEFrame[] = [
          deltaChunk({}, finish_reason),
          chunk({ choices: [], usage: toChatUsage(event.usage) }),
        ];
        if (!strict) {
          const ir = order.map((k) => blocks.get(k)).filter((b): b is Block => b !== undefined);
          frames.push(chunk({ gateway: { ir: ir as unknown as JSONValue, ...(raw ? { finish_reason_raw: raw } : {}) } }));
        }
        frames.push({ data: "[DONE]" });
        return frames;
      }
      case "error-partial":
      case "error-final":
        return [{ data: JSON.stringify(toChatError(event.error)) }, { data: "[DONE]" }];
      default:
        return []; // 미래 이벤트 타입 — CC 무표현 (개방형)
    }
  };
}
