import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../tools/capture/fixtures.js";
import { anthropicAdapter } from "../adapters/anthropic/index.js";
import { geminiAdapter } from "../adapters/gemini/index.js";
import { openaiResponsesAdapter } from "../adapters/openai/index.js";
import type { OutboundAdapter, RequestContext } from "../adapters/types.js";
import { responseToHistoryMessage } from "../ir/history.js";
import { IRRequestSchema, IRResponseSchema, type IRRequest, type IRResponse } from "../ir/index.js";
import type { Message } from "../ir/message.js";
import { retargetRequest } from "./retarget.js";

// 골든셋 ④ — 크로스 왕복 (D9): A 프로바이더 응답 → IR → 히스토리 편입(§13.1) →
// 재타게팅 패스(§13.3) → B 프로바이더 wire 요청 스냅샷.
// 검증 대상: 외래 reasoning 정책, 서버툴·custom 강등, tool 쌍 보존, warning 조립 —
// 조용한 변조가 생기면 스냅샷 diff로 드러난다.

function toIRResponse(adapter: OutboundAdapter, body: unknown, model: string): IRResponse {
  const ctx: RequestContext & { requestedModel: string } = {
    requestId: "req_cross",
    modelId: model,
    requestedModel: model,
  };
  const t = adapter.transformResponse(body, ctx);
  return IRResponseSchema.parse({
    version: "0",
    id: "req_cross",
    created: "2026-08-21T00:00:00Z",
    model: { requested: model, resolved: { provider: t.origin.provider, model: t.origin.model, surface: t.origin.surface ?? adapter.surface } },
    message: { role: "assistant", blocks: t.blocks, origin: t.origin },
    finishReason: t.finishReason,
    usage: t.usage,
    warnings: t.warnings,
    gateway: { requestId: "req_cross" },
  });
}

function followUp(history: Message, targetModel: string, extra?: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({
    version: "0",
    model: targetModel,
    messages: [
      { role: "user", blocks: [{ type: "text", text: "start" }] },
      history,
      { role: "user", blocks: [{ type: "text", text: "continue" }] },
    ],
    ...extra,
  });
}

/** 왕복 스냅샷 — 재타게팅 warning + wire body */
function cross(
  source: OutboundAdapter,
  sourceBody: unknown,
  sourceModel: string,
  target: OutboundAdapter,
  targetProvider: string,
  targetModel: string,
  extra?: Record<string, unknown>,
): unknown {
  const response = toIRResponse(source, sourceBody, sourceModel);
  const history = responseToHistoryMessage(response);
  expect(history).not.toBeNull();
  const req = followUp(history!, targetModel, extra);
  const { request, warnings: retargetWarnings } = retargetRequest(req, targetProvider);
  const { request: wire, warnings } = target.transformRequest(request, {
    requestId: "req_cross",
    modelId: targetModel,
  });
  return { retargetWarnings, warnings, body: wire.body };
}

// ── anthropic 실픽스처 → openai (녹화본 기반 — 픽스처 있는 것만) ──
const ANTHROPIC_CASES = ["text", "tool-call", "thinking", "citations"] as const;

function fixtureExists(provider: string, name: string): boolean {
  try {
    return readdirSync(`fixtures/${provider}`).some((f) => f.startsWith(`${name}.`) && f.endsWith(".json"));
  } catch {
    return false;
  }
}

describe("골든셋 ④ 크로스 왕복: anthropic 응답 → openai 요청", () => {
  for (const name of ANTHROPIC_CASES) {
    it.skipIf(!fixtureExists("anthropic", name))(`${name} — drop 기본 + demote 정책 각 1회`, () => {
      const fixture = readFixture("anthropic", name);
      if (fixture!.meta.status !== 200 || fixture!.meta.stream) return;
      const model = fixture!.meta.model;
      expect(
        cross(anthropicAdapter, fixture!.meta.body, model, openaiResponsesAdapter, "openai", "gpt-5.6-luna"),
      ).toMatchSnapshot("drop");
      expect(
        cross(anthropicAdapter, fixture!.meta.body, model, openaiResponsesAdapter, "openai", "gpt-5.6-luna", {
          retarget: { reasoning: "demote-to-text" },
        }),
      ).toMatchSnapshot("demote");
    });
  }
});

