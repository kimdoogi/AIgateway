# xAI (Grok) API Wire-레벨 기능 인벤토리

- 날짜: 2026-08-20 (2026-08 기준 공식 문서 조사)
- 목적: IR 스키마 설계 입력물 + xAI 어댑터(openai-compat base 상속)의 오버라이드 지점 목록
- 관련 문서: [ADR-0001](../decisions/ADR-0001-adapter-architecture.md) · [Anthropic 커버리지](2026-08-20-anthropic-api-coverage.md)

> **조사 방법 주석**: docs.x.ai 공식 문서를 직접 fetch하여 작성. 문서가 2025년 말~2026년에 걸쳐 대규모 개편됨(`/docs/guides/*` → `/developers/*`). 일부 세부 값은 요약 추출 과정의 손실 가능성이 있어, 어댑터 구현 시 OpenAPI 스펙(각 REST reference 페이지)으로 재검증 권장. 서드파티 출처는 별도 표기.

## A. API 표면 전체

Base URL: `https://api.x.ai/v1` (관리용은 `https://management-api.x.ai` 별도)

| 엔드포인트 | 메서드/경로 | 상태 | 비고 |
|---|---|---|---|
| Chat Completions | `POST /v1/chat/completions` | GA | OpenAI 호환 표면. `deferred`, `search_parameters`(폐기), `reasoning_effort` 등 확장 |
| Deferred 결과 조회 | `GET /v1/chat/deferred-completion/{request_id}` | GA | 200=완료, 202=처리중. 결과 24h 보존 |
| **Responses API** | `POST /v1/responses` | GA (2025-09~) | xAI의 주력 표면. 서버측 에이전트 툴은 여기서만 동작. stateful(기본 30일 저장) |
| Response 조회/삭제 | `GET/DELETE /v1/responses/{response_id}` | GA | |
| **Context Compaction** | `POST /v1/responses/compact` | GA (2026-05~) | 대화 이력을 압축해 canonical form으로 반환 |
| Responses WebSocket 모드 | (WebSocket) | GA (2026-05~) | release notes 언급 |
| 이미지 생성 | `POST /v1/images/generations` | GA | `aspect_ratio`/`resolution`/`quality` — OpenAI `size`/`style` 미지원 |
| 이미지 편집 | `POST /v1/images/edits` | GA | `image`/`images` = URL 또는 `file_id` |
| 비디오 생성/편집/연장 | `POST /v1/videos/generations`, `/v1/videos/edits`, `/v1/videos/extensions`, `GET /v1/videos/{request_id}` | GA | 비동기(request_id 폴링, `status`: pending/done/failed) |
| 음성 TTS / STT | `POST /v1/tts`, `POST /v1/stt` (+wss) | GA (2026-03~) | |
| Speech-to-Speech | `wss://api.x.ai/v1/realtime` (+client_secrets, calls 제어) | GA (2026-04~) | SIP 전화 연동 포함 |
| 모델 목록 | `GET /v1/models`, `GET /v1/models/{id}` | GA | OpenAI 호환(+xAI 확장 필드) |
| 모델 상세(확장) | `GET /v1/language-models`, `/v1/image-generation-models`, `/v1/video-generation-models` (각 `/{id}`) | GA | capability/가격 메타데이터 포함 — **xAI 고유** |
| 토크나이저 | `POST /v1/tokenize-text` | GA | `token_ids[]` (string_token, token_bytes, token_id) |
| API 키 검증 | `GET /v1/api-key` | GA | 키 상태/ACL 조회 |
| Batch API | `POST/GET /v1/batches`, `/{batch_id}`, `/{batch_id}/requests`, `/{batch_id}/results`, `POST /{batch_id}:cancel` | GA | **OpenAI Batch와 완전 비호환 구조** (파일 기반 아님, 요청 배열 직접 등록; 2026-03부터 JSONL 업로드도 지원) |
| Files API | upload/manage/download 계열 | GA (2026 확장) | TTL/만료 정책(2026-04), public URL(2026-06) |
| Collections API | 컬렉션 CRUD + 문서 업로드/폴링 | GA (2025-08~) | RAG용 문서 저장소, `collections_search` 툴의 기반 |
| Management API | `https://management-api.x.ai` (키/ACL/팀/빌링) | GA (2025-06~) | 별도 Management Key 필요 |
| ~~Legacy Completions~~ | `POST /v1/completions` | Legacy | reasoning 모델 미지원 |
| ~~Anthropic 호환~~ | `POST /v1/messages`, `POST /v1/complete` | **Deprecated** | Anthropic API 호환 표면이었으나 폐기 예고, Responses API로 대체 |
| 임베딩 | 없음 | — | REST 공개 임베딩 API 없음(서드파티 확인) |

