import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../../tools/capture/fixtures.js";
import { parseSSEText } from "../stream/sse.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { createApp } from "../server/app.js";
import { compatChatToIR } from "./openai-compat/request.js";
import { compatMessagesToIR } from "./anthropic-compat/request.js";
import { GatewayError } from "../gateway/errors.js";
import { anthropicAdapter } from "../adapters/anthropic/index.js";
import { createStreamTransformer as createAnthropicStream } from "../adapters/anthropic/stream.js";
import { createMessagesDownconverter } from "./anthropic-compat/stream.js";
import { createChatDownconverter } from "./openai-compat/stream.js";
import { toMessagesUsage as toMessagesUsageForTest } from "./anthropic-compat/response.js";

// compat 인바운드 2종 (부록 (a)) — 변환 단위 + E2E(픽스처 mock — D9 네트워크 금지).
// E2E가 곧 크로스 검증: openai-compat 포맷으로 claude 모델 호출 → anthropic 아웃바운드.

process.env["ANTHROPIC_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

function fixtureFetch(caseName: string): typeof fetch {
  const fixture = readFixture("anthropic", caseName);
  if (!fixture) throw new Error(`픽스처 없음: ${caseName}`);
  const { meta, chunks } = fixture;
  return async () => {
    if (meta.stream && meta.status === 200) {
      return new Response(chunks, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify(meta.body), { status: meta.status, headers: { "content-type": "application/json" } });
  };
}

const deps = (caseName: string) => ({
  fetchImpl: fixtureFetch(caseName),
  now: () => new Date("2026-08-21T00:00:00Z"),
  genId: () => "req_compat01",
  heartbeatMs: 60_000,
});

describe("openai-compat 요청 변환 (§3.1)", () => {
  it("CC 메시지·툴·파라미터 → IR", () => {
    const ir = compatChatToIR(
      {
        model: "claude-haiku-4-5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
          { role: "assistant", content: "hello", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "result" },
        ],
        max_completion_tokens: 100,
        temperature: 0.5,
        seed: 42,
        stop: ["END"],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" }, strict: true } }],
        tool_choice: { type: "function", function: { name: "f" } },
        response_format: { type: "json_schema", json_schema: { name: "out", schema: { type: "object" }, strict: true } },
        reasoning_effort: "low",
        user: "u1",
        store: true,
      },
      false,
    );
    expect(ir.model).toBe("claude-haiku-4-5");
    expect(ir.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(ir.messages[1]!.blocks.map((b) => b.type)).toEqual(["text", "file"]);
    expect(ir.messages[2]!.blocks.map((b) => b.type)).toEqual(["text", "toolCall"]);
    expect(ir.maxOutputTokens).toBe(100);
    expect(ir.seed).toBe(42);
    expect(ir.stopSequences).toEqual(["END"]);
    expect(ir.toolChoice).toEqual({ type: "tool", toolName: "f" });
    expect(ir.responseFormat).toMatchObject({ type: "json", name: "out", strict: true });
    expect(ir.reasoning?.effort).toBe("low");
    expect(ir.metadata?.["userId"]).toBe("u1");
    expect(ir.providerOptions?.["openai"]).toEqual({ store: true });
  });

  it("gateway.ir 복원 1순위 — opaqueState·origin 포함 왕복 (§13.4-2)", () => {
    const ir = compatChatToIR(
      {
        model: "gpt-5.6-luna",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "visible",
            gateway: {
              origin: { provider: "openai", model: "gpt-5.6-luna", surface: "responses" },
              ir: [
                { type: "reasoning", text: "hidden", opaqueState: { provider: "openai", data: "ENC" } },
                { type: "text", text: "visible" },
              ],
            },
          },
          { role: "user", content: "more" },
        ],
      },
      false,
    );
    const assistant = ir.messages[1]!;
    expect(assistant.origin?.surface).toBe("responses");
    expect(assistant.blocks[0]).toMatchObject({ type: "reasoning", opaqueState: { provider: "openai", data: "ENC" } });
  });

  it("gateway.ir 검증 실패는 4xx (조용한 절반 복원 금지)", () => {
    expect(() =>
      compatChatToIR(
        { model: "m", messages: [{ role: "assistant", gateway: { ir: [{ type: "nonsense" }] } }] },
        false,
      ),
    ).toThrow(GatewayError);
  });

  it("n>1은 400 (G2), 미지 키는 400 (D5)", () => {
    expect(() => compatChatToIR({ model: "m", messages: [{ role: "user", content: "x" }], n: 2 }, false)).toThrow(/n>1/);
    expect(() => compatChatToIR({ model: "m", messages: [{ role: "user", content: "x" }], future_param: 1 }, false)).toThrow(/future_param/);
    // opt-in이면 통과 (미지 키는 무시하지 않고 IR로 못 실으므로 드롭 — v0)
    expect(() => compatChatToIR({ model: "m", messages: [{ role: "user", content: "x" }], future_param: 1 }, true)).not.toThrow();
  });
});

