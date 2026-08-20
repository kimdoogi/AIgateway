# ADR-0002: OpenAI 아웃바운드 주 경로는 Responses API + `store: false`

- 상태: **승인** (2026-08-20 사용자 승인)
- 날짜: 2026-08-20
- 근거 자료: [OpenAI API 인벤토리](../research/2026-08-20-openai-api.md)
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D6(재타게팅), 목표 3(고유 기능 커버리지)의 OpenAI 적용 (D10 하드 보장은 Anthropic 한정)

## 컨텍스트

OpenAI는 텍스트 생성에 두 API 표면을 제공한다: Chat Completions(CC)와 Responses. 게이트웨이 아웃바운드 어댑터는 하나를 canonical 경로로 정해야 한다.

## 결정

1. **OpenAI 아웃바운드의 canonical 경로는 Responses API다.**
2. **기본 `store: false`를 강제**하고, 응답의 reasoning item을 IR reasoning 블록으로 실어 왕복시킨다 — stateless 게이트웨이 원칙 유지. (이후 IR v0에서 구체화: `encrypted_content`는 공통 슬롯 `opaqueState`, itemId류 참조만 `providerMetadata.openai` — ir-v0 §4.10.)
3. `previous_response_id` / `conversation` / `background`는 opt-in passthrough (providerOptions.openai).
4. **CC는 보조 경로로 유지**: audio in/out, predicted outputs, `seed`/`logit_bias`/penalties 등 CC 전용 기능이 요청된 경우에만 어댑터가 자동 선택. 이 경우 reasoning 보존 불가를 warning으로 보고 (ADR-0001 D5). (`n>1`은 CC 전환 사유가 아니다 — [IR 설계 게이트](ir-design-gate.md) G2 결정에 따라 v1 IR은 단일 후보이며 `n>1`은 drop+warning 처리.)

## 근거 (상세는 인벤토리 §0)

- **reasoning 보존이 CC에서 구조적으로 불가능** — 툴콜 루프에서 reasoning 상태가 매 턴 소실. 우리 목표 2(히스토리 보존·모델 교체)와 직결.
- 신기능(빌트인 툴 16종, reasoning.mode/context, compaction, background)이 전부 Responses에만 착륙 — 목표 3(고유 기능 전부)과 직결.
- pro 계열 등 **Responses 전용 모델이 이미 존재** (CC 호출 시 404).
- OpenAI 공식 문서가 신규 프로젝트에 Responses 권장 + Assistants API 실제 셧다운(2026-08-26) 전례.
- Responses semantic events(item 경계 + sequence_number)가 우리 IR 스트림 이벤트 모델(ADR-0001 D2)과 구조적으로 동형 — 변환 손실 최소.
- 비용: `store: false` + 전체 히스토리 재전송은 서버측 체이닝과 과금이 동일 (체인 전체 input이 매번 과금됨) — stateless 선택에 비용 페널티 없음.

## 기각한 대안

**CC를 주 경로로** — OpenAI-호환 생태계(xAI 포함)와 코드 공유가 쉬워지지만, reasoning 손실·신기능 미착륙·전용 모델 404가 프로덕션 목표와 충돌. OpenAI-호환 롱테일용 openai-compat base 어댑터는 CC 형태로 별도 유지하므로 코드 공유 이점은 어차피 확보된다(xAI 어댑터가 이를 상속).

## 결과

- OpenAI 어댑터는 이중 경로: `responses.ts`(주) + `chat-completions.ts`(보조, openai-compat base 상속). 경로 선택은 요청 기능 기반 자동 + 명시 오버라이드 옵션.
- **표면 안정성 규칙 (2026-08-20 리뷰 반영)**: 표면 선택은 **대화 단위로 sticky**하다 — 같은 대화의 후속 요청은 이전 표면을 유지하고, 전환은 명시 옵트인 또는 warning 동반으로만 한다. 대화 중간 무통보 전환은 프로바이더 프롬프트 캐시 전체 미스와 reasoning 연속성 소실을 유발하기 때문. 이 규칙은 이중 표면을 가진 모든 프로바이더(Gemini generateContent/Interactions, xAI chat/responses)의 표면 라우팅에 공통 적용된다. **판별 메커니즘**: 코어는 stateless(ADR-0006 §2)이므로 직전 assistant 턴의 `Origin.surface`(ir-v0 §4.0)를 재타게팅 패스가 읽어 표면을 고정한다 — compat 인바운드는 origin 복원 규약(ir-v0 §13.4)에 의존.
- IR reasoning 블록은 opaque 상태(`encrypted_content`, Anthropic `signature`)를 보존하는 구조가 확정적으로 필요 — IR v0에서 공통 슬롯 `opaqueState`(ir-v0 §4.10)로 구체화 완료.
- 재타게팅 패스: OpenAI→타사 교체 시 reasoning drop/강등 정책은 ADR-0001 D6 그대로; 타사→OpenAI 교체 시 외래 reasoning은 스킵하되 보고.
