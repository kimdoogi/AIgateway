import type { Warning } from "../ir/common.js";
import type { IRError } from "../ir/error.js";
import type { IRRequest } from "../ir/request.js";
import type { Attempt, IRResponse } from "../ir/response.js";
import { TERMINAL_EVENT_SET } from "../ir/stream.js";
import type { Usage } from "../ir/usage.js";
import type { AdapterStreamEvent, OutboundAdapter, RequestContext, WireRequest } from "../adapters/types.js";
import { AdapterInvalidRequestError, makeWarning } from "../adapters/shared.js";
import { parseSSEStream } from "../stream/sse.js";
import { getProvider, resolveModel, selectSurface, type ProviderRuntime } from "./registry.js";
import { retargetRequest } from "./retarget.js";
import { GatewayError, irError, providerError, toIRError } from "./errors.js";
import { SessionStore, type StreamSession, type StreamEventDraft } from "./session.js";
import type { LedgerRow, UsageLedger } from "../state/types.js";
import { DEFAULT_RETRY, retryDelayMs, type RetryPolicy } from "../policy/retry.js";
import { estimateCostUSD, isPricedModel } from "./pricing.js";
import { withUpstreamTimeout } from "./http.js";
import { buildBilling, mergeBilling } from "../ops/billing.js";
import {
  endSpanError,
  stdoutMetaLog,
  tracer,
  warningCount,
  type MetaLogSink,
} from "./observability.js";

// 요청 실행기 v0 — 단일 target, 폴백 트리 없음 (로드맵 4). 코어에 프로바이더 분기문 금지 (D4).
// 스트림은 seq 없는 draft를 방출한다 — seq 발급은 세션(envelope 계층) 단독 (ir-v0 §13.1).
// 리트라이 범위: dispatch 단계(콘텐츠 방출 전)만 — mid-stream 재시도는 로드맵 4 폴백 트리 소관
// (problem log 2026-08-21 stage-7 항목).

