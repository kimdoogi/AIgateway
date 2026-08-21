import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { openaiAdapters, selectOpenAISurface } from "../adapters/openai/index.js";
import { GatewayError } from "./errors.js";
import {
  clearProviders,
  getProvider,
  previousSurface,
  registerProvider,
  resolveModel,
  selectSurface,
} from "./registry.js";

// 표면 축 (ADR-0002 결과 절): 오버라이드 > required > sticky > 기본, capability 게이트 마지막.

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model: "gpt-5.6-luna",
    messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    ...input,
  });
}

const assistantTurn = (surface: string) => ({
  role: "assistant",
  origin: { provider: "openai", model: "gpt-5.6-luna", surface },
  blocks: [{ type: "text", text: "prev" }],
});

describe("registry 표면 축", () => {
  beforeEach(() => {
    clearProviders();
    registerProvider({
      adapters: openaiAdapters,
      baseUrl: "https://api.openai.com",
      auth: { envVar: "OPENAI_API_KEY", header: "authorization", prefix: "Bearer " },
      selectSurface: selectOpenAISurface,
    });
  });
  afterEach(() => clearProviders());

  const rt = () => getProvider("openai");
  const route = { provider: "openai", modelId: "gpt-5.6-luna" };

  it("기본 표면 = 첫 등록 어댑터 (responses)", () => {
    const { adapter, warnings } = selectSurface(rt(), ir({}), route);
    expect(adapter.surface).toBe("responses");
    expect(warnings).toEqual([]);
  });

  it("sticky — 직전 assistant 턴의 표면 유지 (warning 없음)", () => {
    const req = ir({ messages: [{ role: "user", blocks: [{ type: "text", text: "a" }] }, assistantTurn("chat-completions"), { role: "user", blocks: [{ type: "text", text: "b" }] }] });
    const { adapter, warnings } = selectSurface(rt(), req, route);
    expect(adapter.surface).toBe("chat-completions");
    expect(warnings).toEqual([]);
  });

  it("required 기능이 sticky를 이김 + surface-switched warning", () => {
    const req = ir({
      messages: [assistantTurn("chat-completions"), { role: "user", blocks: [{ type: "text", text: "b" }] }],
      tools: [{ type: "provider", id: "openai.web_search", args: {} }],
    });
    const { adapter, warnings } = selectSurface(rt(), req, route);
    expect(adapter.surface).toBe("responses");
    expect(warnings.map((w) => w.code)).toEqual(["surface-switched"]);
  });

  it("CC 전용 파라미터(seed)는 chat-completions 강제", () => {
    const { adapter } = selectSurface(rt(), ir({ seed: 1 }), route);
    expect(adapter.surface).toBe("chat-completions");
  });

  it("openai reasoning 히스토리는 responses 강제 (보존)", () => {
    const req = ir({
      messages: [
        {
          role: "assistant",
          origin: { provider: "openai", model: "m", surface: "responses" },
          blocks: [{ type: "reasoning", text: "", opaqueState: { provider: "openai", data: "E" } }, { type: "text", text: "x" }],
        },
        { role: "user", blocks: [{ type: "text", text: "b" }] },
      ],
    });
    expect(selectSurface(rt(), req, route).adapter.surface).toBe("responses");
  });

  it("명시 오버라이드 providerOptions.openai.surface가 최우선", () => {
    const req = ir({ providerOptions: { openai: { surface: "chat-completions" } } });
    expect(selectSurface(rt(), req, route).adapter.surface).toBe("chat-completions");
  });

  it("capability surfaces 게이트 — 접근 불가 표면은 전환 + warning", () => {
    const routeCC = { provider: "openai", modelId: "gpt-audio-1.5", capabilities: { surfaces: ["chat-completions"] } };
    const req = ir({ messages: [assistantTurn("responses"), { role: "user", blocks: [{ type: "text", text: "b" }] }] });
    const { adapter, warnings } = selectSurface(rt(), req, routeCC);
    expect(adapter.surface).toBe("chat-completions");
    expect(warnings.map((w) => w.code)).toEqual(["surface-switched"]);
  });

  it("required 기능 × 접근 불가 표면 = 4xx (조용한 강등 금지)", () => {
    const routeCC = { provider: "openai", modelId: "gpt-audio-1.5", capabilities: { surfaces: ["chat-completions"] } };
    const req = ir({ tools: [{ type: "provider", id: "openai.web_search", args: {} }] });
    expect(() => selectSurface(rt(), req, routeCC)).toThrow(GatewayError);
  });

  it("previousSurface — 마지막 assistant 턴 우선, 타 프로바이더 무시", () => {
    const req = ir({
      messages: [
        assistantTurn("responses"),
        { role: "assistant", origin: { provider: "anthropic", model: "c", surface: "messages" }, blocks: [{ type: "text", text: "x" }] },
        { role: "user", blocks: [{ type: "text", text: "b" }] },
      ],
    });
    expect(previousSurface(req, "openai")).toBe("responses");
    expect(previousSurface(req, "anthropic")).toBe("messages");
    expect(previousSurface(req, "google")).toBeUndefined();
  });

  it("모델 라우팅 — openai 패턴·capability 힌트", () => {
    expect(resolveModel("gpt-5.6-luna").provider).toBe("openai");
    expect(resolveModel("gpt-5.6-luna").capabilities?.unsupportedParams).toContain("temperature");
    expect(resolveModel("gpt-5-pro").capabilities?.surfaces).toEqual(["responses"]);
    expect(resolveModel("gpt-audio-1.5").capabilities?.surfaces).toEqual(["chat-completions"]);
    expect(resolveModel("claude-haiku-4-5").provider).toBe("anthropic");
    expect(resolveModel("grok-4.6").provider).toBe("xai");
    expect(resolveModel("grok-4.6").capabilities?.supportedEfforts).toContain("xhigh");
    expect(resolveModel("grok-4.6").capabilities?.unsupportedParams).toContain("stopSequences");
    expect(resolveModel("grok-4.20-non-reasoning").capabilities?.unsupportedParams).toBeUndefined();
    expect(() => resolveModel("unknown-99")).toThrow();
  });

  it("표면 중복/혼합 등록 거부", () => {
    clearProviders();
    expect(() =>
      registerProvider({
        adapters: [openaiAdapters[0]!, openaiAdapters[0]!],
        baseUrl: "x",
        auth: { envVar: "X", header: "x" },
      }),
    ).toThrow(/중복/);
  });
});
