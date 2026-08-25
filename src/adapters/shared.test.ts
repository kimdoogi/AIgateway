import { describe, expect, it } from "vitest";
import type { Warning } from "../ir/common.js";
import { AdapterInvalidRequestError, gateBlockLevelOptions, gateEffort } from "./shared.js";

// 모델 effort 게이트 (ir-v0 §6.3) — 전 어댑터 공통 정책 골격.
// 핵심 불변식: on/off 경계는 어느 방향으로도 넘지 않는다 (리뷰 2026-08-22).

const opts = { label: "test" };

describe("gateEffort", () => {
  it("지원 값은 그대로", () => {
    const warnings: Warning[] = [];
    expect(gateEffort("high", ["low", "high"], opts, warnings)).toBe("high");
    expect(warnings).toEqual([]);
  });

  it("지원 집합 밖은 최근접 — 최저 고정이 아니다", () => {
    const warnings: Warning[] = [];
    expect(gateEffort("max", ["low", "medium", "high"], opts, warnings)).toBe("high");
    expect(warnings[0]!.code).toBe("parameter-clamped");
  });

  it("'none' 요청은 올려붙이지 않고 드롭 — 끄기가 켜기로 반전되면 안 된다", () => {
    const warnings: Warning[] = [];
    expect(gateEffort("none", ["low", "medium", "high"], opts, warnings)).toBeUndefined();
    expect(warnings[0]!.code).toBe("parameter-dropped");
    expect(warnings[0]!.path).toBe("reasoning.effort");
  });

  it("'none'은 클램프 대상도 아니다 — 켜기 요청이 꺼짐으로 반전되면 안 된다", () => {
    const warnings: Warning[] = [];
    // 'minimal'의 최근접은 인덱스상 'none'이지만, 그건 추론을 끄는 것이다
    expect(gateEffort("minimal", ["none", "low", "medium"], opts, warnings)).toBe("low");
  });

  it("supportedEfforts가 빈 집합이면 드롭 (세대 미지원)", () => {
    const warnings: Warning[] = [];
    expect(gateEffort("high", [], opts, warnings)).toBeUndefined();
    expect(warnings[0]!.code).toBe("parameter-dropped");
  });

  it("'none'만 지원하는 모델에 추론을 요청하면 드롭", () => {
    const warnings: Warning[] = [];
    expect(gateEffort("high", ["none"], opts, warnings)).toBeUndefined();
    expect(warnings[0]!.code).toBe("parameter-dropped");
  });

  it("strictParameters면 드롭 대신 4xx (D5)", () => {
    expect(() => gateEffort("none", ["low"], { ...opts, strict: true }, [])).toThrow(AdapterInvalidRequestError);
    // 클램프는 4xx가 아니다 — 값이 살아서 나간다
    const warnings: Warning[] = [];
    expect(gateEffort("max", ["low", "high"], { ...opts, strict: true }, warnings)).toBe("high");
  });
});

describe("gateBlockLevelOptions — 블록·메시지 레벨 PO D5 (감사 #17)", () => {
  const messages = [
    {
      role: "user",
      providerOptions: { anthropic: { unknownMsgKey: 1 } },
      blocks: [
        { type: "text", text: "hi", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
        { type: "text", text: "x", providerOptions: { anthropic: { mysteryKey: true }, google: { whatever: 1 } } },
      ],
    },
  ] as unknown as Parameters<typeof gateBlockLevelOptions>[0];
  const KNOWN = new Set(["cacheControl"]);

  it("자기 NS 미지 키는 기본 4xx (인지 키·타사 NS는 무관)", () => {
    expect(() => gateBlockLevelOptions(messages, "anthropic", KNOWN, new Set(), false, [])).toThrow(
      AdapterInvalidRequestError,
    );
    // 타사(google) NS만 보는 어댑터 관점에서는 통과 — 자기 네임스페이스만 검사 (ir-v0 §2)
    const warnings: Warning[] = [];
    gateBlockLevelOptions(messages, "google", new Set(["whatever"]), new Set(), false, warnings);
    expect(warnings).toEqual([]);
  });

  it("opt-in이면 warning으로 강등 (무시됨을 명시)", () => {
    const warnings: Warning[] = [];
    gateBlockLevelOptions(messages, "anthropic", KNOWN, new Set(), true, warnings);
    expect(warnings.map((w) => w.code)).toEqual(["unknown-provider-option-passed", "unknown-provider-option-passed"]);
    expect(warnings[0]!.path).toBe("messages[0].providerOptions.anthropic.unknownMsgKey");
  });
});
