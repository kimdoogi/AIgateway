import type { Warning } from "../ir/common.js";
import type { IRRequest } from "../ir/request.js";
import type { IRResponse } from "../ir/response.js";
import type { ResourceStore } from "../state/types.js";
import { makeWarning } from "../adapters/shared.js";
import { GatewayError, irError } from "../gateway/errors.js";
import { withUpstreamTimeout } from "../gateway/http.js";

// 서버 상태 리소스 레지스트리 (ADR-0006 §3) — 게이트웨이 관리형 수명.
// 데이터 테이블: 프로바이더별 "참조" PO 키 (재타게팅의 SERVER_STATE_KEYS와 동족이지만
// 용도가 다르다 — 저긴 드롭 판단, 여긴 소유권 검증). 코어 분기문 없음 (D4).

/** PO에서 외부 리소스 id를 참조하는 키 → 리소스 타입 */
const REFERENCE_KEYS: Record<string, Record<string, string>> = {
  openai: { previousResponseId: "response", conversation: "conversation" },
  xai: { previousResponseId: "response" },
  google: { cachedContent: "cachedContent" },
  anthropic: {}, // container는 PO가 아니라 passthrough/compat 경로 — v1은 응답 등록만
};

/** 응답에서 게이트웨이 관리 대상으로 등록할 리소스 추출 — 생성은 opt-in일 때만 (ADR-0006 §3) */
const RESPONSE_RESOURCES: Record<
  string,
  (res: IRResponse, req: IRRequest) => Array<{ resourceType: string; externalId: string }>
> = {
  anthropic: (res) => {
    // container는 존재 자체가 생성 증거 (코드 실행 옵트인 결과)
    const container = (res.providerMetadata?.["anthropic"] as Record<string, unknown> | undefined)?.["container"];
    const id = container && typeof container === "object" ? (container as Record<string, unknown>)["id"] : undefined;
    return typeof id === "string" && id.length > 0 ? [{ resourceType: "container", externalId: id }] : [];
  },
  openai: (res, req) => {
    if (req.providerOptions?.["openai"]?.["store"] !== true) return []; // store 옵트인 시에만 서버 상태 생성
    const id = res.gateway.providerRequestId;
    return typeof id === "string" && id.length > 0 ? [{ resourceType: "response", externalId: id }] : [];
  },
  xai: (res, req) => {
    if (req.providerOptions?.["xai"]?.["store"] !== true) return [];
    const id = res.gateway.providerRequestId;
    return typeof id === "string" && id.length > 0 ? [{ resourceType: "response", externalId: id }] : [];
  },
};

export interface ResourcePolicy {
  /** 미등록 외부 id 허용 (테넌트 설정 — 기본 거부, 허용 시 관리 대상 아님 warning) */
  allowUnregistered?: boolean;
}

/**
 * 인바운드 참조 검증 (ADR-0006 §3): PO의 외부 리소스 id를 레지스트리와 대조.
 * 타 테넌트 소유 → 404 (존재 노출 금지), 미등록 → 기본 거부/opt-in 통과+warning.
 */
export async function checkInboundResources(
  req: IRRequest,
  provider: string,
  tenant: string,
  store: ResourceStore,
  policy: ResourcePolicy = {},
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  const refKeys = REFERENCE_KEYS[provider] ?? {};
  const ns = req.providerOptions?.[provider];
  if (!ns) return warnings;
  for (const [poKey, resourceType] of Object.entries(refKeys)) {
    const value = ns[poKey];
    if (typeof value !== "string" || value.length === 0) continue;
    const owner = await store.ownerOf(provider, resourceType, value);
    if (owner === tenant) continue;
    if (owner !== null) {
      // 타 테넌트 리소스 — 존재를 노출하지 않는다
      throw new GatewayError(irError("not_found", 404, `리소스 없음: ${poKey} (테넌트 격리 — ADR-0006 §3)`));
    }
    if (!policy.allowUnregistered) {
      throw new GatewayError(
        irError(
          "invalid_request",
          400,
          `미등록 외부 리소스 참조: providerOptions.${provider}.${poKey} — 게이트웨이 밖에서 생성된 리소스는 기본 거부 (테넌트 설정 allowUnregistered로 허용 가능, ADR-0006 §3)`,
        ),
      );
    }
    warnings.push(
      makeWarning(
        "other",
        "server-state-unmanaged",
        `미등록 외부 리소스 통과 (opt-in) — TTL·삭제 대행 등 게이트웨이 관리 대상 아님: ${poKey}`,
        `providerOptions.${provider}.${poKey}`,
      ),
    );
  }
  return warnings;
}

/** 응답에서 생성된 서버 상태를 레지스트리에 등록 (비스트림 v1 — 스트림은 finish PM 후처리 좌석) */
export async function registerResponseResources(
  res: IRResponse,
  req: IRRequest,
  tenant: string,
  store: ResourceStore,
  opts: { ttlSeconds?: number; keyId?: string; now?: () => Date } = {},
): Promise<void> {
  const provider = res.model.resolved.provider;
  const extract = RESPONSE_RESOURCES[provider];
  if (!extract) return;
  const now = opts.now?.() ?? new Date();
  for (const r of extract(res, req)) {
    await store.register({
      tenant,
      provider,
      resourceType: r.resourceType,
      externalId: r.externalId,
      createdAt: now.toISOString(),
      ...(opts.ttlSeconds !== undefined
        ? { expiresAt: new Date(now.getTime() + opts.ttlSeconds * 1000).toISOString() }
        : {}),
      ...(opts.keyId ? { createdByKeyId: opts.keyId } : {}),
    });
  }
}

/** TTL 스윕 (v1: 관리 API 트리거) — 삭제 API가 있는 리소스는 프로바이더 삭제 대행 */
const DELETE_PATHS: Record<string, Record<string, (id: string) => string>> = {
  openai: { response: (id) => `/v1/responses/${id}`, conversation: (id) => `/v1/conversations/${id}` },
  xai: { response: (id) => `/v1/responses/${id}` },
  // anthropic container·google cachedContent 만료는 프로바이더 자체 TTL — 참조 차단으로 대체 (한계 문서화)
};

export interface SweepResult {
  deleted: number;
  unlinked: number; // 삭제 API 없음 — 레지스트리 제거(참조 차단)만
}

export async function sweepExpiredResources(
  store: ResourceStore,
  deps: {
    now?: () => Date;
    fetchImpl?: typeof fetch;
    baseUrlFor: (provider: string) => string;
    credentialsFor: (provider: string) => Record<string, string>;
  },
): Promise<SweepResult> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const expired = await store.listExpired(nowIso);
  let deleted = 0;
  let unlinked = 0;
  for (const r of expired) {
    const path = DELETE_PATHS[r.provider]?.[r.resourceType]?.(r.externalId);
    if (path) {
      try {
        const fetchImpl = withUpstreamTimeout(deps.fetchImpl ?? fetch, {
          label: `${r.provider} 리소스 삭제`,
        });
        await fetchImpl(`${deps.baseUrlFor(r.provider)}${path}`, {
          method: "DELETE",
          headers: deps.credentialsFor(r.provider),
        });
        deleted += 1;
      } catch (err) {
        console.error("[resource-sweep]", r.provider, r.externalId, err instanceof Error ? err.message : err);
        continue; // 실패 리소스는 레지스트리 유지 — 다음 스윕 재시도
      }
    } else {
      unlinked += 1;
    }
    await store.delete(r.provider, r.resourceType, r.externalId);
  }
  return { deleted, unlinked };
}
