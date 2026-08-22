import type { JSONObject, JSONValue } from "../ir/json.js";
import type { Warning } from "../ir/common.js";
import type { IRError } from "../ir/error.js";
import type { FinishReason } from "../ir/finish.js";
import type { Usage } from "../ir/usage.js";
import type { IRRequest } from "../ir/request.js";
import type { Message } from "../ir/message.js";
import type { WireRequest } from "../adapters/types.js";
import { AdapterInvalidRequestError } from "../adapters/shared.js";
import type { BatchJob, BatchStore, UsageLedger } from "../state/types.js";
import { genRequestId, resolveCredentials, type ExecuteDeps } from "../gateway/execute.js";
import { GatewayError, irError } from "../gateway/errors.js";
import { getProvider, resolveModel, selectSurface, type ProviderRuntime } from "../gateway/registry.js";
import { retargetRequest } from "../gateway/retarget.js";
import { buildBilling } from "../ops/billing.js";
import { DEFAULT_TENANT } from "./files.js";

// Batches 브리지 (부록 (b) §3) — 항목 wire는 어댑터의 같은 순수 변환을 재사용하고,
// 브리지는 잡 수명·custom_id 매핑·상태 정규화만 소유한다. 4사 wire 차이는 데이터 테이블 (D4).
// 배치 = 단일 프로바이더·단일 표면 (§3.1 — 크로스 fan-out은 2차).
// wire 검증 현황 (smoke:batches): anthropic 전 수명주기·google/xai 생성~취소 실검증(2026-08-22),
// openai는 키 확보 대기. 완료·결과 경로 실검증은 anthropic만 (problem log).

export interface BatchBridgeDeps extends ExecuteDeps {
  batches: BatchStore;
  ledger?: UsageLedger;
  /** 미설정 시 "default" */
  tenant?: string;
  /** 발급 가상 키 — 원장 행 귀속·예산 집계 기준 (ADR-0007 §3) */
  keyId?: string;
  keySource?: "byo" | "pool";
}

export interface BatchItemInput {
  customId: string;
  request: IRRequest;
}

export interface BatchEnvelope {
  id: string;
  provider: string;
  status: string;
  rawStatus?: string;
  counts: BatchJob["counts"];
  createdAt: string;
  expiresAt?: string;
}

export interface BatchResultItem {
  customId: string;
  response?: {
    message: { role: "assistant"; blocks: Message["blocks"]; origin: NonNullable<Message["origin"]> };
    finishReason: FinishReason;
    usage: Usage;
    warnings: Warning[];
  };
  error?: IRError;
}

interface PreparedItem {
  customId: string;
  model: string;
  wire: WireRequest;
  warnings: Warning[];
}

interface CreateResult {
  providerBatchId: string;
  rawStatus?: string;
  bridgeState?: Record<string, string>;
  expiresAt?: string;
}

interface PollResult {
  status: string; // 정규화 (부록 (b) §3.3)
  rawStatus: string;
  counts?: Partial<BatchJob["counts"]>;
  bridgeState?: Record<string, string>;
}

interface RawResultItem {
  customId: string;
  /** 200 상당 wire 응답 body — 어댑터 transformResponse로 정규화 */
  wireBody?: unknown;
  /** 항목 실패 — mapHttpError로 정규화 */
  wireError?: { status: number; body: unknown };
  /** canceled/expired 등 응답 없는 종결 */
  terminal?: "canceled" | "expired";
}

type BatchAuth = Record<string, string>;

interface BatchProviderOps {
  /** 배치가 요구하는 표면 (어댑터 선택 검증용). null = 표면 선택자 결과 사용 */
  surface: string | null;
  // auth는 호출측이 해소해 주입한다 (테넌트 BYO > env 풀 — resolveCredentials)
  create(items: PreparedItem[], rt: ProviderRuntime, auth: BatchAuth, fetchImpl: typeof fetch): Promise<CreateResult>;
  poll(job: BatchJob, rt: ProviderRuntime, auth: BatchAuth, fetchImpl: typeof fetch): Promise<PollResult>;
  results(job: BatchJob, rt: ProviderRuntime, auth: BatchAuth, fetchImpl: typeof fetch): Promise<RawResultItem[]>;
  cancel(job: BatchJob, rt: ProviderRuntime, auth: BatchAuth, fetchImpl: typeof fetch): Promise<void>;
}

