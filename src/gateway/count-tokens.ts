import type { NS, Warning } from "../ir/common.js";
import type { IRRequest } from "../ir/request.js";
import type { ResolvedModel } from "../ir/response.js";
import { AdapterInvalidRequestError } from "../adapters/shared.js";
import { genRequestId, resolveCredentials, type ExecuteDeps } from "./execute.js";
import { GatewayError } from "./errors.js";
import { getProvider, resolveModel, selectSurface } from "./registry.js";
import { withUpstreamTimeout } from "./http.js";
import { retargetRequest } from "./retarget.js";

// count_tokens 프록시 (부록 (b) §1) — 동기 파이프라인과 같은 라우팅·재타게팅·표면 규칙을
// 통과시키되, 어댑터 옵셔널 계약(countTokens)이 없으면 명시적 501 (조용한 추정 금지 — D5).

export interface CountTokensResponse {
  version: "0";
  id: string;
  created: string;
  model: { requested: string; resolved: ResolvedModel };
  inputTokens: number;
  providerMetadata?: NS;
  warnings: Warning[];
  gateway: { requestId: string };
}

export async function executeCountTokens(
  req: IRRequest,
  deps: ExecuteDeps = {},
  signal?: AbortSignal,
): Promise<CountTokensResponse> {
  const route = resolveModel(req.model);
  const rt = getProvider(route.provider);
  const { request: retargeted, warnings: retargetWarnings } = retargetRequest(req, route.provider);
  const { adapter, warnings: surfaceWarnings } = selectSurface(rt, retargeted, route);
  if (!adapter.countTokens) {
    throw new GatewayError({
      category: "invalid_request",
      httpStatus: 501,
      message: `${route.provider}는 count_tokens 미지원 — 지원 프로바이더: anthropic·google (부록 (b) §1)`,
      fallbackEligible: false,
      billed: false,
      provider: { key: route.provider, code: "count-tokens-unsupported" },
    });
  }

  const requestId = genRequestId(deps);
  const ctx = {
    requestId,
    modelId: route.modelId,
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
  };
  let transformed;
  try {
    transformed = adapter.countTokens.transformRequest(retargeted, ctx);
  } catch (err) {
    if (err instanceof AdapterInvalidRequestError) throw new GatewayError(err.irError);
    throw err;
  }

  const fetchImpl = withUpstreamTimeout(deps.fetchImpl ?? fetch, {
    ...(deps.upstreamTimeoutMs !== undefined ? { timeoutMs: deps.upstreamTimeoutMs } : {}),
    signal,
    label: `${route.provider} count_tokens`,
  });
  // 테넌트 BYO 우선 — 본 요청과 같은 계정으로 세야 캐시·쿼터 회계가 어긋나지 않는다 (리뷰 2026-08-22)
  const auth = await resolveCredentials(rt, deps);
  const response = await fetchImpl(`${rt.baseUrl}${transformed.request.path}`, {
    method: transformed.request.method,
    headers: { ...transformed.request.headers, ...auth },
    body: JSON.stringify(transformed.request.body),
  });
  if (response.status !== 200) {
    const body: unknown = await response.json().catch(() => undefined);
    throw new GatewayError(adapter.mapHttpError(response.status, body, Object.fromEntries(response.headers)));
  }
  const body: unknown = await response.json();
  const result = adapter.countTokens.transformResponse(body);

  return {
    version: "0",
    id: requestId,
    created: (deps.now?.() ?? new Date()).toISOString(),
    model: {
      requested: req.model,
      resolved: { provider: route.provider, model: route.modelId, surface: adapter.surface },
    },
    inputTokens: result.inputTokens,
    ...(result.providerMetadata ? { providerMetadata: result.providerMetadata } : {}),
    warnings: [...retargetWarnings, ...surfaceWarnings, ...transformed.warnings],
    gateway: { requestId },
  };
}
