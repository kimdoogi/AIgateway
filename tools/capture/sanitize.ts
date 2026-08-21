// 픽스처 새니타이저 (ADR-0001 §4 — 키 흔적·org/request id 제거).
// id는 **결정론적 치환** — 같은 원본 id는 같은 자리표시자로. JSON 문자열 값 전체에만 매칭해
// base64 signature 내부의 우연한 유사 패턴 오염을 방지한다 (리뷰 F9).
// thinking signature는 유지: 비밀이 아니라 왕복(opaqueState) 검증에 필요한 페이로드다.

const ID_PREFIXES = [
  // anthropic
  "msg", "toolu", "srvtoolu", "mcptoolu", "req", "file", "container", "compaction", "batch",
  // openai (responses item·call id — chatcmpl은 하이픈형이라 별도 패턴)
  "resp", "rs", "fc", "call", "ws", "fs", "ci", "ig", "cu", "sh", "lsh", "ap", "mcp", "item", "conv",
  // xai responses (2026-08-21 실측 — id 형태는 `접두사_UUID`, 접두사는 openai와 공유 + tco 추가)
  "tco",
];
const ID_PATTERN = new RegExp(`(?<=")(${ID_PREFIXES.join("|")})_[A-Za-z0-9_]{6,}(?=")`, "g");
// openai CC 응답 id (chatcmpl-abc123 하이픈형) — 결정론 치환은 sanitizeText에서 별도 처리
const CHATCMPL_PATTERN = /(?<=")chatcmpl-[A-Za-z0-9_-]{6,}(?=")/g;
// xai id (2026-08-21 실측 4형) — ① `접두사_UUID`(responses item) ② bare UUID(body.id)
// ③ `call-UUID-n`(CC tool call) ④ `접두사_UUID_call-UUID-n`(responses 서버툴 복합).
// UUID는 하이픈 필수라 base64 오염 불가(F9 예외 성립). 접두사 없으면 uuid_/call_ 자리표시자.
const UUID_HEX = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CALL_ID = `call-${UUID_HEX}-\\d+`;
const UUID_ID_PATTERN = new RegExp(
  `(?<=")(?:(${ID_PREFIXES.join("|")})_${UUID_HEX}(?:_${CALL_ID})?|${CALL_ID}|${UUID_HEX})(?=")`,
  "g",
);
const PLACEHOLDER = /_fixture\d{4,}$/;
const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-REDACTED"],
  [/xai-[A-Za-z0-9_-]{20,}/g, "xai-REDACTED"],
  [/sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{10,}/g, "sk-proj-REDACTED"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-REDACTED"],
  [/Bearer\s+[A-Za-z0-9._-]{10,}/g, "Bearer REDACTED"],
];

/** 응답 헤더 화이트리스트 — 나머지(request-id, org id, cf-ray, 쿠키 등)는 저장하지 않는다 */
const HEADER_ALLOWLIST = ["content-type", "retry-after"];

export type IdMap = Map<string, string>;

/**
 * 키 흔적 제거 + id 결정론적 치환. idMap을 호출 간 공유하면 한 케이스의 json/chunks가
 * 같은 자리표시자를 쓴다. 기존 자리표시자는 자기 자신으로 등록해 재실행 시 재번호·
 * 신규 id와의 번호 충돌을 모두 방지한다 (리뷰 F17/A5-r3).
 */
function toPlaceholder(idMap: IdMap, match: string, prefix: string): string {
  const existing = idMap.get(match);
  if (existing) return existing;
  if (PLACEHOLDER.test(match)) {
    idMap.set(match, match); // 기존 자리표시자 — 번호 공간 예약
    return match;
  }
  const used = new Set(idMap.values());
  let n = idMap.size + 1;
  let placeholder = `${prefix}_fixture${String(n).padStart(4, "0")}`;
  while (used.has(placeholder)) placeholder = `${prefix}_fixture${String(++n).padStart(4, "0")}`;
  idMap.set(match, placeholder);
  return placeholder;
}

export function sanitizeText(text: string, idMap: IdMap = new Map()): string {
  let out = text;
  for (const [pattern, replacement] of KEY_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(CHATCMPL_PATTERN, (match) => toPlaceholder(idMap, match, "chatcmpl"));
  out = out.replace(UUID_ID_PATTERN, (match, prefix: string | undefined) =>
    toPlaceholder(idMap, match, prefix ?? (match.startsWith("call-") ? "call" : "uuid")),
  );
  return out.replace(ID_PATTERN, (match, prefix: string) => toPlaceholder(idMap, match, prefix));
}

/**
 * 앵커링(문자열 값 전체 매칭)이 놓치는 문자열 내부 잔류 id 후보 검출 — 하네스가 경고로 승격
 * (자동 치환하면 base64 오염 위험이 있어 사람 검토로 넘긴다 — 리뷰 F9-r3)
 */
export function findResidualIds(text: string): string[] {
  const loose = new RegExp(
    `\\b((${ID_PREFIXES.join("|")})_[A-Za-z0-9]{8,}|chatcmpl-[A-Za-z0-9_-]{6,}|${UUID_HEX})`,
    "g",
  );
  const found = new Set<string>();
  for (const match of text.matchAll(loose)) {
    if (!PLACEHOLDER.test(match[0])) found.add(match[0]);
  }
  return [...found];
}

export function sanitizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) out[name] = sanitizeText(value);
  }
  return out;
}
