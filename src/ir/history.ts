import type { Block } from "./blocks.js";
import type { Message } from "./message.js";
import type { IRResponse } from "./response.js";
import type { NS } from "./common.js";

// ir-v0 §13.1 — 히스토리 편입 계약: 응답 블록의 providerMetadata → providerOptions 복사,
// origin·opaqueState 보존. providerMetadata 키는 자기 요청측 PO 스키마가 수용해야 한다는
// 왕복 불변식(G1)이 이 변환의 전제다.

function mergeNS(metadata: NS | undefined, options: NS | undefined): NS | undefined {
  if (!metadata && !options) return undefined;
  const merged: NS = {};
  for (const [ns, obj] of Object.entries(metadata ?? {})) merged[ns] = { ...obj };
  // 기존 providerOptions가 있으면 그것이 우선 (클라이언트 명시 지시 > 응답 메타)
  for (const [ns, obj] of Object.entries(options ?? {})) merged[ns] = { ...(merged[ns] ?? {}), ...obj };
  return merged;
}

export function blockToHistory(block: Block): Block {
  const { providerMetadata, providerOptions, ...rest } = block;
  const merged = mergeNS(providerMetadata, providerOptions);
  return (merged ? { ...rest, providerOptions: merged } : rest) as Block;
}

/**
 * 응답 message를 히스토리 assistant 메시지로 변환.
 * 빈 blocks 응답은 히스토리 메시지를 생성하지 않는다 — null 반환, 호출자는 해당 턴 생략
 * (ir-v0 §13.1 빈 응답 규칙 — MessageSchema.min(1)과의 왕복 정합).
 */
export function responseToHistoryMessage(response: IRResponse): Message | null {
  if (response.message.blocks.length === 0) return null;
  return {
    role: "assistant",
    blocks: response.message.blocks.map(blockToHistory),
    origin: response.message.origin,
  };
}
