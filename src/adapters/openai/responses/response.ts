import { z } from "zod";
import type { JSONObject, JSONValue } from "../../../ir/json.js";
import type { Block } from "../../../ir/blocks.js";
import type { Citation, Warning } from "../../../ir/common.js";
import type { RequestContext, TransformedResponse } from "../../types.js";
import { makeWarning } from "../../shared.js";
import { convertUsage, mapResponsesFinishReason, type OpenAIWireUsage } from "../errors.js";

// OpenAI Responses wire 응답 → IR (인벤토리 §B/§D, ir-v0 §7/§13).
// item 무손실 규칙 (§4.2): reasoning·서버툴 item은 PM openai.item에 원문 통째 보존.

export const SURFACE = "responses";

const WireResponseSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  status: z.string().optional(),
  incomplete_details: z.looseObject({ reason: z.string().optional() }).nullish(),
  output: z.array(z.record(z.string(), z.unknown())).optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
  error: z.record(z.string(), z.unknown()).nullish(),
});

/** 서버 실행 툴 item 타입 → toolName (인벤토리 §B). 호출·결과가 한 item */
export const SERVER_TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "mcp_call",
  "tool_search_call",
  "x_search_call", // xai responses (base 상속 — OpenAI 미발행이라 base 무해. 감사 xai #3: 미등록 시 providerExecuted가 passthrough 강등)
]);

/**
 * 클라이언트 실행형 빌트인 툴 (§13.5 — 감사 openai #4): 모델이 호출을 내고 클라이언트가
 * 실행해 *_output item을 제출한다. providerExecuted 없는 toolCall로 수납해 서버 실행형과 구분
 */
export const CLIENT_EXECUTED_CALL_TYPES: ReadonlySet<string> = new Set([
  "computer_call",
  "local_shell_call",
  "shell_call",
  "apply_patch_call",
]);

/** custom 블록으로 수납하는 item 타입 (라운드트립 무변경 재전송 — §4.7) */
export const CUSTOM_ITEM_TYPES: ReadonlySet<string> = new Set([
  "mcp_list_tools",
  "mcp_approval_request",
  "compaction",
  "item_reference",
  "additional_tools",
  "program",
  "program_output",
]);

/** annotation → IR Citation (인벤토리 §B — url_citation/file_citation/container_file_citation/file_path) */
export function mapAnnotation(raw: Record<string, unknown>): Citation {
  const type = raw["type"];
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const int = (k: string): number | undefined =>
    typeof raw[k] === "number" && Number.isInteger(raw[k]) ? (raw[k] as number) : undefined;
  const start = int("start_index");
  const end = int("end_index");
  const location =
    start !== undefined && end !== undefined && end >= start
      ? { location: { type: "outputRange" as const, start, end } }
      : {};
  if (type === "url_citation") {
    const url = str("url");
    const title = str("title");
    return { source: { type: "url", ...(url ? { url } : {}), ...(title ? { title } : {}) }, ...location };
  }
  // file_citation / container_file_citation / file_path — 출처는 파일
  const fileId = str("file_id");
  const filename = str("filename");
  return {
    source: { type: "file", ...(fileId ? { fileId } : {}), ...(filename ? { title: filename } : {}) },
    ...location,
  };
}

/** reasoning item → 표시 텍스트 (summary 우선, content(reasoning_text) 보조) */
export function reasoningItemText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"] as const) {
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    for (const p of arr) {
      if (p && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string") {
        parts.push((p as Record<string, unknown>)["text"] as string);
      }
    }
    if (parts.length > 0) break; // summary가 있으면 content는 중복 표시 방지
  }
  return parts.join("\n\n");
}

/** function_call arguments 문자열 → IR toolCall input (파싱 실패는 text 강등 — §4.3) */
export function parseToolArguments(
  args: string,
  toolName: string,
  warnings: Warning[],
): { type: "json"; value: JSONValue } | { type: "text"; text: string } {
  if (args.length === 0) return { type: "json", value: {} };
  try {
    return { type: "json", value: JSON.parse(args) as JSONValue };
  } catch {
    warnings.push(
      makeWarning("unsupported", "tool-input-demoted", `tool input이 유효 JSON이 아님 — text 강등 (${toolName})`),
    );
    return { type: "text", text: args };
  }
}

