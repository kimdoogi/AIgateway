import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Warning } from "../../ir/common.js";
import type { StreamEvent } from "../../ir/stream.js";
import { blockToWire, toMessagesError, toMessagesStopReason, toMessagesUsage } from "./response.js";
import { makeWarning } from "../../adapters/shared.js";

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
  // §2.2: 비-anthropic origin reasoning 복원 판단 근거 — 비스트림 toMessagesResponse와 대칭 (감사 #8/#19)
  let origin: { provider: string; model: string; surface?: string } | undefined;
  // D5 — warning은 wire에 자리가 없어 finish의 gateway 확장으로 일괄 전달 (리뷰 G2)
  const warnings: Warning[] = [];

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
        warnings.push(...event.warnings);
        return [];
      case "response-metadata": {
        requestId = event.id;
        model = event.model.resolved.model;
        originProvider = event.model.resolved.provider;
        origin = event.model.resolved;
        if (started) return [];
        started = true;
        const container = event.providerMetadata?.["anthropic"]?.["container"];
        // input·cache 토큰은 wire 계약상 message_start가 유일한 소스 — 스텁 0을 보내면
        // 소비자(SDK·과금 집계)의 input이 0이 된다. PM 원문 우선 (2026-08-21 실테스트 검출)
        const startUsage = event.providerMetadata?.["anthropic"]?.["usage"];
        return [
          frame("message_start", {
            message: {
              id: requestId, type: "message", role: "assistant", model, content: [],
              stop_reason: null, stop_sequence: null,
              ...(container !== undefined ? { container } : {}),
              usage: startUsage ?? { input_tokens: 0, output_tokens: 0 }, // 비 anthropic origin은 스텁 (최종은 message_delta)
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
      case "warning":
        warnings.push(event.warning); // 소멸 금지 — finish gateway 확장으로 (리뷰 G2)
        return [];
      case "provider-switched":
        // Messages wire에 전환 슬롯이 없다 — finish의 gateway.warnings로 보고 (D5)
        warnings.push(
          makeWarning(
            "other",
            "fallback-target-switched",
            `폴백 전환 ${event.from.model} → ${event.to.model} (${event.reason})`,
          ),
        );
        return [frame("ping", {})]; // 연결 유지 — 전환 대기 동안 유휴 타임아웃 방지
      case "file":
      case "source":
      case "usage-interim":
      case "raw":
        return [];
      case "heartbeat":
        return [frame("ping", {})];
      case "finish": {
        const { stop_reason, raw } = toMessagesStopReason(event.finishReason, originProvider === "anthropic");
        const deltaBody: JSONObject = {
          delta: { stop_reason, stop_sequence: null },
          usage: toMessagesUsage(event.usage, originProvider === "anthropic"),
        };
        // 턴 중 생성·교체된 container — SDK가 message_delta에서도 읽는다 (리뷰 G1)
        const container = event.providerMetadata?.["anthropic"]?.["container"];
        if (container !== undefined) deltaBody["container"] = container;
        const gateway: JSONObject = {};
        if (!strict && origin !== undefined) gateway["origin"] = origin as unknown as JSONValue; // 비스트림 대칭 (§2.2)
        if (raw !== undefined) gateway["finish_reason_raw"] = raw;
        if (!strict && warnings.length > 0) gateway["warnings"] = warnings as unknown as JSONValue;
        if (Object.keys(gateway).length > 0) deltaBody["gateway"] = gateway;
        return [frame("message_delta", deltaBody), frame("message_stop", {})];
      }
      case "error-partial":
        // willRetry:true는 터미널이 아니다 (ir-v0 §6.4) — error 이벤트를 내면 SDK가 턴을 실패로 끝낸다
        if (event.willRetry) return [];
        return [frame("error", { error: (toMessagesError(event.error)["error"] ?? {}) as JSONObject })];
      case "error-final":
        return [frame("error", { error: (toMessagesError(event.error)["error"] ?? {}) as JSONObject })];
      default:
        return [];
    }
  };
}
