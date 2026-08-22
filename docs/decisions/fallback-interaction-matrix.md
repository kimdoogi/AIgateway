# 폴백 경합 매트릭스 — 폴백이 다른 보장과 만날 때 누가 이기는가

- 상태: **확정** (2026-08-20 — E2E 워크스루 검증 F2~F8/F10의 해소 규칙 통합)
- 배경: E2E 검증에서 발견된 구멍은 블록 레벨이 아니라 **레이어 규칙들이 동시에 발화하는 경계 교차 지점**, 특히 폴백에 집중됐다. 이 문서는 각 조합의 확정 규칙을 한 장으로 모은 규범이다. 개별 규칙의 원 출처는 각 행에 링크 — 상충 발견 시 이 매트릭스가 아니라 원 출처를 고치고 여기 반영한다.

| 폴백/장애가 만나는 보장 | 확정 규칙 | 출처 |
|---|---|---|
| **스트림 재개** (Last-Event-ID) | 비정상 단선은 grace window **30초** 동안 업스트림 유지+버퍼링, 초과 시 취소 (재접속은 버퍼 재생만). **명시적 abort는 즉시 취소.** | [ADR-0005 §1](ADR-0005-stream-contract.md) / ADR-0001 D7 예외 |
| **예산 hard 한도** | 집행 단위 = 게이트웨이 요청(`req_`)당 PreRequest 1회 평가. **같은 요청 내 폴백 시도는 현재 스트림의 연속** — 차단하지 않고 초과분은 원장 기록, 다음 요청부터 차단. | [ADR-0007](ADR-0007-billing-envelope.md) / [ir-v0 §10.4](../specs/ir-v0.md) |
| **D10 passthrough 보장** (anthropic-compat→anthropic) | 폴백으로 타깃이 anthropic이 아니게 되면 **보장 소멸** — passthrough 블록·params·headers 드롭 + warning. `passthroughParams.pinned: true`면 anthropic 외 타깃은 `attempts: skipped`. | ADR-0001 D10-1 / ir-v0 §13.3 |
| **BYO 자격증명** (하이브리드) | 라우팅 사전 질의에 credential 해소 포함 — 키 없는 타깃은 `attempts: skipped`. **풀 키 대체는 기본 금지**, 테넌트 opt-in + 과금 주체 변경 고지. 전 타깃 skip 시 원 에러 반환. 원장에 키 소스 구분 기록. | ADR-0001 D7 / ADR-0007 |
| **관리형 서버 상태** (container 등) | 레지스트리는 무동작(TTL 유지). 히스토리/PO의 서버 상태 참조가 타깃과 불일치하면 드롭 + `warning(server-state-inapplicable)` — 조용한 무시 금지. | [ADR-0006 §3](ADR-0006-state-layer.md) / ir-v0 §13.3 |
| **paused 턴의 계속** | 원 프로바이더·표면 고정이 기본 (pause 의미론은 프로바이더 종속). 타 프로바이더로 갈 경우 재타게팅 D6 규칙으로 강등 + warning. | [ADR-0005 §2](ADR-0005-stream-contract.md) |
| **표면 전환 × 폴백·리트라이** | 표면은 **타깃 단위 속성**이다: 같은 프로바이더 재시도는 직전 표면을 유지하고, 폴백으로 프로바이더가 바뀌면 새 타깃의 표면 선택자가 다시 판단한다(선택 결과는 새 `Origin.surface`로 기록). 같은 프로바이더 안에서 표면만 바꾸는 재시도는 **폴백이 아니다** — 명시 opt-in 또는 `surface-switched` warning 동반으로만 허용하고, 자동 오류 복구 수단으로 쓰지 않는다(캐시 전멸·reasoning 연속성 소실). | [ADR-0002](ADR-0002-openai-outbound-responses-api.md) / [ADR-0004](ADR-0004-xai-outbound-surface.md) |
| **표면 sticky** (Responses/CC, generateContent/Interactions) | 직전 assistant 턴의 `Origin.surface`를 재타게팅 패스가 읽어 고정 (stateless 판별). compat 인바운드는 `gateway` 확장 필드의 origin 복원(ir-v0 §13.4)에 의존 — 확장 부재 시 sticky 보장 하락 (기본 표면 적용 + warning). | [ADR-0002](ADR-0002-openai-outbound-responses-api.md) / ir-v0 §13.4 |
| **usage/billing 회계** (다중 시도) | `finish.usage` = 성공 시도분, 실패 시도 usage는 각 `error-partial.usage`(과금 발생 시 필수), `billing.lineItems` = 과금된 전 시도 합산, 원장 = 시도별 행. 스트림 `finish.attempts`로 시도 이력 노출 (비스트림 `gateway.attempts`와 대칭). | ir-v0 §10.1 / ADR-0007 |
| **서버측 fallbacks** (Anthropic) | 게이트웨이 트리 기본. PO 명시 요청 시에만 통과 + 해당 target의 refusal 폴백은 서버 위임 마킹(중복 수행 금지). | [ADR-0005 §3](ADR-0005-stream-contract.md) |
| **게이트웨이 내부 결함** | `gatewayException: true` 마킹된 에러는 폴백 트리를 타지 않는다 (어댑터 버그가 비용을 태우며 전파되는 것 방지 — Portkey 차용). | ir-v0 §12 / ADR-0001 D7 |

