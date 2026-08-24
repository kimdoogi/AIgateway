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

### 2026-08-21 — Walking skeleton 완료, OpenAI 착수 전 계약 간극 점검

- **Walking skeleton(로드맵 3) 완료** — 3~8단계 전부 + 고강도 리뷰 5라운드. Anthropic 어댑터·캡처 하네스·골든셋(실 녹화 24케이스)·native 인바운드 서버·정책/상태/관측성·실 E2E 스모크. DoD 6항목 충족. 상세는 [실행 계획](plan/walking-skeleton.md)
- **[OpenAI 어댑터 착수 전 간극 점검](plan/openai-adapter-gaps.md)** — 현행 어댑터 계약이 Responses API를 못 담는 지점 9건 분류(차단 3·패치 4·노트 2). 사용자 결정 3건: ① 표면(surface)을 레지스트리 1급 축으로 도입(이중 표면 처음부터), ② `AdapterCapabilities`에 `unsupportedParams`·`surfaces` 추가, ③ providerOptions가 표준 필드와 같은 wire 슬롯을 다투면 **PO 우선 + `provider-option-override` warning**
- 결정에 따른 스펙 패치: ir-v0 §2(PO 충돌 규범)·§5(warning 코드)·§4.0(응답 방향 `origin.surface` 필수)·§4.2(reasoning 보존 키 PO 등재)·§10.2(refusal·서버툴 진행 이벤트)·§15(image_generation 범위 밖) + [폴백 매트릭스](decisions/fallback-interaction-matrix.md) 표면×폴백 행 + ADR-0002 결과 절 + [problem log](problems/problem-log.md)
- 다음 단계: 계약 변경(표면 축·capability 슬롯·conformance) → OpenAI Responses 어댑터 → 캡처·골든셋 → CC 보조 경로 → 재타게팅 패스 + 크로스 왕복

### 2026-08-21 — 로드맵 4 구현: OpenAI 이중 표면 + 재타게팅 + compat 인바운드 (코드 완료, 실 녹화 대기)

- **표면(surface)을 레지스트리 1급 축으로**: provider당 어댑터 복수 등록, 표면 결정 공통 규칙(명시 오버라이드 > 기능 required > sticky(직전 `Origin.surface`) > 기본) + 모델 capability(`surfaces`) 게이트. 선택 기준은 프로바이더 소유 선택자(D4). `AdapterCapabilities`에 `unsupportedParams`·`surfaces` 추가
- **OpenAI 어댑터** (`src/adapters/openai/`, ADR-0002): Responses 주 표면(store:false 강제 + encrypted reasoning 왕복 + item 무손실 §4.2 + semantic events ~58종 상태 머신 + 서버툴 진행 passthrough) + CC 보조 표면(audio/seed/penalties/prediction, 툴콜 파편 조립, [DONE] 종결) + 에러/usage/finishReason 공통 매핑. conformance에 응답 `origin.surface` 검증 추가
- **재타게팅 패스 v0** (`src/gateway/retarget.ts`, §13.3): 고아 tool 쌍 수리(D6-10, 마지막 assistant 툴콜 턴은 보존), 타깃 상이 서버 상태 PO 드롭 + `server-state-inapplicable`, `cache-breakpoint-ignored`. **크로스 왕복 골든셋** — anthropic 실픽스처→openai wire / openai→anthropic, 동일 타깃 item 원문 복원 검증
- **[부록 (a)](specs/appendix-a-compat-inbound.md) 확정 + compat 인바운드 2종** (`src/inbound/`): openai-compat CC·anthropic-compat Messages — `gateway` 확장 필드(§13.4: `gateway.ir` 복원 1순위·strict 모드 헤더), finishReason/usage 다운컨버트 표, 스트림 재합성(CC chunk + gateway.ir chunk / Anthropic SSE 재합성). 서버 라우트 `/compat/openai/v1/chat/completions`·`/compat/anthropic/v1/messages` — 실행은 native와 동일 경로(G1 우회 없음). E2E: **openai-compat 포맷으로 claude 호출** 교차 검증
- **캡처 하네스 멀티 프로바이더화**: 프로바이더 구성 데이터 테이블(분기문 없음), OpenAI 케이스 22종(무과금 게이트 5·manual 2 포함), 새니타이저 openai id(resp/rs/fc/call/chatcmpl-)·키 패턴 확장. 테스트 240개
- **실 녹화 완료** (2026-08-21 — 21케이스, 총 ≈$0.045): encrypted reasoning·서버툴 web_search_call·게이트 400×3·401·404(pro-on-cc) 전부 확보, 골든셋 ② 자동 편입(스냅샷 21). 신선도 장치 검출 3건: ① `$.tool_usage` 신필드, ② **GPT-5.6 CC 함수 툴 = `reasoning_effort:'none'` 필수**(400 실측 — 케이스 반영), ③ 미지 모델은 404 아닌 400
- **실 E2E 스모크 통과** (`pnpm smoke:roadmap4`): openai 비스트림·스트림 완주(seq 단조), **크로스 프로바이더 대화**(claude 1턴 → 히스토리 → gpt 2턴, 내용 연속성 실검증 — 목표 2), compat CC→claude, encrypted reasoning 왕복. 스모크가 **`input_tokens_details.cache_write_tokens` 신필드 검출** → 구 인벤토리의 "캐시 쓰기 미관측" 전제 폐기, convertUsage·ir-v0 §8 갱신. **로드맵 4 완료** — 테스트 261개

