import { createHash } from "node:crypto";
import type { JSONValue } from "../../ir/json.js";
import type { Origin } from "../../ir/common.js";
import type { AdapterStreamEvent, StreamContext, StreamTransformer } from "../types.js";
import { makeWarning } from "../shared.js";
import { groundingSourceBlocks, synthToolCallId } from "./response.js";
import {
  convertUsage,
  mapFinishReason,
  mapGeminiError,
  promptBlockedError,
  streamTruncationError,
  type GeminiWireUsage,
} from "./errors.js";

// Gemini :streamGenerateContent?alt=sse → IR 스트림 이벤트 draft (ADR-0003, ir-v0 §10).
// 각 SSE data는 완전한 GenerateContentResponse — 별도 델타 타입 없이 parts를 append 병합하고
// (인벤토리 F-2), 종료 이벤트도 없다 → finishReason을 기억했다가 onStreamEnd에서 finish를 적재한다.
// thoughtSignature: 서명 실린 text part는 그 자리에서 블록을 닫아 서명별 1블록을 보장하고
// (비스트림 part당 1블록과 대칭 — last-wins 유실 금지), thought part 것은 reasoning-delta.opaqueState,
// functionCall 것은 tool-call 블록, 미디어 part 것은 file 블록 opaqueState에 싣는다.
// grounding citation(groundingSupports)은 partIndex 정렬이 스트림에서 불안정 — 원문을 finish PM에
// 보존하고 스트림 citation-delta는 미방출 (비스트림 변환이 표준 Citation을 채운다).

type OpenBlock =
  | { kind: "text"; irId: string; signature?: string }
  | { kind: "reasoning"; irId: string };

