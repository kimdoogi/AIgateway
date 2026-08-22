import type { BodyLogSink } from "../state/types.js";

// 본문 로그 (ADR-0008 — 사용자 결정 D3: 기본 on, 테넌트/키 opt-out).
// grounding TOS: groundingMetadata는 캐시·로그 금지 — 로그 사본에서 제거 (원본 응답 무영향).

/** 로그용 사본에서 TOS 제외 대상 제거 (providerMetadata.google.groundingMetadata) */
export function stripForLog(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const obj = body as Record<string, unknown>;
  const pm = obj["providerMetadata"];
  if (typeof pm !== "object" || pm === null) return body;
  const google = (pm as Record<string, unknown>)["google"];
  if (typeof google !== "object" || google === null) return body;
  const g = google as Record<string, unknown>;
  if (g["groundingMetadata"] === undefined && g["urlContextMetadata"] === undefined) return body;
  const { groundingMetadata: _gm, urlContextMetadata: _uc, ...restGoogle } = g;
  return {
    ...obj,
    providerMetadata: {
      ...(pm as Record<string, unknown>),
      google: { ...restGoogle, groundingMetadataOmitted: true }, // 제거 사실 표기 (조용한 변조 아님 — 로그 사본 한정)
    },
  };
}

export async function logBody(
  sink: BodyLogSink | undefined,
  entry: { requestId: string; tenant?: string; direction: "request" | "response"; body: unknown; now?: () => Date },
): Promise<void> {
  if (!sink) return;
  try {
    await sink.record({
      requestId: entry.requestId,
      ...(entry.tenant ? { tenant: entry.tenant } : {}),
      direction: entry.direction,
      body: stripForLog(entry.body),
      createdAt: (entry.now?.() ?? new Date()).toISOString(),
    });
  } catch (err) {
    console.error("[body-log]", err instanceof Error ? err.message : err); // 로그 실패는 요청 비차단
  }
}
