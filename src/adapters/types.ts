import type { JSONObject, JSONValue } from "../ir/json.js";
import type { Block } from "../ir/blocks.js";
import type { NS, Origin, Warning } from "../ir/common.js";
import type { FinishReason } from "../ir/finish.js";
import type { Usage } from "../ir/usage.js";
import type { IRError } from "../ir/error.js";
import type { IRRequest } from "../ir/request.js";
import type { ResolvedModel } from "../ir/response.js";
import type { StreamEvent } from "../ir/stream.js";

// ADR-0001 D4 — 어댑터 계약: 순수 변환 함수 + 명시적 스트림 상태 머신.
// 코어에 프로바이더 분기문 금지 — 프로바이더 지식(프레이밍·경로·헤더)은 전부 여기 속성으로.

export interface WireRequest {
  method: "POST";
  path: string; // base URL 제외. 인증 헤더는 credential resolver가 주입 (어댑터는 비밀을 만지지 않는다)
  headers: Record<string, string>;
  body: JSONObject;
}

export interface TransformedRequest {
  request: WireRequest;
  warnings: Warning[];
}

export interface TransformedResponse {
  blocks: Block[];
  origin: Origin;
  finishReason: FinishReason;
  usage: Usage;
  providerRequestId?: string;
  providerMetadata?: NS;
  warnings: Warning[];
}

/**
 * 레지스트리 이관 경로 예약 (리뷰 A3, D10-4): 모델×기능 게이트는 레지스트리 소관이며,
 * 레지스트리 완성 전까지 게이트웨이가 이 힌트로 어댑터에 공급한다. 힌트 부재 시
 * 어댑터는 안전측 기본값을 쓴다.
 */
export interface AdapterCapabilities {
  /** messages 배열 내 mid-conversation system 지원 여부 — 모델별 값은 레지스트리가 공급 */
  midConversationSystem?: boolean;
  /** 모델이 수용하는 effort 값 집합 — 밖의 값은 클램프 + warning */
  supportedEfforts?: readonly string[];
  /** 필수 max tokens 부재 시 주입할 모델별 기본값 */
  defaultMaxTokens?: number;
  /**
   * 모델이 400으로 거부하는 IR 표준 파라미터 이름 (예: OpenAI reasoning 모델의
   * temperature/topP/penalties). 어댑터는 wire 조립 전 드롭 + warning(parameter-dropped),
   * strictParameters면 4xx (shared.gateUnsupportedParams).
   */
  unsupportedParams?: readonly string[];
  /**
   * 모델이 접근 가능한 표면 집합 (예: gpt-5-pro = ["responses"], gpt-audio-* = ["chat-completions"]).
   * 미지정이면 프로바이더의 전 표면 허용. 표면 선택자의 게이트 입력 (ADR-0002 결과 절).
   */
  surfaces?: readonly string[];
}

/**
 * 표면 선택자 (ADR-0002/0004 — 이중 표면 프로바이더).
 * 선택 기준(어떤 기능이 어느 표면 전용인가)은 프로바이더 지식이므로 어댑터 쪽이 소유하고,
 * 코어는 결과만 소비한다 (D4). sticky·capability 게이트·warning 조립은 코어(registry) 소관.
 */
export interface SurfaceChoiceInput {
  request: IRRequest;
  modelId: string;
  capabilities?: AdapterCapabilities;
}

export interface SurfaceChoice {
  /** 이 요청에 적합한 표면 */
  surface: string;
  /** true = 요청 기능이 이 표면을 강제한다 (sticky보다 우선, 전환 시 warning) */
  required?: boolean;
  /** 강제 사유 — warning 메시지에 실린다 */
  reason?: string;
}

export type SurfaceSelector = (input: SurfaceChoiceInput) => SurfaceChoice;

export interface RequestContext {
  requestId: string;
  /** 레지스트리가 해석한 프로바이더 모델 id (v0 skeleton은 IR model 그대로) */
  modelId: string;
  capabilities?: AdapterCapabilities;
}

/**
 * seq는 게이트웨이가 부여 — 어댑터는 seq 없는 draft를 방출한다 (ir-v0 §10).
 * response-metadata는 추가로 id/created/model.requested도 게이트웨이가 enrich한다
 * (ir-v0 §13.1 스트림 draft enrich 계약 — 어댑터는 wire에서만 얻는 것만 싣는다).
 */
type DraftOf<T> = T extends { seq: number } ? Omit<T, "seq"> : never;

export interface ResponseMetadataDraft {
  type: "response-metadata";
  model: { resolved: ResolvedModel };
  providerRequestId?: string;
  /** wire 선두에서만 얻는 고유 메타 (Anthropic message_start.container 등 — §10.1) */
  providerMetadata?: NS;
}

// 게이트웨이 세션의 StreamEventDraft(전체 이벤트 Omit seq)와 다른 타입 — 동명 오임포트 방지 개명 (리뷰 RU3-r3)
export type AdapterEventDraft =
  | DraftOf<Exclude<StreamEvent, { type: "response-metadata" }>>
  | ResponseMetadataDraft;

/**
 * 프로바이더 레벨 오류 — error-partial/final 판정(폴백 여부)은 게이트웨이 소관.
 * usage: 과금이 발생한 시도는 반드시 포함 (ADR-0005 — 산출 근거는 어댑터만 가짐, 리뷰 R2)
 */
export type AdapterStreamEvent =
  | AdapterEventDraft
  | { type: "provider-error"; error: IRError; usage?: Usage };

export interface StreamContext {
  modelId: string;
  /** streamOptions.includeRaw — 프로바이더 원문 이벤트를 raw 이벤트로 병행 방출 */
  includeRaw?: boolean;
  capabilities?: AdapterCapabilities;
}

export interface StreamTransformer {
  /** 프레이밍 지식은 어댑터 소유 (Portkey 코어 누수 반면교사) */
  readonly framing: "sse" | "ndjson" | "json-array" | "aws-eventstream";
  /** 프레이밍 파서가 분리한 이벤트 1건을 IR 이벤트 draft로 변환 */
  onEvent(eventName: string | undefined, data: string): AdapterStreamEvent[];
  /**
   * 프로바이더가 종료 신호 없이 스트림을 끊었을 때 — 터미널 보장은 게이트웨이+어댑터 공동 책임.
   * 계약: 터미널 미방출 상태의 첫 호출은 터미널을 방출해야 하고, 터미널 이후·반복 호출은
   * 빈 배열이어야 한다 (멱등 — adapter-conformance가 검증, 재생 유틸이 무조건 호출).
   */
  onStreamEnd(): AdapterStreamEvent[];
}

/** 부록 (b) §1 — count_tokens 프록시 결과 */
export interface CountTokensResult {
  inputTokens: number;
  providerMetadata?: NS;
  raw: JSONValue;
}

export interface OutboundAdapter {
  readonly provider: string;
  readonly surface: string;
  transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest;
  transformResponse(body: unknown, ctx: RequestContext & { requestedModel: string }): TransformedResponse;
  createStreamTransformer(ctx: StreamContext): StreamTransformer;
  mapHttpError(status: number, body: unknown, headers?: Record<string, string>): IRError;
  /** 옵셔널 (부록 (b) §1) — 미구현 프로바이더는 게이트웨이가 501 (조용한 추정 금지, D5) */
  countTokens?: {
    transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest;
    transformResponse(body: unknown): CountTokensResult;
  };
}