// ── openai 합성 응답 → anthropic (openai 실픽스처 확보 전 임시 — 녹화 후 픽스처 기반 추가) ──
const OPENAI_SYNTH_RESPONSE = {
  id: "resp_cross1",
  model: "gpt-5.6-luna-2026",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_c1", summary: [{ type: "summary_text", text: "I should check the weather." }], encrypted_content: "ENC_CROSS" },
    { type: "message", id: "msg_c1", role: "assistant", content: [{ type: "output_text", text: "Let me check.", annotations: [] }] },
    { type: "function_call", id: "fc_c1", call_id: "call_c1", name: "get_weather", arguments: '{"city":"Paris"}' },
  ],
  usage: { input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 5 } },
};

describe("골든셋 ④ 크로스 왕복: openai 응답 → anthropic 요청", () => {
  it("reasoning(encrypted)+toolCall — 외래 reasoning drop, tool 쌍은 결과와 함께 보존", () => {
    const response = toIRResponse(openaiResponsesAdapter, OPENAI_SYNTH_RESPONSE, "gpt-5.6-luna");
    const history = responseToHistoryMessage(response)!;
    const req = IRRequestSchema.parse({
      version: "0",
      model: "claude-haiku-4-5",
      messages: [
        { role: "user", blocks: [{ type: "text", text: "weather in Paris?" }] },
        history,
        { role: "tool", blocks: [{ type: "toolResult", toolCallId: "call_c1", toolName: "get_weather", output: { type: "json", value: { temp_c: 21 } } }] },
      ],
      maxOutputTokens: 100,
    });
    const { request, warnings: retargetWarnings } = retargetRequest(req, "anthropic");
    const { request: wire, warnings } = anthropicAdapter.transformRequest(request, {
      requestId: "req_cross",
      modelId: "claude-haiku-4-5",
    });
    expect({ retargetWarnings, warnings, body: wire.body }).toMatchSnapshot();
    // 외래 reasoning은 드롭 보고, toolCall은 anthropic tool_use로 재작성됐어야 한다
    expect(warnings.some((w) => w.code === "reasoning-dropped")).toBe(true);
    const messages = wire.body["messages"] as Array<{ content: Array<{ type: string }> }>;
    expect(messages[1]!.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("동일 타깃(openai) 재전송 — reasoning item 원문 복원 (무손실 §4.2)", () => {
    const response = toIRResponse(openaiResponsesAdapter, OPENAI_SYNTH_RESPONSE, "gpt-5.6-luna");
    const history = responseToHistoryMessage(response)!;
    const req = followUp(history, "gpt-5.6-luna");
    const { request: wire } = openaiResponsesAdapter.transformRequest(req, {
      requestId: "req_cross",
      modelId: "gpt-5.6-luna",
    });
    const input = wire.body["input"] as Array<Record<string, unknown>>;
    const reasoningItem = input.find((i) => i["type"] === "reasoning");
    // 원문 item이 그대로 (id·encrypted_content 포함) — "손대지 않고 재전송"
    expect(reasoningItem).toEqual(OPENAI_SYNTH_RESPONSE.output[0]);
    const fc = input.find((i) => i["type"] === "function_call");
    expect(fc).toEqual(OPENAI_SYNTH_RESPONSE.output[2]);
  });
});

// ── gemini 실픽스처 → anthropic (로드맵 5 — 녹화본 기반) ──
const GEMINI_CASES = ["gemini-text", "gemini-thinking", "gemini-tool-call"] as const;

describe("골든셋 ④ 크로스 왕복: gemini 응답 → anthropic 요청", () => {
  for (const name of GEMINI_CASES) {
    it.skipIf(!fixtureExists("google", name))(`${name} — drop 기본 + demote 정책 각 1회`, () => {
      const fixture = readFixture("google", name);
      if (fixture!.meta.status !== 200 || fixture!.meta.stream) return;
      const model = fixture!.meta.model;
      expect(
        cross(geminiAdapter, fixture!.meta.body, model, anthropicAdapter, "anthropic", "claude-haiku-4-5"),
      ).toMatchSnapshot("drop");
      expect(
        cross(geminiAdapter, fixture!.meta.body, model, anthropicAdapter, "anthropic", "claude-haiku-4-5", {
          retarget: { reasoning: "demote-to-text" },
        }),
      ).toMatchSnapshot("demote");
    });
  }
});

// ── anthropic 실픽스처 → gemini (D6-9 더미 서명·외래 reasoning 정책 검증) ──
describe("골든셋 ④ 크로스 왕복: anthropic 응답 → gemini 요청", () => {
  for (const name of ["text", "tool-call", "thinking"] as const) {
    it.skipIf(!fixtureExists("anthropic", name))(`${name} — drop 기본`, () => {
      const fixture = readFixture("anthropic", name);
      if (fixture!.meta.status !== 200 || fixture!.meta.stream) return;
      const result = cross(
        anthropicAdapter,
        fixture!.meta.body,
        fixture!.meta.model,
        geminiAdapter,
        "google",
        "gemini-3.7-flash",
      ) as { warnings: Array<{ code: string }>; body: Record<string, unknown> };
      expect(result).toMatchSnapshot("drop");
      if (name === "tool-call") {
        // anthropic tool_use 히스토리는 서명이 없다 → 첫 functionCall에 공식 더미 삽입 (D6-9)
        expect(result.warnings.some((w) => w.code === "signature-synthesized")).toBe(true);
        const contents = result.body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        const modelTurn = contents.find((c) => c.role === "model")!;
        const firstFC = modelTurn.parts.find((p) => p["functionCall"] !== undefined)!;
        expect(firstFC["thoughtSignature"]).toBe("skip_thought_signature_validator");
      }
    });
  }
});

// ── 동일 타깃(gemini) 재전송 — thoughtSignature 바이트 그대로 복원 (§4.10) ──
describe("골든셋 ④ 동일 타깃 재전송: gemini → gemini", () => {
  it.skipIf(!fixtureExists("google", "gemini-thinking"))("text part 서명 원문 복원", () => {
    const fixture = readFixture("google", "gemini-thinking")!;
    const wireParts = (
      (fixture.meta.body as Record<string, any>)["candidates"][0]["content"]["parts"] as Array<Record<string, unknown>>
    );
    const originalSig = wireParts.find((p) => typeof p["thoughtSignature"] === "string")!["thoughtSignature"];

    const response = toIRResponse(geminiAdapter, fixture.meta.body, fixture.meta.model);
    const history = responseToHistoryMessage(response)!;
    const req = followUp(history, fixture.meta.model);
    const { request: wire } = geminiAdapter.transformRequest(req, {
      requestId: "req_cross",
      modelId: fixture.meta.model,
    });
    const contents = wire.body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const modelTurn = contents.find((c) => c.role === "model")!;
    const resent = modelTurn.parts.find((p) => typeof p["thoughtSignature"] === "string");
    expect(resent?.["thoughtSignature"]).toBe(originalSig); // 바이트 그대로 (§4.10 왕복 규칙)
  });

  it.skipIf(!fixtureExists("google", "gemini-tool-call"))("functionCall 서명 복원 + id 드롭 (name+순서 매칭 — §13.2)", () => {
    const fixture = readFixture("google", "gemini-tool-call")!;
    const response = toIRResponse(geminiAdapter, fixture.meta.body, fixture.meta.model);
    const history = responseToHistoryMessage(response)!;
    const req = IRRequestSchema.parse({
      version: "0",
      model: fixture.meta.model,
      messages: [
        { role: "user", blocks: [{ type: "text", text: "weather?" }] },
        history,
        {
          role: "tool",
          blocks: [
            {
              type: "toolResult",
              toolCallId: (history.blocks.find((b) => b.type === "toolCall") as { toolCallId: string }).toolCallId,
              toolName: "get_weather",
              output: { type: "json", value: { temp_c: 21 } },
            },
          ],
        },
      ],
      maxOutputTokens: 100,
    });
    const { request: wire, warnings } = geminiAdapter.transformRequest(req, {
      requestId: "req_cross",
      modelId: fixture.meta.model,
    });
    const contents = wire.body["contents"] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const fcPart = contents.flatMap((c) => c.parts).find((p) => p["functionCall"] !== undefined)!;
    // 실서명 보존 → 더미 삽입 불필요
    expect(typeof fcPart["thoughtSignature"]).toBe("string");
    expect(fcPart["thoughtSignature"]).not.toBe("skip_thought_signature_validator");
    expect(warnings.some((w) => w.code === "signature-synthesized")).toBe(false);
    // wire가 발급한 call_ id는 재전송에서 드롭 — name+순서 매칭 (§13.2)
    expect((fcPart["functionCall"] as Record<string, unknown>)["id"]).toBeUndefined();
    const frPart = contents.flatMap((c) => c.parts).find((p) => p["functionResponse"] !== undefined)!;
    expect((frPart["functionResponse"] as Record<string, unknown>)["name"]).toBe("get_weather");
  });
});
