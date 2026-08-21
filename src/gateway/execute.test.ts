import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../../tools/capture/fixtures.js";
import { bootstrapProviders } from "./bootstrap.js";
import { executeNonStream } from "./execute.js";
import { GatewayError } from "./errors.js";
import { InMemoryLedger } from "../state/memory.js";
import type { MetaLogEntry } from "./observability.js";
import type { IRRequest } from "../ir/request.js";

// 7단계 — 리트라이 정책(Retry-After 존중·상한) + usage 원장(시도별 행) + 메타 로그 (D9: 픽스처만)

process.env["ANTHROPIC_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

const req: IRRequest = {
  version: "0",
  model: "claude-haiku-4-5",
  maxOutputTokens: 100,
  messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
} as IRRequest;

function okResponse(): Response {
  const meta = readFixture("anthropic", "text")!.meta;
  return new Response(JSON.stringify(meta.body), { status: 200, headers: { "content-type": "application/json" } });
}

const rateLimited = (retryAfter: string) =>
  new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": retryAfter },
  });

function deps(responses: Array<() => Response>, ledger = new InMemoryLedger(), metaLogs: MetaLogEntry[] = []) {
  let i = 0;
  const slept: number[] = [];
  return {
    ledger,
    metaLogs,
    slept,
    d: {
      fetchImpl: (async () => {
        const next = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        return next();
      }) as typeof fetch,
      ledger,
      metaLog: (e: MetaLogEntry) => metaLogs.push(e),
      sleep: async (ms: number) => void slept.push(ms),
      now: () => new Date("2026-08-21T00:00:00Z"),
      genId: () => "req_retry01",
    } as {
      fetchImpl: typeof fetch;
      ledger: InMemoryLedger;
      metaLog: (e: MetaLogEntry) => void;
      sleep: (ms: number) => Promise<void>;
      now: () => Date;
      genId: () => string;
      retry?: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
    },
  };
}

describe("리트라이 정책 (7단계)", () => {
  it("429 후 성공 — Retry-After 존중, 원장에 실패 시도 + 성공 행", async () => {
    const h = deps([() => rateLimited("2"), okResponse]);
    const res = await executeNonStream(req, h.d);
    expect(res.finishReason.unified).toBe("stop");
    expect(h.slept).toEqual([2000]); // Retry-After 2초
    expect(h.ledger.rows.map((r) => [r.attempt, r.outcome, r.httpStatus])).toEqual([
      [1, "error", 429],
      [2, "success", 200],
    ]);
    expect(h.metaLogs.length).toBe(2);
  });

  it("maxAttempts 소진 시 마지막 오류로 실패 — 최종 시도는 1회만 기록", async () => {
    const h = deps([() => rateLimited("0")]);
    await expect(executeNonStream(req, h.d)).rejects.toThrow(GatewayError);
    expect(h.slept.length).toBe(2); // 3시도 = 대기 2회
    expect(h.ledger.rows.map((r) => r.outcome)).toEqual(["error", "error", "error"]);
    expect(h.ledger.rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
  });

  it("Retry-After가 maxDelayMs 초과면 대기 없이 즉시 포기", async () => {
    const h = deps([() => rateLimited("3600")]);
    await expect(executeNonStream(req, h.d)).rejects.toThrow(GatewayError);
    expect(h.slept).toEqual([]);
    expect(h.ledger.rows.length).toBe(1);
  });

  it("비재시도 오류(400)는 1회로 종결", async () => {
    const fixture = readFixture("anthropic", "error-400-effort-gate")!.meta;
    const h = deps([
      () => new Response(JSON.stringify(fixture.body), { status: 400, headers: { "content-type": "application/json" } }),
    ]);
    await expect(executeNonStream(req, h.d)).rejects.toThrow(GatewayError);
    expect(h.slept).toEqual([]);
    expect(h.ledger.rows.map((r) => [r.outcome, r.errorCategory])).toEqual([["error", "invalid_request"]]);
  });

  it("성공 원장 행에 usage가 실린다 (DoD 5)", async () => {
    const h = deps([okResponse]);
    await executeNonStream(req, h.d);
    const row = h.ledger.rows[0]!;
    expect(row.usage?.totalTokens).toBeGreaterThan(0);
    expect(row.billed).toBe(true);
    expect(row.provider).toBe("anthropic");
  });
});

describe("R4 수정 회귀", () => {
  it("리트라이 성공 시 gateway.attempts에 시도 이력 노출 (ir-v0 §7)", async () => {
    const h = deps([() => rateLimited("0"), okResponse]);
    const res = await executeNonStream(req, h.d);
    expect(res.gateway.attempts).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", outcome: "failed", error: "rate_limit" },
      { provider: "anthropic", model: "claude-haiku-4-5", outcome: "success" },
    ]);
  });

  it("리트라이 없으면 attempts 미노출", async () => {
    const h = deps([okResponse]);
    const res = await executeNonStream(req, h.d);
    expect(res.gateway.attempts).toBeUndefined();
  });

  it("200 후 변환 실패도 원장에 billed 행 기록 (과금 유출 방지 — 리뷰 F2-r4)", async () => {
    const h = deps([
      () => new Response('{"broken": true}', { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    await expect(executeNonStream(req, h.d)).rejects.toThrow();
    expect(h.ledger.rows.length).toBe(1);
    const row = h.ledger.rows[0]!;
    expect(row.outcome).toBe("error");
    expect(row.billed).toBe(true); // 200 수신 = 과금 발생
  });

  it("백오프 공식은 maxDelayMs 클램프 — maxAttempts까지 소진 (리뷰 A7-r4)", async () => {
    const noHeader = () =>
      new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x" } }), {
        status: 429, headers: { "content-type": "application/json" }, // retry-after 없음 → 공식 경로
      });
    const h = deps([noHeader]);
    h.d.retry = { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 10_000 };
    await expect(executeNonStream(req, h.d)).rejects.toThrow(GatewayError);
    expect(h.slept.length).toBe(5); // 6시도 = 대기 5회 (공식이 상한 넘어도 포기하지 않음)
    expect(h.slept[4]).toBe(10_000); // attempt 5: 12500 → 클램프
  });
});
