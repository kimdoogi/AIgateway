# Walking Skeleton 실행 계획 (로드맵 3)

- 상태: **착수됨** (2026-08-20 승인 — API 키·원격 저장소·pnpm 확인 완료)
- 진행: ✅ 1단계 스캐폴딩 (pnpm 9 사용자 설치, TS strict, Vitest, docker-compose, CI workflow, CLAUDE.md — 주의: 로컬 Node v20.17, 프로덕션 타깃 22 유지) · ✅ 2단계 IR zod 스키마 (src/ir/ 14개 모듈) · ✅ 3단계 Anthropic 어댑터 (src/adapters/anthropic/ — 요청/응답 순수 변환 + D4 요청 방향 wire 검증(wire.ts), SSE 상태 머신, 에러/usage/finishReason 매핑, 공유 모듈 shared.ts. `output_config.format` wire 형태와 tool_choice none 조합은 녹화 시 검증 TODO) · ✅ **고강도 코드 리뷰 + 수정 라운드** (8앵글×검증 20회, REFUTED 0 — 리포트 10건+백로그 21건 수정, 효율 4건 보류. [백로그](../problems/review-backlog-2026-08-20.md) 참조. 테스트 51개) · ✅ 4단계 캡처 하네스 구축 (2026-08-21 — `tools/capture/`: 케이스 27종(무과금 게이트 6·manual 3 포함), 새니타이저(키 흔적 제거 + id 결정론 치환, signature 보존), SSE 파서 `src/stream/sse.ts`, 재생 유틸, 미지 필드 검출기 `known-fields.ts`(D10-5), 콜별 비용 누적 + $1.00 하드 캡. 실행 `pnpm capture`. 테스트 61개) · ✅ **실 녹화 완료** (2026-08-21 — 24케이스, 총 ≈$0.10. 캐시 write/read 4402토큰 히트 확인, 병렬 툴콜 2건, thinking signature, interleaved, adaptive(thinking_tokens 61), citations char_location, 게이트 400×4·404·401. 신선도 장치가 미지 필드 2건 검출(`tool_use.caller`, `usage.output_tokens_details`) → problem log 기록 + known-fields 등재. manual 3종(429·529·절단)은 기회 채집 대기) · ✅ 5단계 골든셋 테스트 (2026-08-21 — ① IR→wire 스냅샷 15케이스 `goldenset.request.test.ts`, ② 픽스처 자동발견 재생 24케이스 `goldenset.response.test.ts`(200 비스트림→transformResponse, 스트림→SSE 재생, 에러→mapHttpError), 바이트 결정론 양방향, conformance 공유 suite `adapter-conformance.ts`(후속 어댑터 상속용 — 순수성·결정론·터미널 보장·IRError 형태). 스냅샷 39개, 테스트 108개) · ✅ 6단계 native 인바운드 + 서버 (2026-08-21 — `src/gateway/`: registry(모델 라우팅 v0 데이터 테이블 + capability 힌트), execute(비스트림 envelope 조립 + 스트림 draft enrich·seq 부여·터미널 보장), session(재개 버퍼·grace 30s·명시적 취소 즉시·백프레셔 8MB·TTL 종료후 5분), bootstrap(조립 루트 — 코어 무분기 유지). `src/server/`: Hono — POST /v0/responses(IR envelope, SSE id:=seq), GET /v0/streams/:id(Last-Event-ID 재개, 만료 410), POST /v0/streams/:id/cancel(D7). heartbeat 15s. E2E 테스트는 픽스처 mock fetch(D9) — 재개·취소·터미널 검증. 실행 `pnpm dev`. 테스트 117개. 인메모리 세션 스토어 — Redis 교체는 7단계) · ✅ **고강도 코드 리뷰 2라운드 + 전건 수정** (2026-08-21 — 8앵글 파인더, 보고 10건(CONFIRMED 9)+하위 후보 전부 처리: **seq 단일 발급자화**(session.append 재스탬프 — heartbeat 충돌·재개 유실 해소), 펌프 catch(터미널 보장), PRICING 접두 매칭(캡 5배 과대계상), 픽스처 날짜 정렬, read() abort 리스너 누수, heartbeatSeconds 존중(D5), 새니타이저 밑줄 포함+요청 우선, Last-Event-ID 십진 검증, 증분 SSE 파서 `parseSSEStream` 신설(CR 계열 경계·CRLF 백트래킹 오인 수정·분할 조합 전수 테스트·O(n²) 제거·execute 복붙 루프 해소), transformResponse 예외 IRError 매핑, onStreamEnd 멱등화+conformance 보강, 직렬화 1회화+byteLength 캡, loadDotenv/오류 헬퍼/requestId/테스트 파서 중복 제거. 테스트 123개) · ✅ **리뷰 3라운드(xhigh, 파인더 10+스윕) + 15건 전건 수정** (2026-08-21 — 구조: executeStream이 **seq 없는 draft** 방출로 전환(세션이 유일 스탬퍼, 키 순서 canonical type·seq 선두 — D10), **startStreamSession** 게이트웨이 추출(펌프·heartbeat·터미널 보장 — compat 인바운드 재사용 지점), cancel은 abort만 하고 터미널은 펌프가 회계와 함께 적재 + end() 방어 터미널. abort 계열은 error-partial(ADR-0005), dispatch catch GatewayError 언랩, 200 body 읽기 실패 비삼킴, onStreamEnd try 내부, heartbeatSeconds 3600s 클램프+warning, 백프레셔 billed:true, Last-Event-ID safeInteger, IRError 조립 gateway/errors.ts 단일화, TERMINAL 상수 재사용, 새니타이저 JSON 문자열 앵커링+자리표시자 보호, known-fields delta 내부 키 스캔, BOUNDARY 호출별 인스턴스, onStreamEnd 멱등 계약 문서화. 테스트 126개 — 백프레셔·방어 터미널·취소 후 재개 터미널·키 순서 회귀 포함) · ✅ **리뷰 4라운드(xhigh) + 15건·하위 전건 수정 + 스펙 소급 문서화** (2026-08-21 — abort 3계열(cancel/grace/backpressure) 전부 abort-only + abortReason, 터미널은 펌프가 어댑터 회계(usage/billed)와 함께 적재(대칭 하비스트·자체 방어), 비스트림 dispatch 가드(스트림과 동일 분류), 클램프 warning을 stream-start.warnings로(§10.1), gatewayException 기본 false(내부 결함에만), providerError 헬퍼, AdapterEventDraft 개명, 새니타이저 번호 충돌 해소+잔류 id 검출기, 캡처 검증-후-쓰기(고아 방지)+mtime 타이브레이크, 픽스처 잔재 정리, conformance draft seq 검증, known-fields stop 이벤트, grace 경로 테스트. **ir-v0 §6·§10.4 패치 + problem log**(heartbeat 상한·abort 회계·410 통합·willRetry 지뢰·Redis 좌석 예고). 테스트 130개) · ✅ 7단계 정책+상태+관측성 (2026-08-21 — `src/policy/retry.ts`(Retry-After 존중·백오프·상한 초과 즉시 포기, 적격: rate_limit/overloaded/provider_error/timeout·시도별 원장 행), `src/state/`(UsageLedger·SessionPersistence 인터페이스 + 인메모리/PostgresLedger(DDL 자동)/RedisSessionPersistence(write-through, 재시작 후 재생 전용)), `src/gateway/observability.ts`(메타 로그 JSON 1행 — 본문 없음 + OTel API span 선배선 — SDK 미등록 시 no-op, ADR-0008), 세션 영속화 훅 + 서버 재시작 후 Redis 재개 폴백. 주의: 로컬 homebrew PG/Redis가 5432/6379 선점 → compose 포트 5433/6380 이동. 테스트 137개) · ✅ 8단계 E2E 스모크 (실 Anthropic — 비스트림 stop·15토큰 + 스트림 8이벤트 완주, Postgres 원장 1행·Redis 버퍼 키·프로세스 재시작 후 Last-Event-ID 재개 전부 실검증. **DoD 6항목 전부 충족**) — walking skeleton **완료** · ✅ **리뷰 5라운드(xhigh) + 15건·하위 전건 수정** (2026-08-21 — pg Pool error 리스너, 거부 프라미스 캐시 리셋, persistTail 직렬화(터미널 TTL 경합 해소), append 실패 시 버퍼 무효화, 200-후 실패 billed 원장 행, attempt 전 경로 전파, gateway.attempts/finish.attempts 구현, 접속 타임아웃 120s(category timeout), 콘텐츠 유무 기반 partial/final 판정, 재개 폴백 400/빈 재생/방어 터미널, 백오프 클램프, rowBase 통합, 스트림 span+TTFT+warnings 메타 배선, expire 주기화, SIGTERM. 매트릭스 리트라이 행 + problem log 갱신(항목① stale 수정) + ir-v0 백프레셔 문구 정정. 테스트 144개, 실 스택 재검증). 다음: 로드맵 4 (OpenAI 어댑터 + 재타게팅 + compat 인바운드)
- 목표: **"native 인바운드 → Anthropic 아웃바운드" 한 줄기가 스트리밍 포함으로 끝까지 동작하고, 골든셋 하네스로 검증되는 최소 시스템.** 기능 완성이 아니라 어댑터 인터페이스(D4)·IR 스키마·테스트 인프라의 **실물 검증**이 목적이다.
- 선행 조건: [IR v0](../specs/ir-v0.md) 사용자 승인 (E2E·정합성 검증 반영 완료 상태)

