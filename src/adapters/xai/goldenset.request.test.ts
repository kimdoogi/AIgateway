import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../../ir/index.js";
import type { RequestContext } from "../types.js";
import { describeAdapterConformance } from "../adapter-conformance.js";
import { mapXAIError } from "./errors.js";
import { selectXAISurface, xaiChatAdapter, xaiResponsesAdapter } from "./index.js";

// 골든셋 ① — IR → xAI wire 스냅샷 (D9). openai-compat base 상속(ADR-0004)의 리맵·오버라이드 검증.

const ctx: RequestContext = {
  requestId: "req_golden",
  modelId: "grok-4.6",
  capabilities: {
    supportedEfforts: ["low", "medium", "high", "xhigh"],
    unsupportedParams: ["presencePenalty", "frequencyPenalty", "stopSequences"],
  },
};

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({ version: "0", model: "grok-4.6", ...input });
}

const user = (text: string) => ({ role: "user", blocks: [{ type: "text", text }] });

describe("골든셋 ① IR → xai chat-completions wire", () => {
  it("text + effort xhigh — CC 주 표면, reasoning_effort 통과", () => {
    expect(
      xaiChatAdapter.transformRequest(
        ir({ messages: [user("hi")], maxOutputTokens: 100, reasoning: { effort: "xhigh" } }),
        ctx,
      ),
    ).toMatchSnapshot();
  });

  it("reasoning 모델 게이트 — penalties·stop 드롭 + warning (인벤토리 B2-3)", () => {
    const result = xaiChatAdapter.transformRequest(
      ir({ messages: [user("hi")], presencePenalty: 0.1, frequencyPenalty: 0.2, stopSequences: ["END"], seed: 7 }),
      ctx,
    );
    expect(result.request.body["presence_penalty"]).toBeUndefined();
    expect(result.request.body["stop"]).toBeUndefined();
    expect(result.request.body["seed"]).toBe(7); // seed는 xAI CC 지원
    expect(result.warnings.filter((w) => w.code === "parameter-dropped").length).toBe(3);
    expect(result).toMatchSnapshot();
  });

  it("metadata.userId → user (safety_identifier는 xAI 미지원 — 제거 + warning)", () => {
    const result = xaiChatAdapter.transformRequest(ir({ messages: [user("hi")], metadata: { userId: "u1" } }), ctx);
    expect(result.request.body["user"]).toBe("u1");
    expect(result.request.body["safety_identifier"]).toBeUndefined();
    expect(result.request.body["metadata"]).toBeUndefined();
  });

  it("xGrokConvId → x-grok-conv-id 헤더 (캐시 라우팅 — 오버라이드 #7)", () => {
    const result = xaiChatAdapter.transformRequest(
      ir({ messages: [user("hi")], providerOptions: { xai: { promptCacheKey: "k1", xGrokConvId: "conv_1" } }, allowUnknownProviderOptions: true }),
      ctx,
    );
    expect(result.request.headers["x-grok-conv-id"]).toBe("conv_1");
    expect(result.request.body["prompt_cache_key"]).toBe("k1");
  });

  it("warning 라벨이 xai로 정정된다 (openai 오표기 방지)", () => {
    const result = xaiChatAdapter.transformRequest(ir({ messages: [user("hi")], topK: 40 }), ctx);
    const dropped = result.warnings.find((w) => w.code === "parameter-dropped" && w.path === "topK");
    expect(dropped?.message).not.toContain("openai");
    expect(dropped?.message).toContain("xai");
  });
});

