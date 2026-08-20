# Walking Skeleton 실행 계획 (로드맵 3)

- 상태: **착수됨** (2026-08-20 승인 — API 키·원격 저장소·pnpm 확인 완료)
- 진행: ✅ 1단계 스캐폴딩 (pnpm 9 사용자 설치, TS strict, Vitest, docker-compose, CI workflow, CLAUDE.md — 주의: 로컬 Node v20.17, 프로덕션 타깃 22 유지) · ✅ 2단계 IR zod 스키마 (src/ir/ 14개 모듈) · ✅ 3단계 Anthropic 어댑터 (src/adapters/anthropic/ — 요청/응답 순수 변환 + D4 요청 방향 wire 검증(wire.ts), SSE 상태 머신, 에러/usage/finishReason 매핑, 공유 모듈 shared.ts. `output_config.format` wire 형태와 tool_choice none 조합은 녹화 시 검증 TODO) · ✅ **고강도 코드 리뷰 + 수정 라운드** (8앵글×검증 20회, REFUTED 0 — 리포트 10건+백로그 21건 수정, 효율 4건 보류. [백로그](../problems/review-backlog-2026-08-20.md) 참조. 테스트 51개) · 다음: 4단계 캡처 하네스 (저비용 전략 + $1 하드 캡)
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