export interface ExecuteDeps {
  /** 주입 시 반드시 init.signal을 존중해야 한다 — 무시하면 취소 터미널이 스트림 자연 종료까지 지연 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  genId?: () => string;
  /** usage 원장 (ADR-0006/0007) — 시도별 1행 append-only. 실패는 로그 강등, 요청 비차단 */
  ledger?: UsageLedger;
  /** 메타 로그 sink (ADR-0008 §1) — 기본 stdout JSON */
  metaLog?: MetaLogSink;
  sleep?: (ms: number) => Promise<void>;
  retry?: RetryPolicy;
  /** 업스트림 접속(헤더 수신까지) 타임아웃 — body 스트리밍에는 미적용. 기본 120s */
  upstreamTimeoutMs?: number;
  // ── 운영 평면 (ADR-0006/0007 — 2026-08-21) ──
  /** 인증 미들웨어가 해석한 테넌트 컨텍스트 — 원장 행에 병기 (정산 분리 기준) */
  tenantContext?: { tenant: string; keyId?: string; keySource?: "byo" | "pool" };
  /** 정책 레이어 사전 warning (예산 soft 등) — 응답/stream-start warnings에 병합 */
  preWarnings?: Warning[];
  /** 자격증명 결정자 — 기본 env 풀 키. BYO는 앱이 테넌트 키로 오버라이드 (ADR-0001 하이브리드) */
  credentials?: (rt: ProviderRuntime) => Record<string, string> | Promise<Record<string, string>>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function genRequestId(deps: ExecuteDeps = {}): string {
  return deps.genId?.() ?? `req_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 원장 + 메타 로그 동시 기록 — 관측 실패(동기 throw 포함)가 요청을 막지 않는다 (ADR-0006) */
function recordAttempt(
  deps: ExecuteDeps,
  row: LedgerRow,
  extra?: { providerRequestId?: string; warnings?: number; ttftMs?: number },
): void {
  try {
    // 가격표 근사 비용 병기 (ADR-0007 — raw usage로 재계산 가능)
    if (row.usage && row.costUsd === undefined) row = { ...row, costUsd: estimateCostUSD(row.model, row.usage) };
    deps.ledger?.record(row).catch((err) => console.error("[ledger]", err));
    (deps.metaLog ?? stdoutMetaLog)({
      requestId: row.requestId,
      attempt: row.attempt,
      provider: row.provider,
      model: row.model,
      surface: row.surface,
      stream: row.stream,
      outcome: row.outcome,
      httpStatus: row.httpStatus,
      finishReason: row.finishReason,
      errorCategory: row.errorCategory,
      providerRequestId: extra?.providerRequestId,
      totalTokens: row.usage?.totalTokens,
      billed: row.billed,
      durationMs: row.durationMs,
      ttftMs: extra?.ttftMs,
      warnings: extra?.warnings,
    });
  } catch (err) {
    console.error("[observability]", err);
  }
}

export function credentialHeaders(rt: ProviderRuntime): Record<string, string> {
  const secret = process.env[rt.auth.envVar];
  if (!secret) {
    // 설정 결함 = 게이트웨이 내부 결함
    throw new GatewayError(
      irError("auth", 500, `${rt.auth.envVar} 미설정 — ${rt.provider} 자격증명 없음`, {
        gatewayException: true,
      }),
    );
  }
  return { [rt.auth.header]: `${rt.auth.prefix ?? ""}${secret}` };
}

/**
 * 자격증명 해소 단일 지점 (ADR-0001 하이브리드): 테넌트 BYO 리졸버가 있으면 그것, 없으면 env 풀 키.
 * 실행부뿐 아니라 count_tokens·Files·Batches 브리지도 이 함수를 통과해야 한다 —
 * 직접 credentialHeaders를 부르면 BYO 테넌트가 풀 계정으로 나간다 (리뷰 2026-08-22).
 */
export async function resolveCredentials(
  rt: ProviderRuntime,
  deps: Pick<ExecuteDeps, "credentials">,
): Promise<Record<string, string>> {
  return deps.credentials ? await deps.credentials(rt) : credentialHeaders(rt);
}

interface PreparedCall {
  rt: ProviderRuntime;
  /** 표면 선택 결과 — 이 호출이 쓰는 어댑터 (ADR-0002 결과 절) */
  adapter: OutboundAdapter;
  ctx: RequestContext & { requestedModel: string };
  wire: WireRequest;
  transformWarnings: Warning[];
  created: string;
}

function prepare(req: IRRequest, deps: ExecuteDeps): PreparedCall {
  const route = resolveModel(req.model);
  const rt = getProvider(route.provider);
  // 재타게팅 패스 (ir-v0 §13.3) — 고아 tool 쌍·타깃 상이 서버 상태 PO 정규화, 어댑터 진입 전
  const { request: retargeted, warnings: retargetWarnings } = retargetRequest(req, route.provider);
  req = retargeted;
  // 표면 결정은 레지스트리 공통 규칙 + 프로바이더 소유 선택자 (D4 — 코어에 분기문 없음)
  const { adapter, warnings: surfaceWarnings } = selectSurface(rt, req, route);
  const ctx = {
    requestId: genRequestId(deps),
    modelId: route.modelId,
    requestedModel: req.model,
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
  };
  try {
    const { request, warnings } = adapter.transformRequest(req, ctx);
    // 가격표 미등재 모델은 근사 과금 — 조용히 넘기면 청구서가 소리 없이 틀어진다 (D5)
    const priceWarnings: Warning[] = isPricedModel(route.modelId)
      ? []
      : [
          makeWarning(
            "other",
            "billing-price-estimated",
            `${route.modelId}은 가격표 미등재 — billing·costUsd는 폴백 단가 근사입니다 (정산은 usage raw로 재계산 필요)`,
          ),
        ];
    return {
      rt,
      adapter,
      ctx,
      wire: request,
      transformWarnings: [...(deps.preWarnings ?? []), ...retargetWarnings, ...surfaceWarnings, ...priceWarnings, ...warnings],
      created: (deps.now?.() ?? new Date()).toISOString(),
    };
  } catch (err) {
    if (err instanceof AdapterInvalidRequestError) throw new GatewayError(err.irError);
    throw err;
  }
}

/** 원장 행 공통 필드 (리뷰 RU1-r4 — 4개 사이트 중복 해소). model은 라우팅 id로 통일 */
function rowBase(
  call: PreparedCall,
  deps: ExecuteDeps,
  attempt: number,
  stream: boolean,
  durationMs: number,
): Omit<LedgerRow, "outcome" | "billed"> {
  return {
    requestId: call.ctx.requestId,
    attempt,
    provider: call.adapter.provider,
    model: call.ctx.modelId,
    surface: call.adapter.surface,
    stream,
    durationMs,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    // 운영 평면 — 테넌트·키·소스 병기 (미들웨어 미설정 시 생략)
    ...(deps.tenantContext
      ? {
          tenant: deps.tenantContext.tenant,
          ...(deps.tenantContext.keyId ? { keyId: deps.tenantContext.keyId } : {}),
          ...(deps.tenantContext.keySource ? { keySource: deps.tenantContext.keySource } : {}),
        }
      : {}),
  };
}

async function dispatch(
  call: PreparedCall,
  deps: ExecuteDeps,
  signal: AbortSignal | undefined,
): Promise<Response> {
  // 접속 타임아웃 — 헤더 수신(fetch resolve)까지만. body 스트리밍은 타이머 해제 후 무영향 (리뷰 SW4-r4).
  // 정책은 gateway/http.ts 단일 지점 — 브리지·count_tokens도 같은 데코레이터를 쓴다
  const fetchImpl = withUpstreamTimeout(deps.fetchImpl ?? fetch, {
    ...(deps.upstreamTimeoutMs !== undefined ? { timeoutMs: deps.upstreamTimeoutMs } : {}),
    signal,
    label: `${call.adapter.provider}/${call.adapter.surface}`,
  });
  const auth = await resolveCredentials(call.rt, deps);
  return fetchImpl(`${call.rt.baseUrl}${call.wire.path}`, {
    method: call.wire.method,
    headers: { ...call.wire.headers, ...auth },
    body: JSON.stringify(call.wire.body),
  });
}

async function mapHttpErrorResponse(call: PreparedCall, response: Response): Promise<GatewayError> {
  const body: unknown = await response.json().catch(() => undefined); // 에러 body는 비JSON 허용
  return new GatewayError(
    call.adapter.mapHttpError(response.status, body, Object.fromEntries(response.headers)),
  );
}

interface DispatchResult {
  response: Response;
  attempt: number;
  attempts: Attempt[];
}

/**
 * 리트라이 정책 적용 dispatch (Retry-After 존중 + 단일 대기 상한, 같은 타깃만).
 * 재시도 확정 시도는 원장에 시도별 행 기록; 최종 실패는 호출측이 터미널로 1회 기록.
 * attempts는 클라이언트 노출용 시도 이력 (ir-v0 §7 gateway.attempts / finish.attempts).
 */
async function dispatchWithRetry(
  call: PreparedCall,
  deps: ExecuteDeps,
  signal: AbortSignal | undefined,
  stream: boolean,
): Promise<DispatchResult> {
  const policy = deps.retry ?? DEFAULT_RETRY;
  const sleep = deps.sleep ?? defaultSleep;
  const attempts: Attempt[] = [];
  const target = { provider: call.adapter.provider, model: call.ctx.modelId };
  for (let attempt = 1; ; attempt++) {
    const attemptStart = Date.now();
    let error: IRError | undefined;
    let raw: unknown;
    try {
      const response = await dispatch(call, deps, signal);
      if (response.ok) {
        attempts.push({ ...target, outcome: "success" });
        return { response, attempt, attempts };
      }
      raw = response; // !ok 매핑은 try 밖 — 어댑터 mapHttpError 결함을 재시도 대상으로 오분류 금지 (리뷰 B4-r4)
    } catch (err) {
      if (signal?.aborted) {
        const canceled =
          err instanceof GatewayError ? err : new GatewayError(irError("gateway_error", 499, "클라이언트 취소로 요청 중단"));
        canceled.attempt = attempt; // 원장 attempt 충돌 방지 (리뷰 F6-r4)
        throw canceled;
      }
      if (err instanceof GatewayError) {
        if (err.irError.category === "timeout") error = err.irError;
        else {
          err.attempt = attempt;
          throw err; // 자격증명 등 비재시도 게이트웨이 오류
        }
      } else {
        error = providerError(`업스트림 접속 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (error === undefined) {
      error = (await mapHttpErrorResponse(call, raw as Response)).irError;
    }
    const delay = retryDelayMs(error, attempt, policy);
    if (delay === null) {
      attempts.push({ ...target, outcome: "failed", error: error.category });
      const giveUp = new GatewayError(error); // 최종 실패는 호출측이 터미널로 1회 기록
      giveUp.attempt = attempt;
      giveUp.attempts = attempts;
      throw giveUp;
    }
    attempts.push({ ...target, outcome: "failed", error: error.category });
    // 재시도 확정 시도만 여기서 기록 (시도별 행 — 해당 시도 소요만)
    recordAttempt(deps, {
      ...rowBase(call, deps, attempt, stream, Date.now() - attemptStart),
      outcome: "error",
      httpStatus: error.httpStatus,
      errorCategory: error.category,
      billed: error.billed,
    });
    await sleep(delay); // ponytail: sleep은 abort 비인지 — 아래 체크가 커버, race 도입은 로드맵 4에서
    if (signal?.aborted) {
      const canceled = new GatewayError(irError("gateway_error", 499, "리트라이 대기 중 취소"));
      canceled.attempt = attempt;
      throw canceled;
    }
  }
}

