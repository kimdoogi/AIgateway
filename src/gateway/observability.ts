import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import type { Warning } from "../ir/common.js";

// 관측성 skeleton (ADR-0008): 메타데이터 로그(본문 없음, 항상 on) + OTel API 계측.
// SDK/익스포터 미등록 시 span은 no-op — "나중에 붙이면 계측 공백" 방지용 API 선배선.
// 본문 로그 파이프라인은 로드맵 5 (grounding 제외·마스킹 훅 선행 조건 — ADR-0008 §6).

export const tracer = trace.getTracer("ai-gateway", "0.0.1");

/** 메타 로그 1행 (ADR-0008 §1 — request-id·모델·usage 요약·상태·레이턴시·warning, 본문 금지) */
export interface MetaLogEntry {
  requestId: string;
  attempt: number;
  provider: string;
  model: string;
  surface?: string;
  stream: boolean;
  outcome: "success" | "error" | "canceled";
  httpStatus?: number;
  finishReason?: string;
  errorCategory?: string;
  providerRequestId?: string;
  totalTokens?: number;
  billed?: boolean;
  durationMs: number;
  /** 첫 콘텐츠 이벤트까지 (스트림 전용 — ADR-0008 §1 TTFT) */
  ttftMs?: number;
  warnings?: number;
}

export type MetaLogSink = (entry: MetaLogEntry) => void;

/** 기본 sink — 구조화 JSON 1행 stdout (수집기는 배포 환경 소관) */
export const stdoutMetaLog: MetaLogSink = (entry) => {
  console.log(JSON.stringify({ log: "gateway.request", ...entry }));
};

export function warningCount(warnings: Warning[] | undefined): number | undefined {
  return warnings && warnings.length > 0 ? warnings.length : undefined;
}

export function endSpanError(span: Span, category: string, message: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: category });
  span.setAttribute("gateway.error.category", category);
  span.setAttribute("gateway.error.message", message);
}
