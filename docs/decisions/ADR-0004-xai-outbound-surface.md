# ADR-0004: xAI 아웃바운드 표면 전략 — chat completions 주 경로 + 기능 트리거 시 responses 스위칭, `store: false` 강제

- 상태: **승인** (2026-08-20 사용자 승인)
- 날짜: 2026-08-20
- 근거 자료: [xAI API 인벤토리](../research/2026-08-20-xai-grok-api.md)
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D8, [ADR-0002](ADR-0002-openai-outbound-responses-api.md) (동형 구도 + 표면 안정성 규칙)

## 컨텍스트

이중 표면 3사(OpenAI, Gemini, xAI) 중 xAI만 표면 결정이 없었다 (전체 계획 리뷰에서 지적). xAI 인벤토리 결과: `/v1/chat/completions`는 OpenAI-호환 표면, `/v1/responses`는 xAI의 주력 표면이며 **서버측 에이전트 툴(web_search/x_search/code_interpreter/collections_search/mcp)과 encrypted reasoning은 responses 전용**이다. xAI responses도 기본 30일 서버 저장이다.

## 결정

1. **xAI 아웃바운드 v1 주 경로는 `/v1/chat/completions`** — openai-compat base 어댑터 상속(D8) + 인벤토리의 오버라이드 14개 지점 적용. ADR-0002(OpenAI=Responses)와 결정이 다른 이유: xAI CC에는 OpenAI CC와 달리 reasoning 노출(`reasoning_content`)이 있어 구조적 결격이 없고, base 어댑터 재사용으로 구현·골든셋 비용이 최소가 된다.
2. **기능 트리거 시 `/v1/responses`로 스위칭**: 서버측 에이전트 툴, encrypted reasoning 왕복(`include:["reasoning.encrypted_content"]`), stateful 기능이 요청되면 responses 경로 사용. 목표 3(고유 기능 전부) 충족 수단.
3. **responses 경로에서는 `store: false` 강제** (기본 30일 저장 방지) — ADR-0002와 동일 원칙. `previous_response_id` 등은 opt-in passthrough.
4. **표면 안정성 규칙 적용** (ADR-0002 결과): 대화 단위 sticky, 전환은 명시 옵트인 또는 warning 동반.
5. deprecated `/v1/messages`(Anthropic 호환 표면)와 폐기된 Live Search(`search_parameters` → 410)는 사용 금지 — search_parameters 인입 시 어댑터가 agent tools로 변환하거나 명시 거부.

## 결과

- xAI 어댑터 구조: openai-compat base 상속 + `surfaces/responses/` 예약. xAI responses는 OpenAI Responses 패턴 호환이므로 OpenAI responses 어댑터 코드의 부분 공유 가능성을 구현 시 검토.
- 커버리지 매트릭스에 표면 축 적용 (ADR-0003과 동일).
- responses 주 경로 승격 재검토 트리거: xAI가 CC를 deprecation하거나, 에이전트 툴 사용이 주류가 될 때.
