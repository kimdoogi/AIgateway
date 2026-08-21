import { describe, expect, it } from "vitest";
import type { AdapterStreamEvent } from "../types.js";
import { createStreamTransformer } from "./stream.js";

// Gemini 스트림 상태 머신 단위 테스트 — 합성 청크 (실 SSE 재생은 골든셋 ②가 담당, D9).
// 검증 대상: parts append 병합, thought↔text 전환, 빈 text part 서명(§10.2 프루닝 금지),
// finishReason 지연 finish(onStreamEnd 적재), soft-block 승격, 절단 터미널 보장.

function chunk(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function run(chunks: Record<string, unknown>[]): AdapterStreamEvent[] {
  const t = createStreamTransformer({ modelId: "gemini-3.7-flash" });
  const events: AdapterStreamEvent[] = [];
  for (const c of chunks) events.push(...t.onEvent(undefined, chunk(c)));
  events.push(...t.onStreamEnd());
  return events;
}

const meta = { responseId: "resp-1", modelVersion: "gemini-3.7-flash" };

describe("gemini stream", () => {
  it("텍스트 스트림 — 연속 text part 병합, finish는 스트림 종료 시 적재", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] } }] },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["response-metadata", "text-start", "text-delta", "text-delta", "text-delta", "text-end", "finish"]);
    const finish = events.at(-1) as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.finishReason).toEqual({ unified: "stop", raw: "STOP" });
    expect(finish.usage.input.total).toBe(5);
    expect(finish.usage.output.total).toBe(3);
  });

  it("thought part → reasoning 블록, text 전환 시 블록 교체", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "hmm", thought: true }] } }] },
      {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "answer" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 7 },
      },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    const finish = events.at(-1) as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.usage.output).toEqual({ total: 9, text: 2, reasoning: 7 }); // §8: candidates+thoughts 합산
  });

  it("빈 text part + thoughtSignature — 블록 보존 + text-end.opaqueState (§10.2)", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "", thoughtSignature: "c2ln" }] }, finishReason: "STOP" }] },
    ]);
    const end = events.find((e) => e.type === "text-end") as Extract<AdapterStreamEvent, { type: "text-end" }>;
    expect(end.opaqueState).toEqual({ provider: "google", data: "c2ln" });
  });

  it("functionCall — 통짜 도착, 인자 단일 delta(compat 재현용), synth id, STOP→tool_call 승격", () => {
    const events = run([
      {
        ...meta,
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "c2lnLWZj" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
      },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["response-metadata", "tool-input-start", "tool-input-delta", "tool-input-end", "tool-call", "finish"]);
    // delta-기반 소비자(compat 다운컨버터)가 완성 인자를 받도록 직렬화 인자를 단일 delta로
    const delta = events.find((e) => e.type === "tool-input-delta") as Extract<AdapterStreamEvent, { type: "tool-input-delta" }>;
    expect(delta.delta).toBe('{"city":"Paris"}');
    const call = events.find((e) => e.type === "tool-call") as Extract<AdapterStreamEvent, { type: "tool-call" }>;
    expect(call.block.toolCallId).toBe("synth:google:resp-1:0:get_weather");
    expect(call.block.opaqueState).toEqual({ provider: "google", data: "c2lnLWZj" });
    const finish = events.at(-1) as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.finishReason).toEqual({ unified: "tool_call", raw: "STOP" });
  });

  it("서명 실린 text part 연속 — 서명별 1블록 분할 (last-wins 유실 금지)", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "a", thoughtSignature: "S1" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "b", thoughtSignature: "S2" }] }, finishReason: "STOP" }] },
    ]);
    const ends = events.filter((e) => e.type === "text-end") as Extract<AdapterStreamEvent, { type: "text-end" }>[];
    expect(ends).toHaveLength(2);
    expect(ends[0]!.opaqueState).toEqual({ provider: "google", data: "S1" });
    expect(ends[1]!.opaqueState).toEqual({ provider: "google", data: "S2" });
  });

  it("순수 빈 text part(서명 없음)는 프루닝 — 비스트림과 동일 IR (유령 블록 금지)", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "" }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
    ]);
    expect(events.filter((e) => e.type === "text-start")).toHaveLength(1);
  });

  it("fileData part — file reference 블록 (비스트림과 동일 매핑)", () => {
    const events = run([
      {
        ...meta,
        candidates: [
          {
            content: { role: "model", parts: [{ fileData: { mimeType: "video/mp4", fileUri: "files/abc" } }] },
            finishReason: "STOP",
          },
        ],
      },
    ]);
    const file = events.find((e) => e.type === "file") as Extract<AdapterStreamEvent, { type: "file" }>;
    expect(file.block.data).toEqual({ type: "reference", refs: { google: "files/abc" } });
  });

  it("promptFeedback.blockReason — soft-block을 provider-error로 승격 + usage 동봉 (§12)", () => {
    const events = run([
      { ...meta, promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 12 } },
    ]);
    const err = events.find((e) => e.type === "provider-error") as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(err.error.provider?.code).toBe("prompt_blocked:SAFETY");
    expect(err.error.fallbackEligible).toBe(false);
    expect(err.error.billed).toBe(true); // 200 수신 = 프롬프트 처리 (원장 규칙과 정합)
    expect(err.usage?.input.total).toBe(12); // 차단 청크의 usage 유실 금지
    expect(events.filter((e) => e.type === "provider-error" || e.type === "finish")).toHaveLength(1);
  });

  it("콘텐츠 수신 후 blockReason — 승격하지 않고 정상 finish (비스트림 조건과 대칭)", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] },
      { promptFeedback: { blockReason: "RECITATION" }, candidates: [{ finishReason: "RECITATION" }] },
    ]);
    expect(events.some((e) => e.type === "provider-error")).toBe(false);
    const finish = events.at(-1) as Extract<AdapterStreamEvent, { type: "finish" }>;
    expect(finish.type).toBe("finish");
    expect(finish.finishReason).toEqual({ unified: "content_filter", raw: "RECITATION" });
  });

  it("첫 청크가 error JSON — billed:false (프롬프트 처리 증거 없음)", () => {
    const events = run([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "rate limited" } }]);
    const err = events.find((e) => e.type === "provider-error") as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(err.error.billed).toBe(false);
    expect(err.error.category).toBe("rate_limit");
  });

  it("finishReason 없는 절단 — provider-error 터미널 보장 + 과금 usage 동봉 (ADR-0005)", () => {
    const events = run([
      {
        ...meta,
        candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      },
    ]);
    const last = events.at(-1) as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(last.type).toBe("provider-error");
    expect(last.error.billed).toBe(true);
    expect(last.usage?.input.total).toBe(5);
  });

  it("스트림 내 error JSON — HTTP 매퍼 재사용 + 터미널", () => {
    const events = run([
      { ...meta, candidates: [{ content: { role: "model", parts: [{ text: "a" }] } }] },
      { error: { code: 503, status: "UNAVAILABLE", message: "overloaded" } },
    ]);
    const err = events.find((e) => e.type === "provider-error") as Extract<AdapterStreamEvent, { type: "provider-error" }>;
    expect(err.error.category).toBe("overloaded");
    // 터미널 이후 이벤트·onStreamEnd 재방출 없음 (멱등)
    expect(events.filter((e) => e.type === "provider-error")).toHaveLength(1);
  });
});