export function itemToBlocks(
  item: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): Block[] {
  const type = item["type"];
  const itemId = typeof item["id"] === "string" ? item["id"] : undefined;

  if (type === "message") {
    const content = Array.isArray(item["content"]) ? item["content"] : [];
    const blocks: Block[] = [];
    content.forEach((rawPart, pi) => {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      const pType = part["type"];
      if (pType === "output_text") {
        const annotationsRaw = part["annotations"];
        const citations = Array.isArray(annotationsRaw)
          ? annotationsRaw.map((a) => mapAnnotation(a as Record<string, unknown>))
          : [];
        blocks.push({
          type: "text",
          text: String(part["text"] ?? ""),
          ...(citations.length > 0 ? { citations } : {}),
          ...(itemId ? { providerMetadata: { openai: { itemId } } } : {}),
        });
        return;
      }
      if (pType === "refusal") {
        // §14 — text 강등 + PM refusal 표식 (finishReason refusal과 별개 축)
        blocks.push({
          type: "text",
          text: String(part["refusal"] ?? ""),
          providerMetadata: { openai: { refusal: true, ...(itemId ? { itemId } : {}) } },
        });
        return;
      }
      warnings.push(
        makeWarning(
          "compatibility",
          "unknown-block-passthrough",
          `미지의 message content part '${String(pType)}' — passthrough로 보존`,
          `${path}.content[${pi}]`,
        ),
      );
      blocks.push({ type: "passthrough", provider: "openai", raw: part as JSONValue });
    });
    return blocks;
  }

  if (type === "reasoning") {
    const encrypted = typeof item["encrypted_content"] === "string" ? item["encrypted_content"] : undefined;
    return [
      {
        type: "reasoning",
        text: reasoningItemText(item),
        ...(encrypted ? { opaqueState: { provider: "openai", data: encrypted } } : {}),
        providerMetadata: { openai: { item: item as JSONValue } }, // 무손실 왕복 (§4.2)
      },
    ];
  }

  if (type === "function_call") {
    const callId = typeof item["call_id"] === "string" && item["call_id"].length > 0 ? item["call_id"] : "";
    const name = typeof item["name"] === "string" ? item["name"] : "";
    if (name.length === 0) {
      warnings.push(
        makeWarning("compatibility", "unknown-block-passthrough", "name 없는 function_call — passthrough 보존", path),
      );
      return [{ type: "passthrough", provider: "openai", raw: item as JSONValue }];
    }
    return [
      {
        type: "toolCall",
        toolCallId: callId, // "" → 호출측이 결정론적 합성 (G5)
        toolName: name,
        input: parseToolArguments(String(item["arguments"] ?? ""), name, warnings),
        providerMetadata: { openai: { item: item as JSONValue } }, // item id 왕복 보존
      },
    ];
  }

  if (type === "custom_tool_call") {
    const callId = typeof item["call_id"] === "string" && item["call_id"].length > 0 ? item["call_id"] : "";
    const name = typeof item["name"] === "string" ? item["name"] : "custom";
    return [
      {
        type: "toolCall",
        toolCallId: callId,
        toolName: name,
        input: { type: "text", text: String(item["input"] ?? "") },
        providerMetadata: { openai: { item: item as JSONValue } },
      },
    ];
  }

  if (typeof type === "string" && CLIENT_EXECUTED_CALL_TYPES.has(type)) {
    // 클라이언트 실행형 (§13.5) — providerExecuted 없음: 클라이언트가 실행·output 제출.
    // 이전엔 서버 실행형으로 강등돼 output 제출 루프가 1급 표현 불가였다 (감사 openai #4)
    const name = typeof item["name"] === "string" ? item["name"] : type.replace(/_call$/, "");
    const callId =
      typeof item["call_id"] === "string" && item["call_id"].length > 0 ? item["call_id"] : (itemId ?? "");
    return [
      {
        type: "toolCall",
        toolCallId: callId,
        toolName: name,
        input: { type: "json", value: item as JSONValue },
        providerMetadata: { openai: { item: item as JSONValue } },
      },
    ];
  }

  if (typeof type === "string" && SERVER_TOOL_CALL_TYPES.has(type)) {
    // 서버 실행 툴 — 호출·결과가 한 item. toolCall 블록 + item 원문 보존 (별도 toolResult 없음)
    const name = typeof item["name"] === "string" ? item["name"] : type.replace(/_call$/, "");
    return [
      {
        type: "toolCall",
        toolCallId: itemId ?? "",
        toolName: name,
        input: { type: "json", value: item as JSONValue },
        providerExecuted: true,
        providerMetadata: { openai: { item: item as JSONValue } },
      },
    ];
  }

  if (typeof type === "string" && CUSTOM_ITEM_TYPES.has(type)) {
    return [{ type: "custom", kind: `openai.${type}`, payload: item as JSONValue }];
  }

  warnings.push(
    makeWarning(
      "compatibility",
      "unknown-block-passthrough",
      `미지의 openai output item '${String(type)}' — passthrough로 보존`,
      path,
    ),
  );
  return [{ type: "passthrough", provider: "openai", raw: item as JSONValue }];
}

