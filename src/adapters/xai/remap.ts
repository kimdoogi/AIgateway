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

function remapNS(ns: NS | undefined, from: string, to: string): NS | undefined {
  if (!ns) return undefined;
  if (!(from in ns)) return ns;
  const { [from]: moved, ...rest } = ns;
  // 대상 키가 이미 있으면 from 쪽이 우선 (자기 네임스페이스가 명시 지시)
  return { ...rest, [to]: { ...(ns[to] ?? {}), ...moved } } as NS;
}

function remapOrigin(origin: Origin | undefined, from: string, to: string): Origin | undefined {
  if (!origin || origin.provider !== from) return origin;
  return { ...origin, provider: to };
}

function remapBlock(block: Block, from: string, to: string): Block {
  const out: Block = { ...block };
  const origin = remapOrigin(out.origin, from, to);
  if (origin !== out.origin) out.origin = origin!;
  if (out.opaqueState?.provider === from) out.opaqueState = { ...out.opaqueState, provider: to };
  const po = remapNS(out.providerOptions, from, to);
  if (po !== out.providerOptions) out.providerOptions = po!;
  const pm = remapNS(out.providerMetadata, from, to);
  if (pm !== out.providerMetadata) out.providerMetadata = pm!;
  if (out.type === "passthrough" && out.provider === from) out.provider = to;
  if (out.type === "custom" && out.kind.startsWith(`${from}.`)) {
    out.kind = `${to}.${out.kind.slice(from.length + 1)}` as typeof out.kind;
  }
  return out;
}

function remapMessage(msg: Message, from: string, to: string): Message {
  return {
    ...msg,
    blocks: msg.blocks.map((b) => remapBlock(b, from, to)),
    ...(msg.origin ? { origin: remapOrigin(msg.origin, from, to)! } : {}),
    ...(msg.providerOptions ? { providerOptions: remapNS(msg.providerOptions, from, to)! } : {}),
  };
}

/** IR 요청: xai 표식 → openai (base 어댑터가 자기 것으로 인식하게) */
export function requestToBase(req: IRRequest): IRRequest {
  const out: IRRequest = {
    ...req,
    messages: req.messages.map((m) => remapMessage(m, FROM, TO)),
  };
  if (req.providerOptions) out.providerOptions = remapNS(req.providerOptions, FROM, TO)!;
  if (req.tools) {
    out.tools = req.tools.map((t) => {
      if (t.type === "provider" && t.id.startsWith(`${FROM}.`)) {
        return { ...t, id: `${TO}.${t.id.slice(FROM.length + 1)}` as typeof t.id };
      }
      return t.providerOptions ? { ...t, providerOptions: remapNS(t.providerOptions, FROM, TO)! } : t;
    });
  }
  if (req.passthroughParams?.provider === FROM) {
    out.passthroughParams = { ...req.passthroughParams, provider: TO };
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
    blocks: t.blocks.map((b) => remapBlock(b, TO, FROM)),
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
      return { ...event, block: remapBlock(event.block as Block, TO, FROM) as never };
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
