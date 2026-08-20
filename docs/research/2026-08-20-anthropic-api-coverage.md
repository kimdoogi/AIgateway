# Anthropic (Claude) API 기능 인벤토리 & 커버리지 체크리스트

- 날짜: 2026-08-20
- 목적: **"Claude API 기능 중 안 되는 것이 없어야 한다"** 요구사항(ADR-0001 D10)의 기준 문서. IR 스키마 설계의 1차 입력물이며, 어댑터 완성 시 이 문서의 전 항목이 커버리지 매트릭스에서 체크되어야 한다.
- 기준: Messages API 중심, 2026-08 시점 공식 레퍼런스 기준. API가 진화하므로 이 문서는 살아있는 문서다 — 신기능 발견 시 즉시 추가.

## 범례 — 커버리지 방식 분류

| 분류 | 의미 |
|---|---|
| **IR 표준** | canonical IR의 1급 필드/블록으로 표현 (2개 이상 프로바이더 공유 개념) |
| **PO** | `providerOptions.anthropic` / `providerMetadata.anthropic` 네임스페이스로 노출 |
| **PT** | anthropic-compat 인바운드 → anthropic 아웃바운드 보존 passthrough로 커버 (IR 경유 시에도 손실 금지) |
| **EP** | Messages 외 별도 엔드포인트 — 게이트웨이 라우팅 대상 |
| **정책** | 게이트웨이 정책 레이어와 상호작용 (캐시 키, 과금, 라우팅 등) |
| **미결** | v1 포함 여부 결정 필요 |

## 1. 엔드포인트 표면

| 엔드포인트 | 내용 | 커버리지 |
|---|---|---|
| `POST /v1/messages` | 핵심. 모든 생성 기능이 이 단일 엔드포인트의 기능 | IR 표준 |
| `POST /v1/messages/count_tokens` | 토큰 카운팅 | EP (v1 포함 권장 — 클라이언트 컨텍스트 관리에 필수) |
| `POST /v1/messages/batches` + retrieve/results/list/cancel | Message Batches (50% 비용, 비동기) | EP·**v1 확정** (§10-1. 결과 스트림은 `custom_id` 키, 순서 무보장) |
| `POST /v1/files` (beta `files-api-2025-04-14`) | Files API — file_id로 문서/이미지 참조. 업로드와 참조 요청 양쪽에 베타 헤더 필요 | EP·**v1 확정** (§10-2. file_id 참조 블록은 IR file 블록의 `reference` variant로 표현) |
| `GET /v1/models`, `/v1/models/{id}` | 모델 목록/조회 — `max_input_tokens`, `max_tokens`, `capabilities` 필드 제공 | EP + **정책** (우리 모델 레지스트리의 갱신 소스로 활용 가능) |
| `/v1/skills` (beta `skills-2025-10-02`) | Agent Skills 관리 | **2차** (§10-3) |
| Managed Agents (`/v1/agents`, sessions, environments, vaults, deployments...) (beta `managed-agents-2026-04-01`) | 별도 서피스 — 서버 관리 에이전트 | **2차** (§10-3 — 필요 시 raw passthrough만) |

## 2. `POST /v1/messages` 요청 파라미터 전수

