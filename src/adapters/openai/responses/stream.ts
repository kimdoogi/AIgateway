import type { JSONValue } from "../../../ir/json.js";
import type { Origin } from "../../../ir/common.js";
import type { Usage } from "../../../ir/usage.js";
import type { AdapterStreamEvent, StreamContext, StreamTransformer } from "../../types.js";
import { makeWarning } from "../../shared.js";
import { convertUsage, mapInStreamError, mapResponsesFinishReason, streamTruncationError, type OpenAIWireUsage } from "../errors.js";
import {
  CUSTOM_ITEM_TYPES,
  SERVER_TOOL_CALL_TYPES,
  SURFACE,
  mapAnnotation,
  parseToolArguments,
  reasoningItemText,
  scanOutput,
} from "./response.js";

// OpenAI Responses semantic events → IR 스트림 draft (인벤토리 §D, ir-v0 §10, ADR-0005).
// 명시적 상태 머신 (D4). item_id 기반 블록 스코프 — message item의 파트는 `${itemId}:${contentIndex}`.
// usage는 최종 response.completed의 response 객체에만 (§D) — finish에서 1회 수확.
// 서버 툴 진행 이벤트(in_progress/searching 등)는 §10.2 확정 규칙대로 passthrough 방출.

interface OpenItem {
  type: string;
  itemId: string;
  /** function_call/custom_tool_call: 인자 누적 */
  argsAcc: string;
  callId?: string;
  toolName?: string;
  /** reasoning: 시작 이벤트를 이미 냈는가 */
  reasoningStarted?: boolean;
  /** reasoning: 파트 사이 구분자 필요 여부 */
  reasoningNeedsSep?: boolean;
}

/** 진행 상태 알림형 이벤트 접미 (툴별 in_progress/searching/completed 등) — passthrough 대상 */
const PROGRESS_EVENT_RE =
  /^response\.(web_search_call|file_search_call|code_interpreter_call|image_generation_call|mcp_call|mcp_list_tools|local_shell_call|shell_call|apply_patch_call|computer_call|tool_search_call)\./;