## 작업 분해 (순서 = 의존 순서)

### 1. 저장소 스캐폴딩
- TypeScript 프로젝트: Node 22, `tsconfig` strict, **pnpm**(제안), Vitest, ESLint+Prettier. v0는 **단일 패키지** (어댑터 증가 시 워크스페이스 분리 — 조기 모노레포는 YAGNI).
- 디렉토리: `src/ir/`(스키마·유틸), `src/adapters/anthropic/`, `src/inbound/native/`, `src/policy/`, `src/state/`(스토리지 인터페이스), `src/server/`(Hono), `fixtures/`, `tools/`(캡처 하네스).
- docker-compose: Postgres + Redis (ADR-0006). CI: typecheck + test (GitHub Actions 또는 로컬 스크립트 — 원격 저장소 결정은 사용자에게 확인).

### 2. IR 스키마 구현
- [ir-v0](../specs/ir-v0.md) → zod 스키마. **문서가 원본** — 불일치 시 문서 우선, 발견 즉시 문서 수정과 동기화.
- 직렬화 결정론 유틸 (키 순서·생략 규칙 — §1) + **"동일 IR → 바이트 동일 JSON" 테스트** (D10).
- 히스토리 편입 유틸 (`providerMetadata` → `providerOptions` 복사 — §13.1).