// ── 비스트림 ─────────────────────────────────────────────
async function executeNonStreamTarget(
  req: IRRequest,
  deps: ExecuteDeps = {},
  signal?: AbortSignal,
): Promise<IRResponse> {
  const startedAt = Date.now();
  const call = prepare(req, deps);
  const span = tracer.startSpan("gateway.request", {
    attributes: {
      "gateway.request_id": call.ctx.requestId,
      "gateway.provider": call.adapter.provider,
      "gateway.model": call.ctx.modelId,
      "gateway.stream": false,
    },
  });

  let response: Response;
  let attempt = 1;
  let attempts: Attempt[] = [];
  try {
    ({ response, attempt, attempts } = await dispatchWithRetry(call, deps, signal, false));
  } catch (err) {
    const irErr = toIRError(err);
    if (err instanceof GatewayError && err.attempt !== undefined) attempt = err.attempt;
    recordAttempt(deps, {
      ...rowBase(call, deps, attempt, false, Date.now() - startedAt),
      outcome: irErr.httpStatus === 499 ? "canceled" : "error",
      httpStatus: irErr.httpStatus,
      errorCategory: irErr.category,
      billed: irErr.billed,
    });
    endSpanError(span, irErr.category, irErr.message);
    span.end();
    throw err instanceof GatewayError ? err : new GatewayError(irErr);
  }

  // 200 이후 실패도 과금된 시도 — 반드시 원장 기록 (리뷰 F2-r4 과금 유출)
  try {
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (signal?.aborted) throw new GatewayError(irError("gateway_error", 499, "클라이언트 취소로 응답 수신 중단"));
      throw new GatewayError(
        providerError(`응답 body 읽기 실패: ${err instanceof Error ? err.message : String(err)}`, call.adapter.provider, 200),
      );
    }

    let t: ReturnType<typeof call.adapter.transformResponse>;
    try {
      t = call.adapter.transformResponse(body, call.ctx);
    } catch (err) {
      if (err instanceof AdapterInvalidRequestError) throw new GatewayError(err.irError);
      throw new GatewayError(
        providerError(`응답 변환 실패: ${err instanceof Error ? err.message : String(err)}`, call.adapter.provider, 200),
      );
    }

    const warnings = [...call.transformWarnings, ...t.warnings];
    recordAttempt(
      deps,
      {
        ...rowBase(call, deps, attempt, false, Date.now() - startedAt),
        outcome: "success",
        httpStatus: 200,
        finishReason: t.finishReason.unified,
        usage: t.usage,
        billed: true,
      },
      { providerRequestId: t.providerRequestId, warnings: warningCount(warnings) },
    );
    span.setAttribute("gateway.finish_reason", t.finishReason.unified);
    span.setAttribute("gateway.total_tokens", t.usage.totalTokens);
    span.end();
    return {
      version: "0",
      id: call.ctx.requestId,
      created: call.created,
      model: {
        requested: call.ctx.requestedModel,
        resolved: { provider: t.origin.provider, model: t.origin.model, surface: t.origin.surface ?? call.adapter.surface },
      },
      message: { role: "assistant", blocks: t.blocks, origin: t.origin },
      finishReason: t.finishReason,
      usage: t.usage,
      billing: buildBilling(call.adapter.provider, call.ctx.modelId, t.usage), // ADR-0007 §1
      warnings,
      gateway: {
        requestId: call.ctx.requestId,
        ...(t.providerRequestId ? { providerRequestId: t.providerRequestId } : {}),
        ...(attempts.length > 1 ? { attempts } : {}), // 리트라이 발생 시 시도 이력 노출 (ir-v0 §7)
      },
      ...(t.providerMetadata ? { providerMetadata: t.providerMetadata } : {}),
    };
  } catch (err) {
    const irErr = toIRError(err);
    recordAttempt(deps, {
      ...rowBase(call, deps, attempt, false, Date.now() - startedAt),
      outcome: irErr.httpStatus === 499 ? "canceled" : "error",
      httpStatus: irErr.httpStatus,
      errorCategory: irErr.category,
      billed: irErr.httpStatus === 499 ? false : true, // 200 수신 = 과금 발생 (취소는 수신 중단)
    });
    endSpanError(span, irErr.category, irErr.message);
    span.end();
    throw err;
  }
}

