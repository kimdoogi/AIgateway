import type { JSONValue } from "../../ir/json.js";
import type { Origin } from "../../ir/common.js";
import type { Usage } from "../../ir/usage.js";
import type { AdapterStreamEvent, StreamContext, StreamTransformer } from "../types.js";
import { makeWarning } from "../shared.js";
import { mapCitation } from "./response.js";
import {
  convertUsage,
  mapInStreamError,
  mapStopReason,
  streamTruncationError,
  type AnthropicWireUsage,
} from "./errors.js";

// Anthropic SSE → IR 스트림 이벤트 draft (ir-v0 §10, ADR-0005)
// 명시적 상태 머신 (D4). 계약: 터미널 이후 이벤트는 무시(§10.2), 미지 요소는 보존+보고(§4.9),
// 과금 발생 시도는 provider-error에 usage 동봉(리뷰 R2), 완성본 블록에는 origin 부착(리뷰 R8).

type OpenBlock =
  | { kind: "text"; irId: string }
  | { kind: "reasoning"; irId: string }
  | {
      kind: "tool";
      irId: string;
      toolCallId: string; // "" = 미발급 → stop 시 결정론적 합성 (G5)
      toolName: string;
      providerExecuted: boolean;
      wireType?: string;
      inputAcc: string;
      initialInput?: JSONValue;
    }
  | { kind: "unknown"; irId: string; wireType: string };