| 파라미터 | 내용 | 커버리지 |
|---|---|---|
| `model` | 모델 ID | IR 표준 |
| `max_tokens` | 필수. 최신 모델 128K까지 (SDK는 대형 값에 스트리밍 요구) | IR 표준 |
| `messages[]` | role: user/assistant + **mid-conversation `system`** (Opus 5/4.8/Fable 5 — 캐시 프리픽스 보존용 운영자 채널. 위치 제약: messages[0] 불가, user 뒤) | IR 표준 (mid-conv system은 IR system 메시지의 위치 보존으로 자연 커버 — D6 재타게팅 규칙에 반영) |
| `system` | top-level 시스템 프롬프트 (문자열 또는 블록 배열 + cache_control) | IR 표준 |
| `metadata.user_id` | 어뷰즈 추적용 최종 사용자 ID | IR 표준 후보 (게이트웨이 테넌시와 연동) |
| `stop_sequences` | 커스텀 중단 시퀀스 | IR 표준 |
| `stream` | SSE 스트리밍 | IR 표준 |
| `temperature` / `top_p` / `top_k` | 구모델용. **Fable 5/Opus 5/4.8/4.7/Sonnet 5에서는 제거되어 400** | IR 표준 + **정책** (모델 세대별 파라미터 게이트 — §9) |
| `tools[]` / `tool_choice` | §4 참조 | IR 표준 |
| `thinking` | `{type: "adaptive"}` (4.6+) / `{type: "enabled", budget_tokens}` (구모델) / `{type: "disabled"}` + `display: "summarized" \| "omitted"` (5세대 기본 omitted) | IR 표준(reasoning on/off/effort) + PO(display, adaptive/budget 세부) |
| `output_config.effort` | `low/medium/high/xhigh/max` — GA | IR 표준 (OpenAI reasoning effort와 공유 개념 → 승격 조건 충족) |
| `output_config.format` | Structured outputs (구 `output_format` deprecated) | IR 표준 (citations와 동시 사용 시 400 — 제약도 기록) |
| `output_config.task_budget` (beta `task-budgets-2026-03-13`) | 에이전틱 루프용 advisory 토큰 예산 (`{type:"tokens", total, remaining?}`, 최소 20K) | PO |
| `context_management.edits` (beta `context-management-2025-06-27`) | `clear_tool_uses_20250919` / `clear_thinking_20251015` — 히스토리 삭제 (compaction 아님) | PO |
| compaction (beta `compact-2026-01-12`) | 서버측 자동 요약. **응답의 compaction 블록을 다음 요청에 반드시 재전송** — 텍스트만 추출하면 상태 소실 | PO + IR에 compaction 블록 수납 필요 (라운드트립 계약) |
| `mcp_servers[]` + `tools[{type:"mcp_toolset"}]` (beta `mcp-client-2025-11-20`) | MCP 커넥터 — 둘 다 있어야 유효 | PO (검증 규칙 포함) |
| `container` | 코드 실행 컨테이너 재사용 / Agent Skills (`{skills:[...]}`, betas `code-execution-2025-08-25`+`skills-2025-10-02`) | PO + **정책** (서버 상태 수명 결정: 게이트웨이 관리형 — ADR-0006 §3) |
| `speed: "fast"` (beta `fast-mode-2026-02-01`) | Fast mode — Opus 5/4.8 한정, 별도 단가·별도 rate limit, **캐시 무효화 주의** | PO + **정책** (과금 단가 분기, 캐시 키에 speed 포함) |
| `fallbacks` (beta `server-side-fallback-2026-07-01`) | refusal 시 서버측 모델 폴백 (`"default"` 또는 배열) | PO + **정책** (결정: 게이트웨이 트리 기본, 서버측은 opt-in + 위임 마킹 — ADR-0005 §3) |
| `inference_geo` | 추론 지역 지정 (top-level; usage에 실제 지역 리포트) | PO + **정책** (데이터 주권 — 국내 기업 대상이면 중요) |
| `service_tier` | Priority Tier (Opus 5/Sonnet 5/Fable 5 제외 모델) | PO + 정책 |
| `cache_control` (top-level) | 자동 캐싱 (breakpoint 자동 배치) | PO (블록 단위 cache_control과 별개) |
| `diagnostics.previous_message_id` (beta `cache-diagnosis-2026-04-07`) | 캐시 진단 | PO |
| `betas[]` / `anthropic-beta` 헤더 | 베타 기능 게이팅 — 복수 지정 가능 | **PT 핵심** (§8) |
| `anthropic-version` 헤더 | API 버전 (2023-06-01) | 어댑터 소유 |
| ~~assistant prefill~~ | **5세대/4.6+에서 400** (구모델만 동작) | 정책 (§9 — 모델 게이트) |

## 3. 콘텐츠 블록 전수

### 요청 방향 (user/assistant 콘텐츠)

