import { z } from "zod";
import type { JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { Citation, Warning } from "../../ir/common.js";
import type { RequestContext, TransformedResponse } from "../types.js";
import { makeWarning } from "../shared.js";
import { convertUsage, mapStopReason } from "./errors.js";

// Anthropic wire 응답 → IR (ir-v0 §7/§13). 미지 블록 타입은 passthrough + warning (§4.9 (b)).

const WireResponseSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  content: z.array(z.record(z.string(), z.unknown())),
  stop_reason: z.string().nullish(),
  usage: z.record(z.string(), z.unknown()).optional(),
  container: z.record(z.string(), z.unknown()).nullish(), // 코드 실행 샌드박스 id·만료 (§14)
});

function intOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** Anthropic citation 객체 → IR Citation (리뷰 P5/P6 — url 인용 보존, end 무검증 제거) */
export function mapCitation(raw: Record<string, unknown>): Citation {
  const type = raw["type"];
  const citedText = typeof raw["cited_text"] === "string" ? raw["cited_text"] : undefined;
  const docTitle = typeof raw["document_title"] === "string" ? raw["document_title"] : undefined;
  const docIndex = intOrUndefined(raw["document_index"]);

  // 웹서치 인용 — 출처가 URL (source.type "url" + url/title 보존)
  if (type === "web_search_result_location") {
    const url = typeof raw["url"] === "string" ? raw["url"] : undefined;
    const title = typeof raw["title"] === "string" ? raw["title"] : undefined;
    return {
      source: { type: "url", ...(url ? { url } : {}), ...(title ? { title } : {}) },
      ...(citedText ? { citedText } : {}),
    };
  }

  let location: Citation["location"];
  const range = (startKey: string, endKey: string, locType: "char" | "page" | "block") => {
    const start = intOrUndefined(raw[startKey]);
    const end = intOrUndefined(raw[endKey]);
    // start·end 둘 다 유효한 정수일 때만 location 생성 (역전 range/비숫자 방지 — P6)
    if (start !== undefined && end !== undefined && end >= start) {
      location = { type: locType, start, end };
    }
  };
  if (type === "char_location") range("start_char_index", "end_char_index", "char");
  else if (type === "page_location") range("start_page_number", "end_page_number", "page");
  else if (type === "content_block_location") range("start_block_index", "end_block_index", "block");

  return {
    source: {
      type: "document",
      ...(docTitle ? { title: docTitle } : {}),
      ...(docIndex !== undefined ? { documentIndex: docIndex } : {}),
    },
    ...(citedText ? { citedText } : {}),
    ...(location ? { location } : {}),
  };
}

export function wireBlockToIR(
  raw: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): Block | null {
  const type = raw["type"];
  switch (type) {
    case "text": {
      const citationsRaw = raw["citations"];
      const citations = Array.isArray(citationsRaw)
        ? citationsRaw.map((c) => mapCitation(c as Record<string, unknown>))
        : undefined;
      return {
        type: "text",
        text: String(raw["text"] ?? ""),
        ...(citations && citations.length > 0 ? { citations } : {}),
      };
    }
    case "thinking":
      return {
        type: "reasoning",
        text: String(raw["thinking"] ?? ""),
        ...(typeof raw["signature"] === "string" && raw["signature"].length > 0
          ? { opaqueState: { provider: "anthropic", data: raw["signature"] } }
          : {}),
      };
    case "redacted_thinking":
      return {
        type: "reasoning",
        text: "",
        redacted: true,
        opaqueState: { provider: "anthropic", data: String(raw["data"] ?? "") },
      };
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use": {
      const id = typeof raw["id"] === "string" && raw["id"].length > 0 ? raw["id"] : undefined;
      const name = typeof raw["name"] === "string" && raw["name"].length > 0 ? raw["name"] : undefined;
      if (!name) break; // name 없는 tool_use는 비정형 — passthrough로 보존 (아래 default)
      const serverExecuted = type !== "tool_use";
      return {
        type: "toolCall",
        // id 미발급 비정형 응답 → 결정론적 합성은 호출측(assignIds)에서 responseScope와 함께 (G5)
        toolCallId: id ?? "",
        toolName: name,
        input: { type: "json", value: (raw["input"] ?? {}) as JSONValue },
        ...(serverExecuted
          ? { providerExecuted: true as const, providerMetadata: { anthropic: { wireType: type } } }
          : {}),
      };
    }
    default:
      break;
  }
  // *_tool_result (서버 툴 결과) — providerExecuted toolResult로 수납 + wireType 보존 (G1 왕복)
  if (typeof type === "string" && type.endsWith("_tool_result") && typeof raw["tool_use_id"] === "string") {
    return {
      type: "toolResult",
      toolCallId: raw["tool_use_id"],
      toolName: type.replace(/_tool_result$/, ""),
      output: { type: "json", value: (raw["content"] ?? null) as JSONValue },
      providerExecuted: true,
      providerMetadata: { anthropic: { wireType: type } },
    };
  }
  // 미지 블록 → passthrough + warning (§4.9 — day-1 보존)
  warnings.push(
    makeWarning(
      "compatibility",
      "unknown-block-passthrough",
      `미지의 anthropic 블록 타입 '${String(type)}' — passthrough로 보존`,
      path,
    ),
  );
  return { type: "passthrough", provider: "anthropic", raw: raw as JSONValue };
}

/** G5 — id 미발급 블록의 결정론적 합성 id (같은 응답 재변환 = 같은 id, 턴 간 충돌 없음) */
function synthToolCallId(responseScope: string, index: number, toolName: string): string {
  return `synth:anthropic:${responseScope}:${index}:${toolName}`;
}

export function transformResponse(
  body: unknown,
  ctx: RequestContext & { requestedModel: string },
): TransformedResponse {
  const warnings: Warning[] = [];
  const wire = WireResponseSchema.parse(body);
  const origin = { provider: "anthropic", model: wire.model, surface: "messages" };
  const blocks: Block[] = [];
  wire.content.forEach((raw, i) => {
    const block = wireBlockToIR(raw, warnings, `content[${i}]`);
    if (!block) return;
    // §4.0 — 응답 블록에는 id·origin 항상 존재 (리뷰 P2/R8)
    const withIds: Block = { ...block, id: `blk_${i}`, origin };
    if (withIds.type === "toolCall" && withIds.toolCallId === "") {
      withIds.toolCallId = synthToolCallId(wire.id, i, withIds.toolName);
    }
    blocks.push(withIds);
  });
  return {
    blocks,
    origin,
    finishReason: mapStopReason(wire.stop_reason),
    usage: convertUsage(wire.usage ?? {}),
    providerRequestId: wire.id,
    // container 유실 방지 (2026-08-21 neuro 연동 검출) — 재사용 계약은 id 왕복이 전제
    ...(wire.container ? { providerMetadata: { anthropic: { container: wire.container as JSONValue } } } : {}),
    warnings,
  };
}
