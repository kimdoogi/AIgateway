# ADR-0005: 스트림 v1 계약과 턴 의미론 — 풀스펙(재개·중간 usage 포함), pause_turn 항상 노출

- 상태: **승인** (2026-08-20 사용자 결정)
- 날짜: 2026-08-20
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D2/D5/D7, [ADR-0006](ADR-0006-state-layer.md)(재개 버퍼), [IR 게이트](ir-design-gate.md) G7

## 결정

### 1. 스트림 이벤트 v1 범위 — "더 두껍게"

- **공통 필드**: 모든 IR 스트림 이벤트에 `sequence_number` (스트림 내 단조 증가, 재개 커서 겸용).
- **터미널 이벤트 3종** (모든 스트림은 반드시 셋 중 하나로 끝난다 — 어댑터 계약):
  - `finish`: 정상 종료 — unified finishReason(+raw), 최종 usage, billing 요약
  - `error-final`: 복구 불가 종료 — 구조화 에러 + 과금된 부분 usage 명시
  - `error-partial`: mid-stream 절단 — 이미 방출된 이벤트 유효, 재시도/폴백 가능 여부 포함 (이후 `provider-switched`로 이어질 수 있음)
- **운영 이벤트**:
  - `heartbeat`: 주기 발신 (기본 15초 제안) — 프록시/LB 타임아웃 방지
  - `provider-switched`: 폴백/재시도로 타깃 변경 시 — 이전/새 {provider, model} + 사유
  - `usage-interim`: 중간 usage 집계 — 어댑터가 산출 가능한 시점마다 (과금 미터링, 장시간 스트림 모니터링용)
- **재개 API (v1 포함)**: 게이트웨이가 스트림 이벤트를 단기 버퍼(Redis, TTL 5분 제안)에 보관. 클라이언트는 `Last-Event-ID`(= sequence_number)로 재접속해 이어받기. **단선 처리 (2026-08-20 E2E 검증 반영 — D7 취소 전파와의 충돌 해소)**: 비정상 단선 시 **grace window 30초** 동안 업스트림 생성을 유지하며 버퍼링을 계속하고, 초과 시 업스트림 취소 (이후 재접속은 버퍼 프리픽스 + `error-partial` 재생만). 클라이언트의 **명시적 abort는 grace 없이 즉시** 업스트림 취소 (D7 원칙).
- **백프레셔**: 클라이언트 소비 지연으로 버퍼 상한(기본 제안 8MB) 초과 시 연결 종료 + 업스트림 즉시 취소 + `error-partial` 기록. 재개 버퍼가 남아 있으면 재접속으로 복구 가능.

### 2. `pause_turn` — 항상 노출 (자동 계속 없음)

사용자 결정: 모든 인바운드에서 게이트웨이는 pause를 자동 계속하지 않고 그대로 노출한다.

- 인바운드별 표현: native = unified finishReason `paused`(+raw) / anthropic-compat = 원문 `pause_turn` / openai-compat = `finish_reason`에 비표준 값 `paused` 노출 (다운컨버트 시 raw를 확장 필드에 병기).
- 계속 진행은 클라이언트가 히스토리 재전송으로 수행 — 게이트웨이는 paused 상태의 assistant 턴을 재타게팅 패스에서 온전히 보존해 재전송을 정상 지원한다.
- **리스크 고지**: openai-compat 클라이언트는 `paused`를 모르는 값으로 받는다 — 게이트웨이 문서에 명시하고, 클라이언트가 그대로 히스토리를 재전송하면 계속되도록 설계한다.
- **계속 요청의 라우팅**: paused 턴의 계속 요청은 표면 안정성 규칙과 동일하게 **원 프로바이더·표면 고정이 기본**이다 (pause_turn 의미론은 프로바이더 종속 — 서버 툴 루프의 중단점). 라우팅이 타 프로바이더로 보내는 경우 재타게팅 D6 규칙으로 강등 + warning.

### 3. 이중 폴백 방지

- 게이트웨이 폴백 트리가 기본이다.
- Anthropic 서버측 `fallbacks`는 `providerOptions.anthropic`으로 명시 요청 시에만 통과. 이 경우 해당 target의 refusal 계열 폴백은 서버에 **위임된 것으로 마킹**하고 게이트웨이 트리는 같은 사유의 폴백을 중복 수행하지 않는다.

## 결과

- IR 스트림 이벤트 스키마(로드맵 2)에 위 이벤트들이 1급으로 들어간다.
- 재개 버퍼·중간 usage는 walking skeleton(로드맵 3)부터 구현 — Redis 의존이 skeleton 단계에 포함됨 (ADR-0006).
- 골든셋(D9)의 스트림 픽스처에 터미널 3종·재개 시나리오 케이스 포함.
