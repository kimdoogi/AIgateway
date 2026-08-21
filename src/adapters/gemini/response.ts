import { createHash } from "node:crypto";
import { z } from "zod";
import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { Citation, Warning } from "../../ir/common.js";
import type { RequestContext, TransformedResponse } from "../types.js";
import { AdapterInvalidRequestError, makeWarning } from "../shared.js";
import { convertUsage, mapFinishReason, mapGeminiError, promptBlockedError, type GeminiWireUsage } from "./errors.js";

// Gemini GenerateContentResponse → IR (ir-v0 §7/§13, 인벤토리 §C·E-1·F-3).
// 미지 part는 passthrough + warning (§4.9). promptFeedback soft-block은 IRError 승격 (§12).

const WireResponseSchema = z.looseObject({
  candidates: z.array(z.record(z.string(), z.unknown())).optional(),
  promptFeedback: z.record(z.string(), z.unknown()).optional(),
  usageMetadata: z.record(z.string(), z.unknown()).optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
});

/** §13.2 — id 미발급(generateContent) 툴콜의 결정론적 합성 id */
export function synthToolCallId(responseScope: string, index: number, toolName: string): string {
  return `synth:google:${responseScope}:${index}:${toolName}`;
}

/** responseId 부재 시 응답 콘텐츠 SHA-256 앞 8자 (§13.2 — 랜덤 금지) */
export function fallbackResponseScope(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts ?? "")).digest("hex").slice(0, 8);
}

/** part 1건 → IR 블록 (스트림과 공유하는 단일 매핑 — 증분 병합은 스트림 소관) */
export function partToBlock(
  raw: Record<string, unknown>,
  warnings: Warning[],
  path: string,
): Block | null {
  const signature =
    typeof raw["thoughtSignature"] === "string" && raw["thoughtSignature"].length > 0
      ? { provider: "google", data: raw["thoughtSignature"] }
      : undefined;

  if (raw["thought"] === true) {
    return {
      type: "reasoning",
      text: String(raw["text"] ?? ""),
      ...(signature ? { opaqueState: signature } : {}),
    };
  }
  if (typeof raw["text"] === "string") {
    // 빈 text + signature는 보존 (§10.2 프루닝 금지 — Gemini 3 재전송 요구), 순수 빈 text는 스킵
    if (raw["text"].length === 0 && !signature) return null;
    return { type: "text", text: raw["text"], ...(signature ? { opaqueState: signature } : {}) };
  }
  const fc = raw["functionCall"];
  if (fc && typeof fc === "object") {
    const call = fc as Record<string, unknown>;
    const name = typeof call["name"] === "string" && call["name"].length > 0 ? call["name"] : undefined;
    if (!name) {
      warnings.push(
        makeWarning("compatibility", "unknown-block-passthrough", "name 없는 functionCall — passthrough 보존", path),
      );
      return { type: "passthrough", provider: "google", raw: raw as JSONValue };
    }
    return {
      type: "toolCall",
      // generateContent는 id 미발급 (Live/Interactions만) — "" → 호출측이 합성 (§13.2)
      toolCallId: typeof call["id"] === "string" && call["id"].length > 0 ? call["id"] : "",
      toolName: name,
      input: { type: "json", value: (call["args"] ?? {}) as JSONValue },
      ...(signature ? { opaqueState: signature } : {}),
    };
  }
  const inline = raw["inlineData"];
  if (inline && typeof inline === "object") {
    const d = inline as Record<string, unknown>;
    return {
      type: "file",
      mediaType: String(d["mimeType"] ?? "application/octet-stream"),
      data: { type: "base64", data: String(d["data"] ?? "") },
      ...(signature ? { opaqueState: signature } : {}), // 미디어 part 서명도 왕복 보존 (C-2)
    };
  }
  const fileData = raw["fileData"];
  if (fileData && typeof fileData === "object") {
    const d = fileData as Record<string, unknown>;
    return {
      type: "file",
      mediaType: String(d["mimeType"] ?? "application/octet-stream"),
      data: { type: "reference", refs: { google: String(d["fileUri"] ?? "") } },
      ...(signature ? { opaqueState: signature } : {}),
    };
  }
  // 서버 툴 아티팩트 — custom 블록 무변경 라운드트립 (ir-v0 §15)
  if (raw["executableCode"] !== undefined) {
    return { type: "custom", kind: "google.executable_code", payload: raw as JSONValue };
  }
  if (raw["codeExecutionResult"] !== undefined) {
    return { type: "custom", kind: "google.code_execution_result", payload: raw as JSONValue };
  }
  // 미지 part → passthrough + warning (§4.9 — day-1 보존)
  warnings.push(
    makeWarning(
      "compatibility",
      "unknown-block-passthrough",
      `미지의 gemini part (키: ${Object.keys(raw).join(",")}) — passthrough로 보존`,
      path,
    ),
  );
  return { type: "passthrough", provider: "google", raw: raw as JSONValue };
}