공통 원칙: **폴백은 "가장 약한 보장"으로 수렴한다** — 폴백 타깃에서 유지 불가능한 보장(passthrough, 서버 상태, pause 의미론)은 조용히 깨지는 게 아니라 **드롭+warning 또는 skip**으로 명시화된다 (D5 조용한 변조 금지의 폴백 확장).


## 추가 행 (2026-08-21 — walking skeleton 7단계, 같은-타깃 리트라이)

| 교차 | 규칙 |
|---|---|
| 리트라이 × 명시적 취소 | dispatch 중이든 백오프 대기 중이든 취소 시 즉시 중단, 터미널은 499 canceled (attempt 번호 유지). 대기 sleep 자체는 v0에서 비중단 — 대기 후 즉시 체크 (race 도입은 로드맵 4) |
| 리트라이 × 스트림 | dispatch 단계(콘텐츠 방출 전)만 재시도. mid-stream 절단의 재시도(error-partial willRetry:true)는 로드맵 4 폴백 트리 소관 |
| 리트라이 × 회계 | 재시도 확정 시도는 시도별 원장 행(해당 시도 소요), 최종 성공/실패는 터미널에서 1회(요청 총 소요). 리트라이 발생 시 `gateway.attempts`(비스트림)/`finish.attempts`(스트림) 노출 |
| 리트라이 × 예산 | 요청당 1회 평가 유지 — 같은 요청 내 재시도는 추가 평가 없음 (ADR-0007) |
| 접속 타임아웃 | 헤더 수신까지 120s(기본) — 초과 시 category timeout(504, 재시도 적격). body 스트리밍에는 미적용 |

## 추가 행 (2026-08-22 — 폴백 트리 v1 구현, ir-v0 §6.4)

| 교차 | 규칙 |
|---|---|
| 폴백 체인 정의 | v1은 요청 명시(`fallbackModels`)만 — 레지스트리 기본 체인(모델 동급 판정)은 2차 |
| 폴백 × 스트림 콘텐츠 | **콘텐츠 방출 전 실패만 자동 전환** (error-partial willRetry:true → provider-switched → 새 타깃). 방출 후 실패는 터미널 종결 — 중복 콘텐츠 자동 재방출 금지. mid-stream continuation은 2차 |
| 폴백 × 세션 터미널 | `error-partial(willRetry: true)`는 터미널이 아니다 — 세션 done 처리 예외 (problem log 2026-08-21 예고의 해소) |
| 폴백 × 원장 attempt 번호 | 타깃별 리트라이 attempt는 타깃 내 1부터 — 원장 행은 (requestId, provider, attempt)로 구분 (requestId는 전 타깃 공유) |
| 폴백 × 폴백 타깃 prepare 실패 | 1차 타깃 prepare 실패는 즉시 반환(기존과 동일), **폴백 타깃**의 prepare 실패(미라우팅 모델 등)는 skipped 처리 후 다음 타깃 — 오타 하나가 전체 요청을 죽이지 않게 |
| 폴백 × compat 다운컨버트 (2026-08-22 리뷰) | `error-partial(willRetry:true)`는 compat wire에서도 **종결로 번역 금지** — openai-compat은 `[DONE]` 미방출(SSE 주석만), anthropic-compat은 `error` 이벤트 미방출. 전환 사실은 finish의 `gateway.warnings`에 `fallback-target-switched`로 (부록 (a) §6.1/6.2) |
| 폴백 × 세션 소유권 (2026-08-22 리뷰) | 세션은 생성 시 소유 테넌트를 새긴다 — 폴백으로 타깃이 바뀌어도 소유자는 불변(요청 발신 테넌트). 재개·취소는 소유자만, 불일치는 미지 세션과 동일한 410 |
