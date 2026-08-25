import type { SSEFrame } from "../../stream/sse.js";

// 기준 문서 신선도 장치 (ADR-0001 §5, D10-5): 픽스처를 재녹화할 때 어댑터가 모르는 wire 필드가
// 새로 등장하면 경고로 승격한다. "체크리스트×어댑터" CI가 못 잡는 "체크리스트×실제 API" 드리프트용.
// 이 목록은 어댑터가 **인지**하는 필드 집합이다 — 소비 여부와는 별개 (보존만 하는 필드도 포함).

const RESPONSE_KEYS = [
  "id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "stop_details",
  "usage", "container", "context_management",
] as const;

const USAGE_KEYS = [
  "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  "cache_creation", "server_tool_use", "service_tier", "iterations", "speed", "inference_geo",
  "output_tokens_details", // 2026-08-21 녹화에서 검출 — thinking_tokens 세부 (problem log 참조)
] as const;

// 블록 타입별 인지 키. 여기 없는 **타입**은 passthrough로 보존되므로 별도 경고 대상 (미지 타입).
const BLOCK_KEYS: Record<string, readonly string[]> = {
  text: ["type", "text", "citations"],
  thinking: ["type", "thinking", "signature"],
  redacted_thinking: ["type", "data"],
  tool_use: ["type", "id", "name", "input", "caller"], // caller: 2026-08-21 녹화에서 검출
  server_tool_use: ["type", "id", "name", "input", "caller"], // caller: 2026-08-21 녹화에서 검출
  mcp_tool_use: ["type", "id", "name", "input", "server_name"],
  web_search_tool_result: ["type", "tool_use_id", "content"],
  web_fetch_tool_result: ["type", "tool_use_id", "content"],
  code_execution_tool_result: ["type", "tool_use_id", "content"],
  bash_code_execution_tool_result: ["type", "tool_use_id", "content"],
  mcp_tool_result: ["type", "tool_use_id", "content", "is_error"],
};

const EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_start", "content_block_start", "content_block_delta", "content_block_stop",
  "message_delta", "message_stop", "ping", "error",
]);

// delta 타입별 인지 키 — 타입 멤버십만이 아니라 내부 신필드도 드리프트 감지 (리뷰 F12)
const DELTA_KEYS: Record<string, readonly string[]> = {
  text_delta: ["type", "text"],
  thinking_delta: ["type", "thinking"],
  signature_delta: ["type", "signature"],
  input_json_delta: ["type", "partial_json"],
  citations_delta: ["type", "citation"],
};

// container: stream.ts가 '실관측 2경로'로 소비 (top-level·delta) — 미등재 시 아는 필드를
// 드리프트로 오탐하는 자기모순 (감사 #41)
const MESSAGE_DELTA_KEYS = ["type", "delta", "usage", "context_management", "container"] as const;
const MESSAGE_DELTA_DELTA_KEYS = ["stop_reason", "stop_sequence", "stop_details", "container"] as const;
const CONTENT_BLOCK_DELTA_KEYS = ["type", "index", "delta"] as const;
const CONTENT_BLOCK_STOP_KEYS = ["type", "index"] as const;
const MESSAGE_STOP_KEYS = ["type"] as const;
const ERROR_EVENT_KEYS = ["type", "error"] as const;

function extraKeys(obj: unknown, known: readonly string[], path: string): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>)
    .filter((k) => !known.includes(k))
    .map((k) => `${path}.${k}`);
}

function scanBlock(raw: unknown, path: string): string[] {
  if (!raw || typeof raw !== "object") return [];
  const block = raw as Record<string, unknown>;
  const type = typeof block["type"] === "string" ? block["type"] : "";
  const known = BLOCK_KEYS[type];
  if (!known) return [`${path}: 미지 블록 타입 '${type || "?"}'`];
  return extraKeys(block, known, path);
}

/** 비스트림 응답 body에서 어댑터가 모르는 필드 경로 목록 */
// count_tokens 응답 (부록 (b) §1) — messages 응답과 형태가 다른 별도 엔드포인트
const COUNT_TOKENS_KEYS = ["input_tokens"] as const;

export function unknownResponseFields(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const wire = body as Record<string, unknown>;
  // 형태 자동 판별: content 없이 input_tokens만 있으면 count_tokens 응답 (openai known-fields 오탐 수정과 동형)
  if (wire["content"] === undefined && wire["input_tokens"] !== undefined) {
    return extraKeys(wire, COUNT_TOKENS_KEYS, "$");
  }
  const found = [
    ...extraKeys(wire, RESPONSE_KEYS, "$"),
    ...extraKeys(wire["usage"], USAGE_KEYS, "$.usage"),
  ];
  const content = wire["content"];
  if (Array.isArray(content)) {
    content.forEach((b, i) => found.push(...scanBlock(b, `$.content[${i}]`)));
  }
  return found;
}

/** SSE 프레임 배열에서 어댑터가 모르는 이벤트/델타/필드 목록 */
export function unknownStreamFields(frames: readonly SSEFrame[]): string[] {
  const found = new Set<string>();
  frames.forEach((frame, i) => {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      found.add(`frame[${i}]: JSON 파싱 불가`);
      return;
    }
    const type = (json["type"] as string | undefined) ?? frame.event;
    if (!type || !EVENT_TYPES.has(type)) {
      found.add(`event: 미지 이벤트 '${type ?? "?"}'`);
      return;
    }
    if (type === "message_start") {
      for (const key of unknownResponseFields(json["message"])) found.add(`message_start ${key}`);
    } else if (type === "content_block_start") {
      for (const key of scanBlock(json["content_block"], "content_block")) found.add(key);
    } else if (type === "content_block_delta") {
      for (const key of extraKeys(json, CONTENT_BLOCK_DELTA_KEYS, "content_block_delta")) found.add(key);
      const delta = (json["delta"] ?? {}) as Record<string, unknown>;
      const dType = delta["type"] as string | undefined;
      const known = dType !== undefined ? DELTA_KEYS[dType] : undefined;
      if (!known) found.add(`delta: 미지 델타 타입 '${dType ?? "?"}'`);
      else for (const key of extraKeys(delta, known, `delta(${dType})`)) found.add(key);
    } else if (type === "message_delta") {
      for (const key of extraKeys(json, MESSAGE_DELTA_KEYS, "message_delta")) found.add(key);
      for (const key of extraKeys(json["delta"], MESSAGE_DELTA_DELTA_KEYS, "message_delta.delta")) found.add(key);
      for (const key of extraKeys(json["usage"], USAGE_KEYS, "message_delta.usage")) found.add(key);
    } else if (type === "content_block_stop") {
      for (const key of extraKeys(json, CONTENT_BLOCK_STOP_KEYS, "content_block_stop")) found.add(key);
    } else if (type === "message_stop") {
      for (const key of extraKeys(json, MESSAGE_STOP_KEYS, "message_stop")) found.add(key);
    } else if (type === "error") {
      for (const key of extraKeys(json, ERROR_EVENT_KEYS, "error")) found.add(key);
    }
  });
  return [...found];
}
