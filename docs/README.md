# AI Gateway — 문서 위키

작업 과정 전체를 기록하는 llm-wiki. 모든 설계 결정과 문제는 여기에 남긴다.

## 프로젝트 목표

1. 어댑터 패턴으로 N×M 변환을 N+M으로 (N = 인바운드 API 포맷, M = 아웃바운드 프로바이더)
2. 대화 중간에 모델/프로바이더를 바꿔도 히스토리가 동작
3. 각 프로바이더(SaaS LLM)의 고유 기능을 전부 노출 — 최소공배수 게이트웨이 금지

작업 원칙: 골든셋 기반 테스트 · 전 과정 문서화 · 문제 발생 시 problem log 기록 · 프로덕션 품질 (테스트용 아님)

## 문서 구조

| 디렉토리 | 내용 |
|---|---|
| [research/](research/) | 선행 사례 소스 레벨 분석 + 프로바이더 인벤토리 |
| [decisions/](decisions/) | 아키텍처 결정 기록 (ADR) |
| [specs/](specs/) | 스펙 문서 — [IR v0](specs/ir-v0.md) |
| [plan/](plan/) | 실행 계획 — [walking skeleton](plan/walking-skeleton.md) |
| [problems/](problems/) | 작업 중 문제가 됐던 것들의 기록 (problem log) |

## 타임라인

### 2026-08-20 — 프로젝트 시작, 선행 사례 리서치, 어댑터 아키텍처 제안

- 기술 스택 방향: TypeScript (Node 22 LTS) + Hono + Zod + Vitest. 인프라는 로컬 docker-compose(게이트웨이 + Postgres + Redis — ADR-0006; 코어는 stateless).
- 선행 사례 3개를 소스 레벨로 분석:
  - [Vercel AI SDK](research/2026-08-20-vercel-ai-sdk.md) — LanguageModelV4 스펙 (자체 canonical 허브의 성공 사례. 스펙은 V2가 아니라 V4까지 진화해 있었음)
  - [Portkey Gateway](research/2026-08-20-portkey-gateway.md) — OpenAI-슈퍼셋 허브 게이트웨이 (구조가 우리와 가장 유사, 허브 부식의 실증)
  - [LiteLLM](research/2026-08-20-litellm.md) — 반면교사 (OpenAI 허브 + 동적 dict 파이프라인의 실패 패턴, 단 모델 레지스트리는 최대 자산)
- 종합 결론: [ADR-0001 어댑터 아키텍처](decisions/ADR-0001-adapter-architecture.md) — 자체 IR 허브 + 네임스페이스드 확장 + 히스토리 재타게팅 패스. **당일 사용자 승인**: 초기 프로바이더 4개(Anthropic/OpenAI/Google/xAI), native IR 스펙 우선, Anthropic API 100% 커버리지 하드 요구사항(D10)
- [Problem log 사전 경고 워치리스트](problems/problem-log.md) 시드 — 리서치에서 확인된, 구현 시 반드시 만날 지뢰 목록
- 프로바이더 4종 wire 기능 인벤토리 완료 (IR 설계 입력물):
  - [Anthropic API 커버리지 체크리스트](research/2026-08-20-anthropic-api-coverage.md) — 100% 커버리지 요구사항의 기준 문서
  - [OpenAI API 인벤토리](research/2026-08-20-openai-api.md) — Responses vs Chat Completions 비교 포함
  - [Gemini API 인벤토리](research/2026-08-20-gemini-api.md) — thought signature 규칙 전문, generateContent vs Interactions 이원화 발견
  - [xAI(Grok) API 인벤토리](research/2026-08-20-xai-grok-api.md) — OpenAI 호환에서 어긋나는 지점 전수 + base 어댑터 오버라이드 목록