async function jsonOrThrow(provider: string, res: Response, action: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GatewayError({
      category: res.status === 404 ? "not_found" : res.status === 401 ? "auth" : "provider_error",
      httpStatus: res.status,
      message: `${provider} 배치 ${action} 실패 (HTTP ${res.status})`,
      fallbackEligible: false,
      billed: false,
      provider: { key: provider, status: res.status, raw: body.slice(0, 2000) },
    });
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

function parseJsonl(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── 상태 정규화 (부록 (b) §3.3 — 개방형: 미지 값은 other + raw 보존) ──
const STATUS_MAP: Record<string, string> = {
  // anthropic
  in_progress: "in_progress",
  canceling: "canceling",
  ended: "completed", // 세부는 counts로 (부분 취소 포함)
  // openai
  validating: "validating",
  finalizing: "finalizing",
  completed: "completed",
  failed: "failed",
  expired: "expired",
  cancelling: "canceling",
  cancelled: "canceled",
  // google
  BATCH_STATE_PENDING: "in_progress",
  BATCH_STATE_RUNNING: "in_progress",
  BATCH_STATE_SUCCEEDED: "completed",
  BATCH_STATE_FAILED: "failed",
  BATCH_STATE_CANCELLED: "canceled",
  BATCH_STATE_EXPIRED: "expired",
  // xai
  pending: "in_progress",
  running: "in_progress",
  done: "completed",
  canceled: "canceled",
};

function normalizeStatus(raw: string): string {
  return STATUS_MAP[raw] ?? "other";
}

const anthropicHeaders = { "anthropic-version": "2023-06-01" };

const BATCH_PROVIDERS: Record<string, BatchProviderOps> = {
  anthropic: {
    surface: "messages",
    async create(items, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/messages/batches`, {
        method: "POST",
        headers: { "content-type": "application/json", ...anthropicHeaders, ...auth },
        body: JSON.stringify({ requests: items.map((i) => ({ custom_id: i.customId, params: i.wire.body })) }),
      });
      const body = await jsonOrThrow("anthropic", res, "생성");
      return {
        providerBatchId: String(body["id"] ?? ""),
        rawStatus: String(body["processing_status"] ?? "in_progress"),
        ...(typeof body["expires_at"] === "string" ? { expiresAt: body["expires_at"] } : {}),
      };
    },
    async poll(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/messages/batches/${job.providerBatchId}`, {
        headers: { ...anthropicHeaders, ...auth },
      });
      const body = await jsonOrThrow("anthropic", res, "조회");
      const raw = String(body["processing_status"] ?? "in_progress");
      const rc = (body["request_counts"] ?? {}) as Record<string, unknown>;
      const num = (k: string): number => (typeof rc[k] === "number" ? (rc[k] as number) : 0);
      const state: Record<string, string> = {};
      if (typeof body["results_url"] === "string") state["resultsUrl"] = body["results_url"];
      return {
        status: normalizeStatus(raw),
        rawStatus: raw,
        counts: { succeeded: num("succeeded"), errored: num("errored"), canceled: num("canceled"), expired: num("expired") },
        ...(Object.keys(state).length > 0 ? { bridgeState: state } : {}),
      };
    },
    async results(job, rt, auth, fetchImpl) {
      const url = job.bridgeState?.["resultsUrl"] ?? `${rt.baseUrl}/v1/messages/batches/${job.providerBatchId}/results`;
      const res = await fetchImpl(url, { headers: { ...anthropicHeaders, ...auth } });
      if (!res.ok) await jsonOrThrow("anthropic", res, "결과");
      const lines = parseJsonl(await res.text());
      return lines.map((line) => {
        const customId = String(line["custom_id"] ?? "");
        const result = (line["result"] ?? {}) as Record<string, unknown>;
        const type = result["type"];
        if (type === "succeeded") return { customId, wireBody: result["message"] };
        if (type === "errored") return { customId, wireError: { status: 400, body: result["error"] } };
        return { customId, terminal: (type === "expired" ? "expired" : "canceled") as "expired" | "canceled" };
      });
    },
    async cancel(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/messages/batches/${job.providerBatchId}/cancel`, {
        method: "POST",
        headers: { ...anthropicHeaders, ...auth },
      });
      await jsonOrThrow("anthropic", res, "취소");
    },
  },

  openai: {
    surface: "responses",
    async create(items, rt, auth, fetchImpl) {
      // JSONL 업로드(purpose: batch) → 배치 생성 (인벤토리 — 파일 기반 구조)
      const jsonl = items
        .map((i) => JSON.stringify({ custom_id: i.customId, method: "POST", url: "/v1/responses", body: i.wire.body }))
        .join("\n");
      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "batch-input.jsonl");
      const up = await fetchImpl(`${rt.baseUrl}/v1/files`, { method: "POST", headers: auth, body: form });
      const upBody = await jsonOrThrow("openai", up, "입력 파일 업로드");
      const inputFileId = String(upBody["id"] ?? "");

      const res = await fetchImpl(`${rt.baseUrl}/v1/batches`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ input_file_id: inputFileId, endpoint: "/v1/responses", completion_window: "24h" }),
      });
      const body = await jsonOrThrow("openai", res, "생성");
      return {
        providerBatchId: String(body["id"] ?? ""),
        rawStatus: String(body["status"] ?? "validating"),
        bridgeState: { inputFileId },
      };
    },
    async poll(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/batches/${job.providerBatchId}`, { headers: auth });
      const body = await jsonOrThrow("openai", res, "조회");
      const raw = String(body["status"] ?? "in_progress");
      const rc = (body["request_counts"] ?? {}) as Record<string, unknown>;
      const completed = typeof rc["completed"] === "number" ? (rc["completed"] as number) : 0;
      const failed = typeof rc["failed"] === "number" ? (rc["failed"] as number) : 0;
      const state: Record<string, string> = { ...(job.bridgeState ?? {}) };
      if (typeof body["output_file_id"] === "string") state["outputFileId"] = body["output_file_id"];
      if (typeof body["error_file_id"] === "string") state["errorFileId"] = body["error_file_id"];
      return {
        status: normalizeStatus(raw),
        rawStatus: raw,
        counts: { succeeded: completed, errored: failed, canceled: 0, expired: 0 },
        bridgeState: state,
      };
    },
    async results(job, rt, auth, fetchImpl) {
      const out: RawResultItem[] = [];
      for (const key of ["outputFileId", "errorFileId"] as const) {
        const fileId = job.bridgeState?.[key];
        if (!fileId) continue;
        const res = await fetchImpl(`${rt.baseUrl}/v1/files/${fileId}/content`, { headers: auth });
        if (!res.ok) await jsonOrThrow("openai", res, "결과 파일");
        for (const line of parseJsonl(await res.text())) {
          const customId = String(line["custom_id"] ?? "");
          const response = (line["response"] ?? {}) as Record<string, unknown>;
          const statusCode = typeof response["status_code"] === "number" ? (response["status_code"] as number) : 0;
          if (line["error"] != null) {
            out.push({ customId, wireError: { status: statusCode || 500, body: line["error"] } });
          } else if (statusCode === 200) {
            out.push({ customId, wireBody: response["body"] });
          } else {
            out.push({ customId, wireError: { status: statusCode || 500, body: response["body"] } });
          }
        }
      }
      return out;
    },
    async cancel(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/batches/${job.providerBatchId}/cancel`, {
        method: "POST",
        headers: auth,
      });
      await jsonOrThrow("openai", res, "취소");
    },
  },

  google: {
    // 2026-08-22 실검증: 생성(BATCH_STATE_PENDING)·폴링(RUNNING)·취소(CANCELLED) wire 확정
    surface: "generate-content",
    async create(items, rt, auth, fetchImpl) {
      // 배치당 단일 모델 (모델이 경로에 — 부록 (b) §3.1). 혼합은 createBatch에서 사전 400
      const model = items[0]!.model;
      const res = await fetchImpl(`${rt.baseUrl}/v1beta/models/${model}:batchGenerateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          batch: {
            displayName: `gw-${items.length}items`,
            inputConfig: { requests: { requests: items.map((i) => ({ request: i.wire.body, metadata: { key: i.customId } })) } },
          },
        }),
      });
      const body = await jsonOrThrow("google", res, "생성");
      const meta = (body["metadata"] ?? {}) as Record<string, unknown>;
      return {
        providerBatchId: String(body["name"] ?? ""),
        rawStatus: String(meta["state"] ?? "BATCH_STATE_PENDING"),
      };
    },
    async poll(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1beta/${job.providerBatchId}`, { headers: auth });
      const body = await jsonOrThrow("google", res, "조회");
      const meta = (body["metadata"] ?? {}) as Record<string, unknown>;
      const raw = String(meta["state"] ?? (body["done"] === true ? "BATCH_STATE_SUCCEEDED" : "BATCH_STATE_RUNNING"));
      return { status: normalizeStatus(raw), rawStatus: raw };
    },
    async results(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1beta/${job.providerBatchId}`, { headers: auth });
      const body = await jsonOrThrow("google", res, "결과");
      const response = (body["response"] ?? {}) as Record<string, unknown>;
      const inlined = ((response["inlinedResponses"] ?? {}) as Record<string, unknown>)["inlinedResponses"];
      if (!Array.isArray(inlined)) return [];
      return inlined.map((entry) => {
        const e = entry as Record<string, unknown>;
        const customId = String(((e["metadata"] ?? {}) as Record<string, unknown>)["key"] ?? "");
        if (e["error"] != null) {
          const err = e["error"] as Record<string, unknown>;
          const code = typeof err["code"] === "number" ? (err["code"] as number) : 500;
          return { customId, wireError: { status: code, body: { error: err } } };
        }
        return { customId, wireBody: e["response"] };
      });
    },
    async cancel(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1beta/${job.providerBatchId}:cancel`, {
        method: "POST",
        headers: auth,
      });
      await jsonOrThrow("google", res, "취소");
    },
  },

  xai: {
    // 2026-08-22 실검증: 생성·폴링(pending/running)·취소 wire 확정. 주의 — 배치는 모델 게이트 있음:
    // grok-4.3·grok-4.20 계열 지원, grok-4.6/4.5/build-0.1은 400 "not supported for batch processing"
    surface: "chat-completions",
    async create(items, rt, auth, fetchImpl) {
      const created = await fetchImpl(`${rt.baseUrl}/v1/batches`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ name: `gw-${items.length}items` }),
      });
      const body = await jsonOrThrow("xai", created, "생성");
      const providerBatchId = String(body["batch_id"] ?? body["id"] ?? "");
      // 2026-08-22 실측: 등록 필드는 batch_requests (요청 `requests` 가정은 422로 반증 — problem log)
      const reg = await fetchImpl(`${rt.baseUrl}/v1/batches/${providerBatchId}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          // batch_request는 태그드 유니온 (2026-08-22 실측: chat_get_completion|responses|image_generation|…)
          batch_requests: items.map((i) => ({
            unique_id: i.customId,
            batch_request: {
              [i.wire.path.includes("/chat/completions") ? "chat_get_completion" : "responses"]: i.wire.body,
            },
          })),
        }),
      });
      await jsonOrThrow("xai", reg, "요청 등록");
      return { providerBatchId, rawStatus: "pending" };
    },
    async poll(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/batches/${job.providerBatchId}`, { headers: auth });
      const body = await jsonOrThrow("xai", res, "조회");
      const raw = String(body["status"] ?? "running");
      return { status: normalizeStatus(raw), rawStatus: raw };
    },
    async results(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/batches/${job.providerBatchId}/results`, {
        headers: auth,
      });
      const body = await jsonOrThrow("xai", res, "결과");
      const results = body["results"];
      if (!Array.isArray(results)) return [];
      return results.map((entry) => {
        const e = entry as Record<string, unknown>;
        const customId = String(e["unique_id"] ?? e["custom_id"] ?? "");
        if (e["error"] != null) {
          return { customId, wireError: { status: 400, body: e["error"] } };
        }
        return { customId, wireBody: e["response"] ?? e["body"] };
      });
    },
    async cancel(job, rt, auth, fetchImpl) {
      const res = await fetchImpl(`${rt.baseUrl}/v1/batches/${job.providerBatchId}:cancel`, {
        method: "POST",
        headers: auth,
      });
      await jsonOrThrow("xai", res, "취소");
    },
  },
};