describe("anthropic-compat 요청 변환 (§3.2)", () => {
  it("블록·cache_control·thinking·베타 헤더 → IR", () => {
    const ir = compatMessagesToIR(
      {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "SIG" },
              { type: "tool_use", id: "toolu_1", name: "f", input: { x: 1 } },
            ],
            gateway: { origin: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" } },
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        ],
        tools: [{ name: "f", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
        tool_choice: { type: "any", disable_parallel_tool_use: true },
        thinking: { type: "enabled", budget_tokens: 1000 },
        metadata: { user_id: "u1" },
      },
      false,
      "context-1m-2025-08-07",
    );
    expect(ir.maxOutputTokens).toBe(200);
    expect(ir.messages[0]!.blocks[0]!.providerOptions?.["anthropic"]?.["cacheControl"]).toEqual({ type: "ephemeral" });
    const assistant = ir.messages[2]!;
    expect(assistant.origin?.surface).toBe("messages");
    expect(assistant.blocks[0]).toMatchObject({ type: "reasoning", opaqueState: { provider: "anthropic", data: "SIG" } });
    expect(assistant.blocks[1]).toMatchObject({ type: "toolCall", toolCallId: "toolu_1" });
    expect(ir.messages[3]!.blocks[0]).toMatchObject({ type: "toolResult", output: { type: "text", text: "ok" } });
    expect(ir.toolChoice).toBe("required");
    expect(ir.parallelToolCalls).toBe(false);
    expect(ir.tools?.[0]).toMatchObject({ type: "function", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } });
    expect(ir.providerOptions?.["anthropic"]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1000 }, betas: ["context-1m-2025-08-07"] });
    expect(ir.metadata?.["userId"]).toBe("u1");
  });

  it("서버 툴 정의 → provider 툴", () => {
    const ir = compatMessagesToIR(
      {
        model: "claude-haiku-4-5",
        max_tokens: 100,
        messages: [{ role: "user", content: "search" }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      },
      false,
    );
    expect(ir.tools?.[0]).toEqual({
      type: "provider",
      id: "anthropic.web_search",
      args: { type: "web_search_20250305", max_uses: 3 },
    });
  });
});

