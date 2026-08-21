// SSE 프레이밍 파서 — 프레이밍 분리는 게이트웨이 소관이고 어댑터는 (eventName, data)만 받는다
// (ADR-0001 D4 / adapters/types.ts StreamTransformer.framing). 골든셋 재생과 서버 스트림이 공유한다.

export interface SSEFrame {
  event?: string;
  data: string;
  /** 인바운드 재개 테스트 등에서 사용 — 게이트웨이 아웃바운드가 id:=seq를 발행한다 */
  id?: string;
}

/**
 * 완결된 SSE 텍스트(픽스처 `*.chunks.txt` 등)를 프레임 배열로 파싱한다.
 * WHATWG SSE 규칙: `:` 시작 줄은 주석, 빈 줄이 디스패치, `data:`는 줄바꿈으로 결합.
 * 마지막 프레임이 빈 줄 없이 끝나도 방출한다 — 절단 스트림 픽스처를 잃지 않기 위함
 * (터미널 보장은 어댑터 onStreamEnd가 맡는다).
 */
export function parseSSEText(text: string): SSEFrame[] {
  const frames: SSEFrame[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let data: string[] = [];

  const flush = (): void => {
    if (data.length === 0 && event === undefined && id === undefined) return;
    frames.push({
      ...(event !== undefined ? { event } : {}),
      data: data.join("\n"),
      ...(id !== undefined ? { id } : {}),
    });
    event = undefined;
    id = undefined;
    data = [];
  };

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue; // 주석(heartbeat 등)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
    // retry는 프로바이더 인바운드에서 쓰이지 않는다
  }
  flush();
  return frames;
}

/**
 * 바이트 청크 스트림을 SSE 프레임으로 증분 파싱한다 (게이트웨이 스트림 경로).
 * 완결 파서(parseSSEText)와 프레임 집합이 동일함을 sse.test.ts가 분할 조합으로 검증한다.
 * scanFrom 북마크로 미완 프레임 재스캔을 방지 (거대 프레임에서 O(n²) 회피).
 */
export async function* parseSSEStream(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEFrame> {
  const decoder = new TextDecoder();
  let carry = "";
  let scanFrom = 0;
  // 디스패치 경계 = 연속한 줄바꿈 2개 (parseSSEText와 동일 문법). \r(?!\n): CRLF 한 쌍이
  // 백트래킹으로 두 개행으로 오인되는 것 방지. 호출별 인스턴스 — lastIndex 공유 금지 (리뷰 F16)
  const BOUNDARY = /(\r\n|\n|\r(?!\n))(\r\n|\n|\r(?!\n))/g;

  for await (const chunk of chunks) {
    carry += decoder.decode(chunk, { stream: true });
    BOUNDARY.lastIndex = scanFrom;
    let lastEnd = -1;
    for (let m = BOUNDARY.exec(carry); m; m = BOUNDARY.exec(carry)) lastEnd = m.index + m[0].length;
    if (lastEnd === -1) {
      // 경계 없음 — 다음 청크는 겹침 3자만 재스캔 (경계 최장 4자)
      scanFrom = Math.max(0, carry.length - 3);
      continue;
    }
    const complete = carry.slice(0, lastEnd);
    // 잔여 선두의 고아 줄바꿈(경계가 청크에 걸쳐 \r|\n으로 쪼개진 경우) 제거
    carry = carry.slice(lastEnd).replace(/^\r?\n/, "");
    scanFrom = 0;
    yield* parseSSEText(complete);
  }
  carry += decoder.decode(); // 말미 미완 UTF-8 시퀀스 플러시
  if (carry.trim().length > 0) yield* parseSSEText(carry);
}