function batchOps(provider: string): BatchProviderOps {
  const ops = BATCH_PROVIDERS[provider];
  if (!ops) {
    throw new GatewayError({
      category: "invalid_request",
      httpStatus: 501,
      message: `${provider}는 Batches 브리지 미지원`,
      fallbackEligible: false,
      billed: false,
      provider: { key: provider, code: "batches-unsupported" },
    });
  }
  return ops;
}

function toEnvelope(job: BatchJob): BatchEnvelope {
  return {
    id: job.gatewayBatchId,
    provider: job.provider,
    status: job.status,
    ...(job.rawStatus ? { rawStatus: job.rawStatus } : {}),
    counts: job.counts,
    createdAt: job.createdAt,
    ...(job.expiresAt ? { expiresAt: job.expiresAt } : {}),
  };
}

export async function createBatch(items: BatchItemInput[], deps: BatchBridgeDeps): Promise<BatchEnvelope> {
  if (items.length === 0) throw new GatewayError(irError("invalid_request", 400, "requests가 비었습니다"));
  const seen = new Set<string>();
  for (const item of items) {
    if (item.customId.length === 0) throw new GatewayError(irError("invalid_request", 400, "customId는 비울 수 없습니다"));
    if (seen.has(item.customId)) {
      throw new GatewayError(irError("invalid_request", 400, `customId 중복: ${item.customId} (부록 (b) §3.2 — 유일 매핑 키)`));
    }
    seen.add(item.customId);
    if (item.request.stream) {
      throw new GatewayError(irError("invalid_request", 400, `배치 항목은 stream 불가 (${item.customId})`));
    }
  }

  // 단일 프로바이더 검증 (§3.1) + 항목 변환 (어댑터 재사용)
  const prepared: PreparedItem[] = [];
  let provider: string | undefined;
  let surface: string | undefined;
  const itemModels: Record<string, string> = {};
  for (const item of items) {
    const route = resolveModel(item.request.model);
    provider ??= route.provider;
    if (route.provider !== provider) {
      throw new GatewayError(
        irError("invalid_request", 400, `배치는 단일 프로바이더 (§3.1) — ${provider} vs ${route.provider} (${item.customId}). 프로바이더별로 나눠 제출`),
      );
    }
    const rt = getProvider(route.provider);
    const { request: retargeted } = retargetRequest(item.request, route.provider);
    const { adapter } = selectSurface(rt, retargeted, route);
    const requiredSurface = batchOps(route.provider).surface;
    const effectiveAdapter = requiredSurface !== null && adapter.surface !== requiredSurface
      ? rt.adapters.get(requiredSurface)
      : adapter;
    if (!effectiveAdapter) {
      throw new GatewayError(irError("invalid_request", 400, `${route.provider} 배치 표면(${requiredSurface}) 미등록`));
    }
    surface ??= effectiveAdapter.surface;
    if (effectiveAdapter.surface !== surface) {
      throw new GatewayError(irError("invalid_request", 400, `배치 내 표면 혼합 불가 (§3.4) — ${surface} vs ${effectiveAdapter.surface}`));
    }
    try {
      const { request: wire, warnings } = effectiveAdapter.transformRequest(retargeted, {
        requestId: `batch_${item.customId}`,
        modelId: route.modelId,
        ...(route.capabilities ? { capabilities: route.capabilities } : {}),
      });
      const body = { ...wire.body };
      delete body["stream"]; // 배치 항목은 비스트림 (wire에 stream 슬롯 없음)
      prepared.push({ customId: item.customId, model: route.modelId, wire: { ...wire, body: body as JSONObject }, warnings });
      itemModels[item.customId] = route.modelId;
    } catch (err) {
      if (err instanceof AdapterInvalidRequestError) {
        throw new GatewayError({ ...err.irError, message: `[${item.customId}] ${err.irError.message}` });
      }
      throw err;
    }
  }
  if (provider === "google") {
    const models = new Set(prepared.map((p) => p.model));
    if (models.size > 1) {
      throw new GatewayError(irError("invalid_request", 400, `google 배치는 단일 모델 (모델이 경로에 — §3.1): ${[...models].join(", ")}`));
    }
  }
  const rt = getProvider(provider!);
  const created = await batchOps(provider!).create(prepared, rt, await resolveCredentials(rt, deps), deps.fetchImpl ?? fetch);
  if (!created.providerBatchId) {
    throw new GatewayError(irError("provider_error", 502, `${provider} 배치 생성 응답에 id 없음`));
  }
  const job: BatchJob = {
    gatewayBatchId: `gwb_${genRequestId(deps).slice(4)}`,
    tenant: deps.tenant ?? DEFAULT_TENANT,
    provider: provider!,
    providerBatchId: created.providerBatchId,
    ...(created.bridgeState ? { bridgeState: created.bridgeState } : {}),
    status: created.rawStatus ? normalizeStatus(created.rawStatus) : "in_progress",
    ...(created.rawStatus ? { rawStatus: created.rawStatus } : {}),
    counts: { total: items.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    itemModels,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
  };
  await deps.batches.put(job);
  return toEnvelope(job);
}

async function loadJob(gatewayBatchId: string, deps: BatchBridgeDeps): Promise<BatchJob> {
  const job = await deps.batches.get(deps.tenant ?? DEFAULT_TENANT, gatewayBatchId);
  if (!job) throw new GatewayError(irError("not_found", 404, `배치 없음: ${gatewayBatchId}`));
  return job;
}

export async function getBatch(gatewayBatchId: string, deps: BatchBridgeDeps): Promise<BatchEnvelope> {
  let job = await loadJob(gatewayBatchId, deps);
  const rt = getProvider(job.provider);
  const polled = await batchOps(job.provider).poll(job, rt, await resolveCredentials(rt, deps), deps.fetchImpl ?? fetch);
  job = {
    ...job,
    status: polled.status,
    rawStatus: polled.rawStatus,
    counts: { ...job.counts, ...polled.counts },
    ...(polled.bridgeState ? { bridgeState: { ...(job.bridgeState ?? {}), ...polled.bridgeState } } : {}),
  };
  await deps.batches.put(job);
  return toEnvelope(job);
}

export async function listBatches(deps: BatchBridgeDeps): Promise<BatchEnvelope[]> {
  return (await deps.batches.list(deps.tenant ?? DEFAULT_TENANT)).map(toEnvelope);
}

export async function cancelBatch(gatewayBatchId: string, deps: BatchBridgeDeps): Promise<BatchEnvelope> {
  const job = await loadJob(gatewayBatchId, deps);
  const rt = getProvider(job.provider);
  await batchOps(job.provider).cancel(job, rt, await resolveCredentials(rt, deps), deps.fetchImpl ?? fetch);
  return getBatch(gatewayBatchId, deps); // 취소는 비동기 — 최신 상태 재조회 (§3.2)
}

/** 항목 결과 정규화 — 어댑터 transformResponse 재사용 + 원장 1회 적재 (부록 (b) §3.4) */
export async function getBatchResults(gatewayBatchId: string, deps: BatchBridgeDeps): Promise<BatchResultItem[]> {
  const job = await loadJob(gatewayBatchId, deps);
  const rt = getProvider(job.provider);
  const ops = batchOps(job.provider);
  const raw = await ops.results(job, rt, await resolveCredentials(rt, deps), deps.fetchImpl ?? fetch);

  const out: BatchResultItem[] = [];
  for (const item of raw) {
    const modelId = job.itemModels[item.customId] ?? job.provider;
    // 배치 표면 어댑터로 정규화 (생성과 동일 표면 — §3.4)
    const adapter = ops.surface !== null ? rt.adapters.get(ops.surface) : rt.adapters.get(rt.defaultSurface);
    if (!adapter) continue;
    if (item.wireBody !== undefined) {
      try {
        const t = adapter.transformResponse(item.wireBody, {
          requestId: `batch_${item.customId}`,
          modelId,
          requestedModel: modelId,
        });
        out.push({
          customId: item.customId,
          response: {
            message: { role: "assistant", blocks: t.blocks, origin: t.origin },
            finishReason: t.finishReason,
            usage: t.usage,
            warnings: t.warnings,
          },
        });
      } catch (err) {
        const irErr = err instanceof AdapterInvalidRequestError ? err.irError : irError("provider_error", 502, `결과 변환 실패: ${err instanceof Error ? err.message : String(err)}`);
        out.push({ customId: item.customId, error: irErr });
      }
    } else if (item.wireError) {
      out.push({ customId: item.customId, error: adapter.mapHttpError(item.wireError.status, item.wireError.body) });
    } else {
      out.push({
        customId: item.customId,
        error: {
          category: "provider_error",
          httpStatus: 499,
          message: `배치 항목 ${item.terminal ?? "canceled"} — 응답 없음 (부분 취소/만료)`,
          fallbackEligible: false,
          billed: false,
          provider: { key: job.provider, code: `batch-item-${item.terminal ?? "canceled"}` },
        },
      });
    }
  }

  // 원장 적재 — 결과 수확 시점 1회 (재조회 중복 방지 플래그, ADR-0007 배치 SKU는 운영 평면)
  if (deps.ledger && job.bridgeState?.["ledgerRecorded"] !== "true") {
    const createdAt = (deps.now?.() ?? new Date()).toISOString();
    for (const r of out) {
      try {
        const itemModel = job.itemModels[r.customId] ?? job.provider;
        await deps.ledger.record({
          requestId: `${gatewayBatchId}:${r.customId}`,
          attempt: 1,
          provider: job.provider,
          model: itemModel,
          surface: ops.surface ?? rt.defaultSurface,
          stream: false,
          outcome: r.response ? "success" : "error",
          ...(r.response ? { finishReason: r.response.finishReason.unified } : {}),
          ...(r.error ? { errorCategory: r.error.category } : {}),
          ...(r.response ? { usage: r.response.usage } : {}),
          billed: r.response !== undefined,
          durationMs: 0, // 배치는 요청 단위 소요 미제공
          createdAt,
          // 귀속 없는 행은 예산 집계(withSpendTracking)와 테넌트 정산에서 통째로 빠진다 (리뷰 2026-08-22)
          tenant: job.tenant,
          ...(deps.keyId ? { keyId: deps.keyId } : {}),
          ...(deps.keySource ? { keySource: deps.keySource } : {}),
          // 배치 할인 SKU 기준 비용 (부록 (b) §3.4) — 동기 경로의 recordAttempt와 대칭
          ...(r.response
            ? { costUsd: buildBilling(job.provider, itemModel, r.response.usage, { batch: true }).total }
            : {}),
        });
      } catch (err) {
        console.error("[batch-ledger]", err instanceof Error ? err.message : err);
      }
    }
    await deps.batches.put({ ...job, bridgeState: { ...(job.bridgeState ?? {}), ledgerRecorded: "true" } });
  }
  return out;
}