### 3. Anthropic 아웃바운드 어댑터 (D4 계약의 첫 구현)
- `wire.ts`: Anthropic 요청/응답/SSE 이벤트 zod 스키마.
- `request.ts` / `response.ts`: IR ↔ wire 순수 함수. system 배치, cache_control(PO), thinking↔reasoning+opaqueState, 툴, 문서/이미지.
- `stream.ts`: SSE 프레이밍 + 상태 머신 → IR 이벤트 (블록 index→id, tool 재번호, signature_delta→opaqueState-only delta, first-chunk 프로브로 in-stream overloaded→529 승격).
- `errors.ts`: 에러/finishReason/usage 매핑 (§8 공식, §9, §12 — rate_limit vs quota 구분 포함).
- `options.ts`: `providerOptions.anthropic` zod 스키마 (커버리지 체크리스트 §2의 PO 항목).
- **코어에 `if (provider === ...)` 금지 검증**: 어댑터 등록이 인터페이스만으로 되는지 이 단계에서 확인.

### 4. 골든셋 캡처 하네스 (어댑터와 동시 — DoD 소급 방지)
- `tools/capture/`: 실 API 녹화 스크립트 (→ `*.json` + `*.chunks.txt`), **새니타이저**(org/request id·키 흔적 제거), 픽스처 명명 규약(`{기능}.{모델스냅샷}.{녹화일}` — 신선도 장치 D10-5의 전제).
- **저비용 녹화 전략 (2026-08-20 확정 — 목표 $1 이하, 예상 $0.3~0.5)**:
  - 기본 녹화 모델 = **Haiku 4.5** (wire 포맷은 프로바이더 내 모델 불문 동일 — 골든셋은 품질이 아니라 포맷 검증)
  - 5세대 전용 wire가 다른 픽스처(adaptive thinking 등)만 **Sonnet 4.6** 소량
  - 모델 게이트 픽스처(400 거부류)는 **무과금** — 적극 수집
  - max_tokens 100~300 캡(장문 스트림도 2K), 프롬프트 최소화
  - **하네스에 비용 가드 내장**: 콜별 usage×단가 누적 출력 + **$1.00 하드 캡 자동 중단**
  - Opus 5 고유 표면(refusal stop_details 등)은 합성 픽스처 + 실전 채집으로 보완 (한계 명시)