| 블록 | 세부 | 커버리지 |
|---|---|---|
| `text` | + `cache_control`, + `citations` 설정 | IR 표준 |
| `image` | source: `base64` / `url` / `file` (file_id) | IR 표준 (file 블록 tagged union: data/url/reference) |
| `document` | source: base64 PDF / plain text / URL / file_id / custom content. + `title`, `context`, `citations: {enabled}` (전부 켜거나 전부 끄기). 한도: 요청 32MB, PDF 600p (200K 모델은 100p) | IR 표준 |
| `search_result` | RAG용 검색 결과 블록 (source, title, content + citations) | IR 표준 후보 / PO |
| `tool_use` (재전송) | 히스토리 내 어시스턴트 툴콜 | IR 표준 |
| `tool_result` | `tool_use_id`, `is_error`, content: text/image 블록 배열 (**멀티모달 툴 결과**) | IR 표준 |
| `thinking` / `redacted_thinking` (재전송) | **signature 검증됨** — 같은 모델 계속 시 무변경 재전송, 타 모델은 드롭. 5세대: display omitted면 빈 텍스트 + 서명만 | IR reasoning 블록 + PO(signature/redactedData) — **재타게팅 패스 핵심 대상** |
| server tool 결과 블록 (재전송) | `server_tool_use`, `web_search_tool_result` 등 히스토리 재전송 | IR 표준(server tool activity) + PT |
| compaction 블록 (재전송) | beta — 무변경 재전송 필수 | PO + 라운드트립 계약 |

### 응답 방향

| 블록/필드 | 세부 | 커버리지 |
|---|---|---|
| `text` + `citations[]` | citation 타입: `char_location` / `page_location`(1-indexed) / `content_block_location`, `cited_text`, `document_index`, `document_title` | IR 표준 |
| `tool_use` | id, name, input | IR 표준 |
| `thinking` (+signature) / `redacted_thinking` | display 설정에 따라 summarized/빈 문자열 | IR reasoning + PO |
| `server_tool_use` | 서버 툴 호출 표시 | IR 표준 |
| `web_search_tool_result` | 성공 시 content가 **리스트**, 에러 시 **객체**(`{error_code}`) — HTTP 200으로 옴 | IR 표준 + 어댑터 에러 승격 |
| `web_fetch_tool_result` | content가 document 블록 포함 | IR 표준 |
| `bash_code_execution_tool_result` (신) / `code_execution_tool_result` (구) | `.content.stdout/.stderr/.return_code` — **타입명이 세대별로 다름** | IR 표준 + 어댑터 매핑 |
| `tool_search_tool_result` | tool search 결과 | PO |
| `mcp_tool_use` / `mcp_tool_result` | MCP 커넥터 결과 | PO |
| compaction 블록 | 재전송 계약 | PO |
| `stop_reason` | `end_turn / max_tokens / stop_sequence / tool_use / pause_turn / refusal / model_context_window_exceeded` — **`pause_turn`은 재요청으로 계속, `refusal`은 `stop_details` 동반** | IR `{unified, raw}` — pause_turn 처리 결정: 항상 노출 (ADR-0005 §2) |
| `stop_details` | refusal 시에만: `{type, category(개방 집합: cyber/bio/…/null), explanation}` — 그 외 null | PO + **정책** (폴백 트리거) |
| `container` | 코드 실행 컨테이너 id (재사용용) | PO |

## 4. 툴 시스템 전수

### 커스텀 툴 정의 필드

| 필드 | 내용 | 커버리지 |
|---|---|---|
| `name` / `description` / `input_schema` | 기본 | IR 표준 |
| `strict: true` | 스키마 정확 검증 (`additionalProperties: false` + `required` 필요). **tool_choice가 아니라 툴 정의의 top-level 필드** | IR 표준 (OpenAI strict와 공유 개념) |
| `cache_control` | 툴 정의 캐싱 breakpoint | PO |
| `defer_loading: true` | tool search와 조합 — 전부 defer면 400 | PO |
| `input_examples` | 입력 예시 (베타 유래) | PO → IR 승격 후보 (Vercel V4에 이미 승격됨) |
| `allowed_callers: ["code_execution_20260120"]` | 프로그래매틱 툴 콜링 — 코드 실행 내부에서 커스텀 툴 호출. strict/disable_parallel/forced tool_choice/MCP와 비호환 | PO |
| `eager_input_streaming: true` | fine-grained tool 입력 스트리밍 (베타 아님) | PO |

### tool_choice

`auto` / `any` / `tool(name)` / `none` + `disable_parallel_tool_use` — IR 표준 (`auto/required/tool/none` 매핑 + 병렬 억제 플래그).

### Anthropic 정의 클라이언트 툴 (스키마 없음 — type+name만 선언)