/** 출력에 tool_call/refusal이 있는가 — finishReason 판정 입력 (errors.ts) */
export function scanOutput(output: readonly Record<string, unknown>[]): {
  hasToolCall: boolean;
  hasRefusal: boolean;
} {
  let hasToolCall = false;
  let hasRefusal = false;
  for (const item of output) {
    const type = item["type"];
    if (type === "function_call" || type === "custom_tool_call") hasToolCall = true;
    if (type === "message" && Array.isArray(item["content"])) {
      for (const p of item["content"]) {
        if (p && typeof p === "object" && (p as Record<string, unknown>)["type"] === "refusal") hasRefusal = true;
      }
    }
  }
  return { hasToolCall, hasRefusal };
}

function synthToolCallId(responseScope: string, index: number, toolName: string): string {
  return `synth:openai:${responseScope}:${index}:${toolName}`;
}

export function transformResponse(
  body: unknown,
  ctx: RequestContext & { requestedModel: string },
): TransformedResponse {
  const warnings: Warning[] = [];
  const wire = WireResponseSchema.parse(body);
  const origin = { provider: "openai", model: wire.model, surface: SURFACE };
  const output = wire.output ?? [];
  const blocks: Block[] = [];
  output.forEach((item, i) => {
    for (const block of itemToBlocks(item, warnings, `output[${i}]`)) {
      const itemId = typeof item["id"] === "string" && item["id"].length > 0 ? item["id"] : undefined;
      const blockIndex = blocks.length;
      const withIds: Block = { ...block, id: itemId ?? `blk_${blockIndex}`, origin };
      if (withIds.type === "toolCall" && withIds.toolCallId === "") {
        withIds.toolCallId = synthToolCallId(wire.id, i, withIds.toolName);
      }
      blocks.push(withIds);
    }
  });
  // message item의 파트 복수 시 id 충돌 방지 — itemId 동일 파트에 접미사
  const seen = new Map<string, number>();
  for (const b of blocks) {
    if (!b.id) continue;
    const n = seen.get(b.id) ?? 0;
    seen.set(b.id, n + 1);
    if (n > 0) b.id = `${b.id}:${n}`;
  }

  const { hasToolCall, hasRefusal } = scanOutput(output);
  return {
    blocks,
    origin,
    finishReason: mapResponsesFinishReason({
      status: wire.status ?? null,
      incompleteReason: wire.incomplete_details?.reason ?? null,
      hasToolCall,
      hasRefusal,
    }),
    usage: convertUsage(wire.usage as OpenAIWireUsage | undefined),
    providerRequestId: wire.id,
    warnings,
  };
}
