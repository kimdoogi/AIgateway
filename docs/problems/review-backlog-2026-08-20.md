# 코드 리뷰 백로그 — 2026-08-20 (walking skeleton 1~3단계 리뷰)

리뷰 방식: high effort — 파인더 8앵글 × 후보 44건 → 중복 병합 35건 → 검증 20건(개별 17 + 배치 3) → **REFUTED 0건**. 상위 10건은 리뷰 리포트로 등재(호스트 UI). 이 문서는 **리포트 상한(10)에서 잘린 검증 통과 25건**의 수정 백로그다. 수정 시 각 항목을 체크하고, 스펙 변경이 필요한 항목은 문서 먼저(CLAUDE.md 규칙).

## 정확성 (리포트 미등재 7건)

- [x] **P1** (PLAUSIBLE) tool id/name `?? ""` — strict min(1) 스키마와 충돌 + G5 결정론적 합성 미구현. providerRequestId도 빈 문자열 방출(생략이 의도). `stream.ts:99-110`, `response.ts:75-76` → 합성 id(`synth:...`) 구현 + 생략 처리
- [x] **P2** (CONFIRMED) 비스트림 응답 블록 id 미부여 — §4.0 "응답 블록에는 항상 존재" 성립 지점 없음. `response.ts:110-124` → `blk_${i}` 부여
- [x] **P3** (CONFIRMED) content_block_start의 초기 text/thinking 스냅샷 유실 (실사용 트리거 낮음 — 방어적 수정). `stream.ts:76-83` → 초기값 non-empty면 delta로 방출
- [x] **P4** (PLAUSIBLE) `toolChoice:"none"` + `parallelToolCalls:false` 조합 wire 유효성 — 문서 상충. **골든셋 녹화 시 실검증** 후 드롭+warning 여부 결정. `request.ts:228-231`
- [x] **P5** (CONFIRMED) citation 매핑 — `web_search_result_location`의 url/title 유실, source.type "document" 고정, 스트림 citations_delta가 mapCitation 미재사용 열화판. `response.ts:18-36`, `stream.ts:155-165`
- [x] **P6** (CONFIRMED) mapCitation `end ?? 0` 역전 range + `as number` 무검증 (start는 가드, end만 캐스팅하는 비대칭). `response.ts:24-30`
- [x] **P7** (CONFIRMED) mapInStreamError — 비-overloaded in-stream 에러에 500 고정 → category/httpStatus 자기모순, 미지 타입 기본 fallbackEligible:true 승격. `errors.ts:112-115`

## 고도 — 다음 어댑터 3개 추가 전 필수 (6건)

- [x] **A1** (CONFIRMED) PO 파티셔닝+opt-in 머신·`AdapterInvalidRequestError`를 `src/adapters/` 공유 모듈로 (안 하면 4벌 복붙 + 코어가 프로바이더 디렉토리 import). `options.ts`
- [x] **A2** (PLAUSIBLE) 미지원 sampling 드롭 루프 — 공유 `dropUnsupported()` 헬퍼로 (레지스트리 게이트 이관 전 중간 단계). `request.ts:238-249`
- [x] **A3** (CONFIRMED) effort 클램프 하드코딩 — RequestContext에 capability 힌트 슬롯 예약 (레지스트리 이관 경로). `request.ts:251-260`, `types.ts`
- [x] **A4** (CONFIRMED) 스트림 response-metadata의 id/created/model.requested를 draft에서 Omit → 게이트웨이 enrich (seq와 동급). StreamContext의 now/requestId 제거 가능. `stream.ts:49-67`, `types.ts`
- [x] **A5** (CONFIRMED) passthroughParams 타깃 검사·`pinned` 시맨틱 → 정책 레이어 소관으로 (어댑터는 무조건 병합만). `request.ts:281-289`
- [x] **A6** (CONFIRMED) DEFAULT_MAX_TOKENS 무경고 주입 — 주입 시 warning + 레지스트리 이관. `request.ts:14,151`

## 클린업 (8건)