export function createStreamTransformer(ctx: StreamContext): StreamTransformer {
  const blocks = new Map<number, OpenBlock>();
  const usageAcc: AnthropicWireUsage = {};
  let rawStartUsage: JSONValue | undefined;
  let rawDeltaUsage: JSONValue | undefined;
  let stopReason: string | null | undefined;
  let providerRequestId: string | undefined;
  let origin: Origin = { provider: "anthropic", model: ctx.modelId, surface: "messages" };
  let sawMessageStart = false; // input 과금 발생 기준 (리뷰 R2 — billed)
  // container 추적 — message_start 외에 top-level·message_delta.delta로도 온다 (턴 중 생성·교체.
  // 리뷰 G1 — 후기 도착분은 response-metadata가 이미 나갔으므로 finish PM에 싣는다)
  let latestContainer: JSONValue | undefined;
  let stopDetails: JSONValue | undefined; // refusal category·explanation (감사 anthropic #3)
  let stopSequence: string | undefined; // 발동한 정지 시퀀스 (감사 #22)
  let terminalEmitted = false;
  const warnedUnknown = new Set<string>(); // 미지 타입별 warning 1회 (§10.2 스팸 방지)

  function currentUsage(): Usage {
    const usage = convertUsage(usageAcc);
    // §8 raw 취지 보존: 스트림은 usage가 분산 도착하므로 원문 payload들을 함께 보존
    usage.raw = {
      ...(rawStartUsage !== undefined ? { message_start: rawStartUsage } : {}),
      ...(rawDeltaUsage !== undefined ? { message_delta: rawDeltaUsage } : {}),
    };
    return usage;
  }

  function mergeUsage(wire: Record<string, unknown>): void {
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ] as const) {
      if (typeof wire[key] === "number") usageAcc[key] = wire[key];
    }
    // thinking_tokens 분해 — convertUsage가 reasoning으로 소비 (감사 anthropic #4)
    if (wire["output_tokens_details"] && typeof wire["output_tokens_details"] === "object") {
      usageAcc.output_tokens_details = wire["output_tokens_details"] as AnthropicWireUsage["output_tokens_details"];
    }
  }

  function warnOnce(kindKey: string, message: string, details?: JSONValue): AdapterStreamEvent[] {
    if (warnedUnknown.has(kindKey)) return [];
    warnedUnknown.add(kindKey);
    return [
      { type: "warning", warning: makeWarning("compatibility", "unknown-block-passthrough", message, undefined, details) },
    ];
  }

  function preserve(raw: JSONValue, rawUnit: "block" | "event" = "block"): AdapterStreamEvent {
    // rawUnit — compat 재합성 판별자 (§4.9): block=콘텐츠 블록 스냅샷, event=SSE 이벤트 전체 (감사 #43)
    return { type: "passthrough", block: { type: "passthrough", provider: "anthropic", raw, rawUnit, origin } };
  }

  /** 터미널 전 열린 블록 폐쇄 — gemini closeOpen과 동일 계약 (감사 #39: 어댑터 간 비대칭이었다) */
  function closeOpenBlocks(out: AdapterStreamEvent[]): void {
    for (const open of blocks.values()) {
      if (open.kind === "text") out.push({ type: "text-end", id: open.irId });
      else if (open.kind === "reasoning") out.push({ type: "reasoning-end", id: open.irId });
      else if (open.kind === "tool") out.push({ type: "tool-input-end", id: open.irId });
      // unknown: 보존은 start/delta에서 완료 — 폐쇄 이벤트 없음
    }
    blocks.clear();
  }

  function synthId(index: number, toolName: string): string {
    return `synth:anthropic:${providerRequestId ?? "unknown"}:${index}:${toolName}`;
  }

  return {
    framing: "sse",

    onEvent(eventName, data): AdapterStreamEvent[] {
      if (terminalEmitted) return []; // §10.2 — 터미널 이후 프로바이더 이벤트 무시 (리뷰 R10)
      if (eventName === "ping") return [];

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 비정형 청크 — 원문을 details에 보존하며 보고 (§5 코드 의미론, 리뷰 R10b)
        return [
          {
            type: "warning",
            warning: makeWarning(
              "compatibility",
              "unknown-block-passthrough",
              `파싱 불가 SSE 청크 (event: ${eventName ?? "?"}) — 원문은 details에 보존`,
              undefined,
              { data },
            ),
          },
        ];
      }

      const out: AdapterStreamEvent[] = [];
      if (ctx.includeRaw) out.push({ type: "raw", provider: "anthropic", value: json as JSONValue });
      const type = (json["type"] as string | undefined) ?? eventName;

      switch (type) {
        case "message_start": {
          const message = (json["message"] ?? {}) as Record<string, unknown>;
          sawMessageStart = true;
          const wireUsage = (message["usage"] ?? {}) as Record<string, unknown>;
          mergeUsage(wireUsage);
          rawStartUsage = wireUsage as JSONValue;
          const model = String(message["model"] ?? ctx.modelId);
          origin = { provider: "anthropic", model, surface: "messages" };
          const id = message["id"];
          if (typeof id === "string" && id.length > 0) providerRequestId = id;
          const container = message["container"];
          if (container && typeof container === "object") latestContainer = container as JSONValue;
          out.push({
            // draft enrich 계약(§13.1): id/created/model.requested는 게이트웨이 부여 (리뷰 A4)
            type: "response-metadata",
            model: { resolved: { provider: "anthropic", model, surface: "messages" } },
            ...(providerRequestId ? { providerRequestId } : {}),
            // §10.1 PM — wire 선두에서만 얻는 것들: container(샌드박스 재사용) +
            // message_start usage 원문 (compat 재합성에서 input·cache 토큰의 유일한 소스 —
            // 스텁 0이면 소비자 과금 집계가 0이 된다. 2026-08-21 neuro 실테스트 검출)
            providerMetadata: {
              anthropic: {
                usage: wireUsage as JSONValue,
                ...(container && typeof container === "object" ? { container: container as JSONValue } : {}),
              },
            },
          });
          return out;
        }

        case "content_block_start": {
          const index = Number(json["index"] ?? 0);
          const cb = (json["content_block"] ?? {}) as Record<string, unknown>;
          const cbType = cb["type"] as string | undefined;
          const irId = `blk_${index}`;
          if (cbType === "text" || cbType === "thinking") {
            const kind = cbType === "text" ? "text" : "reasoning";
            blocks.set(index, { kind, irId });
            out.push(kind === "text" ? { type: "text-start", id: irId } : { type: "reasoning-start", id: irId });
            // 초기 스냅샷 유실 방지 (리뷰 P3): non-empty 초기값은 delta로 재현
            const initial = String(cb[cbType === "text" ? "text" : "thinking"] ?? "");
            if (initial.length > 0) {
              out.push(
                kind === "text"
                  ? { type: "text-delta", id: irId, delta: initial }
                  : { type: "reasoning-delta", id: irId, delta: initial },
              );
            }
            return out;
          }
          if (cbType === "redacted_thinking") {
            blocks.set(index, { kind: "reasoning", irId });
            out.push(
              { type: "reasoning-start", id: irId, redacted: true },
              {
                type: "reasoning-delta",
                id: irId,
                opaqueState: { provider: "anthropic", data: String(cb["data"] ?? "") },
              },
            );
            return out;
          }
          if (cbType === "tool_use" || cbType === "server_tool_use" || cbType === "mcp_tool_use") {
            const name = typeof cb["name"] === "string" && cb["name"].length > 0 ? cb["name"] : undefined;
            if (!name) {
              // name 없는 tool_use는 비정형 — 보존 + 보고 (합성 금지)
              blocks.set(index, { kind: "unknown", irId, wireType: String(cbType) });
              out.push(...warnOnce(`malformed:${cbType}`, `name 없는 ${cbType} 블록 — passthrough 보존`), preserve(cb as JSONValue));
              return out;
            }
            const rawId = typeof cb["id"] === "string" && cb["id"].length > 0 ? cb["id"] : "";
            const open: OpenBlock = {
              kind: "tool",
              irId,
              toolCallId: rawId, // "" → stop 시 합성 (P1)
              toolName: name,
              providerExecuted: cbType !== "tool_use",
              ...(cbType !== "tool_use" ? { wireType: cbType } : {}),
              inputAcc: "",
              initialInput: (cb["input"] ?? undefined) as JSONValue | undefined,
            };
            blocks.set(index, open);
            out.push({
              type: "tool-input-start",
              id: irId,
              toolCallId: rawId.length > 0 ? rawId : synthId(index, name),
              toolName: name,
              ...(open.providerExecuted ? { providerExecuted: true as const } : {}),
            });
            return out;
          }
          // 미지 블록 타입 — start 스냅샷 보존 + 추적 유지 (후속 delta도 보존 — §10.2, 리뷰 R7)
          blocks.set(index, { kind: "unknown", irId, wireType: String(cbType) });
          out.push(
            ...warnOnce(`block:${cbType}`, `미지의 스트림 블록 타입 '${String(cbType)}' — 원문 보존`),
            preserve(cb as JSONValue),
          );
          return out;
        }

        case "content_block_delta": {
          const index = Number(json["index"] ?? 0);
          const open = blocks.get(index);
          if (!open) return out;
          const delta = (json["delta"] ?? {}) as Record<string, unknown>;
          const dType = delta["type"] as string | undefined;

          if (open.kind === "unknown") {
            // 미지 블록의 후속 delta — 이벤트 원문 보존 (리뷰 R7)
            out.push(preserve(json as JSONValue, "event"));
            return out;
          }
          if (dType === "text_delta" && open.kind === "text") {
            out.push({ type: "text-delta", id: open.irId, delta: String(delta["text"] ?? "") });
            return out;
          }
          if (dType === "thinking_delta" && open.kind === "reasoning") {
            out.push({ type: "reasoning-delta", id: open.irId, delta: String(delta["thinking"] ?? "") });
            return out;
          }
          if (dType === "signature_delta" && open.kind === "reasoning") {
            // 내용 없는 delta에 opaqueState만 (ir-v0 §10.2 — signature_delta 패턴)
            out.push({
              type: "reasoning-delta",
              id: open.irId,
              opaqueState: { provider: "anthropic", data: String(delta["signature"] ?? "") },
            });
            return out;
          }
          if (dType === "input_json_delta" && open.kind === "tool") {
            const part = String(delta["partial_json"] ?? "");
            open.inputAcc += part;
            out.push({ type: "tool-input-delta", id: open.irId, delta: part });
            return out;
          }
          if (dType === "citations_delta" && open.kind === "text") {
            const raw = (delta["citation"] ?? {}) as Record<string, unknown>;
            // 스트림/비스트림 동일 매핑 (리뷰 P5 — mapCitation 재사용)
            out.push({ type: "citation-delta", id: open.irId, citation: mapCitation(raw) });
            return out;
          }
          // 알려진 블록에 도착한 미지 delta 타입 — 보존 + 1회 보고 (리뷰 R7/V10b)
          out.push(...warnOnce(`delta:${dType}`, `미지의 delta 타입 '${String(dType)}' — 원문 보존`), preserve(json as JSONValue, "event"));
          return out;
        }

        case "content_block_stop": {
          const index = Number(json["index"] ?? 0);
          const open = blocks.get(index);
          if (!open) return out;
          blocks.delete(index);
          if (open.kind === "text") {
            out.push({ type: "text-end", id: open.irId });
            return out;
          }
          if (open.kind === "reasoning") {
            out.push({ type: "reasoning-end", id: open.irId });
            return out;
          }
          if (open.kind === "unknown") return out; // 보존은 start/delta에서 완료
          // tool: 완성본 tool-call 재전송 (소비자는 delta 무시 가능 — ir-v0 §10.2)
          out.push({ type: "tool-input-end", id: open.irId });
          let input: { type: "json"; value: JSONValue } | { type: "text"; text: string };
          if (open.inputAcc.length === 0) {
            input = { type: "json", value: open.initialInput ?? {} };
          } else {
            try {
              input = { type: "json", value: JSON.parse(open.inputAcc) as JSONValue };
            } catch {
              // 날조 금지 — text 강등 + 보고 (ir-v0 §4.3)
              input = { type: "text", text: open.inputAcc };
              out.push({
                type: "warning",
                warning: makeWarning(
                  "unsupported",
                  "tool-input-demoted",
                  `tool input이 유효 JSON이 아님 — text 강등 (${open.toolName})`,
                ),
              });
            }
          }
          out.push({
            type: "tool-call",
            block: {
              type: "toolCall",
              id: open.irId,
              toolCallId: open.toolCallId.length > 0 ? open.toolCallId : synthId(index, open.toolName),
              toolName: open.toolName,
              input,
              ...(open.providerExecuted ? { providerExecuted: true as const } : {}),
              origin, // 재타게팅 판단 기준 (리뷰 R8)
              ...(open.wireType ? { providerMetadata: { anthropic: { wireType: open.wireType } } } : {}),
            },
          });
          return out;
        }

        case "message_delta": {
          const delta = (json["delta"] ?? {}) as Record<string, unknown>;
          if (typeof delta["stop_reason"] === "string") stopReason = delta["stop_reason"];
          // stop_details 보존 — 폴백 트리거 정책 근거 (감사 anthropic #3, 매트릭스 2026-08-25 행)
          if (delta["stop_details"] && typeof delta["stop_details"] === "object") {
            stopDetails = delta["stop_details"] as JSONValue;
          }
          if (typeof delta["stop_sequence"] === "string") stopSequence = delta["stop_sequence"]; // 감사 #22
          const deltaContainer = json["container"] ?? delta["container"]; // 실관측 2경로 (리뷰 G1)
          if (deltaContainer && typeof deltaContainer === "object") latestContainer = deltaContainer as JSONValue;
          const wireUsage = json["usage"];
          if (wireUsage && typeof wireUsage === "object") {
            // 누적 usage 전 필드 병합 — 서버 툴로 mid-turn input 증가 반영 (리뷰 R3)
            mergeUsage(wireUsage as Record<string, unknown>);
            rawDeltaUsage = wireUsage as JSONValue;
            const u = currentUsage();
            out.push({
              type: "usage-interim",
              usage: { input: { ...u.input }, output: { total: u.output.total } },
            });
          }
          return out;
        }

        case "message_stop": {
          terminalEmitted = true;
          {
            // 최종 container(턴 중 생성·교체분 포함, §10.1 PM 대칭 — 리뷰 G1) + stop_details
            const finishPM: Record<string, JSONValue> = {};
            if (latestContainer !== undefined) finishPM["container"] = latestContainer;
            if (stopDetails !== undefined) finishPM["stopDetails"] = stopDetails;
            if (stopSequence !== undefined) finishPM["stopSequence"] = stopSequence;
            out.push({
              type: "finish",
              finishReason: mapStopReason(stopReason),
              usage: currentUsage(),
              ...(Object.keys(finishPM).length > 0 ? { providerMetadata: { anthropic: finishPM } } : {}),
            });
          }
          return out;
        }

        case "error": {
          const err = (json["error"] ?? {}) as Record<string, unknown>;
          terminalEmitted = true;
          closeOpenBlocks(out); // 터미널 보장 — 열린 블록 폐쇄 (감사 #39)
          out.push({
            type: "provider-error",
            error: {
              ...mapInStreamError(err["type"] as string | undefined, err["message"] as string | undefined),
              billed: sawMessageStart, // message_start 수신 = input 과금 발생 (리뷰 R2)
            },
            ...(sawMessageStart ? { usage: currentUsage() } : {}),
          });
          return out;
        }

        default:
          // 미지 top-level 이벤트 — 보존 + 1회 보고 (리뷰 R7/V10c)
          out.push(...warnOnce(`event:${type}`, `미지의 스트림 이벤트 '${String(type)}' — 원문 보존`), preserve(json as JSONValue, "event"));
          return out;
      }
    },

    onStreamEnd(): AdapterStreamEvent[] {
      if (terminalEmitted) return [];
      terminalEmitted = true; // 멱등 — 재호출·후속 이벤트 무시 (§10.2)
      // 종료 신호 없는 절단 — 터미널 보장 계약 (ADR-0005). 과금 usage 동봉 (리뷰 R2)
      const out: AdapterStreamEvent[] = [];
      closeOpenBlocks(out); // 열린 블록 폐쇄 (감사 #39 — gemini 대칭)
      out.push({
        type: "provider-error",
        error: { ...streamTruncationError(), billed: sawMessageStart },
        ...(sawMessageStart ? { usage: currentUsage() } : {}),
      });
      return out;
    },
  };
}
