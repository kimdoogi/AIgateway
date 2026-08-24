import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// OTel 트레이서 등록 (ADR-0008 — 리뷰 2026-08-22 #10).
// observability.ts는 @opentelemetry/api만 쓰므로 SDK를 등록하지 않으면 모든 span이 no-op이었다.
// "나중에 붙이면 계측 공백"을 피하려 API를 선배선해 뒀는데, 정작 붙이는 쪽이 없었던 셈.
//
// 등록은 **opt-in**: OTEL_EXPORTER_OTLP_ENDPOINT가 없으면 아무것도 하지 않는다 —
// 수집기 없는 환경에서 익스포터가 백그라운드로 재시도하며 로그를 더럽히는 것을 막는다.

let provider: NodeTracerProvider | undefined;

/**
 * 수집기 엔드포인트가 설정돼 있으면 트레이서를 등록한다.
 * 반환값: 등록 여부 (조립 루트가 로그로 가시화 — "켰다고 생각했는데 안 켜진" 상태 방지)
 */
export function setupTracing(opts: { serviceName?: string; version?: string } = {}): boolean {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint || provider) return false;

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName ?? process.env["OTEL_SERVICE_NAME"] ?? "ai-gateway",
      ...(opts.version ? { [ATTR_SERVICE_VERSION]: opts.version } : {}),
    }),
    // Batch — 요청 경로에서 익스포트를 기다리지 않는다 (본문 로그에서 배운 것과 같은 원칙)
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return true;
}

/** shutdown 시 잔여 span 플러시 — 마지막 요청의 트레이스가 유실되지 않게 */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  await provider.shutdown().catch((err: unknown) => {
    console.error("[tracing] shutdown 실패", err instanceof Error ? err.message : err);
  });
  provider = undefined;
}