export function createStreamTransformer(ctx: StreamContext): StreamTransformer {
  let open: OpenBlock | undefined;
  let blockCounter = 0;
  let partCounter = 0; // wire part 서수 — synth id의 blockIndex (§13.2, 비스트림 part 인덱스와 대칭)
  let terminalEmitted = false;
  let metadataEmitted = false;
  let sawAnyChunk = false; // input 과금 발생 기준: 정상 응답 청크 수신 = 프롬프트 처리됨 (에러 전용 청크 제외)
  let sawClientToolCall = false;
  let providerRequestId: string | undefined;
  let origin: Origin = { provider: "google", model: ctx.modelId, surface: "generate-content" };
  let finishRaw: string | undefined;
  let lastUsage: GeminiWireUsage | undefined; // 마지막 청크가 확정치 (인벤토리 F-2)
  let latestGrounding: Record<string, unknown> | undefined;
  let latestUrlContext: Record<string, unknown> | undefined;
  let emittedSources = 0;
  // responseId 부재 시 synth 스코프 — 수신 원문의 연쇄 해시 (§13.2 취지: 턴 간 충돌 방지 + 재생 결정론.
  // 비스트림의 전체-parts SHA와 완전 동일화는 스트림 구조상 불가 — problem log 참조)
  let fallbackScope = "stream";
  const warnedUnknown = new Set<string>();

  function warnOnce(kindKey: string, message: string, details?: JSONValue): AdapterStreamEvent[] {
    if (warnedUnknown.has(kindKey)) return [];
    warnedUnknown.add(kindKey);
    return [
      { type: "warning", warning: makeWarning("compatibility", "unknown-block-passthrough", message, undefined, details) },
    ];
  }

  function nextId(): string {
    return `blk_${blockCounter++}`;
  }

  function closeOpen(out: AdapterStreamEvent[]): void {
    if (!open) return;
    if (open.kind === "text") {
      out.push({
        type: "text-end",
        id: open.irId,
        ...(open.signature !== undefined ? { opaqueState: { provider: "google", data: open.signature } } : {}),
      });
    } else {
      out.push({ type: "reasoning-end", id: open.irId });
    }
    open = undefined;
  }

  function handlePart(raw: Record<string, unknown>, out: AdapterStreamEvent[], partIndex: number): void {
    const signature =
      typeof raw["thoughtSignature"] === "string" && raw["thoughtSignature"].length > 0
        ? raw["thoughtSignature"]
        : undefined;
    const opaque = signature !== undefined ? { opaqueState: { provider: "google", data: signature } } : {};

    if (raw["thought"] === true) {
      if (!open || open.kind !== "reasoning") {
        closeOpen(out);
        open = { kind: "reasoning", irId: nextId() };
        out.push({ type: "reasoning-start", id: open.irId });
      }
      const text = String(raw["text"] ?? "");
      if (text.length > 0) out.push({ type: "reasoning-delta", id: open.irId, delta: text });
      if (signature !== undefined) {
        out.push({ type: "reasoning-delta", id: open.irId, opaqueState: { provider: "google", data: signature } });
      }
      return;
    }
    if (typeof raw["text"] === "string") {
      // 순수 빈 text part(서명 없음)는 비스트림과 동일하게 프루닝 — 유령 블록·synth 인덱스 시프트 방지
      if (raw["text"].length === 0 && signature === undefined) return;
      if (!open || open.kind !== "text") {
        closeOpen(out);
        open = { kind: "text", irId: nextId() };
        out.push({ type: "text-start", id: open.irId });
      }
      if (raw["text"].length > 0) out.push({ type: "text-delta", id: open.irId, delta: raw["text"] });
      if (signature !== undefined && open.kind === "text") {
        // 서명은 part 경계 표식 — 즉시 닫아 서명별 1블록 보장 (병합 last-wins 유실 방지, §10.2/C-2)
        open.signature = signature;
        closeOpen(out);
      }
      return;
    }
    const fc = raw["functionCall"];
    if (fc && typeof fc === "object") {
      const call = fc as Record<string, unknown>;
      const name = typeof call["name"] === "string" && call["name"].length > 0 ? call["name"] : undefined;
      if (!name) {
        out.push(
          ...warnOnce("malformed:functionCall", "name 없는 functionCall — passthrough 보존"),
          { type: "passthrough", block: { type: "passthrough", provider: "google", raw: raw as JSONValue, origin } },
        );
        return;
      }
      closeOpen(out);
      const irId = nextId();
      const wireId = typeof call["id"] === "string" && call["id"].length > 0 ? call["id"] : "";
      const toolCallId =
        wireId.length > 0 ? wireId : synthToolCallId(providerRequestId ?? fallbackScope, partIndex, name);
      sawClientToolCall = true;
      const args = (call["args"] ?? {}) as JSONValue;
      // functionCall은 통짜 도착 (인벤토리 F-2) — 단일 delta로 인자를 실어 delta-기반 소비자
      // (compat 다운컨버터의 wire 재현)도 완성 인자를 받게 한다
      out.push(
        { type: "tool-input-start", id: irId, toolCallId, toolName: name },
        { type: "tool-input-delta", id: irId, delta: JSON.stringify(args) },
        { type: "tool-input-end", id: irId },
        {
          type: "tool-call",
          block: {
            type: "toolCall",
            id: irId,
            toolCallId,
            toolName: name,
            input: { type: "json", value: args },
            ...opaque,
            origin,
          },
        },
      );
      return;
    }
    const inline = raw["inlineData"];
    if (inline && typeof inline === "object") {
      const d = inline as Record<string, unknown>;
      closeOpen(out);
      out.push({
        type: "file",
        block: {
          type: "file",
          mediaType: String(d["mimeType"] ?? "application/octet-stream"),
          data: { type: "base64", data: String(d["data"] ?? "") },
          id: nextId(),
          ...opaque, // 미디어 part의 서명도 왕복 보존 (C-2 — 모든 part에 부착 가능)
          origin,
        },
      });
      return;
    }
    const fileData = raw["fileData"];
    if (fileData && typeof fileData === "object") {
      const d = fileData as Record<string, unknown>;
      closeOpen(out);
      out.push({
        type: "file",
        block: {
          type: "file",
          mediaType: String(d["mimeType"] ?? "application/octet-stream"),
          data: { type: "reference", refs: { google: String(d["fileUri"] ?? "") } },
          id: nextId(),
          ...opaque,
          origin,
        },
      });
      return;
    }
    if (raw["executableCode"] !== undefined || raw["codeExecutionResult"] !== undefined) {
      const kind = raw["executableCode"] !== undefined ? "google.executable_code" : "google.code_execution_result";
      closeOpen(out);
      out.push({
        type: "custom",
        block: { type: "custom", kind, payload: raw as JSONValue, id: nextId(), origin },
      });
      return;
    }
    out.push(
      ...warnOnce(`part:${Object.keys(raw).join(",")}`, `미지의 gemini part (키: ${Object.keys(raw).join(",")}) — 원문 보존`),
      { type: "passthrough", block: { type: "passthrough", provider: "google", raw: raw as JSONValue, origin } },
    );
  }

  return {
    framing: "sse",

    onEvent(_eventName, data): AdapterStreamEvent[] {
      if (terminalEmitted) return []; // §10.2 — 터미널 이후 이벤트 무시
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
              "파싱 불가 SSE 청크 — 원문은 details에 보존",
              undefined,
              { data },
            ),
          },
        ];
      }

      const out: AdapterStreamEvent[] = [];
      if (ctx.includeRaw) out.push({ type: "raw", provider: "google", value: json as JSONValue });

      // 스트림 중간 에러 JSON (인벤토리 F-2) — 에러 전용 청크는 과금 근거가 아니므로
      // sawAnyChunk 갱신보다 먼저 검사한다 (첫 청크 에러 = billed:false)
      const errObj = json["error"];
      if (errObj && typeof errObj === "object") {
        terminalEmitted = true;
        const e = errObj as Record<string, unknown>;
        const status = typeof e["code"] === "number" ? e["code"] : 502;
        closeOpen(out);
        out.push({
          type: "provider-error",
          error: { ...mapGeminiError(status, json), billed: sawAnyChunk },
          ...(lastUsage !== undefined ? { usage: convertUsage(lastUsage) } : {}),
        });
        return out;
      }
      sawAnyChunk = true;
      fallbackScope = createHash("sha256").update(`${fallbackScope}\n${data}`).digest("hex").slice(0, 8);

      if (typeof json["responseId"] === "string" && json["responseId"].length > 0 && !providerRequestId) {
        providerRequestId = json["responseId"];
      }
      if (typeof json["modelVersion"] === "string" && json["modelVersion"].length > 0) {
        origin = { provider: "google", model: json["modelVersion"], surface: "generate-content" };
      }
      if (!metadataEmitted) {
        metadataEmitted = true;
        out.push({
          type: "response-metadata",
          model: { resolved: { provider: "google", model: origin.model, surface: "generate-content" } },
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }

      const candidates = Array.isArray(json["candidates"]) ? (json["candidates"] as Record<string, unknown>[]) : [];
      if (candidates.length > 1 && !warnedUnknown.has("multi-candidate")) {
        warnedUnknown.add("multi-candidate");
        out.push({
          type: "warning",
          warning: makeWarning("unsupported", "block-dropped", `candidates[1..] 무시 — IR은 단일 후보 (G2)`),
        });
      }
      const candidate = candidates[0];
      if (candidate) {
        const content = (candidate["content"] ?? {}) as Record<string, unknown>;
        const parts = Array.isArray(content["parts"]) ? (content["parts"] as Record<string, unknown>[]) : [];
        for (const part of parts) handlePart(part, out, partCounter++);

        if (typeof candidate["finishReason"] === "string") finishRaw = candidate["finishReason"];

        const gm = candidate["groundingMetadata"];
        if (gm && typeof gm === "object") {
          latestGrounding = gm as Record<string, unknown>;
          const sources = groundingSourceBlocks(latestGrounding);
          for (let i = emittedSources; i < sources.length; i++) {
            out.push({ type: "source", block: { ...sources[i]!, id: nextId(), origin } });
          }
          emittedSources = Math.max(emittedSources, sources.length);
        }
        const uc = candidate["urlContextMetadata"];
        if (uc && typeof uc === "object") latestUrlContext = uc as Record<string, unknown>;
      }

      const usage = json["usageMetadata"];
      if (usage && typeof usage === "object") {
        lastUsage = usage as GeminiWireUsage;
        if (finishRaw === undefined) {
          const u = convertUsage(lastUsage);
          out.push({
            type: "usage-interim",
            usage: { input: { ...u.input }, output: { total: u.output.total } },
          });
        }
      }

      // HTTP 200 soft-block — parts·usage 처리 후 판정 (비스트림의 "생성물 없음" 조건과 대칭:
      // 콘텐츠가 이미 나왔으면 차단 사유는 승격하지 않는다). usage는 과금 근거로 동봉.
      const blockReason = ((json["promptFeedback"] ?? {}) as Record<string, unknown>)["blockReason"];
      if (typeof blockReason === "string" && blockCounter === 0 && !sawClientToolCall) {
        terminalEmitted = true;
        closeOpen(out);
        out.push({
          type: "provider-error",
          error: promptBlockedError(blockReason, json as JSONValue),
          ...(lastUsage !== undefined ? { usage: convertUsage(lastUsage) } : {}),
        });
        return out;
      }
      return out;
    },

    onStreamEnd(): AdapterStreamEvent[] {
      if (terminalEmitted) return [];
      terminalEmitted = true; // 멱등 — 재호출·후속 이벤트 무시 (§10.2)
      const out: AdapterStreamEvent[] = [];
      if (finishRaw !== undefined) {
        // Gemini SSE는 종료 이벤트가 없다 — 스트림 정상 종료 시점에 finish 적재
        closeOpen(out);
        const pm: Record<string, JSONValue> = {};
        if (latestGrounding !== undefined) pm["groundingMetadata"] = latestGrounding as JSONValue;
        if (latestUrlContext !== undefined) pm["urlContextMetadata"] = latestUrlContext as JSONValue;
        out.push({
          type: "finish",
          finishReason: mapFinishReason(finishRaw, sawClientToolCall),
          usage: convertUsage(lastUsage ?? {}),
          ...(Object.keys(pm).length > 0 ? { providerMetadata: { google: pm } } : {}),
        });
        return out;
      }
      // finishReason 없는 절단 — 터미널 보장 계약 (ADR-0005). 과금 usage 동봉
      closeOpen(out);
      out.push({
        type: "provider-error",
        error: { ...streamTruncationError(), billed: sawAnyChunk },
        ...(lastUsage !== undefined ? { usage: convertUsage(lastUsage) } : {}),
      });
      return out;
    },
  };
}