// ── 스트림 ───────────────────────────────────────────────
export type { StreamEventDraft };

export interface StreamOptions {
  /** stream-start.warnings에 병합할 게이트웨이 발신 경고 (§10.1 — stream-start가 지정석) */
  extraWarnings?: Warning[];
  /** abort 시 터미널의 error 본문 공급자 — 세션의 abortReason 라벨링 */
  abortDetail?: () => IRError;
}

/** 어댑터 draft → 게이트웨이 draft (seq 없음 — 세션이 발급). envelope 소유 필드 enrich (§13.1) */
function finalizeDraft(draft: AdapterStreamEvent, call: PreparedCall, contentEmitted: boolean): StreamEventDraft {
  if (draft.type === "provider-error") {
    // 절단 경로(아래 catch)와 같은 규칙: 콘텐츠 방출 후면 기방출분이 유효하므로 partial.
    // final로 접으면 클라이언트가 이미 받은 유효 델타를 폐기한다 (ir-v0 §10 의미론)
    return contentEmitted
      ? { type: "error-partial", error: draft.error, usage: draft.usage, willRetry: false }
      : { type: "error-final", error: draft.error, usage: draft.usage };
  }
  if (draft.type === "finish") {
    return { ...draft, billing: buildBilling(call.adapter.provider, call.ctx.modelId, draft.usage) }; // ADR-0007 §1
  }
  if (draft.type === "response-metadata") {
    return {
      type: "response-metadata",
      id: call.ctx.requestId,
      created: call.created,
      model: { requested: call.ctx.requestedModel, resolved: draft.model.resolved },
      ...(draft.providerRequestId ? { providerRequestId: draft.providerRequestId } : {}),
      ...(draft.providerMetadata ? { providerMetadata: draft.providerMetadata } : {}),
    };
  }
  return draft as StreamEventDraft;
}

