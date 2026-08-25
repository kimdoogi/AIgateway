import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { NS, Warning } from "../../ir/common.js";
import type { StreamEvent } from "../../ir/stream.js";
import { chatRawEligible, toChatError, toChatFinishReason, toChatUsage } from "./response.js";
import { makeWarning } from "../../adapters/shared.js";

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
  const warnings: Warning[] = []; // D5 — finish의 gateway chunk로 일괄 전달 (리뷰 G2)
  let providerMetadata: NS | undefined; // container 등 응답 레벨 PM (리뷰 G4)
  // 표면 sticky 복원 근거 (§13.4-1) — 비스트림 toChatResponse와 대칭 (감사 #7)
  let origin: { provider: string; model: string; surface?: string } | undefined;

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
        warnings.push(...event.warnings);
        return [];
      case "response-metadata": {
        if (event.providerMetadata) providerMetadata = { ...providerMetadata, ...event.providerMetadata };
        id = event.id;
        model = event.model.resolved.model;
        origin = event.model.resolved;
        created = Math.floor(Date.parse(event.created) / 1000);
        if (roleSent) return [];
        roleSent = true;
        return [deltaChunk({ role: "assistant" })];
      }
      case "text-start":
        // 델타 0회 text 블록(Gemini 빈 text + thoughtSignature 패턴)도 블록 생성 —
        // 없으면 text-end의 opaqueState/PM이 조용히 유실된다 (감사 #9)
        acc(event.id, () => ({ type: "text", text: "", id: event.id }));
        return [];
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
      case "warning":
        warnings.push(event.warning);
        return [];
      case "provider-switched":
        // 폴백 전환은 CC wire에 슬롯이 없다 — finish의 gateway.warnings로 보고 (D5 조용한 변조 금지)
        warnings.push(
          makeWarning(
            "other",
            "fallback-target-switched",
            `폴백 전환 ${event.from.model} → ${event.to.model} (${event.reason})`,
          ),
        );
        return [{ data: "", comment: `provider-switched: ${event.from.model} -> ${event.to.model}` }];
      case "usage-interim":
      case "raw":
        return [];
      case "finish": {
        // §0-2 raw 복원 자격 — 비스트림 toChatResponse와 동일 규칙 (감사 #18)
        const rawEligible = chatRawEligible(origin);
        const { finish_reason, raw } = toChatFinishReason(event.finishReason, rawEligible);
        const frames: ChatSSEFrame[] = [
          deltaChunk({}, finish_reason),
          chunk({ choices: [], usage: toChatUsage(event.usage, rawEligible) }),
        ];
        if (event.providerMetadata) providerMetadata = { ...providerMetadata, ...event.providerMetadata };
        if (!strict) {
          // §13.4-1: gateway.ir = origin 포함 블록 원문. 델타 조립 블록은 origin 부착 (감사 #7)
          const ir = order
            .map((k) => blocks.get(k))
            .filter((b): b is Block => b !== undefined)
            .map((b) => (b.origin === undefined && origin !== undefined ? { ...b, origin } : b));
          frames.push(chunk({
            gateway: {
              ir: ir as unknown as JSONValue,
              ...(origin ? { origin: origin as unknown as JSONValue } : {}), // 비스트림 대칭 (§2.1)
              ...(raw ? { finish_reason_raw: raw } : {}),
              ...(warnings.length > 0 ? { warnings: warnings as unknown as JSONValue } : {}),
              ...(providerMetadata ? { providerMetadata: providerMetadata as unknown as JSONValue } : {}),
            },
          }));
        } else if (raw) {
          // strict에서도 raw 병기 — 비스트림(toChatResponse)·anthropic-compat 스트림과 동일
          // (§4.1 'paused/tool_error → raw 병기'. 감사 #27: 3경로 모순 해소)
          frames.push(chunk({ gateway: { finish_reason_raw: raw } }));
        }
        frames.push({ data: "[DONE]" });
        return frames;
      }
      case "error-partial":
        // willRetry:true는 논리적 터미널이 아니다 — 폴백 트리가 다음 타깃으로 이어간다 (ir-v0 §6.4).
        // 여기서 [DONE]을 내보내면 SDK가 스트림을 끊어 폴백 성공분이 통째로 유실된다.
        if (event.willRetry) return [{ data: "", comment: `retrying: ${event.error.category}` }];
        return [{ data: JSON.stringify(toChatError(event.error)) }, { data: "[DONE]" }];
      case "error-final":
        return [{ data: JSON.stringify(toChatError(event.error)) }, { data: "[DONE]" }];
      default:
        return []; // 미래 이벤트 타입 — CC 무표현 (개방형)
    }
  };
}
