import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block } from "../../ir/blocks.js";
import type { NS, Origin, Warning } from "../../ir/common.js";
import type { IRRequest } from "../../ir/request.js";
import type { Message } from "../../ir/message.js";
import type { AdapterStreamEvent, TransformedResponse } from "../types.js";

// xAI = openai-compat base 상속 (ADR-0004 D8). wire가 OpenAI 패턴 호환이므로 변환 로직을
// 재구현하지 않고, IR의 프로바이더 표식(providerOptions/providerMetadata 네임스페이스 키,
// origin.provider, opaqueState.provider, provider 툴 id 접두)만 xai↔openai로 리맵해
// openai 어댑터를 통과시킨다. 순수 함수 왕복 — 들어갈 때 xai→openai, 나올 때 openai→xai.

const FROM = "xai";
const TO = "openai";
/**
 * 요청 방향에서 **진짜 openai 표식**(타 프로바이더 히스토리 잔재)에 붙이는 중립 라벨.
 * 라벨을 밀어내지 않으면 base 어댑터가 그것을 자기 것으로 오인해 xAI wire로 흘려보낸다 —
 * "어댑터는 자기 네임스페이스만 소비한다"(ir-v0 §2)를 리맵이 깨뜨리는 셈 (리뷰 2026-08-22).
 * 중립 라벨이 붙으면 base는 정상적으로 "외래"로 취급한다(재타게팅 정책·드롭+warning 경로).
 * 요청 변환 중에만 존재하며 wire에도 히스토리에도 남지 않는다.
 */
const FOREIGN = "openai~foreign";

/** 응답 방향 리맵 — base가 만든 openai 표식을 xai로 되돌린다 */
function remapNS(ns: NS | undefined, from: string, to: string): NS | undefined {
  if (!ns) return undefined;
  if (!(from in ns)) return ns;
  const { [from]: moved, ...rest } = ns;
  // 대상 키가 이미 있으면 from 쪽이 우선 (자기 네임스페이스가 명시 지시)
  return { ...rest, [to]: { ...(ns[to] ?? {}), ...moved } } as NS;
}

/** 요청 방향 리맵 — xai → openai로 옮기고, 원래 있던 openai(타사 지시)는 중립 라벨로 밀어낸다 */
function remapNSToBase(ns: NS | undefined): NS | undefined {
  if (!ns) return undefined;
  if (!(FROM in ns) && !(TO in ns)) return ns;
  const { [FROM]: mine, [TO]: foreign, ...rest } = ns;
  const out: NS = { ...rest };
  if (foreign !== undefined) out[FOREIGN] = foreign;
  if (mine !== undefined) out[TO] = mine;
  return out;
}

/** provider 표식 문자열 리라벨 (요청 방향): openai → 중립, xai → openai */
function providerToBase(provider: string): string {
  return provider === TO ? FOREIGN : provider === FROM ? TO : provider;
}

/** 방향별 리라벨 규칙 — 요청(→base)은 타사 표식 중립화까지, 응답(←base)은 단순 복원 */
interface Relabel {
  provider: (p: string) => string;
  ns: (ns: NS | undefined) => NS | undefined;
  /** custom.kind / provider 툴 id 접두 교체 */
  prefix: (id: string) => string;
}

const TO_BASE: Relabel = {
  provider: providerToBase,
  ns: remapNSToBase,
  prefix: (id) => {
    const dot = id.indexOf(".");
    if (dot < 0) return id;
    return `${providerToBase(id.slice(0, dot))}.${id.slice(dot + 1)}`;
  },
};

const FROM_BASE: Relabel = {
  provider: (p) => (p === TO ? FROM : p),
  ns: (ns) => remapNS(ns, TO, FROM),
  prefix: (id) => (id.startsWith(`${TO}.`) ? `${FROM}.${id.slice(TO.length + 1)}` : id),
};

function remapOrigin(origin: Origin | undefined, r: Relabel): Origin | undefined {
  if (!origin) return origin;
  const provider = r.provider(origin.provider);
  return provider === origin.provider ? origin : { ...origin, provider };
}

function remapBlock(block: Block, r: Relabel): Block {
  const out: Block = { ...block };
  const origin = remapOrigin(out.origin, r);
  if (origin !== out.origin) out.origin = origin!;
  if (out.opaqueState) {
    const provider = r.provider(out.opaqueState.provider);
    if (provider !== out.opaqueState.provider) out.opaqueState = { ...out.opaqueState, provider };
  }
  const po = r.ns(out.providerOptions);
  if (po !== out.providerOptions) out.providerOptions = po!;
  const pm = r.ns(out.providerMetadata);
  if (pm !== out.providerMetadata) out.providerMetadata = pm!;
  if (out.type === "passthrough") out.provider = r.provider(out.provider);
  if (out.type === "custom") out.kind = r.prefix(out.kind) as typeof out.kind;
  return out;
}

