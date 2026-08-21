import type { Block } from "../ir/blocks.js";
import type { NS, Warning } from "../ir/common.js";
import type { IRRequest } from "../ir/request.js";
import type { Message } from "../ir/message.js";
import { makeWarning } from "../adapters/shared.js";

// 재타게팅 패스 v0 (ir-v0 §13.3, ADR-0001 D6) — 어댑터 진입 전 히스토리 정규화.
// 코어 규칙만 여기서: ① 고아 tool 쌍 정리(D6-10) ② 타깃 상이 서버 상태 PO 드롭(§13.3).
// 블록별 이식성(reasoning 정책, passthrough/custom drop, file reference)은 어댑터가
// origin 기반으로 처리한다 — 프로바이더 지식이 필요하기 때문 (D4).
// 표면 sticky 판별은 registry.selectSurface 소관.

/** 서버 상태 참조 PO 키 (§13.3 데이터 테이블 — 프로바이더 지식이지만 분기문이 아닌 데이터) */
const SERVER_STATE_KEYS: Record<string, readonly string[]> = {
  anthropic: ["container"],
  openai: ["previousResponseId", "conversation", "store", "background"],
  xai: ["previousResponseId", "store"],
};

function stripServerStatePO(
  po: NS | undefined,
  target: string,
  path: string,
  warnings: Warning[],
): NS | undefined {
  if (!po) return po;
  let changed = false;
  const out: NS = {};
  for (const [ns, obj] of Object.entries(po)) {
    if (ns === target) {
      out[ns] = obj;
      continue;
    }
    const stateKeys = SERVER_STATE_KEYS[ns];
    if (!stateKeys) {
      out[ns] = obj;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (stateKeys.includes(k)) {
        changed = true;
        warnings.push(
          makeWarning(
            "compatibility",
            "server-state-inapplicable",
            `타깃(${target})에 적용 불가한 서버 상태 참조 ${ns}.${k} 드롭 (§13.3 — 조용한 무시 금지)`,
            `${path}.${ns}.${k}`,
          ),
        );
      } else {
        kept[k] = v;
      }
    }
    if (Object.keys(kept).length > 0) out[ns] = kept as NS[string];
    else changed = true;
  }
  return changed ? out : po;
}

/**
 * D6-10 — 고아 tool 쌍 정리. 짝 없는 toolResult / 결과 없는 toolCall은 프로바이더 400의
 * 원인이므로 쌍 단위로 제거 + warning(tool-pair-repaired). providerExecuted는 쌍 계약 밖.
 * 마지막 assistant 턴의 toolCall은 예외 — 진행 중 툴 루프(결과가 이번 요청에 없음)일 수 있어
 * 제거하지 않는다 (제거하면 정상 루프가 망가진다).
 */
function repairToolPairs(messages: readonly Message[], warnings: Warning[]): Message[] | null {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  let lastAssistantWithCalls = -1;
  messages.forEach((msg, mi) => {
    for (const b of msg.blocks) {
      if (b.type === "toolCall" && !b.providerExecuted) {
        callIds.add(b.toolCallId);
        if (msg.role === "assistant") lastAssistantWithCalls = mi;
      }
      if (b.type === "toolResult" && !b.providerExecuted) resultIds.add(b.toolCallId);
    }
  });

  const dropCall = (id: string, mi: number): boolean =>
    !resultIds.has(id) && mi !== lastAssistantWithCalls;
  const dropResult = (id: string): boolean => !callIds.has(id);

  let changed = false;
  const repaired: Message[] = [];
  messages.forEach((msg, mi) => {
    const blocks: Block[] = [];
    msg.blocks.forEach((b, bi) => {
      if (b.type === "toolCall" && !b.providerExecuted && dropCall(b.toolCallId, mi)) {
        changed = true;
        warnings.push(
          makeWarning(
            "compatibility",
            "tool-pair-repaired",
            `결과 없는 toolCall(${b.toolName}) 제거 (D6-10)`,
            `messages[${mi}].blocks[${bi}]`,
          ),
        );
        return;
      }
      if (b.type === "toolResult" && !b.providerExecuted && dropResult(b.toolCallId)) {
        changed = true;
        warnings.push(
          makeWarning(
            "compatibility",
            "tool-pair-repaired",
            `짝 없는 toolResult(${b.toolName}) 제거 (D6-10)`,
            `messages[${mi}].blocks[${bi}]`,
          ),
        );
        return;
      }
      blocks.push(b);
    });
    // 블록이 전부 제거된 메시지는 생략 (MessageSchema.min(1) — §13.1 빈 응답 규칙과 동일 취지)
    if (blocks.length > 0) repaired.push(blocks === msg.blocks ? msg : { ...msg, blocks });
    else changed = true;
  });
  return changed ? repaired : null;
}

export interface RetargetResult {
  request: IRRequest;
  warnings: Warning[];
}

/** 어댑터 진입 전 정규화 — 순수 함수, 입력 불변 */
export function retargetRequest(req: IRRequest, targetProvider: string): RetargetResult {
  const warnings: Warning[] = [];

  const repairedMessages = repairToolPairs(req.messages, warnings);
  let messages = repairedMessages ?? req.messages;

  // 서버 상태 PO — envelope·메시지·블록 3레벨
  const envPO = stripServerStatePO(req.providerOptions, targetProvider, "providerOptions", warnings);
  let msgChanged = false;
  const strippedMessages = messages.map((msg, mi) => {
    const msgPO = stripServerStatePO(msg.providerOptions, targetProvider, `messages[${mi}].providerOptions`, warnings);
    let blockChanged = false;
    const blocks = msg.blocks.map((b, bi) => {
      // 부록 (a) §3.3 — 타깃 상이 캐시 브레이크포인트는 조용히 사라지므로 보고 (키는 유지)
      const anthroPO = b.providerOptions?.["anthropic"];
      if (targetProvider !== "anthropic" && anthroPO && (anthroPO["cacheControl"] ?? anthroPO["cache_control"])) {
        warnings.push(
          makeWarning(
            "compatibility",
            "cache-breakpoint-ignored",
            `타깃(${targetProvider})은 anthropic cache_control을 해석하지 않음 — 캐시 지시 무효`,
            `messages[${mi}].blocks[${bi}]`,
          ),
        );
      }
      const bPO = stripServerStatePO(b.providerOptions, targetProvider, `messages[${mi}].blocks[${bi}].providerOptions`, warnings);
      if (bPO === b.providerOptions) return b;
      blockChanged = true;
      const { providerOptions: _po, ...rest } = b;
      return (bPO && Object.keys(bPO).length > 0 ? { ...rest, providerOptions: bPO } : rest) as Block;
    });
    if (msgPO === msg.providerOptions && !blockChanged) return msg;
    msgChanged = true;
    const next: Message = { ...msg, blocks };
    if (msgPO && Object.keys(msgPO).length > 0) next.providerOptions = msgPO;
    else delete next.providerOptions;
    return next;
  });
  if (msgChanged) messages = strippedMessages;

  if (messages === req.messages && envPO === req.providerOptions && repairedMessages === null) {
    return { request: req, warnings }; // warning만 발생한 경우(캐시 브레이크포인트 등)도 이 경로
  }
  const request: IRRequest = { ...req, messages };
  if (envPO && Object.keys(envPO).length > 0) request.providerOptions = envPO;
  else if (envPO !== req.providerOptions) delete request.providerOptions;
  return { request, warnings };
}