### 2026-08-21 — neuro 연동 준비: compat 인바운드 보강 3건

- 실소비자 1호(neuro 에이전트 루프) 접속 사전 점검에서 compat 커버리지 구멍 3건 검출·수정: ① 미지 top-level 키 → `passthroughParams(pinned)` 원문 통과(부록 (a) §3.2 개정 — container·context_management·mcp_servers), ② 응답 `container` 유실 → `providerMetadata` + `response-metadata.providerMetadata` 신설(ir-v0 §10.1), ③ PTC `allowed_callers` 등 툴 비표준 키 → `wireExtras` 보존·재병합. neuro형 왕복 테스트 추가, 테스트 265개. 상세: [problem log](problems/problem-log.md)

### 2026-08-21 — 로드맵 5 착수: xAI 어댑터 (openai-compat base 상속 — 코드 완료, 실 녹화 대기)

- **xAI 어댑터** (`src/adapters/xai/`, ADR-0004): openai 어댑터를 **네임스페이스 리맵 래퍼**로 상속(D8 실현) — IR의 프로바이더 표식(PO/PM 키·origin·opaqueState·provider 툴 id)만 xai↔openai 왕복 변환해 변환 로직 재구현 0. 표면: **CC 주**(OpenAI와 반대) + 에이전트 툴·encrypted reasoning·stateful 트리거 시 responses 강제 + store:false
- **오버라이드 14지점 반영**: 평면 에러 포맷(`{"code","error"}`) 이중 파서 + 400 인증 오류 휴리스틱 + 410 폐기 안내, 미지원 파라미터 strip(store/metadata/audio 등 — xAI는 무시가 아니라 400 거부), reasoning 모델 penalty/stop 게이트(레지스트리 공급 — base의 stop도 게이트 편입), `reasoning_content`(CC 응답·스트림 → reasoning 블록 — base 공용 지점 확장), `end_turn`→stop, metadata.userId→`user`, `x-grok-conv-id` 캐시 헤더
- 레지스트리 grok 라우팅(4.6=xhigh 지원, non-reasoning 예외), 캡처 케이스 12종, 골든셋 ① 스냅샷 + conformance 양표면. 테스트 306개
- **실 녹화 완료** (2026-08-21 — 12케이스, 총 ≈$0.021): 골든셋 ② 자동 편입(스냅샷 12). 게이트 판정 3확인(인증 400·penalty 400·Live Search 410)·**1반증(store: 400 거부 → 200 묵살 드리프트** — strip 근거를 ADR-0004 정책으로 이전, 무과금 게이트는 3종으로). xAI id 4형(접두사_UUID·bare UUID·call-UUID-n·서버툴 복합) 실측 → 잔류 검출기(F9-r3)가 경고로 잡아 새니타이저 UUID 패턴 확장. 상세는 [problem log](problems/problem-log.md). 테스트 323개
- **실 E2E 스모크 통과** (`pnpm smoke:xai`, 2026-08-21 — ≈$0.01): CC 주 표면 비스트림·스트림 완주(seq 단조), CC reasoning 블록 수신(B2-6), **표면 스위칭 실증**(PO include → responses 강제 + 히스토리 opaqueState → responses 유지, encrypted reasoning 왕복), **크로스 프로바이더 대화**(claude 1턴 → grok 2턴, 내용 연속성 — 목표 2의 xai 방향), compat CC→grok. **로드맵 5의 xAI 완료**
- **잔여**: Batches/Files 부록 (b)·운영 평면은 로드맵 5 후속

