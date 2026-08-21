import { describe, expect, it } from "vitest";
import type { IRRequest } from "../ir/request.js";
import type { OutboundAdapter, RequestContext } from "./types.js";

// 어댑터 공통 conformance 뼈대 (walking-skeleton 5단계 — LiteLLM BaseLLMChatTest 패턴).
// 후속 어댑터(OpenAI 등)는 이 suite를 상속 호출하는 것이 등록 조건. 테스트 전용 —
// tsconfig.build에서 제외된다 (vitest import 포함).

export function describeAdapterConformance(
  adapter: OutboundAdapter,
  sampleRequest: IRRequest,
  ctx: RequestContext,
): void {
  describe(`conformance: ${adapter.provider}/${adapter.surface}`, () => {
    it("provider/surface 식별자가 있다 (D4 — 코어는 이 속성만 본다)", () => {
      expect(adapter.provider.length).toBeGreaterThan(0);
      expect(adapter.surface.length).toBeGreaterThan(0);
    });

    it("transformRequest는 결정론적이다 — 같은 IR → 바이트 동일 wire (D10)", () => {
      const a = adapter.transformRequest(sampleRequest, ctx);
      const b = adapter.transformRequest(sampleRequest, ctx);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("transformRequest는 입력을 변조하지 않는다 (순수 함수 — D4)", () => {
      const before = JSON.stringify(sampleRequest);
      adapter.transformRequest(sampleRequest, ctx);
      expect(JSON.stringify(sampleRequest)).toBe(before);
    });

    it("종료 신호 없는 스트림 절단 시 터미널을 보장한다 (ADR-0005)", () => {
      const transformer = adapter.createStreamTransformer({ modelId: ctx.modelId });
      const events = transformer.onStreamEnd();
      const last = events[events.length - 1];
      expect(last).toBeDefined();
      expect(["provider-error", "finish"]).toContain(last!.type);
    });

    it("draft는 seq를 싣지 않는다 — seq는 게이트웨이 발급 (ir-v0 §13.1)", () => {
      const transformer = adapter.createStreamTransformer({ modelId: ctx.modelId });
      for (const draft of transformer.onStreamEnd()) {
        expect("seq" in draft, `${draft.type} draft에 seq 금지`).toBe(false);
      }
    });

    it("onStreamEnd는 멱등 — 터미널 방출 후 재호출은 빈 배열 (리뷰 F-B3)", () => {
      const transformer = adapter.createStreamTransformer({ modelId: ctx.modelId });
      const first = transformer.onStreamEnd();
      expect(first.length).toBeGreaterThan(0);
      expect(transformer.onStreamEnd()).toEqual([]);
    });

    it("mapHttpError는 전달된 status를 보존하고 IRError 형태를 지킨다", () => {
      const error = adapter.mapHttpError(500, { error: { type: "api_error", message: "x" } });
      expect(error.httpStatus).toBe(500);
      expect(typeof error.category).toBe("string");
      expect(typeof error.fallbackEligible).toBe("boolean");
      expect(typeof error.billed).toBe("boolean");
    });
  });
}