- [ADR-0002](decisions/ADR-0002-openai-outbound-responses-api.md) (승인) — OpenAI 아웃바운드 주 경로 = Responses API + `store: false` 강제
- [ADR-0003](decisions/ADR-0003-gemini-outbound-generatecontent.md) (승인) — Gemini 아웃바운드 = generateContent(`?alt=sse` 강제) 시작, IR은 Interactions 수용 가능하게
- 전체 계획 리뷰 실시 (자체 리뷰 + 적대적 리뷰 에이전트) → ADR-0001 보강: 취소 전파 1급 요구사항, 429 rate/quota 구분, grounding 캐시·로그 제외, 레지스트리 공식 API 소스·타임아웃·countTokens capability, v1 범위 기본안(§5-5), 골든셋 4종으로 확장(인바운드 응답 방향 추가), D6 재타게팅 규칙 8~10 추가, D10 신선도 장치. ADR-0002/0003에 표면 안정성 규칙(대화 단위 sticky) 추가
- [ADR-0004](decisions/ADR-0004-xai-outbound-surface.md) (승인) — xAI 표면 전략: CC 주 경로 + 기능 트리거 시 responses 스위칭 + `store: false`
- [IR 설계 게이트 결정 레지스터](decisions/ir-design-gate.md) — **클로즈 완료**: G1~G7 권고안 일괄 승인 + G8 확정
- 결정 라운드 완료: v1 기능 범위 확대 확정(텍스트 생성 + 멀티모달 입력 + count_tokens + **Batches + Files**), 테넌트 자격증명 = **하이브리드**(가상 키 발급 + BYO/풀 키 백엔드), 네임스페이스 키 확정
- **운영 결정 7건 전부 클로즈** — 미해결 질문 0건:
  - [ADR-0005](decisions/ADR-0005-stream-contract.md) 스트림 v1 풀스펙(터미널 3종·heartbeat·provider-switched·중간 usage·재개 API·백프레셔) + **pause_turn 항상 노출** + 이중 폴백 규칙
  - [ADR-0006](decisions/ADR-0006-state-layer.md) 상태 계층 = **처음부터 Postgres + Redis** + 서버측 상태 **게이트웨이 관리형**(리소스 레지스트리·TTL·삭제 대행)
  - [ADR-0007](decisions/ADR-0007-billing-envelope.md) 과금 = 라인아이템 + 예산 집행 + **정산 리포트까지 v1**
  - [ADR-0008](decisions/ADR-0008-observability.md) 관측성 = **본문 로깅 기본 on**(opt-out) + 3층 로그 + OTel + 데이터 주권(허용 리전)
  - PO 미지 키 = 기본 거부 + opt-in 통과 (ADR-0001 D5)
- **[IR 스키마 v0](specs/ir-v0.md) 작성 + 검증 + 개정** — 게이트 결정 8건 + ADR-0005 스트림 계약 + ADR-0007 billing을 전부 반영한 canonical 스펙: 블록 union(8종 + opaqueState 공통 슬롯), 요청/응답 envelope, usage 정규화 공식 표, unified finishReason, 스트림 이벤트 전체, 에러 모델, 재타게팅 소비 규칙. 표현력 시뮬레이션 검증(어려운 케이스 22종)으로 스키마 구멍 7건 검출·개정 ([problem log](problems/problem-log.md) 참조)
- **최종 검증 2종 + 전면 수정**: ① 문서 전체 사후 정합성 검사(증분 수정 잔재 14건 정리), ② E2E 시나리오 워크스루 8종(경계 교차 구멍 15건 — 구현 차단 2건 포함) → [폴백 경합 매트릭스](decisions/fallback-interaction-matrix.md) 확정, compat 왕복 규약(ir-v0 §13.4) 신설, grace window 30초로 취소·재개 충돌 해소
- **[Walking skeleton 실행 계획](plan/walking-skeleton.md)** 작성 — 작업 분해 8단계 + DoD 6항목 + 사용자 준비물
- **Walking skeleton 착수** (계획 승인 + API 키·원격 저장소·pnpm 확인) — 1단계 스캐폴딩 + 2단계 IR zod 스키마 완료 (`src/ir/` 14개 모듈, 테스트 21개 통과: 직렬화 결정론·role-블록 허용·signature-only 스트림 이벤트·히스토리 편입 계약 검증). 진행 현황은 [실행 계획](plan/walking-skeleton.md)
- 다음 단계: Anthropic 어댑터(3단계) + 골든셋 캡처 하네스(4단계)

## 로드맵 (2026-08-20 확정)

1. ~~IR 설계 게이트 + 운영 결정 클로즈~~ (완료) → 2. ~~IR 스키마 v0~~ (작성·검증·개정 완료 — 사용자 승인 대기) → 3. **Walking skeleton** ([실행 계획](plan/walking-skeleton.md) — native → Anthropic, stream 포함 + 골든셋 캡처 하네스 + docker-compose + 메타 로그·OTel) → 4. OpenAI 어댑터 + 재타게팅 패스 v0 + 크로스 왕복 골든셋 + **부록 (a) 선행 후** 호환 인바운드 2종 → 5. Gemini·xAI 확장 + **Batches/Files 브리지(부록 (b) 선행)** + 레지스트리·커버리지 CI + 운영 평면(가상 키·예산·정산, 서버 상태 레지스트리, 본문 로그 파이프라인)

원칙: 4사 동시 착수 금지 (2사로 인터페이스 검증 후 확장), 골든셋 하네스는 어댑터와 동시 또는 선행. v1 정의는 넓지만(정산·관리형 서버 상태 포함) 구현 순서는 코어 파이프라인 우선 — 운영 평면은 5단계에 집중.