| 툴 | type | 커버리지 |
|---|---|---|
| Bash | `bash_20250124` | PO (스키마리스 툴 선언을 IR 툴 union에 수납: `provider-defined` variant) |
| Text editor | `text_editor_20250728` | PO |
| Memory | `memory_20250818` | PO |
| Computer use | `computer_*` (세대별 버전) | PO |

### 서버 툴 (Anthropic 인프라 실행)

| 툴 | type (현행 / 구형) | 주요 파라미터 | 커버리지 |
|---|---|---|---|
| Web search | `web_search_20260209` / `web_search_20250305` | `max_uses`, `allowed_domains`/`blocked_domains`, `user_location` | IR server-tool + PO |
| Web fetch | `web_fetch_20260209` / `web_fetch_20250910` | `max_uses`, 도메인 필터, `citations`, `max_content_tokens`. 대화에 이미 있는 URL만 fetch | IR server-tool + PO |
| Code execution | `code_execution_20260521` / `code_execution_20260120` (REPL 지속+프로그래매틱) | — | PO |
| Tool search | `tool_search_tool_regex_20251119` / `tool_search_tool_bm25_20251119` | defer_loading 조합 | PO |
| Advisor | executor↔advisor 모델 페어 제약 (400), **usage `iterations` 별도 단가** | | PO + **정책** (과금 라인아이템) |

주의: `_20260209` web search/fetch는 내부적으로 code execution을 쓰므로 `code_execution`을 별도 선언하면 안 됨 — 어댑터 검증 규칙으로.

## 5. 스트리밍 이벤트 전수

`message_start` → (`content_block_start` → `content_block_delta`* → `content_block_stop`)* → `message_delta` → `message_stop`, 사이사이 `ping`, 에러 시 `error` 이벤트 (**HTTP 200 스트림 내 `overloaded_error` 포함** — 첫 청크 프로브로 529 승격).

delta 타입: `text_delta` / `input_json_delta` (partial_json) / `thinking_delta` / `signature_delta` (**텍스트 없는 서명 델타**) / `citations_delta`.

커버리지: IR 스트림 이벤트가 이 모델의 **상위집합**이어야 함 — 블록 경계(start/stop)와 index를 보존하는 id 기반 이벤트 체계 (ADR-0001 D2). `message_delta`에 실리는 누적 usage/stop_reason 위치도 계약화.

## 6. usage / 에러 모델

### usage 필드

| 필드 | 의미 | 커버리지 |
|---|---|---|
| `input_tokens` | **non-cached만** (OpenAI와 의미 다름 — total = input + cache_read + cache_creation) | IR 중첩 usage로 정규화 + `raw` 보존 |
| `output_tokens` | 출력 (thinking 포함) | IR 표준 |
| `cache_creation_input_tokens` / `cache_read_input_tokens` | 캐시 쓰기/읽기 | IR 표준 (`inputTokens.cacheWrite/cacheRead`) |
| `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` | TTL별 캐시 쓰기 (단가 다름) | PO + **정책** (과금) |
| `server_tool_use.web_search_requests` 등 | 서버 툴 사용량 (별도 과금 단위) | PO + **정책** |
| `iterations` | advisor 등 다중 단가 항목 — **top-level 합산에 미포함** | PO + **정책** (과금 라인아이템 필수 사례) |
| `service_tier` / `speed` / `inference_geo` | 실제 적용된 티어/속도/지역 | PO + 정책 |

### 에러 모델

- 에러 타입: `invalid_request_error`(400) / `authentication_error`(401) / `permission_error`(403) / `not_found_error`(404) / `request_too_large`(413) / `rate_limit_error`(429) / `api_error`(500) / `overloaded_error`(529)
- 헤더: `retry-after`, `anthropic-ratelimit-*` (requests/tokens limit·remaining·reset), `request-id`
- 커버리지: IR 구조화 에러 (`{category, retryAfter, fallbackEligible, billed}`) 매핑 + raw 보존. 529·429는 폴백 적격, 400류는 클라이언트 에러로 폴백 금지.

## 7. 프롬프트 캐싱 세부

