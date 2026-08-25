import { z } from "zod";
import type { JSONValue } from "../../../ir/json.js";
import type { Block } from "../../../ir/blocks.js";
import type { Warning } from "../../../ir/common.js";
import type { RequestContext, TransformedResponse } from "../../types.js";
import { makeWarning } from "../../shared.js";
import { convertUsage, mapChatFinishReason, type OpenAIWireUsage } from "../errors.js";
import { mapAnnotation, parseToolArguments } from "../responses/response.js";

// OpenAI Chat Completions wire 응답 → IR. 단일 후보(G2) — choices[0]만, 이후는 드롭+warning.

export const SURFACE = "chat-completions";

const WireResponseSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  choices: z.array(z.record(z.string(), z.unknown())),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export function messageToBlocks(
  message: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): Block[] {
  const blocks: Block[] = [];

  // xAI CC 확장 (base 상속 — 인벤토리 B2-6): reasoning 요약이 별도 필드로. OpenAI는 미발행.
  // 서명 없는 평문 요약 — opaqueState 없음 (encrypted reasoning은 responses 표면 전용)
  const reasoningContent = message["reasoning_content"];
  if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
    blocks.push({ type: "reasoning", text: reasoningContent });
  }

  const content = message["content"];
  if (typeof content === "string" && content.length > 0) {
    const annotationsRaw = message["annotations"];
    // CC annotation은 {type:"url_citation", url_citation:{...}} 래핑 — 내부 객체엔 type이 없어
    // 언랩만 하면 mapAnnotation이 빈 file 인용으로 변조한다 (감사 2026-08-24 #4). type을 승계.
    const citations = Array.isArray(annotationsRaw)
      ? annotationsRaw.map((a) => {
          const ann = (a ?? {}) as Record<string, unknown>;
          const inner = ann["url_citation"];
          return mapAnnotation(
            inner && typeof inner === "object"
              ? { type: ann["type"] ?? "url_citation", ...(inner as Record<string, unknown>) }
              : ann,
          );
        })
      : [];
    blocks.push({ type: "text", text: content, ...(citations.length > 0 ? { citations } : {}) });
  }

  const refusal = message["refusal"];
  if (typeof refusal === "string" && refusal.length > 0) {
    blocks.push({ type: "text", text: refusal, providerMetadata: { openai: { refusal: true } } });
  }

  const audio = message["audio"];
  if (audio && typeof audio === "object") {
    const a = audio as Record<string, unknown>;
    if (typeof a["data"] === "string") {
      blocks.push({
        type: "file",
        mediaType: "audio/wav",
        data: { type: "base64", data: a["data"] },
        providerMetadata: { openai: { audio: a as JSONValue } },
      });
    }
  }

  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach((raw, ti) => {
      const tc = (raw ?? {}) as Record<string, unknown>;
      const fn = (tc["function"] ?? {}) as Record<string, unknown>;
      const name = typeof fn["name"] === "string" ? fn["name"] : "";
      if (name.length === 0) {
        warnings.push(
          makeWarning("compatibility", "unknown-block-passthrough", "name 없는 tool_call — passthrough 보존", `${path}.tool_calls[${ti}]`),
        );
        blocks.push({ type: "passthrough", provider: "openai", raw: tc as JSONValue });
        return;
      }
      blocks.push({
        type: "toolCall",
        toolCallId: typeof tc["id"] === "string" && tc["id"].length > 0 ? tc["id"] : "",
        toolName: name,
        input: parseToolArguments(String(fn["arguments"] ?? ""), name, warnings),
      });
    });
  }
  return blocks;
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

  if (wire.choices.length > 1) {
    warnings.push(makeWarning("unsupported", "block-dropped", `choices ${wire.choices.length}개 중 첫 번째만 사용 (G2 단일 후보)`));
  }
  const choice = (wire.choices[0] ?? {}) as Record<string, unknown>;
  const message = (choice["message"] ?? {}) as Record<string, unknown>;

  const blocks: Block[] = [];
  messageToBlocks(message, warnings, "choices[0].message").forEach((block, i) => {
    const withIds: Block = { ...block, id: `blk_${i}`, origin };
    if (withIds.type === "toolCall" && withIds.toolCallId === "") {
      withIds.toolCallId = synthToolCallId(wire.id, i, withIds.toolName);
    }
    blocks.push(withIds);
  });

  return {
    blocks,
    origin,
    finishReason: mapChatFinishReason(
      typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null,
    ),
    usage: convertUsage(wire.usage as OpenAIWireUsage | undefined),
    providerRequestId: wire.id,
    warnings,
  };
}