### 2026-08-21 — 로드맵 5 계속: Gemini 어댑터 (generateContent — 코드 완료, 실 녹화 대기)

- **Gemini 어댑터** (`src/adapters/gemini/`, ADR-0003): provider `google`, v1 단일 표면 `generate-content` — native 순수 변환 어댑터(anthropic 패턴). 스트림은 `?alt=sse` 경로 강제(프레이밍 이중성 함정 #1), wire 검증·결정론 직렬화·conformance 상속
- **인벤토리 함정 14개 대응**: ① thoughtSignature 왕복 — 모든 part의 서명을 opaqueState로, 재전송 시 원문 복원 + **서명 없는 크로스 히스토리 functionCall에 공식 더미 삽입**(D6-9, `signature-synthesized` warning) ② functionCall id 미발급 → §13.2 결정론 합성(`synth:google:{scope}:{i}:{name}`), 재전송 시 id 드롭+name·순서 매칭 ③ **HTTP 200 soft-block**(promptFeedback.blockReason) → IRError 승격(§12 — shared 어댑터 예외에 오버라이드 슬롯 신설) ④ system role 부재 → 선두는 systemInstruction·중간은 user 변환(D6-4) ⑤ finishReason 개방형 + STOP&툴콜→tool_call 승격 ⑥ usage: thoughts 별도 합산·cached⊂prompt(§8 표) ⑦ 스트림 종료 이벤트 부재 → finish를 onStreamEnd에서 적재 + 절단 터미널 보장 ⑧ grounding TOS — 원문 PM 무수정 보존 + 표준 Citation·source 블록 병행 ⑨ executableCode/Result는 custom 블록 무변경 라운드트립(§15) ⑩ 429 분당/일일 구분 + RetryInfo에서 retryAfter 추출(Retry-After 헤더 부재)
- 레지스트리 gemini 라우팅(3.x thinkingLevel effort 집합, 3.1-pro는 minimal 제외, 2.5는 effort 드롭+warning — thinkingBudget은 PO 경유), 캡처 케이스 11종(무과금 게이트 3 — thinkingLevel+Budget 동시 400·인증·404 실측 포함), 골든셋 ① 스냅샷 16 + 스트림 상태 머신 단위 테스트 7. 테스트 355개
- **실 녹화 완료** (2026-08-21 — 11케이스, 총 ≈$0.005): 골든셋 ② 자동 편입(스냅샷 11) — thought part+서명 왕복·grounding(Citation·source·PM)·STOP→tool_call 승격·google.rpc 에러 3형 실증. 게이트 판정 3확인(thinking 충돌 400·인증 400·미지 모델 404 — 드리프트 없음). **functionCall id 발급 드리프트 검출**(인벤토리 D-5 반증 — `call_` 접두 id 발급 시작, 어댑터는 wire id 우선이라 무수정·합성은 방어로 강등) + responseId 새니타이저 키 스코프 앵커 신설. 상세는 [problem log](problems/problem-log.md). 테스트 367개
- **크로스 왕복 골든셋 + 실 E2E 스모크 통과** (2026-08-21): 골든셋 ④ 3방향 편입 — gemini 실픽스처→anthropic(drop·demote), anthropic 실픽스처→gemini(**D6-9 더미 서명 삽입 검증**), 동일 타깃 재전송(서명 바이트 복원 + id 드롭·name 매칭). `pnpm smoke:gemini` 6단계 1차 통과 (≈$0.01) — 비스트림·스트림 완주·thinking(thoughts 토큰 분리 집계)·**툴콜 thoughtSignature 왕복 실서명 검증 통과**(MISSING_THOUGHT_SIGNATURE 방어 실증)·크로스 프로바이더(claude→gemini 연속성 — 목표 2)·compat CC→gemini. **로드맵 5의 Gemini 완료** — 테스트 375개
- **리뷰 라운드(10앵글×검증 6·스윕) + CONFIRMED 15건 전건 수정** (2026-08-21): 스트림/비스트림 비대칭(compat 툴콜 인자 공백·유령 빈 블록·fileData/urlContext 유실·soft-block 판정·billed 3원 모순), 서명 보존 3건(병합 last-wins·미디어 part·무서명 google-origin 복원), D5 계약(strictParameters 배선·effort 'none' 경계·file 메타 보고), 인프라(retarget google 서버 상태·레거시 effort 안전값·PO surface·AIza 새니타이저·200 에러 body 승격·proto3 엣지). 실서명 스모크 assert 승격 + 재통과. 테스트 384개. 상세는 [problem log](problems/problem-log.md)
- **잔여**: ~~Batches/Files 부록 (b)~~·운영 평면은 로드맵 5 후속. 4사 어댑터(Anthropic·OpenAI·xAI·Gemini) 전부 골든셋 4종 + 실 스모크 이중 안전망 성립

### 2026-08-21 — 로드맵 5 계속: 부록 (b) + count_tokens·Files·Batches 브리지

- **[부록 (b)](specs/appendix-b-endpoints-async.md) 작성** (ir-v0 §16-2(b) 필수 요구사항 전 항목): count_tokens/Files/Batches 프록시 envelope, 잡 상태 정규화 표(4사), v1 결정 — **배치 = 단일 프로바이더**(크로스 fan-out 2차), customId 유일 키(순서 무보장), 부분 취소 의미론, `:batch` SKU 세그먼트, 비동기 핸들(deferred/background)은 배치 잡 모델 공유로 정의만
- **count_tokens** (`POST /v0/count-tokens`): 어댑터 옵셔널 계약 — anthropic(count_tokens)·google(:countTokens generateContentRequest) 구현 + 동기 변환 재사용, openai·xai는 명시적 501 (조용한 추정 금지 D5). 무과금 실 녹화 2케이스 → 골든셋 편입, known-fields count 형태 등재
- **Files 브리지** (`/v0/files`): gwf_ 매핑(FileStore — 인메모리/Postgres DDL), anthropic(beta 멀티파트)·openai(purpose)·google(resumable 2단계) 업로드/삭제 대행, xai 501. **IR `refs.gateway` 치환 훅** — 타깃 검증 후 프로바이더 id로, 불일치는 D6-8 명시적 400
- **Batches 브리지** (`/v0/batches` + get/results/cancel/list): 항목 wire는 **어댑터 순수 변환 재사용**, 잡 수명·custom_id 매핑·상태 정규화만 브리지 소유(BatchStore). anthropic(JSON+JSONL results)·openai(파일 기반)·google(batchGenerateContent 인라인)·xai(요청 등록형) 4색 wire 테이블. 결과 수확 시 원장 항목별 1회 적재
- **실 E2E 스모크 통과** (`pnpm smoke:appendix-b`): count 2사 실측(claude 14·gemini 8토큰)+501, **anthropic 파일 업로드→조회→삭제 실검증**, **anthropic 1항목 배치가 60초 내 실 완료 — 폴링 12회·결과 정규화(IR message·usage 17토큰)까지 전 수명주기 실검증**. 테스트 403개
- **잔여 좌석**: openai/google/xai 배치 wire는 mock 검증만(실 녹화 대기 — google·xai는 인벤토리 기반 가정), xai Files 501, 비동기 핸들 통합 표면(2차)

### 2026-08-21 — 로드맵 5 계속: 커버리지 매트릭스 CI + 가격표 승격 + 운영 평면 계획

- **커버리지 매트릭스 CI** (ADR-0001 D10 "체크리스트×어댑터" — 커버리지 문서 §8-4의 기계 검증 실현): [기준 문서](research/2026-08-20-anthropic-api-coverage.md)의 표 전 행(8표 78행)을 파싱해 ① 전 행 커버리지 분류 존재 ② **"미결" 0건 유지**(신규 미결 = CI 실패 = 결정 라운드 강제) ③ 섹션별 행수 스냅샷(체크리스트 증감 강제 리뷰) ④ EP v1 확정 항목(count_tokens·Batches·Files)의 구현체 존재를 검증
- **가격표 승격**: 캡처 하네스 소유였던 단가표를 [gateway/pricing.ts](../src/gateway/pricing.ts)로 이동 (ADR-0007 §2 "레지스트리 가격표" 좌석 — billing 엔진·캡처 비용 가드 공용, 캐시 배수 포함). 테스트 408개
- **[운영 평면 실행 계획](plan/ops-plane.md)** 작성 — 작업 분해 6단계(가상 키→라인아이템→예산→정산→리소스 레지스트리→본문 로그) + **사용자 결정 3건**(관리 API 인증·BYO 키 저장·본문 로깅 기본값)

### 2026-08-21 — 로드맵 5 완결: 운영 평면 구현 (결정 3건 확정)

- **결정**: D1 관리 API = `GATEWAY_ADMIN_KEY` 마스터 키(상수 시간 비교) / D2 BYO 프로바이더 키 = **DB 암호화 저장**(AES-256-GCM + env 마스터 키 — 권고안 대신 사용자 선택, KMS 2차) / D3 본문 로깅 = ADR-0008대로 기본 on
- **가상 키·테넌트**: `gwk_` 발급(시크릿 1회 노출·해시만 저장)/폐기 관리 API, `/v0/*` Bearer 인증 미들웨어(keys 미설정 = 개방 모드 — 로컬·스모크 호환), 원장에 tenant·keyId·keySource(BYO/풀)·costUsd 병기. **BYO 자격증명 결정자** — 테넌트 키 우선, env 풀 키 폴백(ADR-0001 하이브리드), Files/Batches 테넌트 축 개통
- **billing·예산·정산**: 응답 envelope `billing` 라인아이템(0수량 제외·`:batch` SKU 50% 근사 — 스트림은 finish에), 지출 트래커를 **원장 데코레이터**로 배선(코어 무수정), soft warning(`budget-soft-warning`)/hard 402(`budget_exceeded`, §10.4 다음 요청 차단), `GET /v0/admin/usage-report`(model|provider|keyId|tenant 집계, JSON/CSV, 멱등)
- **서버 상태 레지스트리** (ADR-0006 §3): 인바운드 PO 참조 검증(테넌트 격리 404·미등록 기본 거부·opt-in 통과+`server-state-unmanaged`), 응답 등록(openai/xai는 store 옵트인 시, anthropic container), TTL 스윕 관리 API(삭제 API 대행 + 참조 차단 대체)
- **본문 로그** (ADR-0008): sink 인터페이스(Postgres/인메모리), groundingMetadata TOS 제외(제거 사실 표기), 키 단위 opt-out. Postgres 스토어 7종 DDL 자동. 테스트 421개 + 실 스모크 재통과(개방 모드 경로 무회귀 — 배치 취소 경로까지 실검증)
- **잔여 좌석**: compat 인증·스트림 응답 본문로그·스트림 리소스 등록·Redis 지출 집계·TTL 스윕 자동화 ([ops-plane](plan/ops-plane.md))

### 2026-08-22 — 배치 wire 실판정: 검증 부채 해소 (google 적중·xai 확정)

- **`pnpm smoke:batches [providers]`** 신설 (비중단·전사 수집형 판정 도구) — google은 인벤토리 추정 wire가 **무수정 적중**(생성→폴링→취소 전 경로), xai는 **반증 3중첩 후 확정**(등록 = `batch_requests[].{unique_id, batch_request: 태그드 유니온}` — serde 오류가 스키마를 가르쳐줘 무과금 프로브 3회로 완료). **xai 배치 모델 게이트 발견**: grok-4.3·4.20 계열만 지원(4.6/4.5/build 400 — 레지스트리 capability 후보). openai는 키 부재로 미판정(재투입 시 즉시 가능). 상세는 [problem log](problems/problem-log.md)

### 2026-08-22 — 크로스 프로바이더 폴백 트리 v1 (ir-v0 §6.4 신설)

- **스펙 신설**: IR 요청에 `fallbackModels`(순서 = 시도 순서) — 각 타깃은 완전한 독립 시도(타깃별 재타게팅·표면 선택·어댑터 변환·같은-타깃 리트라이 소진 후 폴백). 진행 조건 = `fallbackEligible && !gatewayException && !취소`. [폴백 매트릭스](decisions/fallback-interaction-matrix.md)에 v1 행 5개 추가
- **skip 판정** (시도 없이 `attempts: skipped`): pinned passthrough 불일치(D10 보장 유지), 자격증명 해소 불가 타깃(BYO/풀 — 매트릭스 행 실현), 폴백 타깃 라우팅 불가(오타가 요청 전체를 안 죽임). 비-pinned passthrough 불일치는 드롭+`passthrough-params-dropped` 후 시도
- **스트림 (§6.4 v1 결정)**: 콘텐츠 방출 **전** 실패만 무중단 전환 — `error-partial(willRetry:true)` → `provider-switched(from,to,reason)` → 새 타깃 이벤트(stream-start 1회 유지). 방출 **후** 실패는 전환하지 않음(중복 콘텐츠 자동 재방출 = 조용한 변조 소지 — mid-stream continuation은 2차). **세션 터미널 예외**: willRetry:true는 done이 아님(2026-08-21 problem log 예고 해소)
- **회계**: 전 타깃이 같은 `req_` 공유·시도별 원장 행, `gateway.attempts`/`finish.attempts`에 skipped/failed/success 전 이력 노출. 예산은 요청당 1회 평가 유지(매트릭스). 테스트 429개 (폴백 8케이스 — 529→전환·400 즉시 반환·자격증명 skip·pinned 전멸 시 원 에러·스트림 전환/비전환·세션 예외)

## 로드맵 (2026-08-20 확정)

1. ~~IR 설계 게이트 + 운영 결정 클로즈~~ (완료) → 2. ~~IR 스키마 v0~~ (작성·검증·개정 완료 — 사용자 승인 대기) → 3. **Walking skeleton** ([실행 계획](plan/walking-skeleton.md) — native → Anthropic, stream 포함 + 골든셋 캡처 하네스 + docker-compose + 메타 로그·OTel) → 4. OpenAI 어댑터 + 재타게팅 패스 v0 + 크로스 왕복 골든셋 + **부록 (a) 선행 후** 호환 인바운드 2종 → 5. Gemini·xAI 확장 + **Batches/Files 브리지(부록 (b) 선행)** + 레지스트리·커버리지 CI + 운영 평면(가상 키·예산·정산, 서버 상태 레지스트리, 본문 로그 파이프라인)

원칙: 4사 동시 착수 금지 (2사로 인터페이스 검증 후 확장), 골든셋 하네스는 어댑터와 동시 또는 선행. v1 정의는 넓지만(정산·관리형 서버 상태 포함) 구현 순서는 코어 파이프라인 우선 — 운영 평면은 5단계에 집중.

### 2026-08-22 — 전면 코드리뷰 + 확정 15건 수정 (계층 경계 결함)

- `src`·`tools` 전체(21k LOC) 10각도 리뷰 → 확정 15건 전부 수정, 회귀 테스트 32개 추가 (430 → **462개 통과**). 결함이 세 축으로 묶였고 원인이 축마다 같았다 — *기능 추가 시 그 기능이 통과해야 할 다른 평면을 함께 배선하지 않음*. 전문: [problem log](problems/problem-log.md)
- **축 1 compat 평면**: 인증·예산이 `/v0/*`에만 걸려 있어 `/compat/*`가 **무인증으로 풀 키 실행**(귀속·예산 동시 무력화) → 미들웨어 공용화 + 인바운드 전처리(`prepareInbound`) native·compat 통합. 폴백 트리의 `error-partial{willRetry:true}`를 다운컨버터 2종이 종결로 번역해 **폴백 성공분이 유실**되던 것 → 부록 (a) §6.1/6.2 규범화 + `fallback-target-switched` 코드 신설
- **축 2 자격증명 계약**: count_tokens·Files·Batches가 `deps.credentials`를 무시하고 env 풀 키 직행 → `resolveCredentials` 단일 지점 경유. 동반 발견 — 배치 원장 행에 tenant·keyId·costUsd 누락으로 **배치 지출이 예산·정산에서 통째 누락**(할인 SKU 경로도 사문화) → 세 필드 병기 + `buildBilling(batch:true)` 배선
- **축 3 effort on/off 경계**: `'none'`(추론 비활성)은 강도 눈금이 아니라 스위치인데 gemini만 알고 있었다 — anthropic은 `'low'` 고정 클램프로 **끄기가 켜기로 반전**, openai/xai는 가드 부재. 반대 방향(`minimal`→`none`) 반전은 **골든셋 스냅샷이 정답으로 굳혀두고 있었다** → `shared.gateEffort` 단일 구현 + [ir-v0 §6.3](specs/ir-v0.md) 양방향 경계 규범
- 그 밖: 명시 표면 오버라이드 조용한 무시(D5 위반), xai 리맵이 타사 네임스페이스·opaqueState 소비(§2 위반 — 중립 라벨 밀어내기로 해소), 스트림 세션 테넌트 소유권 부재(재개·취소 격리 + 영속 키 스코프), 콘텐츠 방출 후 provider-error의 partial/final 오분류, 고아 toolCall 예외 범위 초과(크로스 왕복 골든셋도 같은 형태를 스냅샷 중이었음), 빈 system content 400, `error.param` 사문화(→ ir-v0 §12 정식 슬롯), 지출 트래커 무한 증가, 가격표 매 호출 정렬
- **[ops-plane](plan/ops-plane.md) "compat 인바운드 인증" 좌석 클로즈**. 리뷰 교훈 3가지(좌석 문구가 위험도를 감춤 · 새 이벤트 의미론의 소비자 전수 · 골든셋이 결함을 굳힘)는 problem log에 기록

### 2026-08-22 — 프로덕션 배포 심사 (오케스트레이터 타깃) + P0/P1/P2 전건 수정

- 배포 준비 관점의 전면 심사 15건 → **전부 수정**. 코어 로직이 아니라 **배포 산출물과 운영 평면이 단일 프로세스 전제**로 멈춰 있던 것이 문제였다. 테스트 483개 (운영 프로브·레이트리밋·크로스노드 취소·바디 상한 신규). 전문: [problem log](problems/problem-log.md)
- **P0 배포 가능선** — Dockerfile(멀티스테이지·비루트·exec CMD)·`.dockerignore`·`.nvmrc`·`pnpm start`·compose gateway 서비스 / `/health`·`/ready` 프로브(인증 밖) / graceful shutdown 드레인 / pg 커넥션 23→1풀 + DDL advisory lock / 전역 `onError`
  - **실제 이미지 기동 검증이 패키징 버그를 잡았다**: `@hono/node-server`가 devDependencies에 있어 `--prod` 이미지가 `ERR_MODULE_NOT_FOUND`로 기동 불가. tsc·vitest 어느 쪽도 못 잡는 종류라 CI에 `image` 잡(빌드→기동→`/health`→SIGTERM→exit 0) 신설
- **P1 다중 레플리카 정합성** — 예산 집계·요청 빈도 제한·취소 전파를 Redis 뒤로. **실 Redis로 검증**: 별도 인스턴스 2개가 집계를 공유하는지, 크로스노드 취소가 도달하는지 직접 확인. 취소의 권한 판정은 **수신 측**에서 — 메시지의 tenant는 발신자 주장이고 세션을 가진 쪽만 대조할 수 있다
- **P2 견고성** — 업스트림 타임아웃 정책 통일(`execute.dispatch`에만 있던 것을 데코레이터로 브리지 24개 호출 지점에 적용) / 바디 상한(인증보다 앞) / 본문 로그 비블로킹 + 보관 정책 / OTel SDK 실등록(이전엔 전 span no-op) / 가격표 미등재 모델의 `billing-price-estimated` warning / google·xai 드리프트 감지기 신설(4사 중 절반이 무감각했다)
- **어댑터 패턴 전수조사** 동반 수행 — 계약 6멤버·어댑터 6개(프로바이더 4사)·D4 분기문 **0건** 확인. "N+M"의 실제 비용이 어댑터 1개가 아니라 **어댑터 1개 + 등록 9곳**인데 완전성 강제 장치가 없던 것이 최대 리스크였고, **같은 날 해소**: [provider-registration.test.ts](../src/gateway/provider-registration.test.ts) 31케이스 — 누락은 실패하고 통과하려면 사유를 적어야 한다. `ModelRoute.sample` 필수화로 정규식 오류·라우트 가려짐까지 검증. 변이 3종으로 테스트가 실제로 잡는지 확인. 테스트 514개

### 2026-08-22 — 스키마 마이그레이션 버전화 (심사 #8 잔여 해소)

- `schema_migrations` 이력 + 순서 있는 append-only 목록 + **체크섬**(적용분 편집 거부) + advisory lock 직렬화. 기존 DDL 4블록을 `0001~0004` baseline으로 채택 — 전부 `IF NOT EXISTS`라 운영 중인 DB도 무해하게 흡수된다
- `pnpm migrate` / `pnpm migrate --status`(종료 코드로 판정). `MIGRATE_ON_BOOT=false`면 앱은 **검사만** 하고 미적용·드리프트 시 `/ready` 503 — 마이그레이션 주체를 Job 하나로 둘 수 있다
- **실 Postgres 검증에서 내 CLI 버그가 나왔다**: 미적용분이 0건이면 러너를 호출하지 않아 드리프트 검사가 건너뛰어졌다(정작 필요한 때가 그때다). 단위 테스트 11건은 `runMigrations`를 직접 불러서 통과했고, 버그는 "그 함수를 부르지 않는 경로"에 있었다 — 단위 테스트는 함수를, 실행은 배선을 검증한다. 테스트 525개
