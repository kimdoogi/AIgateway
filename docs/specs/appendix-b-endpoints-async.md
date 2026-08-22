# 부록 (b) — EP·비동기: count_tokens / Files / Batches 프록시 envelope + 비동기 핸들

- 상태: 초안 (2026-08-21 — ir-v0 §16-2(b)의 필수 요구사항 전 항목 커버)
- 상위 문서: [ir-v0](ir-v0.md) (동기 생성 envelope) · [ADR-0006](../decisions/ADR-0006-state-layer.md)(상태 계층·리소스 레지스트리) · [ADR-0007](../decisions/ADR-0007-billing-envelope.md)(배치 할인 SKU)
- 근거 자료: 4사 인벤토리의 Batches/Files/count_tokens/비동기 절 (research/)

## 0. 원칙

1. **브리지는 파이프라인 재사용이다**: 배치 항목·count_tokens 본문은 동기 경로와 같은 IR 요청이며, 어댑터의 같은 순수 변환(transformRequest/transformResponse)을 통과한다. 브리지가 새로 만드는 것은 잡 수명·매핑·정규화 envelope뿐.
2. 프로바이더별 wire 차이는 **데이터 테이블**(레지스트리/브리지 구성)로 — 코어 분기문 금지 (D4).
3. 미지원 기능은 조용한 대체 금지 — 명시적 501 + 어떤 프로바이더가 지원하는지 안내 (D5).

## 1. count_tokens — `POST /v0/count-tokens`

- 요청: ir-v0 §6과 동일한 IR 요청 (단 `stream`·`maxOutputTokens`는 무시 대상 — warning 없이 정의상 미적용).
- 응답 envelope: `{ version, model:{requested,resolved}, inputTokens, providerMetadata?, warnings, gateway:{requestId} }`.
- 어댑터 옵셔널 계약 `countTokens: { transformRequest, transformResponse }` — 구현 없는 프로바이더는 **501** (`category: invalid_request`, `provider.code: count-tokens-unsupported`).

| 프로바이더 | wire | 응답 매핑 |
|---|---|---|
| anthropic | `POST /v1/messages/count_tokens` (messages/system/tools/thinking — max_tokens 불필요) | `input_tokens` → inputTokens |
| google | `POST /v1beta/models/{m}:countTokens` `{generateContentRequest}` (contents 단독보다 tools·system 충실) | `totalTokens` → inputTokens, `cachedContentTokenCount`는 PM |
| openai | 공개 API 없음 | **501** (로컬 토크나이저 추정은 조용한 날조 소지 — 2차에 opt-in estimate 검토) |
| xai | 공개 API 없음 | **501** |

## 2. Files — `/v0/files` (업로드·조회·삭제)

- **게이트웨이 파일 id** `gwf_{ulid}` 발급. 매핑 레코드(Postgres — ADR-0006 §1): `{gatewayFileId, tenant, provider, providerFileId, mediaType, sizeBytes, createdAt, expiresAt?}`.
- 업로드는 **타깃 프로바이더 명시 필수** (`provider` 필드) — 파일은 모델 라우팅 대상이 아니다. 동일 파일의 다중 프로바이더 업로드는 클라이언트가 반복 호출 (v1; 자동 복제는 2차).
- **IR 연동**: file 블록 `data: { type:"reference", refs:{ gateway: "gwf_..." } }` — 정책 레이어(어댑터 진입 전)가 테넌트 검증 후 `refs`를 해당 프로바이더 id로 **치환**한다. 타깃 프로바이더에 매핑이 없으면 D6-8 규칙(명시적 4xx). 프로바이더 원 id 직접 참조(`refs.anthropic` 등)는 기존대로 허용 — 단 ADR-0006 §3(미등록 외부 id 기본 거부) 적용.
- **테넌트 격리**: 다른 테넌트의 gwf id 참조는 404 (존재 노출 금지).
- 수명: 프로바이더 TTL을 그대로 노출 + 삭제는 프로바이더 삭제 API 대행.

| 프로바이더 | wire | 비고 |
|---|---|---|
| anthropic | `POST /v1/files` (multipart, 베타 헤더 `files-api-2025-04-14` — 업로드·참조 양쪽) | file_id |
| openai | `POST /v1/files` (multipart, `purpose`) | batch 입력 파일도 이 경로 |
| google | resumable upload → Files URI | `files/{id}`, 만료 있음 |
| xai | Files API 있음 (2026 확장 — TTL·public URL) | 업로드 wire 세부 미확보 — **v1 브리지 501** (`files-unsupported`), 인벤토리 보강 후 재검토 |

## 3. Batches — `/v0/batches`

### 3.1 라우팅 결정 (v1 확정)

- **배치 = 단일 프로바이더**. 항목의 model은 전부 같은 프로바이더로 라우팅되어야 하며, 혼합 시 400. 프로바이더 내 모델 혼합은 wire가 허용하는 경우만(anthropic/openai/xai 항목별 model ✓, google은 모델이 경로에 있어 **배치당 단일 모델**).
- **크로스 프로바이더 fan-out/재집계는 2차** — v1에서 다중 프로바이더 배치는 클라이언트가 배치를 나눠 보낸다. (근거: fan-out은 부분 실패·취소·할인 SKU·정산이 프로바이더 수만큼 곱해지는데 실수요 미확인.)

### 3.2 envelope