describe("compat E2E — 픽스처 mock (부록 (a) §1: 포맷 ≠ 타깃 교차)", () => {
  it("openai-compat 포맷으로 claude 호출 → CC 응답 + gateway.ir (비스트림)", async () => {
    const app = createApp(deps("text"));
    const res = await app.request("/compat/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_completion_tokens: 100,
        messages: [{ role: "user", content: "capital of France?" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
    const choice = (body["choices"] as Array<Record<string, unknown>>)[0]!;
    expect(choice["finish_reason"]).toBe("stop");
    expect((choice["message"] as Record<string, unknown>)["content"]).toBeTruthy();
    const usage = body["usage"] as Record<string, unknown>;
    expect(usage["prompt_tokens"]).toBeGreaterThan(0);
    const gateway = body["gateway"] as Record<string, unknown>;
    expect(Array.isArray(gateway["ir"])).toBe(true);
    expect((gateway["origin"] as Record<string, unknown>)["provider"]).toBe("anthropic");
    expect(res.headers.get("x-gateway-request-id")).toBe("req_compat01");
  });

  it("strict 모드 — gateway 확장 미부가 (§2.1)", async () => {
    const app = createApp(deps("text"));
    const res = await app.request("/compat/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-compat": "strict" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["gateway"]).toBeUndefined();
  });

  it("openai-compat 스트림 — CC chunk 재합성 + [DONE] (§6.1)", async () => {
    const app = createApp(deps("text-stream"));
    const res = await app.request("/compat/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true, messages: [{ role: "user", content: "count" }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = parseSSEText(text);
    expect(frames.at(-1)!.data.trim()).toBe("[DONE]");
    const parsed = frames.filter((f) => f.data.trim() !== "[DONE]").map((f) => JSON.parse(f.data) as Record<string, unknown>);
    expect(parsed.every((p) => p["object"] === "chat.completion.chunk" || p["gateway"] !== undefined)).toBe(true);
    const contents = parsed
      .flatMap((p) => (p["choices"] as Array<Record<string, unknown>> | undefined) ?? [])
      .map((ch) => (ch["delta"] as Record<string, unknown> | undefined)?.["content"])
      .filter((c): c is string => typeof c === "string");
    expect(contents.join("").length).toBeGreaterThan(0);
    const finishes = parsed
      .flatMap((p) => (p["choices"] as Array<Record<string, unknown>> | undefined) ?? [])
      .map((ch) => ch["finish_reason"])
      .filter((f) => f != null);
    expect(finishes).toEqual(["stop"]);
    expect(parsed.some((p) => p["usage"] !== undefined)).toBe(true);
    expect(parsed.some((p) => p["gateway"] !== undefined)).toBe(true); // gateway.ir chunk
  });

  it("anthropic-compat 비스트림 — Messages 응답 + gateway.origin (§2.2, raw stop_reason 보존)", async () => {
    const app = createApp(deps("text"));
    const res = await app.request("/compat/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("message");
    expect(body["stop_reason"]).toBe("end_turn"); // origin==anthropic → raw 그대로
    expect((body["content"] as unknown[]).length).toBeGreaterThan(0);
    const usage = body["usage"] as Record<string, unknown>;
    expect(usage["input_tokens"]).toBeGreaterThan(0);
    expect((body["gateway"] as Record<string, unknown>)["origin"]).toMatchObject({ provider: "anthropic" });
  });

  it("anthropic-compat 스트림 — SSE 이벤트 재합성 (§6.2)", async () => {
    const app = createApp(deps("text-stream"));
    const res = await app.request("/compat/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "count" }] }),
    });
    const frames = parseSSEText(await res.text());
    const eventNames = frames.map((f) => f.event);
    expect(eventNames[0]).toBe("message_start");
    expect(eventNames).toContain("content_block_start");
    expect(eventNames).toContain("content_block_delta");
    expect(eventNames.at(-1)).toBe("message_stop");
    const messageDelta = frames.find((f) => f.event === "message_delta")!;
    const delta = JSON.parse(messageDelta.data) as Record<string, unknown>;
    expect((delta["delta"] as Record<string, unknown>)["stop_reason"]).toBe("end_turn");
    expect((delta["usage"] as Record<string, unknown>)["output_tokens"]).toBeGreaterThan(0);
  });

  it("에러 다운컨버트 — 각 포맷의 wire 에러 형태 (§7)", async () => {
    const app = createApp(deps("error-400-missing-max-tokens"));
    const cc = await app.request("/compat/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] }),
    });
    expect(cc.status).toBe(400);
    const ccBody = (await cc.json()) as Record<string, unknown>;
    expect((ccBody["error"] as Record<string, unknown>)["type"]).toBe("invalid_request_error");

    const app2 = createApp(deps("error-400-missing-max-tokens"));
    const an = await app2.request("/compat/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }),
    });
    expect(an.status).toBe(400);
    const anBody = (await an.json()) as Record<string, unknown>;
    expect(anBody["type"]).toBe("error");
  });
});

describe("anthropic-compat — neuro형 요청 왕복 (부록 (a) §3.2 2026-08-21 개정)", () => {
  const NEURO_WIRE = {
    model: "claude-haiku-4-5",
    max_tokens: 4000,
    system: [{ type: "text", text: "You are an ads agent.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "analyze campaign" }],
    tools: [
      // PTC — allowed_callers는 IR 표준 밖 비표준 키
      {
        name: "get_campaign_data",
        input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        allowed_callers: ["code_execution_20250825"],
      },
      { type: "code_execution_20250825", name: "code_execution" },
    ],
    thinking: { type: "enabled", budget_tokens: 2048 },
    // 게이트웨이가 모르는 top-level 3종 — passthroughParams로 통과해야 함
    container: "cont_fixture0001",
    context_management: { edits: [{ type: "context_compaction" }] },
    mcp_servers: [{ type: "url", url: "https://mcp.example.test", name: "neuro" }],
  };

  it("미지 top-level 키 → passthroughParams(pinned) → 아웃바운드 wire 원문 복원", () => {
    const ir = compatMessagesToIR(NEURO_WIRE, false, "context-management-2025-06-27,code-execution-2025-08-25");
    expect(ir.passthroughParams).toEqual({
      provider: "anthropic",
      params: {
        container: "cont_fixture0001",
        context_management: { edits: [{ type: "context_compaction" }] },
        mcp_servers: [{ type: "url", url: "https://mcp.example.test", name: "neuro" }],
      },
      pinned: true,
    });

    // IR → anthropic wire — 원문 필드가 그대로 돌아와야 함
    const { request } = anthropicAdapter.transformRequest(ir, { requestId: "req_n", modelId: "claude-haiku-4-5" });
    expect(request.body["container"]).toBe("cont_fixture0001");
    expect(request.body["context_management"]).toEqual(NEURO_WIRE.context_management);
    expect(request.body["mcp_servers"]).toEqual(NEURO_WIRE.mcp_servers);
    expect(request.body["thinking"]).toEqual(NEURO_WIRE.thinking);
    expect(request.headers["anthropic-beta"]).toBe("context-management-2025-06-27,code-execution-2025-08-25");

    // PTC 툴 확장 키 재병합 + 서버 툴 정의 복원
    const tools = request.body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ name: "get_campaign_data", allowed_callers: ["code_execution_20250825"] });
    expect(tools[1]).toEqual({ name: "code_execution", type: "code_execution_20250825" });
  });

  it("응답 container가 compat 응답 최상위로 복원 (§2.2)", () => {
    const t = anthropicAdapter.transformResponse(
      {
        id: "msg_c1", model: "claude-haiku-4-5", content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
        container: { id: "cont_fixture0001", expires_at: "2026-08-21T01:00:00Z" },
      },
      { requestId: "req_n", modelId: "claude-haiku-4-5", requestedModel: "claude-haiku-4-5" },
    );
    expect(t.providerMetadata?.["anthropic"]?.["container"]).toMatchObject({ id: "cont_fixture0001" });
  });
});

describe("container 스트림 경로 (§10.1 PM — message_start 왕복)", () => {
  it("어댑터: message_start.container → response-metadata PM", () => {
    const t = createAnthropicStream({ modelId: "claude-haiku-4-5" });
    const events = t.onEvent("message_start", JSON.stringify({
      type: "message_start",
      message: { id: "msg_1", model: "claude-haiku-4-5", usage: { input_tokens: 1 }, container: { id: "cont_x" } },
    }));
    const meta = events.find((e) => e.type === "response-metadata")!;
    expect(meta.type === "response-metadata" && meta.providerMetadata?.["anthropic"]?.["container"]).toEqual({ id: "cont_x" });
  });

  it("다운컨버터: response-metadata PM → message_start.message.container", () => {
    const down = createMessagesDownconverter(false);
    const frames = down({
      type: "response-metadata", seq: 1, id: "req_x", created: "2026-08-21T00:00:00Z",
      model: { requested: "claude-haiku-4-5", resolved: { provider: "anthropic", model: "claude-haiku-4-5", surface: "messages" } },
      providerMetadata: { anthropic: { container: { id: "cont_x" } } },
    });
    const start = JSON.parse(frames[0]!.data) as Record<string, any>;
    expect(start.message.container).toEqual({ id: "cont_x" });
  });
});

describe("리뷰 수정 검증 (2026-08-21 — G1·G2·G3·G5·G6)", () => {
  const mkStream = () => createAnthropicStream({ modelId: "claude-haiku-4-5" });

  it("G1: message_delta로 온 container도 finish PM에 실린다 (턴 중 생성·교체)", () => {
    const t = mkStream();
    t.onEvent("message_start", JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "m", usage: { input_tokens: 1 } } }));
    t.onEvent("message_delta", JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", container: { id: "cont_late" } }, usage: { output_tokens: 2 } }));
    const events = t.onEvent("message_stop", JSON.stringify({ type: "message_stop" }));
    const finish = events.find((e) => e.type === "finish")!;
    expect(finish.type === "finish" && finish.providerMetadata?.["anthropic"]?.["container"]).toEqual({ id: "cont_late" });
  });

  it("G1: 다운컨버터가 finish PM container를 message_delta 최상위로 복원", () => {
    const down = createMessagesDownconverter(false);
    down({ type: "response-metadata", seq: 1, id: "r", created: "2026-08-21T00:00:00Z", model: { requested: "m", resolved: { provider: "anthropic", model: "m", surface: "messages" } } });
    const frames = down({
      type: "finish", seq: 2, finishReason: { unified: "stop", raw: "end_turn" },
      usage: { input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, output: { total: 2, text: 2, reasoning: 0 }, totalTokens: 3, raw: {} },
      providerMetadata: { anthropic: { container: { id: "cont_late" } } },
    });
    const delta = JSON.parse(frames[0]!.data) as Record<string, unknown>;
    expect(delta["container"]).toEqual({ id: "cont_late" });
  });

  it("G2: 스트림 warning이 finish의 gateway.warnings로 전달 (소멸 금지)", () => {
    const down = createMessagesDownconverter(false);
    down({ type: "stream-start", seq: 0, warnings: [{ type: "compatibility", code: "cache-breakpoint-ignored", message: "x" }] });
    down({ type: "response-metadata", seq: 1, id: "r", created: "2026-08-21T00:00:00Z", model: { requested: "m", resolved: { provider: "openai", model: "g", surface: "responses" } } });
    down({ type: "warning", seq: 2, warning: { type: "compatibility", code: "server-state-inapplicable", message: "y" } });
    const frames = down({
      type: "finish", seq: 3, finishReason: { unified: "stop", raw: "completed" },
      usage: { input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, output: { total: 1, text: 1, reasoning: 0 }, totalTokens: 2, raw: {} },
    });
    const delta = JSON.parse(frames[0]!.data) as Record<string, any>;
    expect(delta.gateway.warnings.map((w: any) => w.code)).toEqual(["cache-breakpoint-ignored", "server-state-inapplicable"]);
  });

  it("G3: origin==anthropic이면 usage raw 우선 복원 — cache TTL 내역 보존", () => {
    const t = anthropicAdapter.transformResponse(
      {
        id: "msg_1", model: "m", content: [{ type: "text", text: "x" }], stop_reason: "end_turn",
        usage: {
          input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
        },
      },
      { requestId: "r", modelId: "m", requestedModel: "m" },
    );
    const wire = toMessagesUsageForTest(t.usage, true);
    expect(wire["cache_creation"]).toEqual({ ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 });
    const flat = toMessagesUsageForTest(t.usage, false);
    expect(flat["cache_creation"]).toBeUndefined();
  });

  it("G6: 히스토리 tool_use의 caller가 wireExtras로 왕복", () => {
    const ir = compatMessagesToIR(
      {
        model: "claude-haiku-4-5", max_tokens: 100,
        messages: [
          { role: "user", content: "run" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {}, caller: { type: "code_execution_20260120" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        ],
      },
      false,
    );
    const toolCall = ir.messages[1]!.blocks[0]!;
    expect(toolCall.providerOptions?.["anthropic"]?.["wireExtras"]).toEqual({ caller: { type: "code_execution_20260120" } });
    const { request } = anthropicAdapter.transformRequest(ir, { requestId: "r", modelId: "claude-haiku-4-5" });
    const wireMsgs = request.body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
    const wireToolUse = wireMsgs[1]!.content.find((b) => b["type"] === "tool_use")!;
    expect(wireToolUse["caller"]).toEqual({ type: "code_execution_20260120" });
  });

  it("G5: wireExtras가 조립 키와 충돌하면 드롭 + warning (조용한 스킵 금지)", () => {
    const ir = compatMessagesToIR(
      { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "x" }], tools: [{ name: "f", input_schema: { type: "object" } }] },
      false,
    );
    const tampered = {
      ...ir,
      tools: [{ ...ir.tools![0]!, providerOptions: { anthropic: { wireExtras: { name: "hijacked", allowed_callers: ["x"] } } } }],
    };
    const { request, warnings } = anthropicAdapter.transformRequest(tampered as typeof ir, { requestId: "r", modelId: "claude-haiku-4-5" });
    const tool = (request.body["tools"] as Array<Record<string, unknown>>)[0]!;
    expect(tool["name"]).toBe("f");
    expect(tool["allowed_callers"]).toEqual(["x"]);
    expect(warnings.some((w) => w.code === "parameter-dropped" && w.path?.includes("wireExtras.name"))).toBe(true);
  });
});

