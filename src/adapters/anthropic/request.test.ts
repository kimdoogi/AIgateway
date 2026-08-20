import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../../ir/request.js";
import { transformRequest } from "./request.js";
import { AdapterInvalidRequestError } from "../shared.js";

const ctx = { requestId: "req_t", modelId: "claude-haiku-4-5" };

function baseReq(extra: Record<string, unknown> = {}): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model: "claude-haiku-4-5",
    maxOutputTokens: 512,
    messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    ...extra,
  });
}

describe("anthropic transformRequest", () => {
  it("선두 system은 top-level system으로, cache_control은 블록 PO에서", () => {
    const req = baseReq({
      messages: [
        {
          role: "system",
          blocks: [
            {
              type: "text",
              text: "You are helpful.",
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "hi" }] },
      ],
    });
    const { request } = transformRequest(req, ctx);
    expect(request.body["system"]).toEqual([
      { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(request.path).toBe("/v1/messages");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("tool 롤 → user tool_result 재편 + 연속 동일 롤 병합, thinking 서명 왕복", () => {
    const req = baseReq({
      messages: [
        { role: "user", blocks: [{ type: "text", text: "날씨?" }] },
        {
          role: "assistant",
          blocks: [
            { type: "reasoning", text: "생각", opaqueState: { provider: "anthropic", data: "sig1" } },
            {
              type: "toolCall",
              toolCallId: "toolu_01",
              toolName: "weather",
              input: { type: "json", value: { city: "서울" } },
            },
          ],
        },
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: "toolu_01",
              toolName: "weather",
              output: { type: "text", text: "맑음" },
            },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "고마워" }] },
      ],
    });
    const { request, warnings } = transformRequest(req, ctx);
    expect(warnings).toEqual([]);
    expect(request.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "날씨?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "생각", signature: "sig1" },
          { type: "tool_use", id: "toolu_01", name: "weather", input: { city: "서울" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "맑음" },
          { type: "text", text: "고마워" },
        ],
      },
    ]);
  });

  it("서버 툴 결과·호출은 wireType으로 원문 복원 (G1 왕복 — 리뷰 R1)", () => {
    const req = baseReq({
      messages: [
        { role: "user", blocks: [{ type: "text", text: "검색해줘" }] },
        {
          role: "assistant",
          origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" },
          blocks: [
            {
              type: "toolCall",
              toolCallId: "srvtoolu_01",
              toolName: "web_search",
              input: { type: "json", value: { query: "AI 게이트웨이" } },
              providerExecuted: true,
              providerOptions: { anthropic: { wireType: "server_tool_use" } }, // 히스토리 편입 후 형태
            },
            {
              type: "toolResult",
              toolCallId: "srvtoolu_01",
              toolName: "web_search",
              output: { type: "json", value: [{ type: "web_search_result", url: "https://x" }] },
              providerExecuted: true,
              providerOptions: { anthropic: { wireType: "web_search_tool_result" } },
            },
            { type: "text", text: "결과를 요약하면..." },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "고마워" }] },
      ],
    });
    const { request, warnings } = transformRequest(req, ctx);
    expect(warnings).toEqual([]);
    const messages = request.body["messages"] as Array<{ content: unknown[] }>;
    expect(messages[1]!.content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "AI 게이트웨이" } },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_01",
        content: [{ type: "web_search_result", url: "https://x" }],
      },
      { type: "text", text: "결과를 요약하면..." },
    ]);
  });

  it("retarget.reasoning=demote-to-text: 외래 reasoning을 텍스트 강등 + reasoning-demoted (리뷰 R6a)", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        blocks: [
          { type: "reasoning", text: "openai 추론", opaqueState: { provider: "openai", data: "enc" } },
          { type: "text", text: "답" },
        ],
      },
      { role: "user", blocks: [{ type: "text", text: "이어서" }] },
    ];
    const demoted = transformRequest(baseReq({ messages, retarget: { reasoning: "demote-to-text" } }), ctx);
    expect(demoted.warnings.map((w) => w.code)).toContain("reasoning-demoted");
    const msgs = demoted.request.body["messages"] as Array<{ content: unknown[] }>;
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "openai 추론" },
      { type: "text", text: "답" },
    ]);

    const dropped = transformRequest(baseReq({ messages }), ctx); // 기본 drop
    expect(dropped.warnings.map((w) => w.code)).toContain("reasoning-dropped");
  });

  it("중간 system: 기본은 user 변환+warning, capability 지원 시 role system (리뷰 R4)", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "hi" }] },
      { role: "system", blocks: [{ type: "text", text: "새 지침" }] },
      { role: "user", blocks: [{ type: "text", text: "계속" }] },
    ];
    const gated = transformRequest(baseReq({ messages }), ctx);
    expect(gated.warnings.map((w) => w.code)).toContain("system-repositioned");
    expect(gated.request.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: "새 지침" }, { type: "text", text: "계속" }] },
    ]);

    const native = transformRequest(baseReq({ messages }), {
      ...ctx,
      capabilities: { midConversationSystem: true },
    });
    expect(native.warnings).toEqual([]);
    expect(native.request.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: [{ type: "text", text: "새 지침" }] },
      { role: "user", content: [{ type: "text", text: "계속" }] },
    ]);
  });

  it("미지원 sampling은 드롭+warning, strictParameters면 4xx (shared 공통 정책)", () => {
    const { warnings } = transformRequest(baseReq({ seed: 42, temperature: 0.5 }), ctx);
    expect(warnings.map((x) => x.code)).toContain("parameter-dropped");
    expect(() => transformRequest(baseReq({ seed: 42, strictParameters: true }), ctx)).toThrow(
      AdapterInvalidRequestError,
    );
  });

  it("maxOutputTokens 미지정 시 기본값 주입 + parameter-defaulted 보고 (리뷰 A6)", () => {
    const req = IRRequestSchema.parse({
      version: "0",
      model: "claude-haiku-4-5",
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
    });
    const { request, warnings } = transformRequest(req, ctx);
    expect(request.body["max_tokens"]).toBe(4096);
    expect(warnings.map((w) => w.code)).toContain("parameter-defaulted");
  });

  it("effort none은 low로 클램프 + warning, betas는 헤더로", () => {
    const req = baseReq({
      reasoning: { effort: "none" },
      providerOptions: { anthropic: { betas: ["compact-2026-01-12"] } },
    });
    const { request, warnings } = transformRequest(req, ctx);
    expect((request.body["output_config"] as Record<string, unknown>)["effort"]).toBe("low");
    expect(warnings.map((x) => x.code)).toContain("parameter-clamped");
    expect(request.headers["anthropic-beta"]).toBe("compact-2026-01-12");
  });

  it("metadata: userId 외 키는 드롭 + 보고 (리뷰 R6c)", () => {
    const { request, warnings } = transformRequest(
      baseReq({ metadata: { userId: "u1", traceId: "t9" } }),
      ctx,
    );
    expect(request.body["metadata"]).toEqual({ user_id: "u1" });
    expect(warnings.map((w) => w.path)).toContain("metadata.traceId");
  });

  it("PO 미지 키는 기본 거부, opt-in이면 body 병합 + warning (D5)", () => {
    const withUnknown = { providerOptions: { anthropic: { futureParam: { a: 1 } } } };
    expect(() => transformRequest(baseReq(withUnknown), ctx)).toThrow(AdapterInvalidRequestError);
    const { request, warnings } = transformRequest(
      baseReq({ ...withUnknown, allowUnknownProviderOptions: true }),
      ctx,
    );
    expect(request.body["futureParam"]).toEqual({ a: 1 });
    expect(warnings.map((x) => x.code)).toContain("unknown-provider-option-passed");
  });

  it("passthroughParams: 병합 + 예약 키 충돌은 4xx, 타 프로바이더 도달은 게이트웨이 결함 (리뷰 R5/A5)", () => {
    const { request } = transformRequest(
      baseReq({
        passthroughParams: {
          provider: "anthropic",
          params: { brand_new_param: true },
          headers: { "anthropic-beta": "future-beta-2027" },
        },
      }),
      ctx,
    );
    expect(request.body["brand_new_param"]).toBe(true);
    expect(request.headers["anthropic-beta"]).toBe("future-beta-2027");

    // 어댑터가 조립한 핵심 필드 덮어쓰기 → 명시적 에러
    expect(() =>
      transformRequest(
        baseReq({ passthroughParams: { provider: "anthropic", params: { model: "other-model" } } }),
        ctx,
      ),
    ).toThrow(AdapterInvalidRequestError);

    // 타 프로바이더 params 도달 = 정책 레이어 결함 신호
    expect(() =>
      transformRequest(baseReq({ passthroughParams: { provider: "openai", params: { x: 1 } } }), ctx),
    ).toThrow(AdapterInvalidRequestError);
  });

  it("toolChoice none + parallelToolCalls:false 조합은 드롭 + 보고 (리뷰 P4 — 녹화 검증 전 안전측)", () => {
    const { request, warnings } = transformRequest(
      baseReq({ toolChoice: "none", parallelToolCalls: false }),
      ctx,
    );
    expect(request.body["tool_choice"]).toEqual({ type: "none" });
    expect(warnings.map((w) => w.path)).toContain("parallelToolCalls");

    const ok = transformRequest(baseReq({ toolChoice: "auto", parallelToolCalls: false }), ctx);
    expect(ok.request.body["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("비JSON 툴 입력은 명시적 에러", () => {
    expect(() =>
      transformRequest(
        baseReq({
          messages: [
            { role: "user", blocks: [{ type: "text", text: "hi" }] },
            {
              role: "assistant",
              blocks: [
                { type: "toolCall", toolCallId: "c1", toolName: "patch", input: { type: "text", text: "diff" } },
              ],
            },
            { role: "user", blocks: [{ type: "text", text: "ok" }] },
          ],
        }),
        ctx,
      ),
    ).toThrow(AdapterInvalidRequestError);
  });
});