interface GroundingChunkRef {
  url?: string;
  title?: string;
}

function readGroundingChunks(gm: Record<string, unknown>): GroundingChunkRef[] {
  const chunks = Array.isArray(gm["groundingChunks"]) ? gm["groundingChunks"] : [];
  return chunks.map((c) => {
    const web = (c as Record<string, unknown>)?.["web"];
    if (web && typeof web === "object") {
      const w = web as Record<string, unknown>;
      return {
        ...(typeof w["uri"] === "string" ? { url: w["uri"] } : {}),
        ...(typeof w["title"] === "string" ? { title: w["title"] } : {}),
      };
    }
    return {};
  });
}

/** groundingSupports → 표준 Citation (ir-v0 §4.8 — Gemini segment 수용). partIndex별로 묶어 반환 */
export function mapGroundingCitations(gm: Record<string, unknown>): Map<number, Citation[]> {
  const chunks = readGroundingChunks(gm);
  const byPart = new Map<number, Citation[]>();
  const supports = Array.isArray(gm["groundingSupports"]) ? gm["groundingSupports"] : [];
  for (const s of supports) {
    const support = s as Record<string, unknown>;
    const segment = (support["segment"] ?? {}) as Record<string, unknown>;
    const partIndex = typeof segment["partIndex"] === "number" ? segment["partIndex"] : 0;
    // proto3 zero-omission: startIndex 0(응답 선두 세그먼트 — 최빈 케이스)은 wire에서 생략된다 → 0 기본값
    const start = typeof segment["startIndex"] === "number" ? segment["startIndex"] : 0;
    const end = typeof segment["endIndex"] === "number" ? segment["endIndex"] : undefined;
    const citedText = typeof segment["text"] === "string" ? segment["text"] : undefined;
    const indices = Array.isArray(support["groundingChunkIndices"]) ? support["groundingChunkIndices"] : [];
    for (const i of indices) {
      const ref = typeof i === "number" ? chunks[i] : undefined;
      const citation: Citation = {
        source: { type: "url", ...(ref?.url ? { url: ref.url } : {}), ...(ref?.title ? { title: ref.title } : {}) },
        ...(citedText ? { citedText } : {}),
        ...(start !== undefined && end !== undefined && end >= start
          ? { location: { type: "char", start, end } }
          : {}),
      };
      const list = byPart.get(partIndex) ?? [];
      list.push(citation);
      byPart.set(partIndex, list);
    }
  }
  return byPart;
}

/** groundingChunks → source 블록 (§4.6 — 응답 방향 전용) */
export function groundingSourceBlocks(gm: Record<string, unknown>): Extract<Block, { type: "source" }>[] {
  return readGroundingChunks(gm)
    .filter((ref) => ref.url !== undefined || ref.title !== undefined)
    .map((ref) => ({
      type: "source" as const,
      sourceType: "url" as const,
      ...(ref.url ? { url: ref.url } : {}),
      ...(ref.title ? { title: ref.title } : {}),
    }));
}

