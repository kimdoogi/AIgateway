import { describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { retargetRequest } from "./retarget.js";

function ir(input: Record<string, unknown>): IRRequest {
  return IRRequestSchema.parse({ version: "0", model: "claude-haiku-4-5", ...input });
}

const user = { role: "user", blocks: [{ type: "text", text: "hi" }] };

describe("재타게팅 패스 v0 (ir-v0 §13.3)", () => {
  it("변경 없으면 입력 그대로 (참조 동일 — 불필요 복제 없음)", () => {
    const req = ir({ messages: [user] });
    const { request, warnings } = retargetRequest(req, "anthropic");
    expect(request).toBe(req);
    expect(warnings).toEqual([]);
  });

  it("짝 없는 toolResult 제거 + warning (D6-10)", () => {
    const req = ir({
      messages: [
        user,
        { role: "tool", blocks: [{ type: "toolResult", toolCallId: "call_orphan", toolName: "f", output: { type: "text", text: "x" } }] },
        user,
      ],
    });
    const { request, warnings } = retargetRequest(req, "anthropic");
    expect(request.messages.length).toBe(2); // tool 메시지가 통째 생략
    expect(warnings.map((w) => w.code)).toEqual(["tool-pair-repaired"]);
  });

  it("결과 없는 toolCall 제거 — 단 마지막 assistant 툴콜 턴은 보존 (진행 중 루프)", () => {
    const call = (id: string) => ({
      type: "toolCall", toolCallId: id, toolName: "f", input: { type: "json", value: {} },
    });
    const req = ir({
      messages: [
        user,
        { role: "assistant", blocks: [{ type: "text", text: "old" }, call("call_old")] },
        user,
        { role: "assistant", blocks: [call("call_live")] },
      ],
    });
    const { request, warnings } = retargetRequest(req, "anthropic");
    const oldTurn = request.messages[1]!;
    expect(oldTurn.blocks.map((b) => b.type)).toEqual(["text"]); // 고아 제거
    const liveTurn = request.messages[3]!;
    expect(liveTurn.blocks.map((b) => b.type)).toEqual(["toolCall"]); // 진행 중 보존
    expect(warnings.filter((w) => w.code === "tool-pair-repaired").length).toBe(1);
  });

  it("타깃 상이 서버 상태 PO 드롭 + server-state-inapplicable (§13.3)", () => {
    const req = ir({
      messages: [user],
      providerOptions: { openai: { previousResponseId: "resp_1", textVerbosity: "low" } },
    });
    const { request, warnings } = retargetRequest(req, "anthropic");
    expect(request.providerOptions?.["openai"]).toEqual({ textVerbosity: "low" }); // 상태 키만 제거
    expect(warnings.map((w) => w.code)).toEqual(["server-state-inapplicable"]);
  });

  it("타깃 일치 서버 상태 PO는 통과 (opt-in passthrough — ADR-0002 §3)", () => {
    const req = ir({
      messages: [user],
      model: "gpt-5.6-luna",
      providerOptions: { openai: { previousResponseId: "resp_1" } },
    });
    const { request, warnings } = retargetRequest(req, "openai");
    expect(request).toBe(req);
    expect(warnings).toEqual([]);
  });

  it("블록 레벨 서버 상태 PO도 드롭", () => {
    const req = ir({
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: "x", providerOptions: { anthropic: { container: "cont_1" } } }],
        },
        user,
      ],
    });
    const { request, warnings } = retargetRequest(req, "openai");
    expect(request.messages[0]!.blocks[0]!.providerOptions).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["server-state-inapplicable"]);
  });

  it("providerExecuted 쌍은 수리 대상 아님", () => {
    const req = ir({
      messages: [
        user,
        {
          role: "assistant",
          blocks: [
            { type: "toolCall", toolCallId: "srv_1", toolName: "web_search", input: { type: "json", value: {} }, providerExecuted: true },
            { type: "text", text: "done" },
          ],
        },
        user,
      ],
    });
    const { request, warnings } = retargetRequest(req, "anthropic");
    expect(request).toBe(req);
    expect(warnings).toEqual([]);
  });
});