- 생성: `POST /v0/batches` `{ version, requests: [{ customId, request: IRRequest(비스트림) }], metadata? }` → **잡 수리 응답**: `{ id: "gwb_...", status, provider, model?, counts:{total, succeeded, errored, canceled, expired}, createdAt, expiresAt?, gateway:{requestId} }`.
- 조회: `GET /v0/batches/{id}` — 같은 잡 envelope (폴링).
- 결과: `GET /v0/batches/{id}/results` — `[{ customId, response?: IR응답(§7 message·usage·finishReason), error?: IRError }]`. **순서 무보장 — customId가 유일한 매핑 키**. customId는 게이트웨이가 유일성 검증(중복 400), 프로바이더 custom_id 슬롯에 그대로 실어 왕복.
- 취소: `POST /v0/batches/{id}/cancel` — 프로바이더 취소 전파. 취소는 **비동기·부분적**일 수 있다(이미 처리된 항목은 결과에 남고 과금됨) — status `canceling`→`canceled`, 처리분은 counts.succeeded에 유지.
- 항목별 `attempts`: v1은 배치가 프로바이더 고정이라 폴백 없음 — 항목 결과에 `attempts: [{provider, model, outcome}]` 1행 (스키마는 다행 예약, ir-v0 Attempt 재사용).

### 3.3 잡 상태 정규화 (개방형 — 미지 값은 raw 보존 + `other`)

| unified | anthropic | openai | google | xai |
|---|---|---|---|---|
| `validating` | — | validating | — | (등록 단계) |
| `in_progress` | in_progress | in_progress | BATCH_STATE_RUNNING/PENDING | running |
| `finalizing` | — | finalizing | — | — |
| `completed` | ended(+전 항목 종결) | completed | SUCCEEDED | done |
| `failed` | — (항목 단위) | failed | FAILED | failed |
| `expired` | — | expired | EXPIRED | — |
| `canceling` | canceling | cancelling | — | — |
| `canceled` | ended(취소 항목) | cancelled | CANCELLED | canceled |

잡 레코드(Postgres): `{gatewayBatchId, tenant, provider, providerBatchId, status, counts, customId→항목 매핑, createdAt, ...}`. 결과는 조회 시 프로바이더에서 가져와 어댑터 transformResponse로 정규화(캐시 여부는 구현 재량 — grounding 제외 규칙 준수).

### 3.4 wire 브리지 (4사 4색 — 인벤토리 근거)

| 프로바이더 | 생성 | 결과 |
|---|---|---|
| anthropic | `POST /v1/messages/batches` `{requests:[{custom_id, params}]}` | `results_url` → JSONL 스트림 (custom_id 키) |
| openai | 파일 업로드(JSONL) → `POST /v1/batches` `{input_file_id, endpoint, completion_window:"24h"}` | `output_file_id`/`error_file_id` 다운로드 (JSONL) |
| google | `POST /v1beta/models/{m}:batchGenerateContent` (인라인 ≤20MB / JSONL) | 잡 조회 → 인라인 응답 배열 or 파일 |
| xai | `POST /v1/batches`(name) → `/{id}/requests`에 `{batch_requests:[{unique_id, batch_request:{chat_get_completion\|responses\|…: body}}]}` (태그드 유니온 — 2026-08-22 실측) | `GET /{id}/results` |

> **xai 모델 게이트 (2026-08-22 실측)**: 배치는 grok-4.3·grok-4.20 계열만 지원 — grok-4.6/4.5/grok-build-0.1은 400 "not supported for batch processing". 레지스트리 capability 등재 후보.

- 배치 항목의 wire body = **어댑터 transformRequest 결과 재사용** (표면: 각 프로바이더의 배치 지원 표면 — anthropic messages, openai는 CC 또는 responses endpoint 지정, google generateContent, xai CC). 표면 선택자 규칙 동일 적용, 단 배치 내 혼합 표면 금지(400).
- **할인 SKU**: 라인아이템 sku에 `:batch` 세그먼트 (ADR-0007 §2 — openai flex/배치 별도 토큰 풀, anthropic/google/xai 50%). 원장 행은 결과 수확 시점에 항목별 적재.

## 4. 비동기 핸들 (xAI deferred · OpenAI background) — 정의만 v1, 통합 표면은 2차

- 동기 envelope에 실려 오는 프로바이더 비동기 옵션(PO `xai.deferred`, `openai.background`)은 **프로바이더 응답 형태 그대로 PM으로 노출**하고(§2 PO 통과), 게이트웨이 폴링 표면은 제공하지 않는다(v1). 클라이언트는 providerRequestId로 프로바이더에 직접 폴링하거나 배치를 쓴다.
- 2차에 통합할 때의 모델: 위 §3.3 잡 상태 모델을 단일 항목 잡(`counts.total=1`)으로 재사용 — "잡 수리됨 + 핸들 + 폴링"의 응답 형태가 배치와 동형이 되도록 상태 enum을 공유해 설계해 뒀다.

## 5. v1 구현 순서·범위

1. count_tokens (어댑터 옵셔널 계약 + 라우트) — anthropic·google 구현, openai·xai 501
2. Files 브리지 (매핑 스토어 + 라우트 + IR reference 치환 훅)
3. Batches 브리지 (잡 스토어 + 4사 wire 테이블 + 결과 정규화)
4. 비동기 핸들 통합 표면 — **2차** (§4)

미해결/2차: 크로스 프로바이더 fan-out(§3.1), 파일 자동 복제(§2), openai count 추정(§1), 배치 결과 웹훅.
