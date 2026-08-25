import { describe, expect, it } from "vitest";
import type { RequestContext } from "../../types.js";
import { transformResponse } from "./response.js";

const ctx: RequestContext & { requestedModel: string } = {
  requestId: "req_t", modelId: "gpt-5.6-luna", requestedModel: "gpt-5.6-luna",
};

describe("openai responses transformResponse", () => {
  it("message+reasoning+function_call — 블록·origin·usage·finishReason", () => {
    const t = transformResponse(
      {
        id: "resp_1",
        model: "gpt-5.6-luna-2026",
        status: "completed",
        output: [
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC" },
          { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [] }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
        ],
        usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 30 } },
      },
      ctx,
    );
    expect(t.blocks.map((b) => b.type)).toEqual(["reasoning", "text", "toolCall"]);
    const reasoning = t.blocks[0]!;
    expect(reasoning.type === "reasoning" && reasoning.opaqueState).toEqual({ provider: "openai", data: "ENC" });
    expect(reasoning.providerMetadata?.["openai"]?.["item"]).toMatchObject({ type: "reasoning", id: "rs_1" });
    expect(t.blocks.every((b) => b.origin?.surface === "responses")).toBe(true);
    expect(t.finishReason.unified).toBe("tool_call");
    expect(t.usage).toMatchObject({
      input: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
      output: { total: 50, text: 20, reasoning: 30 },
      totalTokens: 150,
    });
    expect(t.providerRequestId).toBe("resp_1");
  });

  it("refusal 파트 — text 강등 + PM 표식 + finishReason refusal", () => {
    const t = transformResponse(
      {
        id: "resp_1", model: "m", status: "completed",
        output: [{ type: "message", id: "msg_1", content: [{ type: "refusal", refusal: "cannot" }] }],
      },
      ctx,
    );
    expect(t.blocks[0]).toMatchObject({ type: "text", text: "cannot", providerMetadata: { openai: { refusal: true, itemId: "msg_1" } } });
    expect(t.finishReason.unified).toBe("refusal");
  });

  it("url_citation annotation → Citation outputRange", () => {
    const t = transformResponse(
      {
        id: "resp_1", model: "m", status: "completed",
        output: [
          {
            type: "message", id: "msg_1",
            content: [
              {
                type: "output_text", text: "Paris is the capital.",
                annotations: [{ type: "url_citation", url: "https://x.test", title: "X", start_index: 0, end_index: 5 }],
              },
            ],
          },
        ],
      },
      ctx,
    );
    const text = t.blocks[0]!;
    expect(text.type === "text" && text.citations).toEqual([
      { source: { type: "url", url: "https://x.test", title: "X" }, location: { type: "outputRange", start: 0, end: 5 } },
    ]);
  });

  it("call_id 미발급 → 결정론적 합성 (같은 응답 재변환 = 같은 id)", () => {
    const body = {
      id: "resp_x", model: "m", status: "completed",
      output: [{ type: "function_call", name: "f", arguments: "{}" }],
    };
    const a = transformResponse(body, ctx);
    const b = transformResponse(body, ctx);
    const call = a.blocks[0]!;
    expect(call.type === "toolCall" && call.toolCallId).toBe("synth:openai:resp_x:0:f");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("미지 item 타입 — passthrough + warning", () => {
    const t = transformResponse(
      { id: "resp_1", model: "m", status: "completed", output: [{ type: "future_item", data: 1 }] },
      ctx,
    );
    expect(t.blocks[0]!.type).toBe("passthrough");
    expect(t.warnings.some((w) => w.code === "unknown-block-passthrough")).toBe(true);
  });

  it("compaction item → custom 블록 (무변경 라운드트립 좌석)", () => {
    const t = transformResponse(
      { id: "resp_1", model: "m", status: "completed", output: [{ type: "compaction", id: "cmp_1" }] },
      ctx,
    );
    expect(t.blocks[0]).toMatchObject({ type: "custom", kind: "openai.compaction" });
  });

  it("incomplete/max_output_tokens → length", () => {
    const t = transformResponse(
      { id: "r", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      ctx,
    );
    expect(t.finishReason).toEqual({ unified: "length", raw: "incomplete:max_output_tokens" });
  });
});

describe("클라이언트 실행 빌트인 툴 왕복 (§13.5 — 감사 openai #4)", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  it("응답: computer_call → providerExecuted 없는 toolCall + item 원문 보존", () => {
    const t = transformResponse(
      {
        id: "resp_cu",
        model: "computer-use-preview",
        status: "completed",
        output: [
          {
            type: "computer_call", id: "cu_1", call_id: "call_cu1",
            action: { type: "click", x: 10, y: 20 },
            pending_safety_checks: [{ id: "sc_1", code: "malicious_instructions", message: "check" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      ctx,
    );
    const call = t.blocks[0]!;
    expect(call).toMatchObject({ type: "toolCall", toolCallId: "call_cu1", toolName: "computer" });
    expect(call.type === "toolCall" && call.providerExecuted).toBeUndefined(); // 클라이언트 실행형
    expect(call.providerMetadata?.["openai"]?.["item"]).toMatchObject({ type: "computer_call" });
  });

  it("요청: 짝 toolCall 기준 *_output 조립 — computer 스크린샷·acked, apply_patch status, shell 문자열", async () => {
    const { transformRequest } = await import("./request.js");
    const cuItem = { type: "computer_call", id: "cu_1", call_id: "call_cu1", action: { type: "screenshot" } };
    const apItem = { type: "apply_patch_call", id: "ap_1", call_id: "call_ap1", input: "diff" };
    const shItem = { type: "local_shell_call", id: "sh_1", call_id: "call_sh1", action: { command: ["ls"] } };
    const req = {
      version: "0" as const,
      model: "computer-use-preview",
      messages: [
        { role: "user" as const, blocks: [{ type: "text" as const, text: "go" }] },
        {
          role: "assistant" as const,
          blocks: [
            { type: "toolCall" as const, toolCallId: "call_cu1", toolName: "computer_call", input: { type: "json" as const, value: cuItem }, origin: { provider: "openai", model: "computer-use-preview", surface: "responses" }, providerOptions: { openai: { item: cuItem } } },
            { type: "toolCall" as const, toolCallId: "call_ap1", toolName: "apply_patch_call", input: { type: "json" as const, value: apItem }, origin: { provider: "openai", model: "computer-use-preview", surface: "responses" }, providerOptions: { openai: { item: apItem } } },
            { type: "toolCall" as const, toolCallId: "call_sh1", toolName: "local_shell_call", input: { type: "json" as const, value: shItem }, origin: { provider: "openai", model: "computer-use-preview", surface: "responses" }, providerOptions: { openai: { item: shItem } } },
          ],
        },
        {
          role: "tool" as const,
          blocks: [
            {
              type: "toolResult" as const,
              toolCallId: "call_cu1",
              toolName: "computer_call",
              output: { type: "content" as const, blocks: [{ type: "file" as const, mediaType: "image/png", data: { type: "base64" as const, data: PNG } }] },
              providerOptions: { openai: { acknowledgedSafetyChecks: [{ id: "sc_1" }] } },
            },
            { type: "toolResult" as const, toolCallId: "call_ap1", toolName: "apply_patch_call", output: { type: "errorText" as const, text: "patch failed" } },
            { type: "toolResult" as const, toolCallId: "call_sh1", toolName: "local_shell_call", output: { type: "text" as const, text: "file.txt" } },
          ],
        },
      ],
    };
    const { request } = transformRequest(req as never, { requestId: "req_cu", modelId: "computer-use-preview" });
    const input = request.body["input"] as Array<Record<string, unknown>>;
    const outputs = input.filter((i) => String(i["type"]).endsWith("_output"));
    expect(outputs).toHaveLength(3);
    const cu = outputs.find((i) => i["type"] === "computer_call_output")!;
    expect(cu["call_id"]).toBe("call_cu1");
    expect(cu["output"]).toMatchObject({ type: "computer_screenshot" });
    expect(cu["acknowledged_safety_checks"]).toEqual([{ id: "sc_1" }]);
    const ap = outputs.find((i) => i["type"] === "apply_patch_call_output")!;
    expect(ap["status"]).toBe("failed");
    expect(ap["output"]).toBe("patch failed");
    const sh = outputs.find((i) => i["type"] === "local_shell_call_output")!;
    expect(sh["output"]).toBe("file.txt");
  });

  it("요청: computer output에 스크린샷 file 블록 부재는 4xx (§13.5 — 조용한 반쪽 제출 금지)", async () => {
    const { transformRequest } = await import("./request.js");
    const cuItem = { type: "computer_call", id: "cu_1", call_id: "call_cu1", action: { type: "screenshot" } };
    const req = {
      version: "0" as const,
      model: "computer-use-preview",
      messages: [
        {
          role: "assistant" as const,
          blocks: [{ type: "toolCall" as const, toolCallId: "call_cu1", toolName: "computer_call", input: { type: "json" as const, value: cuItem }, origin: { provider: "openai", model: "computer-use-preview", surface: "responses" }, providerOptions: { openai: { item: cuItem } } }],
        },
        { role: "tool" as const, blocks: [{ type: "toolResult" as const, toolCallId: "call_cu1", toolName: "computer_call", output: { type: "text" as const, text: "no screenshot" } }] },
      ],
    };
    expect(() => transformRequest(req as never, { requestId: "req_cu", modelId: "computer-use-preview" })).toThrow(/스크린샷/);
  });
});