/** §10.2 콘텐츠 이벤트 여부 — 절단 터미널의 partial/final 판정 기준 (리뷰 SW6-r4) */
const LIFECYCLE_TYPES = new Set(["stream-start", "response-metadata", "warning", "heartbeat", "usage-interim", "raw"]);

/**
 * 스트림 실행 — seq 없는 StreamEventDraft async generator (seq는 세션이 스탬프).
 * 터미널 보장: 모든 실패 경로가 터미널 draft로 끝난다 (ADR-0005).
 * 절단 분류: 콘텐츠 방출 후 = error-partial(기방출분 유효) / 방출 전 = error-final.
 */
async function* executeStreamTarget(
  req: IRRequest,
  deps: ExecuteDeps = {},
  signal?: AbortSignal,
  options: StreamOptions = {},
): AsyncGenerator<StreamEventDraft> {
  const startedAt = Date.now();
  const call = prepare(req, deps); // prepare 실패는 호출측(startStreamSession) 소관 — throw
  const span = tracer.startSpan("gateway.stream", {
    attributes: {
      "gateway.request_id": call.ctx.requestId,
      "gateway.provider": call.adapter.provider,
      "gateway.model": call.ctx.modelId,
      "gateway.stream": true,
    },
  });

  let terminal = false;
  let attempt = 1;
  let attempts: Attempt[] = [];
  let contentEmitted = false;
  let ttftMs: number | undefined;
  let providerRequestId: string | undefined;

  const abortBase = (): IRError => options.abortDetail?.() ?? irError("gateway_error", 499, "업스트림 취소 (ADR-0005)");

  /** 터미널 draft → 원장 행 (스트림 회계 단일 지점). 리트라이 시 finish에 attempts 노출 */
  const recordTerminal = (event: StreamEventDraft): StreamEventDraft => {
    const error = event.type === "error-final" || event.type === "error-partial" ? event.error : undefined;
    const usage = event.type === "finish" || event.type === "error-final" || event.type === "error-partial" ? event.usage : undefined;
    recordAttempt(
      deps,
      {
        ...rowBase(call, deps, attempt, true, Date.now() - startedAt),
        outcome: event.type === "finish" ? "success" : error?.httpStatus === 499 ? "canceled" : "error",
        httpStatus: error?.httpStatus ?? (event.type === "finish" ? 200 : undefined),
        finishReason: event.type === "finish" ? event.finishReason.unified : undefined,
        errorCategory: error?.category,
        usage,
        billed: error ? error.billed : true,
      },
      { providerRequestId, ttftMs, warnings: warningCount(call.transformWarnings) },
    );
    if (error) endSpanError(span, error.category, error.message);
    span.end();
    if (event.type === "finish" && attempts.length > 1) return { ...event, attempts }; // §10.1 finish.attempts
    return event;
  };

  const emit = (event: StreamEventDraft): StreamEventDraft => {
    if (event.type === "response-metadata" && event.providerRequestId) providerRequestId = event.providerRequestId;
    if (!contentEmitted && !LIFECYCLE_TYPES.has(event.type) && !TERMINAL_EVENT_SET.has(event.type)) {
      contentEmitted = true;
      ttftMs = Date.now() - startedAt; // TTFT (ADR-0008 §1)
    }
    if (TERMINAL_EVENT_SET.has(event.type)) {
      terminal = true;
      return recordTerminal(event);
    }
    return event;
  };

  // stream-start는 첫 이벤트 (§10.1) — 게이트웨이 발신 경고도 여기 병합
  yield emit({
    type: "stream-start",
    warnings: [...(options.extraWarnings ?? []), ...call.transformWarnings],
  });

  let response: Response;
  try {
    ({ response, attempt, attempts } = await dispatchWithRetry(call, deps, signal, true));
  } catch (err) {
    if (err instanceof GatewayError && err.attempt !== undefined) attempt = err.attempt;
    if (err instanceof GatewayError && err.attempts !== undefined) attempts = err.attempts;
    if (signal?.aborted) {
      yield emit({ type: "error-partial", error: abortBase(), willRetry: false });
    } else {
      yield emit({ type: "error-final", error: toIRError(err) });
    }
    return;
  }

  const transformer = call.adapter.createStreamTransformer({
    modelId: call.ctx.modelId,
    ...(req.streamOptions?.includeRaw ? { includeRaw: true } : {}),
    ...(call.ctx.capabilities ? { capabilities: call.ctx.capabilities } : {}),
  });

  try {
    const body = response.body;
    if (!body) throw new Error("응답 body 없음");
    for await (const frame of parseSSEStream(body)) {
      for (const draft of transformer.onEvent(frame.event, frame.data)) {
        yield emit(finalizeDraft(draft, call, contentEmitted));
        if (terminal) return;
      }
    }
    // 종료 신호 없는 절단 — 어댑터의 터미널 보장 경로 (try 안 — 어댑터 throw도 catch가 수습)
    for (const draft of transformer.onStreamEnd()) {
      yield emit(finalizeDraft(draft, call, contentEmitted));
      if (terminal) return;
    }
  } catch (err) {
    if (terminal) return;
    if (signal?.aborted) {
      // 취소로 인한 절단. 어댑터 flush 대칭 처리: 콘텐츠 draft 방출, 회계는 abort 터미널에 회수
      let harvested: { billed: boolean; usage?: Usage } | undefined;
      try {
        for (const draft of transformer.onStreamEnd()) {
          if (draft.type === "provider-error") {
            harvested = { billed: draft.error.billed, ...(draft.usage ? { usage: draft.usage } : {}) };
          } else {
            const finalized = finalizeDraft(draft, call, contentEmitted);
            if (!TERMINAL_EVENT_SET.has(finalized.type)) yield emit(finalized); // 터미널은 abort 라벨로 대체
          }
        }
      } catch {
        /* 어댑터 flush 실패 — 기본 abort 터미널로 진행 */
      }
      const error = { ...abortBase(), ...(harvested ? { billed: harvested.billed } : {}) };
      // 콘텐츠 유무로 partial/final 구분 (기방출 이벤트 유효 의미론 — 리뷰 SW6-r4)
      yield emit(
        contentEmitted
          ? { type: "error-partial", error, usage: harvested?.usage, willRetry: false }
          : { type: "error-final", error, usage: harvested?.usage },
      );
      return;
    }
    const error = providerError(`스트림 소비 중단: ${err instanceof Error ? err.message : String(err)}`);
    yield emit(
      contentEmitted
        ? { type: "error-partial", error, willRetry: false }
        : { type: "error-final", error },
    );
  }
}

