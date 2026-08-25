import { beforeAll, describe, expect, it } from "vitest";
import { readFixture } from "../../tools/capture/fixtures.js";
import { parseSSEText } from "../stream/sse.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { SessionStore } from "../gateway/session.js";
import { InMemoryLedger, InMemorySessionPersistence } from "../state/memory.js";
import { createApp } from "./app.js";

// 6단계 E2E (픽스처 재생 — 네트워크 금지 D9): native 인바운드 → 게이트웨이 → (mock 업스트림)
// → IRResponse/SSE. 실 API 스모크는 8단계 opt-in 스크립트.

process.env["ANTHROPIC_API_KEY"] = "test-key"; // sk-ant 패턴 회피 — 시크릿 grep 오탐 방지
beforeAll(() => bootstrapProviders());

/** 픽스처를 업스트림 응답으로 재생하는 fetch mock */
function fixtureFetch(caseName: string): typeof fetch {
  const fixture = readFixture("anthropic", caseName);
  if (!fixture) throw new Error(`픽스처 없음: ${caseName}`);
  const { meta, chunks } = fixture;
  return async () => {
    if (meta.stream && meta.status === 200) {
      return new Response(chunks, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(JSON.stringify(meta.body), {
      status: meta.status,
      headers: { "content-type": "application/json" },
    });
  };
}

const deps = (caseName: string, extra = {}) => ({
  fetchImpl: fixtureFetch(caseName),
  now: () => new Date("2026-08-21T00:00:00Z"),
  genId: () => "req_test0001",
  heartbeatMs: 60_000,
  ...extra,
});

function post(app: ReturnType<typeof createApp>, body: unknown, headers = {}) {
  return app.request("/v0/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const textRequest = {
  version: "0",
  model: "claude-haiku-4-5",
  maxOutputTokens: 100,
  messages: [{ role: "user", blocks: [{ type: "text", text: "capital of France?" }] }],
};

/** 프로덕션과 같은 파서 재사용 (리뷰 RU3) — event/data/id를 IR 이벤트로 */
function parseSSE(text: string): Array<{ id: string; event: string; data: Record<string, unknown> }> {
  return parseSSEText(text).map((f) => ({
    id: f.id!,
    event: f.event!,
    data: JSON.parse(f.data) as Record<string, unknown>,
  }));
}

describe("POST /v0/responses (비스트림)", () => {
  it("IRResponse envelope로 응답한다", async () => {
    const app = createApp(deps("text"));
    const res = await post(app, textRequest);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.version).toBe("0");
    expect(body.id).toBe("req_test0001");
    expect(body.model.resolved).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      surface: "messages",
    });
    expect(body.message.blocks[0].type).toBe("text");
    expect(body.finishReason.unified).toBe("stop");
    expect(body.usage.totalTokens).toBeGreaterThan(0);
    expect(body.gateway.requestId).toBe("req_test0001");
  });

  it("미지 최상위 키는 400 (D5 strict envelope)", async () => {
    const app = createApp(deps("text"));
    const res = await post(app, { ...textRequest, evil_extra: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.category).toBe("invalid_request");
  });

  it("업스트림 4xx는 IRError로 매핑된다", async () => {
    const app = createApp(deps("error-400-effort-gate"));
    const res = await post(app, textRequest);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.category).toBe("invalid_request");
    expect(body.error.provider.code).toBe("invalid_request_error");
  });

  it("라우팅 불가 모델은 404", async () => {
    const app = createApp(deps("text"));
    const res = await post(app, { ...textRequest, model: "unrouted-model-99" });
    expect(res.status).toBe(404);
  });
});