- 초기 픽스처 세트 (Anthropic): 텍스트 / 툴콜(병렬 포함) / thinking(+signature, interleaved) / 캐싱 / 멀티모달 입력(이미지·PDF) / citations / 에러(400 게이트류·429·529·in-stream overloaded) / 스트림.
- 재생 유틸 + 픽스처 재녹화 시 미지 필드 검출 경고 (D10-5).

### 5. 골든셋 테스트 (4종 중 1·2번 + 결정론)
- ① IR 입력 → wire body 스냅샷, ② SSE 픽스처 재생 → IR 이벤트 배열 스냅샷 (D9).
- 바이트 결정론 테스트, conformance 시나리오 뼈대 (후속 어댑터가 상속할 공유 suite — LiteLLM BaseLLMChatTest 패턴).

### 6. native 인바운드 + 서버
- Hono: `POST /v0/responses`(가칭 — IR envelope 그대로), SSE 스트리밍 (`id:` = seq).
- 재개: Redis 버퍼(TTL 5분) + `Last-Event-ID` + grace window 30초 (ADR-0005). heartbeat 15초.
- 취소 전파: 명시적 abort 즉시 / 비정상 단선 grace (폴백 경합 매트릭스).

### 7. 최소 정책 레이어 + 상태 계층
- 단일 target 실행 + 리트라이(Retry-After 존중, 총 상한). 폴백 트리는 로드맵 4에서 (두 번째 프로바이더가 있어야 의미).
- 스토리지 인터페이스 + 구현체: Postgres(usage 원장 append-only), Redis(재개 버퍼), 인메모리(테스트용) — ADR-0006.
- 메타데이터 로그 + OTel 계측 (ADR-0008 — "나중에 붙이면 계측 공백"이므로 skeleton부터).

### 8. E2E 스모크
- docker-compose 위에서 실 Anthropic 1건 (non-stream + stream) — **옵트인** (CI 기본은 픽스처만, import 시 네트워크 의존 금지 — D9).

## 완성 정의 (DoD)

1. native로 들어온 요청이 Anthropic을 거쳐 스트리밍으로 완주한다 (터미널 이벤트 계약 포함).
2. Anthropic 커버리지 체크리스트의 v1 핵심(텍스트·툴·thinking·캐싱·멀티모달 입력·에러)이 골든셋 ①②로 검증된다.
3. 바이트 결정론 테스트 통과.
4. 코어에 프로바이더 분기문 0건 (grep 검증).
5. usage 원장에 요청당 1행 이상 기록, 메타 로그·트레이스 생성.
6. 문서 갱신: 구현 중 발견된 스펙 결함은 ir-v0 수정 + problem log 기록.

## 이 단계에서 하지 않는 것 (로드맵 4~5로 명시 연기)

폴백 트리 실행(단일 target만) · 재타게팅 패스(두 번째 프로바이더 필요) · compat 인바운드(부록 (a) 선행) · 가상 키/예산/정산 · 본문 로그 파이프라인 · Batches/Files · 커버리지 매트릭스 CI · 모델 레지스트리 완전판(어댑터에 필요한 최소 항목만 하드코딩 데이터로 시작).

## 사용자 준비물 / 확인 사항

1. **Anthropic API 키** (골든셋 녹화용) — 4단계 시점까지.
2. 원격 git 저장소 사용 여부 (GitHub 등 — CI 위치 결정).
3. 패키지 매니저 pnpm 제안에 이견 여부.