// ── 크로스 프로바이더 폴백 트리 (ir-v0 §6.4, 폴백 경합 매트릭스) ──────────
// 각 타깃은 완전한 독립 시도 — 타깃별 재타게팅·표면 선택·어댑터 변환·리트라이를 다시 통과.
// 진행 조건: fallbackEligible && !gatewayException && !취소(499). skip: pinned 불일치·자격증명 부재.

function fallbackTargets(req: IRRequest): string[] {
  const seen = new Set<string>();
  return [req.model, ...(req.fallbackModels ?? [])].filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
}

function providerOf(target: string): string {
  try {
    return resolveModel(target).provider;
  } catch {
    return "unknown";
  }
}

/** 타깃 사전 skip 판정 (§6.4) — 사유 문자열 반환, 시도 가능하면 undefined */
async function skipReason(target: string, req: IRRequest, deps: ExecuteDeps): Promise<string | undefined> {
  let provider: string;
  try {
    provider = resolveModel(target).provider;
  } catch (err) {
    return `라우팅 불가: ${err instanceof Error ? err.message : String(err)}`; // 폴백 타깃 오타가 요청 전체를 죽이지 않게
  }
  if (req.passthroughParams?.pinned && provider !== req.passthroughParams.provider) {
    return `pinned passthrough(${req.passthroughParams.provider}) — 타깃 프로바이더 불일치 (D10 보장 유지)`;
  }
  try {
    const rt = getProvider(provider);
    await resolveCredentials(rt, deps); // BYO/풀 해소 불가 타깃은 skip (매트릭스 BYO 행)
  } catch (err) {
    return `자격증명 해소 불가: ${err instanceof Error ? err.message : String(err)}`;
  }
  return undefined;
}

/** 폴백 타깃용 요청 구성 — model 치환 + 비-pinned passthrough 불일치는 드롭+warning (§13.3) */
function targetRequest(req: IRRequest, target: string, warnings: Warning[]): IRRequest {
  const { fallbackModels: _chain, ...rest } = req;
  let out: IRRequest = { ...rest, model: target };
  if (out.passthroughParams && providerOf(target) !== out.passthroughParams.provider) {
    warnings.push(
      makeWarning(
        "unsupported",
        "passthrough-params-dropped",
        `passthroughParams(${out.passthroughParams.provider})는 폴백 타깃 ${target}과 불일치 — 드롭 (§13.3)`,
      ),
    );
    const { passthroughParams: _pp, ...noPass } = out;
    out = noPass;
  }
  return out;
}

function canFallback(irErr: IRError, aborted: boolean | undefined): boolean {
  return irErr.fallbackEligible && irErr.gatewayException !== true && irErr.httpStatus !== 499 && !aborted;
}