export function createStreamTransformer(ctx: StreamContext): StreamTransformer {
  const items = new Map<string, OpenItem>(); // key: item_id
  let origin: Origin & { surface: string } = { provider: "openai", model: ctx.modelId, surface: SURFACE };
  let providerRequestId: string | undefined;
  let sawCreated = false; // 과금 발생 기준 — 요청 수리 후 실패도 input 과금 가능
  let terminalEmitted = false;
  const warnedUnknown = new Set<string>();

  function warnOnce(kindKey: string, message: string, details?: JSONValue): AdapterStreamEvent[] {
    if (warnedUnknown.has(kindKey)) return [];
    warnedUnknown.add(kindKey);
    return [
      { type: "warning", warning: makeWarning("compatibility", "unknown-block-passthrough", message, undefined, details) },
    ];
  }

  function preserve(raw: JSONValue): AdapterStreamEvent {
    return { type: "passthrough", block: { type: "passthrough", provider: "openai", raw, origin } };
  }

  function usageFrom(response: Record<string, unknown> | undefined): Usage | undefined {
    const u = response?.["usage"];
    if (!u || typeof u !== "object") return undefined;
    return convertUsage(u as OpenAIWireUsage);
  }

  function partBlockId(itemId: string, contentIndex: unknown): string {
    const idx = typeof contentIndex === "number" ? contentIndex : 0;
    return `${itemId}:${idx}`;
  }

  return {
    framing: "sse",

    onEvent(eventName, data): AdapterStreamEvent[] {
      if (terminalEmitted) return []; // §10.2 — 터미널 이후 무시

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(data) as Record<string, unknown>;
      } catch {
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
      if (ctx.includeRaw) out.push({ type: "raw", provider: "openai", value: json as JSONValue });
      const type = (json["type"] as string | undefined) ?? eventName ?? "";
      const itemIdOf = (): string => String(json["item_id"] ?? "");

      switch (type) {
        case "response.created": {
          const response = (json["response"] ?? {}) as Record<string, unknown>;
          sawCreated = true;
          const model = String(response["model"] ?? ctx.modelId);
          origin = { provider: "openai", model, surface: SURFACE };
          const id = response["id"];
          if (typeof id === "string" && id.length > 0) providerRequestId = id;
          out.push({
            type: "response-metadata",
            model: { resolved: origin },
            ...(providerRequestId ? { providerRequestId } : {}),
          });
          return out;
        }

        // 진행 스냅샷 — IR 대응 없음, 무해한 노이즈 (ping과 동급으로 무시)
        case "response.queued":
        case "response.in_progress":
          return out;

        case "response.output_item.added": {
          const item = (json["item"] ?? {}) as Record<string, unknown>;
          const iType = String(item["type"] ?? "");
          const itemId = String(item["id"] ?? `item_${json["output_index"] ?? items.size}`);
          const open: OpenItem = { type: iType, itemId, argsAcc: "" };
          if (iType === "function_call" || iType === "custom_tool_call") {
            open.callId = typeof item["call_id"] === "string" && item["call_id"].length > 0 ? item["call_id"] : itemId;
            open.toolName = String(item["name"] ?? (iType === "custom_tool_call" ? "custom" : ""));
            items.set(itemId, open);
            out.push({
              type: "tool-input-start",
              id: itemId,
              toolCallId: open.callId,
              toolName: open.toolName,
            });
            return out;
          }
          if (iType === "reasoning") {
            open.reasoningStarted = true;
            items.set(itemId, open);
            out.push({ type: "reasoning-start", id: itemId });
            return out;
          }
          // message·서버툴·custom item — 파트/완성 이벤트에서 처리
          items.set(itemId, open);
          return out;
        }

        case "response.content_part.added": {
          const part = (json["part"] ?? {}) as Record<string, unknown>;
          const pType = part["type"];
          const blockId = partBlockId(itemIdOf(), json["content_index"]);
          if (pType === "output_text" || pType === "refusal") {
            out.push({ type: "text-start", id: blockId });
            const initial = String(part[pType === "refusal" ? "refusal" : "text"] ?? "");
            if (initial.length > 0) out.push({ type: "text-delta", id: blockId, delta: initial });
            return out;
          }
          out.push(...warnOnce(`part:${String(pType)}`, `미지의 content part '${String(pType)}' — 원문 보존`), preserve(json as JSONValue));
          return out;
        }

        case "response.output_text.delta": {
          out.push({ type: "text-delta", id: partBlockId(itemIdOf(), json["content_index"]), delta: String(json["delta"] ?? "") });
          return out;
        }

        case "response.refusal.delta": {
          out.push({ type: "text-delta", id: partBlockId(itemIdOf(), json["content_index"]), delta: String(json["delta"] ?? "") });
          return out;
        }

        case "response.output_text.annotation.added": {
          const annotation = (json["annotation"] ?? {}) as Record<string, unknown>;
          out.push({
            type: "citation-delta",
            id: partBlockId(itemIdOf(), json["content_index"]),
            citation: mapAnnotation(annotation),
          });
          return out;
        }

        case "response.content_part.done": {
          const part = (json["part"] ?? {}) as Record<string, unknown>;
          const pType = part["type"];
          const blockId = partBlockId(itemIdOf(), json["content_index"]);
          if (pType === "output_text") {
            out.push({ type: "text-end", id: blockId });
            return out;
          }
          if (pType === "refusal") {
            // §10.2 확정 — refusal은 text 강등 + end에 PM 표식
            out.push({ type: "text-end", id: blockId, providerMetadata: { openai: { refusal: true } } });
            return out;
          }
          return out; // 미지 파트는 added에서 보존 완료
        }

        // ── reasoning (summary/content 채널 공통 — reasoning-delta로 수렴) ──
        case "response.reasoning_summary_part.added": {
          const open = items.get(itemIdOf());
          if (open?.reasoningNeedsSep) {
            out.push({ type: "reasoning-delta", id: open.itemId, delta: "\n\n" });
            open.reasoningNeedsSep = false;
          }
          return out;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const open = items.get(itemIdOf());
          if (!open) return out;
          out.push({ type: "reasoning-delta", id: open.itemId, delta: String(json["delta"] ?? "") });
          return out;
        }
        case "response.reasoning_summary_part.done": {
          const open = items.get(itemIdOf());
          if (open) open.reasoningNeedsSep = true;
          return out;
        }
        case "response.reasoning_summary_text.done":
        case "response.reasoning_text.done":
        case "response.output_text.done":
        case "response.refusal.done":
          return out; // 누적 텍스트는 delta로 이미 방출 — done은 완성본 재통지 (2026-08-21 녹화 확인)

        // ── function/custom tool 인자 ──
        case "response.function_call_arguments.delta":
        case "response.custom_tool_call_input.delta":
        case "response.mcp_call_arguments.delta": {
          const open = items.get(itemIdOf());
          if (!open) return out;
          const delta = String(json["delta"] ?? "");
          open.argsAcc += delta;
          if (open.type === "function_call" || open.type === "custom_tool_call") {
            out.push({ type: "tool-input-delta", id: open.itemId, delta });
          }
          // mcp_call 인자는 완성 item에서 tool-call로 — 진행 delta는 방출 생략 (blockId 미개설)
          return out;
        }
        case "response.function_call_arguments.done":
        case "response.custom_tool_call_input.done":
        case "response.mcp_call_arguments.done": {
          const open = items.get(itemIdOf());
          if (open && typeof json["arguments"] === "string") open.argsAcc = json["arguments"];
          if (open && typeof json["input"] === "string") open.argsAcc = json["input"];
          return out;
        }

        case "response.output_item.done": {
          const item = (json["item"] ?? {}) as Record<string, unknown>;
          const iType = String(item["type"] ?? "");
          const itemId = String(item["id"] ?? itemIdOf());
          const open = items.get(itemId);
          items.delete(itemId);

          if (iType === "message") return out; // 파트 이벤트에서 종결 완료

          if (iType === "reasoning") {
            const encrypted = typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
            if (!open?.reasoningStarted) out.push({ type: "reasoning-start", id: itemId });
            // 스트림 delta 미수신(요약 없는 모델)이면 완성 item 텍스트를 delta로 보정
            const text = reasoningItemText(item);
            if (!open?.reasoningStarted && text.length > 0) {
              out.push({ type: "reasoning-delta", id: itemId, delta: text });
            }
            out.push({
              type: "reasoning-delta",
              id: itemId,
              ...(encrypted ? { opaqueState: { provider: "openai", data: encrypted } } : {}),
              providerMetadata: { openai: { item: item as JSONValue } }, // 무손실 왕복 (§4.2)
            });
            out.push({ type: "reasoning-end", id: itemId });
            return out;
          }

          if (iType === "function_call" || iType === "custom_tool_call") {
            out.push({ type: "tool-input-end", id: itemId });
            const name = open?.toolName ?? String(item["name"] ?? "");
            const callId =
              (typeof item["call_id"] === "string" && item["call_id"].length > 0 ? item["call_id"] : undefined) ??
              open?.callId ??
              itemId;
            const warnings: AdapterStreamEvent[] = [];
            const argSource =
              typeof item["arguments"] === "string"
                ? item["arguments"]
                : typeof item["input"] === "string"
                  ? item["input"]
                  : (open?.argsAcc ?? "");
            let input: { type: "json"; value: JSONValue } | { type: "text"; text: string };
            if (iType === "custom_tool_call") {
              input = { type: "text", text: argSource };
            } else {
              const collected: import("../../../ir/common.js").Warning[] = [];
              input = parseToolArguments(argSource, name, collected);
              for (const w of collected) warnings.push({ type: "warning", warning: w });
            }
            out.push(...warnings, {
              type: "tool-call",
              block: {
                type: "toolCall",
                id: itemId,
                toolCallId: callId,
                toolName: name,
                input,
                origin,
                providerMetadata: { openai: { item: item as JSONValue } },
              },
            });
            return out;
          }

          if (SERVER_TOOL_CALL_TYPES.has(iType)) {
            const name = typeof item["name"] === "string" ? item["name"] : iType.replace(/_call$/, "");
            out.push({
              type: "tool-call",
              block: {
                type: "toolCall",
                id: itemId,
                toolCallId: itemId,
                toolName: name,
                input: { type: "json", value: item as JSONValue },
                providerExecuted: true,
                origin,
                providerMetadata: { openai: { item: item as JSONValue } },
              },
            });
            return out;
          }

          if (CUSTOM_ITEM_TYPES.has(iType)) {
            out.push({
              type: "custom",
              block: { type: "custom", kind: `openai.${iType}`, payload: item as JSONValue, id: itemId, origin },
            });
            return out;
          }

          out.push(...warnOnce(`item:${iType}`, `미지의 output item '${iType}' — 원문 보존`), preserve(item as JSONValue));
          return out;
        }

        // ── 터미널 ──
        case "response.completed":
        case "response.incomplete": {
          terminalEmitted = true;
          const response = (json["response"] ?? {}) as Record<string, unknown>;
          const output = Array.isArray(response["output"])
            ? (response["output"] as Record<string, unknown>[])
            : [];
          const incomplete = (response["incomplete_details"] ?? {}) as Record<string, unknown>;
          const { hasToolCall, hasRefusal } = scanOutput(output);
          out.push({
            type: "finish",
            finishReason: mapResponsesFinishReason({
              status: typeof response["status"] === "string" ? response["status"] : type.slice("response.".length),
              incompleteReason: typeof incomplete["reason"] === "string" ? incomplete["reason"] : null,
              hasToolCall,
              hasRefusal,
            }),
            usage: usageFrom(response) ?? convertUsage(undefined),
          });
          return out;
        }

        case "response.failed": {
          terminalEmitted = true;
          const response = (json["response"] ?? {}) as Record<string, unknown>;
          const usage = usageFrom(response);
          out.push({
            type: "provider-error",
            error: { ...mapInStreamError({ error: response["error"] }), billed: sawCreated },
            ...(usage ? { usage } : {}),
          });
          return out;
        }

        case "error": {
          terminalEmitted = true;
          out.push({
            type: "provider-error",
            error: { ...mapInStreamError(json), billed: sawCreated },
          });
          return out;
        }

        default: {
          // 서버 툴 진행 이벤트 — §10.2 확정 규칙: passthrough 방출 (warning 불요, 보존이 기본)
          if (PROGRESS_EVENT_RE.test(type)) {
            out.push(preserve(json as JSONValue));
            return out;
          }
          // 이미지 partial 등 미지/범위 밖 이벤트 — 보존 + 1회 보고
          out.push(...warnOnce(`event:${type}`, `미지의 스트림 이벤트 '${type}' — 원문 보존`), preserve(json as JSONValue));
          return out;
        }
      }
    },

    onStreamEnd(): AdapterStreamEvent[] {
      if (terminalEmitted) return [];
      terminalEmitted = true;
      return [
        {
          type: "provider-error",
          error: { ...streamTruncationError(SURFACE), billed: sawCreated },
        },
      ];
    },
  };
}
