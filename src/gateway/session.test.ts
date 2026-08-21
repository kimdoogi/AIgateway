import { describe, expect, it } from "vitest";
import { SessionStore } from "./session.js";
import { irError } from "./errors.js";

// 리뷰 F1 회귀 — seq 단일 발급자: 이벤트는 draft로 들어오고 세션이 스탬프 (ir-v0 §10 단조 증가)

const delta = { type: "text-delta", id: "blk_0", delta: "x" } as const;
const finish = {
  type: "finish",
  finishReason: { unified: "stop", raw: "end_turn" },
  usage: {
    input: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    output: { total: 1, text: 1, reasoning: 0 },
    totalTokens: 2,
    raw: null,
  },
} as const;

describe("StreamSession", () => {
  it("draft에 seq를 스탬프 — heartbeat 끼어도 0부터 단조 증가·중복 없음", async () => {
    const session = new SessionStore({ graceMs: 10, ttlMs: 1000 }).create("s1");
    session.append(delta);
    session.append(delta);
    session.appendHeartbeat();
    session.append(delta);
    session.append(finish);

    const seqs: number[] = [];
    for await (const e of session.read(-1)) seqs.push(e.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);

    // 재개: heartbeat(seq 2) 커서로 이어받아도 콘텐츠 유실 없음
    const resumed: string[] = [];
    for await (const e of session.read(2)) resumed.push(`${e.seq}:${e.type}`);
    expect(resumed).toEqual(["3:text-delta", "4:finish"]);
  });

  it("키 순서 canonical — type, seq가 선두 (D10)", async () => {
    const session = new SessionStore({ ttlMs: 1000 }).create("s2");
    session.append(delta);
    session.append(finish);
    for await (const e of session.read(-1)) {
      expect(Object.keys(JSON.parse(e.json)).slice(0, 2)).toEqual(["type", "seq"]);
    }
  });

  it("done 이후 append는 무시된다", async () => {
    const session = new SessionStore({ ttlMs: 1000 }).create("s3");
    session.append({ type: "error-final", error: irError("gateway_error", 502, "x") });
    session.append(delta);
    const seqs: number[] = [];
    for await (const e of session.read(-1)) seqs.push(e.seq);
    expect(seqs).toEqual([0]);
  });

  it("백프레셔 — 상한 초과 시 abort-only + 사유 기록, 터미널은 펌프 소관 (리뷰 F4-r3)", () => {
    const session = new SessionStore({ ttlMs: 1000, maxBufferBytes: 200 }).create("s4");
    session.append({ type: "text-delta", id: "blk_0", delta: "가".repeat(200) });
    expect(session.upstreamSignal.aborted).toBe(true);
    expect(session.isDone).toBe(false); // 터미널은 펌프가 회계와 함께 적재
    expect(session.abortReason).toBe("backpressure");
    expect(session.abortError().httpStatus).toBe(507);
  });

  it("grace — 마지막 detach 후 graceMs 지나면 abort(grace), 재부착은 타이머 해제 (리뷰 SW5-r3)", async () => {
    const store = new SessionStore({ graceMs: 20, ttlMs: 1000 });
    const s1 = store.create("g1");
    s1.attach();
    s1.detach();
    await new Promise((r) => setTimeout(r, 40));
    expect(s1.upstreamSignal.aborted).toBe(true);
    expect(s1.abortReason).toBe("grace");

    const s2 = store.create("g2");
    s2.attach();
    s2.detach();
    s2.attach(); // grace 안에 재부착 — 타이머 해제
    await new Promise((r) => setTimeout(r, 40));
    expect(s2.upstreamSignal.aborted).toBe(false);
  });

  it("end()는 터미널 부재 시 방어 터미널을 적재한다 (터미널 보장)", async () => {
    const session = new SessionStore({ ttlMs: 1000 }).create("s5");
    session.append(delta);
    session.end();
    const types: string[] = [];
    for await (const e of session.read(-1)) types.push(e.type);
    expect(types).toEqual(["text-delta", "error-partial"]);
  });
});