export async function executeNonStream(
  req: IRRequest,
  deps: ExecuteDeps = {},
  signal?: AbortSignal,
): Promise<IRResponse> {
  const targets = fallbackTargets(req);
  if (targets.length === 1) return executeNonStreamTarget(req, deps, signal);

  const requestId = genRequestId(deps);
  const fixedDeps = { ...deps, genId: () => requestId }; // 전 타깃이 같은 req_ 공유 (원장 상관관계)
  const priorAttempts: Attempt[] = [];
  let lastErr: unknown;

  for (const [i, target] of targets.entries()) {
    const skip = await skipReason(target, req, fixedDeps);
    if (skip !== undefined) {
      priorAttempts.push({ provider: providerOf(target), model: target, outcome: "skipped", error: skip });
      continue;
    }
    const dropWarnings: Warning[] = [];
    const targetReq = i === 0 ? req : targetRequest(req, target, dropWarnings);
    const targetDeps =
      dropWarnings.length > 0
        ? { ...fixedDeps, preWarnings: [...(fixedDeps.preWarnings ?? []), ...dropWarnings] }
        : fixedDeps;
    try {
      const res = await executeNonStreamTarget(targetReq, targetDeps, signal);
      if (priorAttempts.length === 0) return res;
      const successAttempts: Attempt[] = res.gateway.attempts ?? [
        { provider: res.model.resolved.provider, model: target, outcome: "success" },
      ];
      return { ...res, gateway: { ...res.gateway, attempts: [...priorAttempts, ...successAttempts] } };
    } catch (err) {
      lastErr = err;
      const irErr = toIRError(err);
      priorAttempts.push({ provider: providerOf(target), model: target, outcome: "failed", error: irErr.category });
      if (!(canFallback(irErr, signal?.aborted) && i < targets.length - 1)) throw err;
    }
  }
  if (lastErr) throw lastErr; // 마지막 타깃까지 실패 (루프가 rethrow하므로 도달 안 하지만 방어)
  throw new GatewayError(irError("invalid_request", 400, "모든 폴백 타깃이 skip됨 (pinned/자격증명 — ir-v0 §6.4)"));
}

export async function* executeStream(
  req: IRRequest,
  deps: ExecuteDeps = {},
  signal?: AbortSignal,
  options: StreamOptions = {},
): AsyncGenerator<StreamEventDraft> {
  const targets = fallbackTargets(req);
  if (targets.length === 1) {
    yield* executeStreamTarget(req, deps, signal, options);
    return;
  }

  const requestId = genRequestId(deps);
  const fixedDeps = { ...deps, genId: () => requestId };
  const priorAttempts: Attempt[] = [];
  // 과금된 실패 시도의 billing 누적 — finish에서 최종 시도분과 합산 (ir-v0 §10.1, 감사 #2/#31)
  const billedPrior: ReturnType<typeof buildBilling>[] = [];
  let streamStartSent = false;
  let contentForwarded = false;

  for (const [i, target] of targets.entries()) {
    const skip = await skipReason(target, req, fixedDeps);
    if (skip !== undefined) {
      priorAttempts.push({ provider: providerOf(target), model: target, outcome: "skipped", error: skip });
      continue;
    }
    const dropWarnings: Warning[] = [];
    const targetReq = i === 0 ? req : targetRequest(req, target, dropWarnings);
    const targetDeps =
      dropWarnings.length > 0
        ? { ...fixedDeps, preWarnings: [...(fixedDeps.preWarnings ?? []), ...dropWarnings] }
        : fixedDeps;
    let switched = false;
    try {
      for await (const event of executeStreamTarget(targetReq, targetDeps, signal, options)) {
        if (event.type === "stream-start") {
          if (!streamStartSent) {
            streamStartSent = true;
            yield event;
          } else {
            // stream-start는 1회 (§10.1) — 후속 타깃의 변환 경고는 warning 이벤트로 전달
            for (const warning of event.warnings) yield { type: "warning", warning };
          }
          continue;
        }
        if (event.type === "error-final" && !contentForwarded && i < targets.length - 1 && canFallback(event.error, signal?.aborted)) {
          // 콘텐츠 방출 전 실패 → 무중단 전환 (§6.4). 원장 행은 타깃 내부에서 이미 적재됨
          priorAttempts.push({ provider: providerOf(target), model: target, outcome: "failed", error: event.error.category });
          if (event.error.billed && event.usage) {
            billedPrior.push(buildBilling(providerOf(target), target, event.usage));
          }
          yield {
            type: "error-partial",
            error: event.error,
            ...(event.usage ? { usage: event.usage } : {}),
            willRetry: true,
          };
          yield {
            type: "provider-switched",
            from: { provider: providerOf(target), model: target },
            to: { provider: providerOf(targets[i + 1]!), model: targets[i + 1]! },
            reason: `${event.error.category} — 폴백 체인 진행 (ir-v0 §6.4)`,
          };
          switched = true;
          break;
        }
        if (event.type === "finish" && priorAttempts.length > 0) {
          const successAttempts: Attempt[] = event.attempts ?? [
            { provider: providerOf(target), model: target, outcome: "success" },
          ];
          // §10.1: billing = 과금된 전 시도 합산 (원장 시도별 행과 합계 일치)
          const billing =
            billedPrior.length > 0 && event.billing ? mergeBilling([...billedPrior, event.billing]) : event.billing;
          yield { ...event, ...(billing ? { billing } : {}), attempts: [...priorAttempts, ...successAttempts] };
          return;
        }
        if (!LIFECYCLE_TYPES.has(event.type) && !TERMINAL_EVENT_SET.has(event.type)) contentForwarded = true;
        yield event;
        if (TERMINAL_EVENT_SET.has(event.type)) return;
      }
    } catch (err) {
      // 타깃 generator throw (prepare 실패 등). 1차 타깃 prepare 실패는 기존 계약대로 전파
      const irErr = toIRError(err);
      if (!streamStartSent && i === 0 && !(canFallback(irErr, signal?.aborted) && i < targets.length - 1)) throw err;
      priorAttempts.push({ provider: providerOf(target), model: target, outcome: "failed", error: irErr.category });
      if (canFallback(irErr, signal?.aborted) && i < targets.length - 1) {
        if (streamStartSent) {
          yield { type: "error-partial", error: irErr, willRetry: true };
          yield {
            type: "provider-switched",
            from: { provider: providerOf(target), model: target },
            to: { provider: providerOf(targets[i + 1]!), model: targets[i + 1]! },
            reason: `${irErr.category} — 폴백 체인 진행 (ir-v0 §6.4)`,
          };
        }
        continue;
      }
      if (!streamStartSent) yield { type: "stream-start", warnings: options.extraWarnings ?? [] };
      yield { type: "error-final", error: irErr };
      return;
    }
    if (!switched) return; // 타깃이 자체 터미널로 종결 (finish/error-partial 등 — 위에서 반환)
  }

  // 전 타깃 skip — 명시적 실패 (매트릭스 BYO 행: 전 타깃 skip 시 에러 반환)
  if (!streamStartSent) yield { type: "stream-start", warnings: options.extraWarnings ?? [] };
  yield {
    type: "error-final",
    error: irError("invalid_request", 400, "모든 폴백 타깃이 skip됨 (pinned/자격증명 — ir-v0 §6.4)"),
  };
}