- `cache_control: {type: "ephemeral", ttl: "5m" | "1h"}` — 블록/툴/system 부착, **최대 4 breakpoints**, 최소 캐시 가능 프리픽스 ~1024 토큰 (미만은 조용히 미캐시)
- 렌더 순서 `tools → system → messages` 프리픽스 매치 — **게이트웨이가 요청을 재조립할 때 바이트 안정성을 깨면 사용자 캐시가 전부 미스** → 어댑터 직렬화의 결정론(키 순서 등)이 하드 요구사항. 골든셋에 "동일 IR → 바이트 동일 wire" 테스트 포함할 것.
- 게이트웨이 자체 응답 캐시와 프로바이더 프롬프트 캐시는 별개 층 — 혼동 금지.

## 8. 베타/버전 메커니즘과 "신기능 day-1" 정책 (D10의 핵심 근거)

Anthropic은 신기능을 `anthropic-beta` 헤더 + 새 파라미터/블록 타입으로 출시한다. **게이트웨이가 모르는 신기능이 나와도 다음이 보장되어야 한다:**

1. **anthropic-compat 인바운드 → anthropic 아웃바운드 경로**: 미지 파라미터·미지 블록 타입·베타 헤더를 **보존 통과** (이 경로 한정 — D5의 "미지 키 4xx"의 명시적 예외로 계약화)
2. **native/openai-compat 인바운드**: 미지 Anthropic 기능은 `providerOptions.anthropic.*`로 수납 가능해야 함 — PO 스키마는 알려진 키는 검증, 모르는 키는 opt-in passthrough 정책 결정 필요
3. **베타 헤더 매트릭스**: LiteLLM의 `anthropic_beta_headers_config.json` 방식 차용 — 기능×전달 여부를 선언적 데이터로
4. **커버리지 매트릭스 CI**: 이 문서의 전 항목 × 어댑터 지원 여부 표를 기계 검증 (미지원 항목이 생기면 CI 실패)

## 9. 모델 세대별 파라미터 게이트 — 레지스트리 필요성의 실증

같은 프로바이더 안에서도 모델 세대에 따라 **같은 파라미터가 400을 유발**한다:

| 파라미터 | Fable 5 | Opus 5 | Opus 4.8/4.7 | 4.6 세대 | 구모델 |
|---|---|---|---|---|---|
| `thinking: {type:"disabled"}` | 400 | effort high 이하만 허용 | 허용 | 허용 | n/a |
| `budget_tokens` | 400 | 400 | 400 | deprecated(동작) | 필수 |
| `temperature/top_p/top_k` | 400 | 400 | 400 | 허용 | 허용 |
| assistant prefill | 400 | 400 | 400 | 400 | 허용 |
| `effort: xhigh` | 허용 | 허용 | 허용 | 400 (max까지) | 400 |
| fast mode | — | 허용 | 4.8만 | — | — |

→ 모델 레지스트리(ADR-0001 D7)에 **"모델×파라미터 허용 매트릭스"**가 필요하고, 게이트웨이는 사전 검증으로 400을 예방하되 변조는 D5 원칙대로 보고한다. 또한 **중간 모델 교체 시나리오에서 같은 프로바이더 내 세대 교체**(예: Sonnet 4.5 → Opus 5)도 재타게팅 대상임이 확인됨 — 재타게팅 패스는 프로바이더 간뿐 아니라 모델 세대 간에도 동작해야 한다.

## 10. v1 범위 결정 현황 (2026-08-20 확정)

1. **Batches API** — **v1 포함 확정**. 비동기 잡 상태 저장 필요 → 상태 계층 결정이 walking skeleton 단계로 상향 (ADR-0001 §5-5). 4사 wire 구조가 완전히 달라 별도 브리지 설계 필요, 구현 순서는 코어 파이프라인 이후.
2. **Files API** — **v1 포함 확정**. file_id의 테넌트 격리 설계는 상태 계층 결정과 함께.
3. **Managed Agents 서피스** — 2차 (필요 시 raw passthrough만).
4. **count_tokens** — **v1 포함 확정**. 크로스 프로바이더 동작은 레지스트리 `countTokens` capability로 (OpenAI는 공개 API 없음).
5. **`pause_turn`** — **확정: 항상 노출, 자동 계속 없음** ([ADR-0005 §2](../decisions/ADR-0005-stream-contract.md)).
6. **서버측 `fallbacks`와 게이트웨이 폴백 트리** — **확정: 게이트웨이 트리 기본, 서버측은 PO opt-in + 위임 마킹** ([ADR-0005 §3](../decisions/ADR-0005-stream-contract.md)).