describe("골든셋 ① IR → xai responses wire", () => {
  it("에이전트 툴(xai.web_search) — id 리맵 + store:false 강제", () => {
    const result = xaiResponsesAdapter.transformRequest(
      ir({
        messages: [user("news?")],
        tools: [{ type: "provider", id: "xai.web_search", args: { allowed_domains: ["x.com"] } }],
      }),
      ctx,
    );
    const tools = result.request.body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ type: "web_search", allowed_domains: ["x.com"] });
    expect(result.request.body["store"]).toBe(false);
    expect(result.request.path).toBe("/v1/responses");
    expect(result).toMatchSnapshot();
  });

  it("encrypted reasoning 히스토리 왕복 — opaqueState xai가 base를 통과해 원문 복원", () => {
    const item = { type: "reasoning", id: "rs_x1", summary: [], encrypted_content: "XAI_ENC" };
    const result = xaiResponsesAdapter.transformRequest(
      ir({
        messages: [
          user("q"),
          {
            role: "assistant",
            origin: { provider: "xai", model: "grok-4.6", surface: "responses" },
            blocks: [
              { type: "reasoning", text: "", opaqueState: { provider: "xai", data: "XAI_ENC" }, providerOptions: { xai: { item } } },
              { type: "text", text: "a" },
            ],
          },
          user("q2"),
        ],
      }),
      ctx,
    );
    const input = result.request.body["input"] as Array<Record<string, unknown>>;
    expect(input.find((i) => i["type"] === "reasoning")).toEqual(item); // 무변경 재전송
  });
});

describe("xai 표면 선택자 (ADR-0004)", () => {
  it("기본 = chat-completions (OpenAI와 반대)", () => {
    expect(selectXAISurface({ request: ir({ messages: [user("hi")] }), modelId: "grok-4.6" }).surface).toBe("chat-completions");
  });
  it("에이전트 툴 → responses 강제", () => {
    const choice = selectXAISurface({
      request: ir({ messages: [user("hi")], tools: [{ type: "provider", id: "xai.x_search", args: {} }] }),
      modelId: "grok-4.6",
    });
    expect(choice).toMatchObject({ surface: "responses", required: true });
  });
  it("encrypted reasoning 히스토리 → responses 강제", () => {
    const choice = selectXAISurface({
      request: ir({
        messages: [
          { role: "assistant", blocks: [{ type: "reasoning", text: "", opaqueState: { provider: "xai", data: "E" } }, { type: "text", text: "x" }] },
          user("next"),
        ],
      }),
      modelId: "grok-4.6",
    });
    expect(choice).toMatchObject({ surface: "responses", required: true });
  });
});

describe("xai 응답 방향 — 리맵·확장 필드", () => {
  it("CC 응답: reasoning_content → reasoning 블록, end_turn → stop, origin=xai", () => {
    const t = xaiChatAdapter.transformResponse(
      {
        id: "chatcmpl-x1",
        model: "grok-4.6",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Answer.", reasoning_content: "thinking summary" },
            finish_reason: "end_turn",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } },
      },
      { ...ctx, requestedModel: "grok-4.6" },
    );
    expect(t.blocks.map((b) => b.type)).toEqual(["reasoning", "text"]);
    expect(t.blocks[0]).toMatchObject({ type: "reasoning", text: "thinking summary" });
    expect(t.origin).toEqual({ provider: "xai", model: "grok-4.6", surface: "chat-completions" });
    expect(t.blocks.every((b) => b.origin?.provider === "xai")).toBe(true);
    expect(t.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
    expect(t.usage.output.reasoning).toBe(3);
  });

  it("responses 응답: encrypted reasoning의 opaqueState·PM이 xai 네임스페이스로", () => {
    const t = xaiResponsesAdapter.transformResponse(
      {
        id: "resp_x1", model: "grok-4.6", status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "XAI_ENC" },
          { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      { ...ctx, requestedModel: "grok-4.6" },
    );
    const reasoning = t.blocks[0]!;
    expect(reasoning.type === "reasoning" && reasoning.opaqueState).toEqual({ provider: "xai", data: "XAI_ENC" });
    expect(reasoning.providerMetadata?.["xai"]?.["item"]).toBeDefined();
    expect(reasoning.providerMetadata?.["openai"]).toBeUndefined();
  });

  it("CC 스트림: reasoning_content delta → reasoning 이벤트 + [DONE] 종결", () => {
    const t = xaiChatAdapter.createStreamTransformer({ modelId: "grok-4.6" });
    const chunk = (d: unknown) => t.onEvent(undefined, JSON.stringify(d));
    const base = { id: "chatcmpl-x1", model: "grok-4.6", object: "chat.completion.chunk" };
    const events = [
      ...chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "think " } }] }),
      ...chunk({ ...base, choices: [{ index: 0, delta: { content: "Answer" } }] }),
      ...chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "end_turn" }] }),
      ...chunk({ ...base, choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }),
      ...t.onEvent(undefined, "[DONE]"),
    ];
    expect(events.map((e) => e.type)).toEqual([
      "response-metadata", "reasoning-start", "reasoning-delta", "text-start", "text-delta",
      "text-end", "reasoning-end", "finish",
    ]);
    const meta = events[0]!;
    expect(meta.type === "response-metadata" && meta.model.resolved.provider).toBe("xai");
    const finish = events.at(-1)!;
    expect(finish.type === "finish" && finish.finishReason).toEqual({ unified: "stop", raw: "end_turn" });
  });
});