// ── 스트림 세션 오케스트레이션 (게이트웨이 소관 — compat 인바운드가 재사용) ──
export interface StreamSessionDeps extends ExecuteDeps {
  sessions: SessionStore;
  heartbeatMs?: number;
}

const HEARTBEAT_MS = 15_000;
const HEARTBEAT_MAX_SECONDS = 3600; // setInterval 2^31ms 오버플로 방지 상한 (ir-v0 §6 등재)

/**
 * 세션 생성 + 펌프 + heartbeat 가동. 펌프 예외도 터미널로 수렴 (터미널 보장).
 * heartbeat 주기: 클라이언트 지정(streamOptions.heartbeatSeconds, 상한 클램프+warning — D5) > 기본 15s.
 */
export function startStreamSession(req: IRRequest, deps: StreamSessionDeps): StreamSession {
  const id = genRequestId(deps);
  // 소유 테넌트를 세션에 새긴다 — 재개·취소 권한 검사 기준 (ADR-0006 §3)
  const session = deps.sessions.create(id, deps.tenantContext?.tenant);

  let heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const extraWarnings: Warning[] = [];
  const requested = req.streamOptions?.heartbeatSeconds;
  if (requested !== undefined) {
    if (requested > HEARTBEAT_MAX_SECONDS) {
      heartbeatMs = HEARTBEAT_MAX_SECONDS * 1000;
      extraWarnings.push(
        makeWarning(
          "compatibility",
          "parameter-clamped",
          `heartbeatSeconds ${requested} → ${HEARTBEAT_MAX_SECONDS} 클램프 (게이트웨이 상한 — ir-v0 §6)`,
          "streamOptions.heartbeatSeconds",
        ),
      );
    } else {
      heartbeatMs = requested * 1000;
    }
  }
  const heartbeat = setInterval(() => session.appendHeartbeat(), heartbeatMs);
  heartbeat.unref?.();

  const streamOptions: StreamOptions = {
    extraWarnings,
    abortDetail: () => session.abortError(),
  };

  void (async () => {
    try {
      for await (const draft of executeStream(req, { ...deps, genId: () => id }, session.upstreamSignal, streamOptions)) {
        session.append(draft);
        if (session.isDone) break;
      }
    } catch (err) {
      // prepare 실패·펌프 내부 예외 — 터미널 보장 + 원장/메타 기록 (리뷰 E3-r4)
      const irErr = toIRError(err);
      recordAttempt(deps, {
        requestId: id,
        attempt: 1,
        provider: "unknown", // prepare 전 실패 — 라우팅 미확정
        model: req.model,
        surface: "unknown",
        stream: true,
        outcome: "error",
        httpStatus: irErr.httpStatus,
        errorCategory: irErr.category,
        billed: false,
        durationMs: 0,
        createdAt: (deps.now?.() ?? new Date()).toISOString(),
      });
      if (!session.isDone) {
        session.append({ type: "error-final", error: irErr });
      } else {
        console.error(`[gateway] 스트림 ${id} done 이후 펌프 예외:`, err);
      }
    } finally {
      clearInterval(heartbeat);
      session.end(); // 터미널 부재 시 방어 터미널 적재 (원장 미기록 — session.end가 로그)
    }
  })();

  return session;
}