export function transformResponse(
  body: unknown,
  ctx: RequestContext & { requestedModel: string },
): TransformedResponse {
  const warnings: Warning[] = [];
  // HTTP 200에 실려온 google.rpc 에러 body (프록시/엣지 변조 등) — 빈 성공으로 둔갑 금지,
  // 스트림 경로(in-stream error 승격)와 대칭으로 IRError 승격
  if (typeof body === "object" && body !== null) {
    const errRaw = (body as Record<string, unknown>)["error"];
    if (errRaw && typeof errRaw === "object") {
      const code = (errRaw as Record<string, unknown>)["code"];
      throw new AdapterInvalidRequestError("gemini 200 응답 body가 에러 형태 — 승격", {
        irError: mapGeminiError(typeof code === "number" ? code : 502, body),
      });
    }
  }
  const wire = WireResponseSchema.parse(body);

  const candidates = wire.candidates ?? [];
  const first = candidates[0];
  const content = (first?.["content"] ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content["parts"]) ? (content["parts"] as Record<string, unknown>[]) : [];

  // HTTP 200 soft-block 승격 (ir-v0 §12 — promptFeedback.blockReason + 생성물 없음)
  const blockReason = (wire.promptFeedback ?? {})["blockReason"];
  if (typeof blockReason === "string" && parts.length === 0) {
    throw new AdapterInvalidRequestError(`gemini 프롬프트 차단 (${blockReason})`, {
      irError: promptBlockedError(blockReason, body),
    });
  }
  if (candidates.length > 1) {
    warnings.push(
      makeWarning("unsupported", "block-dropped", `candidates[1..${candidates.length - 1}] 드롭 — IR은 단일 후보 (G2)`),
    );
  }

  const origin = { provider: "google", model: wire.modelVersion ?? ctx.modelId, surface: "generate-content" };
  // "" responseId는 부재 취급 — providerRequestId(하단)·스트림 경로와 동일 기준 (3원 불일치 해소)
  const responseScope =
    wire.responseId && wire.responseId.length > 0 ? wire.responseId : fallbackResponseScope(parts);
  const blocks: Block[] = [];
  const partIndexToBlock = new Map<number, Block>(); // grounding citation 부착용 (partIndex 기준)

  parts.forEach((raw, i) => {
    const block = partToBlock(raw, warnings, `candidates[0].content.parts[${i}]`);
    if (!block) return;
    const withIds: Block = { ...block, id: `blk_${blocks.length}`, origin };
    if (withIds.type === "toolCall" && withIds.toolCallId === "") {
      withIds.toolCallId = synthToolCallId(responseScope, i, withIds.toolName);
    }
    partIndexToBlock.set(i, withIds);
    blocks.push(withIds);
  });

  // grounding (인벤토리 E-1): 원문은 PM 무수정 보존 (TOS — 로그·캐시 제외는 관측성 소관),
  // 표준 Citation + source 블록 병행 (§4.8/§4.6)
  const gm = first?.["groundingMetadata"];
  let providerMetadata: JSONObject | undefined;
  if (gm && typeof gm === "object") {
    const gmObj = gm as Record<string, unknown>;
    for (const [partIndex, citations] of mapGroundingCitations(gmObj)) {
      const target = partIndexToBlock.get(partIndex);
      if (target && target.type === "text") {
        target.citations = [...(target.citations ?? []), ...citations];
      }
    }
    for (const src of groundingSourceBlocks(gmObj)) {
      blocks.push({ ...src, id: `blk_${blocks.length}`, origin });
    }
    providerMetadata = { groundingMetadata: gm as JSONValue };
  }
  const urlMeta = first?.["urlContextMetadata"];
  if (urlMeta && typeof urlMeta === "object") {
    providerMetadata = { ...(providerMetadata ?? {}), urlContextMetadata: urlMeta as JSONValue };
  }

  const hasClientToolCall = blocks.some((b) => b.type === "toolCall" && !b.providerExecuted);
  const finishRaw = typeof first?.["finishReason"] === "string" ? (first["finishReason"] as string) : undefined;

  return {
    blocks,
    origin,
    finishReason: mapFinishReason(finishRaw, hasClientToolCall),
    usage: convertUsage((wire.usageMetadata ?? {}) as GeminiWireUsage),
    ...(wire.responseId ? { providerRequestId: wire.responseId } : {}),
    ...(providerMetadata ? { providerMetadata: { google: providerMetadata } } : {}),
    warnings,
  };
}