- [x] **C1** (CONFIRMED) 수제 JSONValueSchema → `z.json()` / JSONObjectSchema의 불필요 z.lazy 제거 (단, E1 성능 결정과 함께 판단). `json.ts`
- [x] **C2** (CONFIRMED) warning 생성 4벌 + `code: string` 자유형 → 공유 `makeWarning(type, code: WarningCode, ...)` (stream.ts warn()의 type "compatibility" 하드코드로 tool-input-demoted가 오분류 발행 중). 4개 파일
- [x] **C3** (PLAUSIBLE) onStreamEnd 수제 IRError → errors.ts에 절단 전용 헬퍼 신설 후 수렴. `stream.ts:247-263`
- [x] **C4** (CONFIRMED) KNOWN_KEYS 수동 Set → `Object.keys(schema.shape)` 파생 + fromEntries 필터·조건부 스프레드 제거 (z.object strip 모드 활용). `options.ts`
- [x] **C5** (CONFIRMED) withCache를 providerOptions 기준으로 일반화 → 툴 루프 인라인 중복 제거. `request.ts:20-23,202-203`
- [x] **C6** (CONFIRMED) OpenBlock을 kind discriminated union으로 → non-null 단언 4개·무의미 inputAcc 초기화 제거. `stream.ts:10-18`
- [x] **C7** (CONFIRMED) WireMessage interface → type alias (`as unknown as JSONValue` 제거), tools 캐스트 삭제. `request.ts:144-147,192,215`
- [x] **C8** (CONFIRMED) canonical.ts 미사용 `toCanonical` 삭제. `canonical.ts:9-11`

## 효율 (4건 — 의도적 보류, 시점 명시)

- [ ] **E1** (CONFIRMED, 실측 18.6x) JSONValueSchema union 딥클론 → **보류**: C1에서 표준성(z.json 채택)을 우선. 게이트웨이 파이프라인 배선(핫패스 실물화) 후 non-cloning 검증기로 재평가
- [ ] **E2** (PLAUSIBLE) 툴 정의 해시 검증 캐시 → **보류**: 한계 이득 ~0.1-0.4ms/req, 파이프라인 구현 시 재평가
- [ ] **E3** (CONFIRMED, 실측 6.3x) stringifyCanonical 재-parse → **부분 반영**: canonical.ts에 parse-1회 원칙 주석 명시. 브랜드 타입은 게이트웨이 단계에서
- [ ] **E4** (CONFIRMED) tool-call 완성본 재방출 2배 → **보류**: 스펙(ir-v0 §10.2) 계약 변경 필요 — 게이트웨이/인바운드 구현 시 opt-in화 검토 (문서 수정 + problem log 선행)

## 리포트 등재 10건 — 전건 수정 완료 (재보고됨)

R1 서버툴 왕복 400 · R2 provider-error usage 유실 · R3 message_delta input 갱신 무시 · R4 중간 system 무게이트 · R5 요청 wire 검증 부재/핵심 필드 덮어쓰기 · R6 retarget/streamOptions/metadata 조용한 무시 · R7 미지 delta 침묵 드롭 · R8 스트림 origin 미부착 · R9 빈 응답 히스토리 4xx · R10 이중 터미널

## 수정 결과 (2026-08-20)

- 리포트 10건 + 백로그 정확성 7·고도 6·클린업 8 = **31건 수정 완료**, 효율 4건은 시점 명시 보류. 테스트 35→51개(수정 검증 16개 추가), 타입체크 클린.
- 수정 중 스펙 보완 4건 선행: §13.1 빈 응답 규칙·draft enrich 계약, §10.2 미지 요소 보존·터미널 이후 무시, §5 `parameter-defaulted` 코드 (CLAUDE.md "문서 먼저" 규칙 이행).
- 신설: `src/adapters/shared.ts` (D5 공통 정책 — 에러 클래스·makeWarning(WarningCode 컴파일 강제)·PO 파티셔닝·미지원 드롭), `src/adapters/anthropic/wire.ts` (요청 방향 D4 검증), `AdapterCapabilities` 슬롯 (레지스트리 이관 경로).
