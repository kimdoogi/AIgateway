import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../../tools/capture/fixtures.js";
import { parseSSEText } from "../stream/sse.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { createApp } from "../server/app.js";
import { compatChatToIR } from "./openai-compat/request.js";
import { compatMessagesToIR } from "./anthropic-compat/request.js";
import { GatewayError } from "../gateway/errors.js";

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
