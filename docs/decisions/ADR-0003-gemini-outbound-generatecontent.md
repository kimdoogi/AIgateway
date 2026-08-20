# ADR-0003: Gemini 아웃바운드는 generateContent로 시작하되, IR은 Interactions 표현을 수용 가능하게 설계한다

- 상태: **승인** (2026-08-20 사용자 승인)
- 날짜: 2026-08-20
- 근거 자료: [Gemini API 인벤토리](../research/2026-08-20-gemini-api.md)
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D2/D6, [ADR-0002](ADR-0002-openai-outbound-responses-api.md) (동형 구도)

## 컨텍스트

2026-06부로 Gemini Developer API에 Interactions API가 GA 승격되어 신규 프로젝트 권장 표면이 됐고, 기존 generateContent는 "legacy이지만 완전 지원(not deprecated)"이다. 두 표면은 wire 포맷이 완전히 다르다(camelCase Part 유니온 vs snake_case typed step/block). OpenAI의 Responses vs Chat Completions와 동형 구도이지만 성숙도가 다르다 — OpenAI Responses는 수년 운영된 주력 표면인 반면, Interactions는 GA 직후다.

## 결정

1. **Gemini 아웃바운드 어댑터 v1은 `models.generateContent` / `:streamGenerateContent`(v1beta)를 대상으로 한다.**
2. 스트리밍은 **`?alt=sse` 강제** — 기본 JSON 배열 프레이밍 경로는 사용하지 않는다.
3. **IR은 Interactions 전환을 막지 않도록 설계한다**: opaque reasoning 슬롯(4사 공통 **개념** — Anthropic `signature`, OpenAI `encrypted_content`, xAI encrypted reasoning, Gemini 구현은 `thoughtSignature`), 서버 툴 call/result 블록, tool call **id 슬롯 유지**(generateContent는 name+순서 매칭이지만 Live/Interactions는 id 사용), agent 축(`deep-research` 등)은 providerOptions.google로.
4. **Interactions 어댑터는 2차** — MCP·멀티모달 함수응답·background·agents 수요가 확인되면 추가한다. 어댑터 내 표면 라우팅 구조(ADR-0002의 responses/chat-completions 이중 경로와 동형)를 미리 예약해둔다.

## 근거

- generateContent는 "완전 지원" 명시로 폐기 리스크가 낮고, 문서·생태계·안정성이 성숙.
- **현재는 generateContent가 기능 커버리지 우위인 영역도 있다**: explicit caching(`cachedContents`)과 custom safety settings가 Interactions에서 미지원.
- Interactions는 GA 직후라 안정성 관찰 기간이 필요. 신형 표면 전용 기능(MCP 등)도 일부 "coming soon" 상태.
- IR을 양쪽 표현 가능하게 설계해두면 전환 비용은 어댑터 1개 추가로 한정된다 (N+M 구조의 이점).

## 기각한 대안

**처음부터 이중 경로 구현** — 구현량과 골든셋이 2벌이 되는데, Interactions 전용 기능의 실수요가 아직 없다. ADR-0002(OpenAI)와 달리 여기는 신형 표면을 주 경로로 삼을 근거(reasoning 보존 불가 같은 구조적 결격)가 legacy 쪽에 없다.

## 결과

- Gemini 어댑터 디렉토리에 표면 축 예약: `surfaces/generate-content/` (v1), 향후 `surfaces/interactions/`.
- 커버리지 매트릭스에 표면(surface) 축 추가 — 기능×표면 지원 여부가 어긋나는 프로바이더(Gemini, OpenAI, xAI)에 공통 적용.
- Interactions 승격 재검토 트리거: MCP 툴 GA, 멀티모달 함수응답 수요, 또는 generateContent에 실제 deprecation 신호 발생 시.
- 표면 안정성 규칙(대화 단위 sticky — [ADR-0002](ADR-0002-openai-outbound-responses-api.md) 결과 참조)은 Gemini 표면 라우팅에도 공통 적용된다.