describe("xai 에러 파서 (평면 포맷 — 오버라이드 #1)", () => {
  it('평면 {"code","error"} 파싱', () => {
    const e = mapXAIError(400, { code: "400", error: "Argument not supported: store" });
    expect(e).toMatchObject({ category: "invalid_request", httpStatus: 400, message: "Argument not supported: store" });
    expect(e.provider?.key).toBe("xai");
  });
  it("400에 실린 인증 오류를 auth로 분류 (실측 B2-2)", () => {
    const e = mapXAIError(400, { code: "400", error: "Incorrect API key provided" });
    expect(e.category).toBe("auth");
  });
  it("410 폐기 API — Live Search 안내 부착", () => {
    const e = mapXAIError(410, { code: "410", error: "Live Search deprecated" });
    expect(e.message).toContain("agent tools");
  });
  it("중첩(OpenAI형) 폴백 + provider 키 xai 유지", () => {
    const e = mapXAIError(429, { error: { type: "rate_limit_error", message: "slow down" } });
    expect(e.category).toBe("rate_limit");
    expect(e.provider?.key).toBe("xai");
  });
});

describeAdapterConformance(xaiChatAdapter, IRRequestSchema.parse({ version: "0", model: "grok-4.6", messages: [user("hi")] }), ctx, {
  id: "chatcmpl-conf",
  model: "grok-4.6",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "end_turn" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

describeAdapterConformance(xaiResponsesAdapter, IRRequestSchema.parse({ version: "0", model: "grok-4.6", messages: [user("hi")] }), ctx, {
  id: "resp_conf",
  model: "grok-4.6",
  status: "completed",
  output: [{ type: "message", id: "msg_conf", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

// ── 리뷰 2026-08-22 회귀 ──
describe("리맵은 타 프로바이더 표식을 소비하지 않는다 (ir-v0 §2)", () => {
  it("providerOptions.openai는 xAI wire로 새지 않는다", () => {
    // openai로 돌던 대화를 grok으로 재타게팅한 상황 — openai 지시는 xai 것이 아니다
    const req = ir({
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100,
      providerOptions: { openai: { serviceTier: "flex" } },
    });
    const { request } = xaiChatAdapter.transformRequest(req, ctx);
    expect(request.body["service_tier"]).toBeUndefined();
  });

  it("자기 네임스페이스(xai)는 정상 소비", () => {
    const req = ir({
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 100,
      providerOptions: { xai: { serviceTier: "flex" } },
    });
    const { request } = xaiChatAdapter.transformRequest(req, ctx);
    expect(request.body["service_tier"]).toBe("flex");
  });

  it("타사 encrypted reasoning은 외래로 취급 — 자기 것으로 복원하지 않는다", () => {
    const req = ir({
      maxOutputTokens: 100,
      messages: [
        { role: "user", blocks: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          blocks: [
            { type: "reasoning", text: "openai 추론", opaqueState: { provider: "openai", data: "ENC_OPENAI" } },
            { type: "text", text: "답" },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "계속" }] },
      ],
    });
    const { request, warnings } = xaiResponsesAdapter.transformRequest(req, ctx);
    expect(JSON.stringify(request.body)).not.toContain("ENC_OPENAI");
    expect(warnings.map((w) => w.code)).toContain("reasoning-dropped");
  });
});
