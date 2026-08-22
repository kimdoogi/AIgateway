import { beforeAll, describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { bootstrapProviders } from "./bootstrap.js";
import { GatewayError } from "./errors.js";
import { executeCountTokens } from "./count-tokens.js";

// count_tokens 프록시 (부록 (b) §1) — mock fetch, 픽스처 형태의 wire 응답 (D9).

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["GEMINI_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

function ir(model: string): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model,
    messages: [{ role: "user", blocks: [{ type: "text", text: "hello tokens" }] }],
  });
}

function mockFetch(body: unknown): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("executeCountTokens", () => {
  it("anthropic — count_tokens 경로, max_tokens/stream 제거, input_tokens 매핑", async () => {
    const { fetchImpl, calls } = mockFetch({ input_tokens: 42 });
    const res = await executeCountTokens(ir("claude-haiku-4-5"), { fetchImpl, genId: () => "req_ct" });
    expect(res.inputTokens).toBe(42);
    expect(res.model.resolved).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" });
    expect(calls[0]!.url).toContain("/v1/messages/count_tokens");
    const wire = calls[0]!.body as Record<string, unknown>;
    expect(wire["max_tokens"]).toBeUndefined();
    expect(wire["stream"]).toBeUndefined();
    expect(res.warnings).toEqual([]); // maxOutputTokens 기본값 주입 warning 억제 확인
  });

  it("google — :countTokens 경로 + generateContentRequest 래핑, cached는 PM", async () => {
    const { fetchImpl, calls } = mockFetch({ totalTokens: 17, cachedContentTokenCount: 5 });
    const res = await executeCountTokens(ir("gemini-3.7-flash"), { fetchImpl, genId: () => "req_ct" });
    expect(res.inputTokens).toBe(17);
    expect(res.providerMetadata).toEqual({ google: { cachedContentTokenCount: 5 } });
    expect(calls[0]!.url).toContain(":countTokens");
    const wire = calls[0]!.body as Record<string, unknown>;
    expect((wire["generateContentRequest"] as Record<string, unknown>)["model"]).toBe("models/gemini-3.7-flash");
  });

  it("openai — countTokens 계약 부재 = 명시적 501 (조용한 추정 금지, D5)", async () => {
    await expect(executeCountTokens(ir("gpt-5.6-luna"))).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GatewayError);
      const irErr = (err as GatewayError).irError;
      expect(irErr.httpStatus).toBe(501);
      expect(irErr.provider?.code).toBe("count-tokens-unsupported");
      return true;
    });
  });

  it("프로바이더 4xx는 어댑터 에러 매핑 경유", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), {
        status: 400,
      })) as typeof fetch;
    await expect(executeCountTokens(ir("claude-haiku-4-5"), { fetchImpl })).rejects.toSatisfy((err: unknown) => {
      expect((err as GatewayError).irError.category).toBe("invalid_request");
      return true;
    });
  });
});