function remapMessage(msg: Message, r: Relabel): Message {
  return {
    ...msg,
    blocks: msg.blocks.map((b) => remapBlock(b, r)),
    ...(msg.origin ? { origin: remapOrigin(msg.origin, r)! } : {}),
    ...(msg.providerOptions ? { providerOptions: r.ns(msg.providerOptions)! } : {}),
  };
}

/** IR 요청: xai 표식 → openai (base 어댑터가 자기 것으로 인식하게) */
export function requestToBase(req: IRRequest): IRRequest {
  const out: IRRequest = {
    ...req,
    messages: req.messages.map((m) => remapMessage(m, TO_BASE)),
  };
  if (req.providerOptions) out.providerOptions = TO_BASE.ns(req.providerOptions)!;
  if (req.tools) {
    out.tools = req.tools.map((t) => {
      const relabeled =
        t.type === "provider" ? { ...t, id: TO_BASE.prefix(t.id) as typeof t.id } : { ...t };
      return t.providerOptions
        ? ({ ...relabeled, providerOptions: TO_BASE.ns(t.providerOptions)! } as typeof t)
        : (relabeled as typeof t);
    });
  }
  if (req.passthroughParams) {
    // 타사 passthrough가 여기 도달하면 base가 "정책 레이어 필터 누락"으로 명시 실패한다 —
    // 조용히 xAI wire에 병합되는 것보다 낫다 (재타게팅이 이미 걸렀어야 하는 상태)
    out.passthroughParams = {
      ...req.passthroughParams,
      provider: providerToBase(req.passthroughParams.provider),
    };
  }
  return out;
}

/** warning 라벨 정정 — base가 만든 메시지의 openai 표기를 xai로 (조용한 오표기 방지) */
export function relabelWarning(w: Warning): Warning {
  const swap = (s: string): string => s.replaceAll("openai", "xai");
  return {
    ...w,
    message: swap(w.message),
    ...(w.path ? { path: swap(w.path) } : {}),
  };
}

/** 응답 변환 결과: openai 표식 → xai 복원 */
export function responseFromBase(t: TransformedResponse): TransformedResponse {
  return {
    ...t,
    blocks: t.blocks.map((b) => remapBlock(b, FROM_BASE)),
    origin: { ...t.origin, provider: FROM },
    ...(t.providerMetadata ? { providerMetadata: remapNS(t.providerMetadata, TO, FROM)! } : {}),
    warnings: t.warnings.map(relabelWarning),
  };
}

/** 스트림 이벤트: 블록·origin·PM의 openai 표식 → xai */
export function eventFromBase(event: AdapterStreamEvent): AdapterStreamEvent {
  switch (event.type) {
    case "response-metadata": {
      const resolved = event.model.resolved;
      return {
        ...event,
        model: { resolved: resolved.provider === TO ? { ...resolved, provider: FROM } : resolved },
        ...(event.providerMetadata ? { providerMetadata: remapNS(event.providerMetadata, TO, FROM)! } : {}),
      };
    }
    case "tool-call":
    case "tool-result":
    case "file":
    case "source":
    case "custom":
    case "passthrough":
      return { ...event, block: remapBlock(event.block as Block, FROM_BASE) as never };
    case "text-end":
    case "reasoning-delta":
      return {
        ...event,
        ...(("opaqueState" in event && event.opaqueState?.provider === TO)
          ? { opaqueState: { ...event.opaqueState, provider: FROM } }
          : {}),
        ...(("providerMetadata" in event && event.providerMetadata)
          ? { providerMetadata: remapNS(event.providerMetadata, TO, FROM)! }
          : {}),
      };
    case "warning":
      return { ...event, warning: relabelWarning(event.warning) };
    case "finish":
      return {
        ...event,
        ...(event.providerMetadata ? { providerMetadata: remapNS(event.providerMetadata, TO, FROM)! } : {}),
      };
    case "raw":
      return event.provider === TO ? { ...event, provider: FROM } : event;
    case "provider-error": {
      const provider = event.error.provider;
      return provider?.key === TO
        ? { ...event, error: { ...event.error, provider: { ...provider, key: FROM } } }
        : event;
    }
    default:
      return event;
  }
}

/** wire body에서 키 제거 + warning (xAI는 미지원 파라미터를 무시가 아니라 400으로 거부 — B2-7) */
export function stripBodyKeys(
  body: JSONObject,
  keys: readonly string[],
  warnings: Warning[],
  makeWarn: (key: string) => Warning,
): void {
  for (const key of keys) {
    if (body[key] !== undefined) {
      delete body[key];
      warnings.push(makeWarn(key));
    }
  }
}

export type { JSONValue };