출처: https://docs.x.ai/docs/api-reference , https://docs.x.ai/developers/rest-api-reference , https://docs.x.ai/developers/release-notes , https://www.promptfoo.dev/docs/providers/xai/ (임베딩 부재)

## B. OpenAI 호환 정밀 측정 — "어긋나는 지점 전수 목록"

### B-1. 호환인 것

- Base URL 교체(`base_url="https://api.x.ai/v1"`) + `Authorization: Bearer` 만으로 OpenAI SDK 동작. 문서가 "full compatibility with the OpenAI REST API"를 표방 (https://docs.x.ai/developers/quickstart )
- Chat Completions의 핵심 파라미터: `messages`, `model`, `temperature`(0–2), `top_p`, `max_completion_tokens`(구 `max_tokens`는 deprecated), `n`, `stream`, `stream_options`, `seed`, `stop`(최대 4개), `frequency_penalty`/`presence_penalty`, `logprobs`/`top_logprobs`, `logit_bias`, `user`, `response_format`, `tools`/`tool_choice`/`parallel_tool_calls`, `service_tier`, `prompt_cache_key`, `web_search_options`
- Responses API도 OpenAI Responses 패턴(`input`, `previous_response_id`, `store`, `include`, `text.format`, `output[]`) 호환

### B-2. 어긋나는 지점 전수 목록 (게이트웨이 어댑터 관점)

| # | 항목 | OpenAI | xAI | 심각도 |
|---|---|---|---|---|
| 1 | **에러 바디 포맷** | `{"error":{"message","type","param","code"}}` | **`{"code":"400","error":"..."}`** — 평면 구조, `code`가 문자열 상태코드, 메시지 키가 `error` | **높음** — 에러 파서 오버라이드 필수 (실측: https://github.com/openclaw/openclaw/issues/12910 ; 문서 https://docs.x.ai/developers/debugging ) |
| 2 | **잘못된 API 키의 상태코드** | 401 | 문서상 401이나, 실측에서 **400** "Incorrect API key provided…" 사례 다수 | 중간 — 401/400 모두 auth 오류로 매핑 필요 |
| 3 | **reasoning 모델의 파라미터 거부** | penalty/stop 허용 | reasoning 모델에서 `presence_penalty`, `frequency_penalty`, `stop` 지정 시 **400** | **높음** — 어댑터에서 strip 또는 사전 검증 (https://docs.x.ai/developers/model-capabilities/text/reasoning ) |
| 4 | **`reasoning_effort` 값 집합** | low/medium/high | 모델별 상이: grok-4.6은 `low/medium/high/xhigh`(기본 **high**, 비활성화 불가), 일부 모델은 `none` 지원, 미지원 모델은 **400** | **높음** — 모델별 capability gate 필요 |
| 5 | **`finish_reason` 값** | stop/length/tool_calls/content_filter/function_call | 문서상 `stop`/`length`/**`end_turn`**/`null`. `tool_calls`·`content_filter`는 문서에 없음 → `end_turn` 매핑 로직 필요 | 중간 |
| 6 | **응답 확장 필드** | 없음 | `choices[].message.reasoning_content`, 최상위 `citations[]`, `output_files[]`, usage의 `cost_in_usd_ticks`·`num_sources_used` 등 | 낮음 (IR 승격 가치 있음) |
| 7 | **미지원 OpenAI 파라미터** | `store`, `metadata`, `modalities`, `audio`, `prediction`, legacy `functions` | 요청 스키마에 부재. **미지원 파라미터는 무시가 아니라 400 "Argument not supported"로 거부** | **높음** — allowlist strip 필요 |
| 8 | **`max_tokens`** | 병존 | deprecated 표기, `max_completion_tokens` 권장(기본 128,000) | 낮음 |
| 9 | **usage 상세 구조** | 호환 | 호환 + 확장: `prompt_tokens_details.{text_tokens,audio_tokens,image_tokens,cached_tokens}`, `cost_in_usd_ticks`(100억 ticks=$1), `num_sources_used`, (Responses) `num_server_side_tools_used`, `server_side_tool_usage_details.{web_search_calls,x_search_calls,code_interpreter_calls,file_search_calls,document_search_calls,image_generation_calls,mcp_calls}` | 중간 — usage 매퍼 확장 |
| 10 | **Responses API 확장 파라미터** | — | `min_p`, `top_k`, `context_management`, `max_turns`, `reasoning_effort`(top-level) 등 | 중간 |
| 11 | **Responses API 미지원 옵션** | MCP 툴의 `require_approval`, `connector_id` | **미지원** | 중간 |
| 12 | **`include` 값 집합** | OpenAI와 다름 | xAI 고유 값: `reasoning.encrypted_content`, `inline_citations`/`no_inline_citations`, `web_search_call_output`, `code_execution_call_output` | 중간 |
| 13 | **이미지 생성 파라미터** | `size`, `quality(hd)`, `style` | **`size`/`style` 미지원**. 대신 `aspect_ratio`(14종+auto), `resolution`("1k"/"2k"), `quality`("low"/"medium") | **높음**(이미지 경로 사용 시) |
| 14 | **Batch API** | 파일 업로드+input_file_id | 완전히 다른 구조: `POST /v1/batches`(name만) → `/{id}/requests`에 요청 배열 등록 → `/{id}/results` 조회, `:cancel` RPC식 경로 | **높음**(배치 지원 시 전면 재구현) |
| 15 | **임베딩/모더레이션** | 있음 | **없음** (REST 공개 기준) | 중간 — capability 플래그 off |
| 16 | **레이트리밋 헤더** | `x-ratelimit-*` 6종 | 공식 문서에 헤더 명세 없음. 서드파티 실측으로 `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests` 확인 | 중간 — 헤더를 옵셔널로 취급 |
| 17 | **캐시 제어 헤더** | 없음 | **`x-grok-conv-id` 요청 헤더**로 캐시 라우팅 힌트(고유) | 중간 |
| 18 | **410 Gone** | 사용 안 함 | 폐기된 Live Search(`search_parameters`) 요청에 410 반환 | 낮음 |
| 19 | **`/v1/models` 응답** | 표준 | 동일 + `aliases[]`, `context_length`, 가격 필드들 — 상위 호환 | 낮음 |

## C. 고유 기능 전수 목록 (providerOptions.xai 후보)

### C-1. 서버측 에이전트 툴 (Responses API 전용, 2025-10 GA)

`tools` 배열에 선언하면 xAI 서버가 자율 실행 루프(검색→분석→후속검색)를 돌림. 출처: https://docs.x.ai/developers/tools/overview

| 툴 | type 이름 | 옵션 |
|---|---|---|
| Web Search | `web_search` | `allowed_domains`(≤5), `excluded_domains`(≤5, allowed와 배타), `enable_image_understanding`, `enable_image_search` |
| X Search | `x_search` | `allowed_x_handles`(≤20), `excluded_x_handles`(≤20, 배타), `from_date`/`to_date`(ISO8601), `enable_image_understanding`, `enable_video_understanding` |
| Code Interpreter | `code_interpreter`(OpenAI 표면) / `code_execution`(네이티브 SDK) | 옵션 없음. 샌드박스 Python, 네트워크 차단, stateless |
| Collections Search | `file_search`(OpenAI 표면, `vector_store_ids`) / `collections_search`(네이티브, `collection_ids`) | `max_num_results`. 인용 URI `collections://{collection_id}/files/{file_id}` |
| Remote MCP | `mcp` | `server_url`(필수), `server_label`(필수), `server_description`(선택). `require_approval`/`connector_id` 미지원 |
| Image Generation(툴) | 서버측 이미지 생성 | tools overview에 언급 |

과금: 토큰 + **툴 호출 횟수** 이중 과금. 사용량은 `usage.server_side_tool_usage_details.*`로 리포트.

### C-2. 레거시 Live Search — **폐기됨**

- `search_parameters` (Chat Completions): 2026-01-12 폐기, 이후 **410 Gone** → Agent Tools(`web_search`/`x_search`)로 마이그레이션. REST 레퍼런스에 스키마가 잔존해 문서 간 불일치 존재.
- 출처: https://github.com/langchain-ai/langchain/issues/33961 , https://community.make.com/t/x-ai-node-integration-error-410-live-search-deprecated-switch-to-agent-tools-api/102097

### C-3. Reasoning

- `reasoning_effort`: grok-4.6 = `low/medium/high(기본)/xhigh`; grok-4.5 = low/medium/high; 미지원 모델은 400. **비활성화 불가**(일부 구모델만 `none`). grok-4.20-multi-agent에서는 effort가 **에이전트 수**를 제어.
- 노출: ① 요약이 `reasoning_content`(chat) 필드로, ② Responses API에서 `include:["reasoning.encrypted_content"]`로 **암호화된 reasoning**을 받아 다음 턴에 되돌려 컨텍스트 유지, ③ 스트리밍 이벤트 `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`.
- 과금: `completion_tokens_details.reasoning_tokens`로 별도 계상.
- 제약: reasoning 모델 + `presence_penalty`/`frequency_penalty`/`stop` 조합 불가.

### C-4. Structured Outputs

- `response_format`: `text` / `json_object` / `json_schema`(strict). Responses API는 `text.format`.
- 지원 스키마: anyOf/oneOf/allOf(단일)/$ref·$defs(비순환), 포맷 강제(date, time, date-time, email, uuid, ipv4, ipv6, uri — **OpenAI보다 넓음**), min/max 제약 강제(minLength≤2048, minItems≤256, minProperties≤64), ECMAScript 서브셋 regex.
- 거부: 0-variant enum, `true`/`false` 스키마, maxContains/minContains, tuple-형 items. Best-effort: `not`, if/then/else, 다중 allOf.
- 출처: https://docs.x.ai/docs/guides/structured-outputs

### C-5. 기타 고유 기능

| 기능 | 내용 |
|---|---|
| **Deferred completions** | `deferred:true` → 즉시 `{"request_id"}` 반환 → `GET /v1/chat/deferred-completion/{id}` (200/202). 24h 보존. 스트리밍 불가 |
| **Prompt caching** | 자동(옵트인 불요), 메시지 배열 prefix 정확 일치 기반. `x-grok-conv-id` 헤더 + `prompt_cache_key` 파라미터로 히트율 극대화(grok-4.6 문서가 강권). 캐시 토큰 할인 과금 |
| **Stateful Responses** | 기본 30일 서버 저장, `store:false`로 stateless, `previous_response_id` 체이닝 |
| **Context Compaction** | `POST /v1/responses/compact`, `context_management` 파라미터 |
| **Citations** | 최상위 `citations[]`(기본 반환) + `output_text`의 `annotations[]`(`type:"url_citation"`, url, start/end_index, title). 인라인 `[[N]](url)` 마크다운(기본 on) |
| **비전 입력** | `input_image`(Responses)/`image_url`(chat) + `detail`. base64/URL, jpg·png, ≤20MiB, 장수 무제한 |
| **service_tier** | `"default"` \| `"priority"` (Priority Processing, 2026-06) |

## D. 스트리밍

- **프레이밍**: SSE. 종료 센티널 `data: [DONE]`.
- **Chat Completions 청크**: `choices[0].delta.{role,content,tool_calls}` + reasoning 요약이 `delta.reasoning_content`로. `stream_options.include_usage`로 최종 usage 청크 (usage가 중간 청크에 실린다는 서술도 병존 — 두 경로 모두 방어 처리 권장).
- **finish_reason**: 마지막 청크 전까지 `null`, 이후 `stop`/`length`/`end_turn`.
- **Responses API 이벤트**(OpenAI Responses 이벤트 체계 호환): `response.output_text.delta`, `response.reasoning_text.delta`, `response.reasoning_summary_text.delta`. 서버측 툴 호출이 스트림에 실시간 노출, 툴 출력 본문은 기본 미반환 — `include:["web_search_call_output","code_execution_call_output"]`로 옵트인.
- **운영 주의**: reasoning 모델 스트리밍 시 타임아웃 3600s 권장(문서 명시).

## E. 에러 모델과 Rate Limit

**에러 바디**: `{"code":"<HTTP코드 문자열>","error":"<메시지>"}` — OpenAI 중첩 구조와 다름. 코드표: 400(요청 오류), 401, 403, 404, 405, 415, 422(필드 포맷 오류), 429, 202(deferred 처리중), 410(폐기 API). 실측상 인증 오류가 400으로 오는 사례 있음.

**Rate limit**: RPS + TPM 2차원. 티어제(2026-01-01 이후 누적 지출: T0 $0 → T4 $5,000 → Enterprise; 다운그레이드 없음). 예: grok-4.6 T0=150 RPS/50M TPM. TPM에 prompt+completion+reasoning+cached 전부 산입. `Retry-After` 문서 미명세, `x-ratelimit-*` 헤더는 서드파티 실측만 존재.

## F. Usage/과금 리포팅

```
usage: {
  prompt_tokens, completion_tokens, total_tokens,
  prompt_tokens_details: { text_tokens, audio_tokens, image_tokens, cached_tokens },
  completion_tokens_details: { reasoning_tokens, audio_tokens,
                               accepted_prediction_tokens, rejected_prediction_tokens },
  cost_in_usd_ticks,          // 10^10 ticks = $1 (2026-04 도입)
  num_sources_used,           // 레거시 Live Search 소스 수
  // Responses API 추가:
  num_server_side_tools_used,
  server_side_tool_usage_details: { web_search_calls, x_search_calls, code_interpreter_calls,
                                    file_search_calls, document_search_calls,
                                    image_generation_calls, mcp_calls },
  cost_in_nano_usd, context_details.{input_tokens,output_tokens}
}
```

- reasoning 토큰 별도 계상 후 output으로 과금, 캐시 토큰 할인 단가, 에이전트 툴은 **호출 횟수 단위** 추가 과금. 장문 컨텍스트 구간(≥200k)에서 단가 상승 (`prompt_text_token_price_long_context`, `long_context_threshold`가 `/v1/models`에 노출 — **프로바이더가 직접 다단계 가격을 API로 노출하는 사례**, 모델 레지스트리 갱신 소스로 활용).

## G. 모델 목록과 Capability (2026-08)

| 모델 | 컨텍스트 | 모달리티 | reasoning | 비고 |
|---|---|---|---|---|
| grok-4.6 (권장) | 500k | text+image in / text out | low/medium/high/**xhigh** | 2026-08 출시, $2/$0.50(cached)/$6 per 1M (200k 초과 시 $4/$1/$12) |
| grok-4.5 | 500k | text+image in | low/medium/high | EU 리전 제공 |
| grok-4.3 | 1M | text in | effort 값 집합 상이 | 저가 라인 |
| grok-4.20-…-reasoning / -non-reasoning / -multi-agent | 1M | text | multi-agent는 effort가 에이전트 수 제어 | |
| grok-build-0.1 | 256k | text | — | 코딩 에이전트 early access |
| grok-imagine-image-2.0 / -video-1.5 등 | — | 이미지/비디오 생성 | — | |

신규 어댑터는 `GET /v1/language-models`로 런타임 capability(`input_modalities`, `output_modalities`, `aliases`, `context_length`, 가격)를 동적 조회하는 것이 안전.

## H. 인증/버전 정책

- `Authorization: Bearer <XAI_API_KEY>` 단일 방식. `GET /v1/api-key`로 키 상태 검증 가능.
- 경로 버전 `/v1` 고정. **버전/베타 헤더 메커니즘 없음** — 베타는 early access 프로그램과 신규 엔드포인트 추가로 운영.
- 관리 작업은 별도 Management Key + management-api.x.ai.
- 네이티브 대안: gRPC 기반 xai-sdk (REST와 필드명 다름: `cached_prompt_text_tokens`, `tool_result` 역할, `code_execution` 툴명).

## IR 표준 필드 후보 vs providerOptions.xai 후보

### IR 표준 후보 (타 프로바이더 공유 개념)

- messages/roles, 비전 입력 파트, tools/tool_choice/parallel_tool_calls, response_format(json_schema/strict), temperature/top_p/max_output_tokens/stop/seed, stream+usage 옵션 — OpenAI 표면과 동형
- reasoning: `effort` enum, 응답의 reasoning 요약 텍스트, `reasoning_tokens` usage — 3사 공통 개념 (값 집합은 어댑터에서 게이트)
- usage: input/output/total + cached + reasoning 토큰 — 3사 공통
- citations/annotations (`url_citation` + start/end index) — OpenAI·Anthropic 공통 패턴
- 서버측 웹서치 툴 추상 (provider-executed tool 일반화) — 4사 모두 보유
- finish/stop reason 정규화 (`end_turn` → unified `stop` 매핑 + raw 보존)
- async/background 실행 추상 (deferred ↔ OpenAI background ↔ batch) — 최소한 job-id 개념

### providerOptions.xai 후보 (고유)

- 에이전트 툴 세부 옵션: `webSearch.{allowedDomains,excludedDomains,enableImageUnderstanding,enableImageSearch}`, `xSearch.{allowedXHandles,excludedXHandles,fromDate,toDate,…}`, `codeInterpreter`, `collectionsSearch.{collectionIds,maxNumResults}`, `mcp.{serverUrl,serverLabel,serverDescription}`
- ~~`reasoningEffort: "xhigh"` (IR enum 밖 값)~~ *(현행: `xhigh`는 IR 표준 enum 포함 — ir-design-gate G3에서 정정)*, encrypted reasoning round-trip (`include:["reasoning.encrypted_content"]`)
- `include` 값들: `inline_citations`/`no_inline_citations`, `web_search_call_output`, `code_execution_call_output`
- `deferred: true` + 폴링, `serviceTier: "priority"`, `promptCacheKey`, `xGrokConvId`(헤더), `store`/`previousResponseId`, `contextManagement`/`maxTurns`/compact, `minP`/`topK`, `n`, `logitBias`, `webSearchOptions`, 이미지 생성 `aspectRatio`/`resolution`/`quality`, `user`
- `searchParameters`(레거시 — 410, 기본 차단 권장)

## openai-compat base 어댑터에서 오버라이드해야 할 지점 목록

1. **에러 파서**: `{"code","error"}` 평면 포맷 파싱 추가. 400에 인증 오류 메시지가 실릴 수 있으므로 상태코드만으로 auth 오류를 판정하지 말 것. 410 → "기능 폐기" 오류 타입 신설.
2. **파라미터 새니타이저**: 미지원 키는 400으로 거부되므로 allowlist 방식 strip (`store`, `metadata`, `audio`, `modalities`, `prediction`, legacy `functions`). reasoning 모델에서 `presence_penalty`/`frequency_penalty`/`stop` 제거(+보고). `max_tokens`→`max_completion_tokens` 리네임.
3. **reasoning_effort 게이트**: 모델별 허용 값 테이블 (xhigh는 grok-4.6+, 미지원 모델은 파라미터 제거). 기본값 high(비활성 불가)를 비용 추정에 반영.
4. **응답 매퍼 확장**: `message.reasoning_content`, 최상위 `citations[]`, `output_files[]` 수용; finish_reason `end_turn` 매핑; 미문서화 값 방어 처리.
5. **usage 매퍼 확장**: `cost_in_usd_ticks`, `num_sources_used`, `server_side_tool_usage_details.*`, `prompt_tokens_details.image_tokens/text_tokens`.
6. **스트리밍**: `delta.reasoning_content` 처리; usage 위치 이중 방어; 타임아웃 상향(≤3600s); Responses 스트림 reasoning 이벤트 처리.
7. **캐싱 훅**: `prompt_cache_key` 전달 + `x-grok-conv-id` 요청 헤더 주입 (게이트웨이 세션 id 매핑).
8. **서버측 툴 변환기**: IR provider-executed tool → xAI 툴 타입 변환하되 **Responses API로 라우팅 강제** (Chat Completions에서는 불가). `require_approval`/`connector_id` 거부.
9. **엔드포인트 라우팅**: 기본 chat completions 호환 + 서버측 툴·encrypted reasoning·stateful 요구 시 `/v1/responses` 스위칭 이중 경로. deprecated `/v1/messages`(Anthropic 호환) 사용 금지.
10. **비동기 경로**: OpenAI base의 batch 구현 재사용 불가 — xAI 전용 Batch 클라이언트 + deferred 폴링 별도 구현.
11. **capability 디스커버리**: `GET /v1/language-models` 우선 사용 (modality/context/가격/aliases 동적 로드).
12. **기능 플래그 off**: embeddings, moderations, OpenAI식 files/batches, `size`/`style` 이미지 파라미터.
13. **레거시 가드**: `search_parameters` 인입 시 어댑터 레벨에서 agent tools로 변환하거나 명시적 거부.
14. **레이트리밋**: `x-ratelimit-*` 헤더 옵셔널 취급, 부재 시 429 + 지수 백오프. RPS(초당) 한도이므로 게이트웨이 토큰버킷을 초 단위로 설계.

## 주요 출처

- https://docs.x.ai/docs/api-reference · https://docs.x.ai/developers/rest-api-reference · https://docs.x.ai/developers/rest-api-reference/inference/chat
- Tools: https://docs.x.ai/developers/tools/overview (+web-search, x-search, code-execution, collections-search, remote-mcp, citations, streaming-and-sync)
- https://docs.x.ai/developers/model-capabilities/text/reasoning · https://docs.x.ai/docs/guides/structured-outputs · https://docs.x.ai/docs/guides/streaming-response · https://docs.x.ai/docs/guides/deferred-chat-completions
- https://docs.x.ai/developers/advanced-api-usage/prompt-caching/how-it-works · https://docs.x.ai/developers/rate-limits · https://docs.x.ai/developers/debugging · https://docs.x.ai/docs/models · https://docs.x.ai/developers/grok-4-6 · https://docs.x.ai/developers/release-notes
- Live Search 폐기: https://github.com/langchain-ai/langchain/issues/33961 · 에러 포맷 실측: https://github.com/openclaw/openclaw/issues/12910 · 임베딩 부재: https://www.promptfoo.dev/docs/providers/xai/
