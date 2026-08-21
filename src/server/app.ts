import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { IRRequestSchema } from "../ir/request.js";
import type { IRError } from "../ir/error.js";
import type { JSONValue } from "../ir/json.js";
import { executeNonStream, genRequestId, startStreamSession, type ExecuteDeps } from "../gateway/execute.js";
import { irError, toIRError } from "../gateway/errors.js";
import { SessionStore, type StreamSession } from "../gateway/session.js";
import type { SessionPersistence } from "../state/types.js";

// native 인바운드 (walking-skeleton 6단계) — IR envelope 그대로 (ir-v0 §6/§7/§10.4).
// 스트림 오케스트레이션(펌프·heartbeat·seq)은 게이트웨이 소관 — 여기는 파싱 + SSE 인코딩만.
//   POST /v0/responses            비스트림 → IRResponse JSON / stream → SSE (id: = seq)
//   GET  /v0/streams/:id          재개 — Last-Event-ID(=seq)부터 버퍼 재생 + 라이브 테일. 만료 410
//   POST /v0/streams/:id/cancel   명시적 취소 — 즉시 업스트림 abort (D7)

export interface AppDeps extends ExecuteDeps {
  sessions?: SessionStore;
  heartbeatMs?: number;
  /** 프로세스 재시작 후 재개 폴백 (재생 전용 — Redis, ADR-0006) */
  persistence?: SessionPersistence;
}

function errJson(c: Context, error: IRError) {
  // Response 유효 범위 밖 status 방어 (프로바이더 status 패스스루 대비 — 리뷰 D5-r3)
  const status = Math.min(599, Math.max(200, error.httpStatus));
  return c.json({ error }, status as 400);
}

/** Last-Event-ID 파싱 — 부재 -1, 불량 null (Number("")→0·16진·2^53 초과 방지 — 리뷰 F8/F10) */
function parseAfterSeq(header: string | undefined): number | null {
  if (header === undefined || header === "") return -1;
  const n = /^\d+$/.test(header) ? Number(header) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

/** GET 재개·cancel 공용 — 동일 상태 = 동일 응답 (리뷰 E5/RU6) */
const goneStream = (): IRError => irError("not_found", 410, "재개 버퍼 만료 또는 미지 스트림 (TTL 5분)");

/** 세션 이벤트를 SSE로 방출 — 직렬화는 append 시 1회 완료된 문자열 재사용 (id: = seq) */
function sseFromSession(c: Context, session: StreamSession, afterSeq: number) {
  return streamSSE(c, async (stream) => {
    session.attach();
    try {
      for await (const event of session.read(afterSeq, c.req.raw.signal)) {
        if (c.req.raw.signal.aborted) break;
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: event.json });
      }
    } finally {
      session.detach();
    }
  });
}

export function createApp(deps: AppDeps = {}): Hono {
  const app = new Hono();
  const sessions = deps.sessions ?? new SessionStore({ persistence: deps.persistence }); // 기본 스토어도 영속화 배선 (리뷰 F3-r4)

  app.post("/v0/responses", async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      return errJson(c, irError("invalid_request", 400, "JSON body가 아닙니다"));
    }
    const parsed = IRRequestSchema.safeParse(json);
    if (!parsed.success) {
      return errJson(c, {
        ...irError("invalid_request", 400, "IR 요청 검증 실패 (ir-v0 §6 — 미지 최상위 키는 4xx, D5)"),
        provider: { key: "gateway", status: 400, raw: z.treeifyError(parsed.error) as JSONValue },
      });
    }
    const req = parsed.data;

    if (!req.stream) {
      // id를 먼저 발급해 에러 응답에도 상관관계 헤더 제공 (ADR-0008 — 리뷰 A7-r3)
      const id = genRequestId(deps);
      c.header("x-gateway-request-id", id);
      try {
        return c.json(await executeNonStream(req, { ...deps, genId: () => id }, c.req.raw.signal));
      } catch (err) {
        return errJson(c, toIRError(err));
      }
    }

    const session = startStreamSession(req, { ...deps, sessions });
    c.header("x-gateway-request-id", session.id);
    return sseFromSession(c, session, -1);
  });

  app.get("/v0/streams/:id", async (c) => {
    // 헤더 검증은 분기 전 1회 — 라이브/재시작 경로 동일 응답 (리뷰 F7-r4)
    const afterSeq = parseAfterSeq(c.req.header("Last-Event-ID"));
    if (afterSeq === null) {
      return errJson(c, irError("invalid_request", 400, "Last-Event-ID는 안전 정수 범위의 십진 seq여야 합니다"));
    }
    const session = sessions.get(c.req.param("id"));
    if (session) return sseFromSession(c, session, afterSeq);

    // 인메모리 부재 — 영속 버퍼에서 재생 전용 폴백 (프로세스 재시작 시나리오).
    // null = 미지/만료 → 410; [] = 존재하나 커서 이후 없음 → 빈 재생 (리뷰 E1-r4)
    const persisted = await deps.persistence?.loadEvents(c.req.param("id"), afterSeq).catch(() => null);
    if (persisted === null || persisted === undefined) return errJson(c, goneStream());
    return streamSSE(c, async (stream) => {
      let lastSeq = afterSeq;
      let lastType = "";
      for (const json of persisted) {
        const event = JSON.parse(json) as { seq: number; type: string };
        lastSeq = event.seq;
        lastType = event.type;
        await stream.writeSSE({ id: String(event.seq), event: event.type, data: json });
      }
      // 크래시 절단 버퍼 — 터미널 없으면 방어 터미널 합성 (터미널 보장, 리뷰 SW2-r4)
      if (persisted.length > 0 && !["finish", "error-final", "error-partial"].includes(lastType)) {
        const defensive = {
          type: "error-partial",
          seq: lastSeq + 1,
          error: irError("gateway_error", 502, "재시작으로 절단된 스트림 — 버퍼 프리픽스만 유효", { gatewayException: true }),
          willRetry: false,
        };
        await stream.writeSSE({ id: String(defensive.seq), event: defensive.type, data: JSON.stringify(defensive) });
      }
    });
  });

  app.post("/v0/streams/:id/cancel", (c) => {
    const session = sessions.get(c.req.param("id"));
    // GET 재개와 동일 상태 = 동일 status (리뷰 E5 — 404/410 드리프트 방지)
    if (!session) return errJson(c, goneStream());
    const wasLive = !session.isDone;
    session.cancel(); // D7 — 명시적 abort는 grace 없이 즉시. 터미널은 펌프가 적재
    return c.json({ canceled: wasLive }); // 이미 종료된 스트림 취소는 false (리뷰 E6)
  });

  return app;
}
