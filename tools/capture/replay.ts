import { parseSSEText } from "../../src/stream/sse.js";
import { createStreamTransformer } from "../../src/adapters/anthropic/stream.js";
import type { AdapterStreamEvent, StreamContext, StreamTransformer } from "../../src/adapters/types.js";
import type { Usage } from "../../src/ir/usage.js";

// 픽스처 재생 유틸 (walking-skeleton 4단계). 골든셋 ②(SSE 재생 → IR 이벤트 스냅샷)와
// 하네스의 비용 계산이 공유한다 — usage 산출식은 어댑터만 가지므로 재생으로 얻는다.

/** raw SSE 텍스트를 어댑터 상태 머신에 통과시켜 IR 이벤트 draft 배열을 얻는다 */
export function replayStream(text: string, transformer: StreamTransformer): AdapterStreamEvent[] {
  const events: AdapterStreamEvent[] = [];
  for (const frame of parseSSEText(text)) {
    events.push(...transformer.onEvent(frame.event, frame.data));
  }
  events.push(...transformer.onStreamEnd());
  return events;
}

export function replayAnthropicStream(text: string, ctx: StreamContext): AdapterStreamEvent[] {
  return replayStream(text, createStreamTransformer(ctx));
}

/** 터미널 이벤트에서 usage 추출 (과금 집계용 — 절단 스트림의 provider-error도 usage를 싣는다) */
export function usageFromEvents(events: readonly AdapterStreamEvent[]): Usage | undefined {
  for (const event of events) {
    if (event.type === "finish") return event.usage;
    if (event.type === "provider-error" && event.usage) return event.usage;
  }
  return undefined;
}