describe("POST /v0/responses (스트림)", () => {
  it("SSE로 IR 이벤트를 방출한다 — id:=seq, 터미널 finish (ADR-0005)", async () => {
    const app = createApp(deps("text-stream"));
    const res = await post(app, { ...textRequest, stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-gateway-request-id")).toBe("req_test0001");
    const frames = parseSSE(await res.text());
    expect(frames[0]!.event).toBe("stream-start");
    expect(frames.map((f) => f.id)).toEqual(frames.map((_, i) => String(i))); // id: = seq 연속
    const metadata = frames.find((f) => f.event === "response-metadata")!.data as Record<string, unknown>;
    expect(metadata["id"]).toBe("req_test0001");
    expect((metadata["model"] as Record<string, unknown>)["requested"]).toBe("claude-haiku-4-5");
    expect(frames[frames.length - 1]!.event).toBe("finish");
  });

  it("업스트림 HTTP 에러는 error-final 터미널 (터미널 보장)", async () => {
    const app = createApp(deps("error-400-effort-gate"));
    const res = await post(app, { ...textRequest, stream: true });
    expect(res.status).toBe(200); // SSE는 이미 열림 — 에러는 이벤트로
    const frames = parseSSE(await res.text());
    expect(frames[frames.length - 1]!.event).toBe("error-final");
  });
});

describe("재개 + 취소 (ADR-0005 §1)", () => {
  it("Last-Event-ID부터 버퍼를 재생한다", async () => {
    const sessions = new SessionStore({ graceMs: 50, ttlMs: 60_000 });
    const app = createApp(deps("text-stream", { sessions }));
    const first = await post(app, { ...textRequest, stream: true });
    const all = parseSSE(await first.text());
    expect(all.length).toBeGreaterThan(3);

    const resume = await app.request("/v0/streams/req_test0001", {
      headers: { "Last-Event-ID": "1" },
    });
    expect(resume.status).toBe(200);
    const resumed = parseSSE(await resume.text());
    expect(resumed[0]!.id).toBe("2"); // seq 1 이후부터
    expect(resumed.map((f) => f.event)).toEqual(all.slice(2).map((f) => f.event));
  });

  it("미지/만료 스트림 재개는 410", async () => {
    const app = createApp(deps("text-stream"));
    const res = await app.request("/v0/streams/req_gone");
    expect(res.status).toBe(410);
  });

  it("명시적 취소는 즉시 업스트림 abort (D7)", async () => {
    const sessions = new SessionStore({ graceMs: 60_000, ttlMs: 60_000 });
    let aborted = false;
    // 터미널 없이 무한 대기하는 업스트림 — abort 전파 관찰
    const hangingFetch: typeof fetch = async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
          (init?.signal as AbortSignal).addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const app = createApp({ ...deps("text-stream", { sessions }), fetchImpl: hangingFetch });
    void post(app, { ...textRequest, stream: true }); // 응답 소비 없이 세션만 가동
    await new Promise((r) => setTimeout(r, 30));
    const cancel = await app.request("/v0/streams/req_test0001/cancel", { method: "POST" });
    expect(cancel.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(true);

    // 취소 후 재개 — 버퍼는 터미널 이벤트로 끝나야 한다 (ADR-0005 — 리뷰 F1 회귀)
    const resume = await app.request("/v0/streams/req_test0001");
    expect(resume.status).toBe(200);
    const frames = parseSSE(await resume.text());
    const last = frames[frames.length - 1]!;
    expect(["error-partial", "error-final"]).toContain(last.event);
  });
});

describe("7단계 — 상태 계층·관측성", () => {
  it("스트림 완주 시 usage 원장에 행 기록 (DoD 5)", async () => {
    const ledger = new InMemoryLedger();
    const app = createApp({ ...deps("text-stream"), ledger, metaLog: () => {} });
    const res = await post(app, { ...textRequest, stream: true });
    await res.text();
    await new Promise((r) => setTimeout(r, 10)); // 펌프 flush
    expect(ledger.rows.length).toBe(1);
    const row = ledger.rows[0]!;
    expect(row.stream).toBe(true);
    expect(row.outcome).toBe("success");
    expect(row.usage?.totalTokens).toBeGreaterThan(0);
  });

it("재시작 폴백도 불량 Last-Event-ID는 400 — 라이브 경로와 동일 (리뷰 F7-r4)", async () => {
    const persistence = new InMemorySessionPersistence();
    const app = createApp({ ...deps("text-stream", { sessions: new SessionStore() }), persistence, metaLog: () => {} });
    const res = await app.request("/v0/streams/req_any", { headers: { "Last-Event-ID": "0x10" } });
    expect(res.status).toBe(400);
  });

  it("caught-up 재개는 410이 아니라 빈 재생 (리뷰 E1-r4)", async () => {
    const persistence = new InMemorySessionPersistence();
    await persistence.appendEvent("req_done", 0, '{"type":"stream-start","seq":0,"warnings":[]}');
    await persistence.appendEvent("req_done", 1, '{"type":"finish","seq":1}');
    const app = createApp({ ...deps("text-stream", { sessions: new SessionStore() }), persistence, metaLog: () => {} });
    const res = await app.request("/v0/streams/req_done", { headers: { "Last-Event-ID": "1" } });
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(""); // 전부 소비됨 — 빈 SSE
  });

  it("절단 버퍼 재생은 방어 터미널로 끝난다 (리뷰 SW2-r4)", async () => {
    const persistence = new InMemorySessionPersistence();
    await persistence.appendEvent("req_cut", 0, '{"type":"stream-start","seq":0,"warnings":[]}');
    await persistence.appendEvent("req_cut", 1, '{"type":"text-delta","seq":1,"id":"blk_0","delta":"partial"}');
    const app = createApp({ ...deps("text-stream", { sessions: new SessionStore() }), persistence, metaLog: () => {} });
    const res = await app.request("/v0/streams/req_cut");
    const frames = parseSSE(await res.text());
    expect(frames[frames.length - 1]!.event).toBe("error-partial");
    expect(frames[frames.length - 1]!.id).toBe("2");
  });

  it("프로세스 재시작 후 재개 — 인메모리 세션 부재 시 영속 버퍼 재생 전용 폴백", async () => {
    const persistence = new InMemorySessionPersistence();
    const sessions = new SessionStore({ persistence });
    const app = createApp({ ...deps("text-stream", { sessions }), persistence, metaLog: () => {} });
    const first = await post(app, { ...textRequest, stream: true });
    const all = parseSSE(await first.text());
    await new Promise((r) => setTimeout(r, 10));

    // "재시작": 새 SessionStore(빈 인메모리) + 같은 persistence
    const restarted = createApp({
      ...deps("text-stream", { sessions: new SessionStore() }),
      persistence,
      metaLog: () => {},
    });
    const resumed = await restarted.request("/v0/streams/req_test0001", {
      headers: { "Last-Event-ID": "1" },
    });
    expect(resumed.status).toBe(200);
    const frames = parseSSE(await resumed.text());
    expect(frames[0]!.id).toBe("2");
    expect(frames.map((f) => f.event)).toEqual(all.slice(2).map((f) => f.event));
  });
});

describe("바디 상한 — 업로드는 공통 10MB 리미터 제외 (감사 #12)", () => {
  it("POST /v0/files 11MB는 413이 아니다 (64MB 업로드 상한 유효)", async () => {
    const app = createApp(deps("text"));
    const big = new Uint8Array(11 * 1024 * 1024);
    const res = await app.request("/v0/files", { method: "POST", body: big });
    expect(res.status).not.toBe(413); // 인증 에러 등은 무방 — 10MB 중첩 리미터만 없으면 된다
  });

  it("POST /v0/responses 11MB는 여전히 413 (공통 상한 유지)", async () => {
    const app = createApp(deps("text"));
    const res = await app.request("/v0/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"pad":"${"x".repeat(11 * 1024 * 1024)}"}`,
    });
    expect(res.status).toBe(413);
  });
});