// ── 리뷰 2026-08-22 회귀 ──
describe("compat 다운컨버터 — 폴백 중 error-partial은 종결이 아니다 (ir-v0 §6.4)", () => {
  const retrying = {
    type: "error-partial" as const,
    seq: 3,
    error: { category: "overloaded" as const, httpStatus: 529, message: "busy", fallbackEligible: true, billed: false },
    willRetry: true,
  };
  const givingUp = { ...retrying, willRetry: false };

  it("openai-compat: willRetry면 [DONE] 금지 (SDK가 스트림을 끊어 폴백 성공분이 유실된다)", () => {
    const down = createChatDownconverter(false);
    const frames = down(retrying);
    expect(frames.map((f) => f.data)).not.toContain("[DONE]");
    expect(down(givingUp).map((f) => f.data)).toContain("[DONE]");
  });

  it("anthropic-compat: willRetry면 error 이벤트 미방출", () => {
    const down = createMessagesDownconverter(false);
    expect(down(retrying)).toEqual([]);
    expect(down(givingUp).map((f) => f.event)).toEqual(["error"]);
  });

  it("provider-switched는 finish의 gateway.warnings로 보고 (D5 — 조용한 전환 금지)", () => {
    const down = createChatDownconverter(false);
    down({
      type: "provider-switched",
      seq: 4,
      from: { provider: "anthropic", model: "claude-haiku-4-5" },
      to: { provider: "openai", model: "gpt-5.6-luna" },
      reason: "overloaded — 폴백 체인 진행",
    });
    const finishFrames = down({
      type: "finish",
      seq: 9,
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        output: { total: 1, text: 1, reasoning: 0 },
        totalTokens: 2,
        raw: {},
      },
    });
    const gatewayChunk = finishFrames
      .map((f) => (f.data.startsWith("{") ? (JSON.parse(f.data) as Record<string, any>) : null))
      .find((c) => c?.["gateway"]);
    expect(gatewayChunk!["gateway"]["warnings"].map((w: { code: string }) => w.code)).toContain(
      "fallback-target-switched",
    );
  });
});

describe("openai-compat 요청 — 빈 system content (부록 (a) §3.1)", () => {
  it("빈 문자열 system은 메시지 생략 — OpenAI가 수용하는 요청이 400이 되면 안 된다", () => {
    const ir = compatChatToIR(
      { model: "claude-haiku-4-5", messages: [{ role: "system", content: "" }, { role: "user", content: "hi" }] },
      false,
    );
    expect(ir.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("내용 있는 system은 그대로 유지", () => {
    const ir = compatChatToIR(
      { model: "claude-haiku-4-5", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] },
      false,
    );
    expect(ir.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
