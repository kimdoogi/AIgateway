# OpenAI API Wire-레벨 기능 인벤토리

- 날짜: 2026-08-20 (2026-08 기준 공식 문서 + openai-python SDK 타입 교차 검증)
- 목적: IR 스키마 설계 입력물 + **Responses API vs Chat Completions 아웃바운드 결정 근거** ([ADR-0002](../decisions/ADR-0002-openai-outbound-responses-api.md))
- 관련 문서: [ADR-0001](../decisions/ADR-0001-adapter-architecture.md) · [Anthropic 커버리지](2026-08-20-anthropic-api-coverage.md) · [xAI 인벤토리](2026-08-20-xai-grok-api.md)

> 조사 범위: OpenAI 공식 문서 (2026년 3월경 `platform.openai.com/docs` → `developers.openai.com/api/docs`로 이전, 구 URL 301 리다이렉트) + `openai/openai-python` SDK 타입 정의. 현행 최신 모델 세대는 **GPT-5.6 (Sol/Terra/Luna, 2026-07-09 GA)**.

## 0. 결정 권고안: 게이트웨이 아웃바운드 주 경로는 **Responses API**

**권고: OpenAI 아웃바운드의 canonical 경로를 Responses API로 하고, Chat Completions는 레거시 모델·특수 기능(audio out, predicted outputs) 전용 보조 경로로 유지한다. 상태성 문제는 `store: false` + encrypted reasoning 왕복으로 해소한다.**

### 근거 요약

| # | 근거 | 상세 | 출처 |
|---|---|---|---|
| 1 | **reasoning 보존이 CC에서 구조적으로 불가능** | Chat Completions는 reasoning item을 응답으로 반환하지 않음(입력은 `reasoning_effort` 뿐, 출력은 usage 카운트 뿐). 툴콜 루프에서 reasoning 상태가 매 turn 소실 → 품질·캐시 저하. Responses는 reasoning item + `encrypted_content` 왕복 가능 | https://developers.openai.com/api/docs/guides/reasoning , https://developers.openai.com/api/docs/guides/migrate-to-responses |
| 2 | **품질/비용 수치가 공식 문서에 명시** | migrate 가이드: reasoning 모델에서 "3% improvement in SWE-bench", 캐시 활용률 "40% to 80% improvement" | migrate 가이드 |
| 3 | **신기능이 Responses에만 착륙** | 빌트인 툴 전체(web_search, file_search, code_interpreter, computer use, image_generation, MCP, shell, apply_patch, tool_search 등), `reasoning.mode: pro`, `reasoning.context: all_turns`, `context_management`(compaction), background mode가 모두 Responses 전용. CC의 서버 툴은 `web_search_options` 하나 뿐 | https://developers.openai.com/api/docs/guides/tools |
| 4 | **모델 접근성 격차 발생 중** | GPT-5.6 Sol/Terra/Luna는 CC도 지원하지만, **pro 계열(gpt-5-pro, gpt-5.4-pro)은 Responses 전용**(CC 호출 시 404). computer-use, deep research 계열도 Responses 전용 | https://developers.openai.com/api/docs/models/gpt-5-pro |
| 5 | **deprecation 방향성** | CC 자체는 "not deprecated"이나 "Responses is recommended for all new projects" 포지셔닝. **Assistants API는 2026-08-26 셧다운** — 구 API를 실제로 폐기하는 전례 확립 | https://developers.openai.com/api/docs/deprecations |
| 6 | **스트리밍 이벤트가 IR 친화적** | Responses semantic events(타입별 delta/done + item 경계 + `sequence_number`)는 정규화·재전송·resume에 유리. CC delta chunk는 툴콜 arguments 파편 조립을 클라이언트가 해야 함 | https://developers.openai.com/api/docs/api-reference/responses-streaming |

### 상태성 제약과 회피 (stateless 게이트웨이 관점)

| 항목 | 내용 |
|---|---|
| `store` 기본값 | Responses는 **기본 저장(store: true)**, 30일 보관. 게이트웨이는 **명시적으로 `store: false` 강제** 권장 |
| encrypted reasoning | `store: false`(또는 ZDR)면 reasoning item에 `encrypted_content`가 **기본 포함** (과거의 `include: ["reasoning.encrypted_content"]`는 하위호환으로 허용). 이 opaque 토큰을 다음 요청 input에 그대로 되돌리면 reasoning 연속성 유지 |
| 왕복 규칙 | 함수콜 루프에서 "마지막 user 메시지 이후의 모든 item(reasoning, function_call, function_call_output)을 손대지 않고 그대로 다음 요청에 전달" 요구 → **IR이 item 순서·원문 보존을 보장해야 함** |
| `previous_response_id` / `conversation` | 서버측 상태 참조, 둘은 상호 배타. stateless 게이트웨이는 둘 다 쓰지 않고 전체 히스토리 재전송(체인 전체 input이 매번 과금되므로 비용 손해 없음). 클라이언트 요구 시 opt-in passthrough |
| background mode | `background: true`는 서버 임시 저장 + 폴링/재개(`starting_after=sequence_number`) — opt-in 기능으로 분리 |

**CC를 보조 경로로 남길 유일한 사유**: audio in/out(`modalities` — Responses 미지원), predicted outputs(CC 전용), `n>1`, `logit_bias`, `seed`, penalties 등 CC 고유 파라미터. *(현행 결정: `n>1`은 CC 전환 사유에서 제외 — v1 IR은 단일 후보, drop+warning. ir-design-gate G2.)*

## 1. Responses vs Chat Completions 기능 대조표

| 기능 | Responses | Chat Completions |
|---|---|---|
| reasoning item 반환/왕복 | O (`reasoning` item, `encrypted_content`) | X (usage 카운트만) |
| reasoning 제어 | `reasoning: {effort, summary, context, mode}` | `reasoning_effort` 단일 필드만 |
| `reasoning.mode: pro` (GPT-5.6-sol) | O | X |
| `reasoning.context: all_turns` | O (GPT-5.6 기본) | X |
| 빌트인 툴 | 16종 (§G) | `web_search_options` 1종 |
| 서버측 상태 | O (store/previous_response_id/conversation) | `store`만 (기본 false, evals용) |
| background + webhook + stream resume | O | X |
| `context_management` (compaction) | O | X |
| audio in/out | X | O (`audio`, `modalities`, `input_audio`) |
| predicted outputs | X | O (`prediction`) |
| `n`, `logit_bias`, `seed`, penalties, `stop` | X | O (단 reasoning 모델은 다수 거부) |
| 구조화 출력 | `text.format` | `response_format` |
| 스트리밍 | semantic events (~58종) | `chat.completion.chunk` delta |

## A. Responses API 요청 스키마 전수

`POST /v1/responses`:

| 파라미터 | 값/범위 | 비고 |
|---|---|---|
| `model` | 필수 | alias(`gpt-5.6`) 또는 스냅샷 ID |
| `input` | string \| item 배열 | §B |
| `instructions` | string | system/developer 역할. `previous_response_id` 사용 시 이전 instructions는 **이월 안 됨** |
| `reasoning` | `effort: none/minimal/low/medium/high/xhigh/max` (모델별 부분집합, GPT-5.6 기본 medium) · `summary: auto/concise/detailed` · `context: auto/current_turn/all_turns` (GPT-5.6 기본 all_turns) · `mode: standard/pro` (pro는 gpt-5.6-sol) | reasoning 모델 전용 |
| `text` | `verbosity: low/medium/high` · `format: {type:"text"} \| {type:"json_schema", name, schema, strict} \| {type:"json_object"}` | |
| `temperature` / `top_p` | 0–2 / 0–1 | **reasoning 모델은 400 거부** |
| `top_logprobs` | 0–20 | include와 병용 |
| `max_output_tokens` | | visible + reasoning 포함 상한 |
| `max_tool_calls` | | 빌트인 툴 총 호출 상한 |
| `tools` | 16종 + `function{type,name,description,parameters,strict}` | |
| `tool_choice` | `auto/required/none` \| `{type:"function",name}` \| `{type:"allowed_tools", mode, tools}` \| `{type:"mcp"/"custom"/...}` | |
| `parallel_tool_calls` | 기본 true | |
| `include` | `web_search_call.results`, `web_search_call.action.sources`, `file_search_call.results`, `message.input_image.image_url`, `message.output_text.logprobs`, `computer_call_output.output.image_url`, `code_interpreter_call.outputs`, `reasoning.encrypted_content` (8종) | |
| `store` | **기본 true**, 30일 | stateless는 명시적 false |
| `previous_response_id` / `conversation` | 상호 배타 | conversation은 30일 TTL 비적용 |
| `background` | 기본 false | 비동기 |
| `stream` / `stream_options` | `include_obfuscation` (side-channel 완화 패딩) | |
| `service_tier` | `auto/default/flex/scale/priority/fast/ultrafast` — `priority`는 2026-07-30 **`fast`로 개명**(양쪽 허용) | |
| `truncation` | `auto/disabled` — **기본 disabled** (초과 시 400) | |
| `prompt` | `{id, version, variables}` — 저장 템플릿. **v1/prompts 2026-11-30 셧다운 예정** | |
| `prompt_cache_key` | 캐시 라우팅 힌트 (구 `user`의 절반) | |
| `prompt_cache_options` | `mode: implicit/explicit` · `ttl: "30m"` — GPT-5.6+ | |
| `prompt_cache_retention` | `in_memory/24h` — 구모델용 deprecated | |
| `safety_identifier` | ≤64자 (구 `user`의 나머지 절반 — 어뷰징 탐지) | |
| `user` | **deprecated** → safety_identifier + prompt_cache_key로 분리 | |
| `metadata` | key ≤64자, value ≤512자, ≤16쌍 | |
| `context_management` | `[{type:"compaction", ...}]` 자동 압축 | 신기능 |
| `moderation` | 입출력 moderation 설정 | 신기능 |

## B. 메시지 / 콘텐츠 구조 전수

### Input/Output item 타입

| item type | 방향 | 핵심 필드 |
|---|---|---|
| `message` | in/out | role: user/assistant/system/developer, content: part 배열. assistant에 phase 라벨(`commentary`/`final_answer`) 개념 |
| `function_call` | out→재입력 | `call_id`, `name`, `arguments`(JSON string) |
| `function_call_output` | in | `call_id`, `output` |
| `reasoning` | out→재입력 | `summary[]`, `content[]`(reasoning_text), `encrypted_content` |
| `item_reference` | in | `id` — 저장 item 참조 (stateful 전용) |
| `web_search_call` / `file_search_call` | out | 액션/쿼리/결과 |
| `computer_call` / `computer_call_output` | out/in | 액션 / 스크린샷 |
| `image_generation_call` | out | base64 이미지 |
| `code_interpreter_call` | out | code, outputs, container_id |
| `local_shell_call(_output)` / `shell_call(_output)` | out/in | 로컬 셸 / hosted shell |
| `apply_patch_call(_output)` | out/in | 패치 적용 |
| `mcp_call`, `mcp_list_tools`, `mcp_approval_request/response` | out/in | 원격 MCP 왕복 |
| `custom_tool_call(_output)` | out/in | 자유형(비JSON) 툴 I/O |
| `compaction` | out | context_management 압축 결과 |
| `additional_tools`, `program`, `program_output`, tool_search call/output | in/out | 신형: item 레벨 툴 주입, programmatic tool calling, 동적 툴 검색 |

### Content part 타입

| part | 필드 | 비고 |
|---|---|---|
| `input_text` | text, (`prompt_cache_breakpoint` — explicit 캐시 모드) | |
| `input_image` | `image_url`(https URL 또는 base64 data URL) \| `file_id`, `detail: low/high/auto/original` | 3가지 전달 방식 |
| `input_file` | `file_id` \| `file_url` \| `file_data`(base64) + filename | PDF 등 |
| `output_text` | text, `annotations[]`(`file_citation`/`url_citation`/`container_file_citation`/`file_path`), logprobs | |
| `refusal` | refusal | |
| (`input_audio`) | — | **Responses content union에 없음** — 오디오 I/O는 CC 전용 |

CC 측: `messages[].content[]`의 text/image_url/input_audio/file, role은 developer/system/user/assistant/tool(+deprecated function).

## C. 구조화 출력 — strict JSON Schema subset

- 지원: string, number, integer, boolean, object, array, enum, `anyOf`
- 필수 규칙: 모든 필드 `required` 명시, 모든 object에 `additionalProperties: false`, **루트는 object + 루트 anyOf 불가**. optional은 `["string","null"]` union
- 지원 키워드: string `pattern`/`format`(date-time, time, date, duration, email, hostname, ipv4, ipv6, uuid) · number `multipleOf`/min/max · array `minItems`/`maxItems` · `$ref`/`$defs` · 재귀(`"$ref": "#"`)
- 미지원: `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if/then/else`
- 한도: 5,000 properties, 중첩 10단계, 이름 합산 120,000자, enum 총 1,000개
- 새 스키마 첫 요청은 컴파일 지연, 이후 캐시

## D. Responses 스트리밍 이벤트 전수 (~58종)

모든 이벤트에 `sequence_number`(resume 커서). **usage는 최종 `response.completed`의 response 객체에만**. 에러는 스트림 내 `error` + 터미널 `response.failed`.

- **라이프사이클**: `response.created/queued/in_progress/completed/failed/incomplete`, `error`
- **item/part 경계**: `response.output_item.added/done`, `response.content_part.added/done`
- **텍스트/거부**: `response.output_text.delta/done`, `response.output_text.annotation.added`, `response.refusal.delta/done`
- **함수콜**: `response.function_call_arguments.delta/done`
- **reasoning**: `response.reasoning_summary_part.added/done`, `response.reasoning_summary_text.delta/done`, `response.reasoning_text.delta/done`
- **빌트인 툴**: `response.web_search_call.in_progress/searching/completed`, `response.file_search_call.*`, `response.code_interpreter_call.*` + `response.code_interpreter_call_code.delta/done`, `response.image_generation_call.*` (partial_image 포함), `response.mcp_call.*` + `response.mcp_call_arguments.delta/done`, `response.mcp_list_tools.*`, `response.custom_tool_call_input.delta/done`, shell 계열 5종(정확한 wire 문자열은 SDK 클래스명 기반 추정 — 구현 전 재확인)
- **오디오(CC/realtime 호환)**: `response.audio.delta/done`, `response.audio.transcript.delta/done`

CC 대비: `chat.completion.chunk` 단일 타입, `choices[].delta.{content, tool_calls[].function.arguments, refusal}` + finish_reason(stop/length/tool_calls/content_filter/function_call), usage는 `stream_options:{include_usage:true}` 시 마지막 chunk. 이벤트 의미 구분·재개 커서 없음.

## E. 에러 모델

- 구조: `{"error": {"message", "type", "code", "param"}}`
- 상태코드: 400, 401, 403(지역/권한), 404(Responses 전용 모델을 CC로 호출 시 포함), 409, 422, 429(quota 포함, 과금 없음), 408(flex 타임아웃), 500, 503
- 주요 code: `context_length_exceeded`, `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `previous_response_not_found`
- rate limit 헤더: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` + 프로젝트 스코프 변형 + `Retry-After`
- 관측 헤더: `x-request-id`, `openai-processing-ms`, 클라이언트 지정 `X-Client-Request-Id`(≤512자)

## F. usage 구조 + 캐싱

| | Responses | Chat Completions |
|---|---|---|
| 입력 | `input_tokens` + `input_tokens_details.cached_tokens` | `prompt_tokens` + `prompt_tokens_details.{cached_tokens, audio_tokens}` |
| 출력 | `output_tokens` + `output_tokens_details.reasoning_tokens` | `completion_tokens` + `completion_tokens_details.{reasoning_tokens, audio_tokens, accepted/rejected_prediction_tokens}` |

**캐싱**: 1,024토큰 이상 prefix 자동 캐싱. 완전 동일 prefix 필요(메시지·이미지·툴 정의·스키마). 읽기 0.1×. **GPT-5.6+: 정확 30분 TTL(`prompt_cache_options.ttl:"30m"`), 재사용 무료 갱신, 쓰기 1.25×** / 구모델: in-memory 5–10분, `prompt_cache_retention:"24h"` 연장. `prompt_cache_key` 라우팅(키당 ~15 RPM). 캐시 토큰도 rate limit 산입.

## G. OpenAI 고유 기능 전수 (providerOptions.openai 후보)

| 기능 | API | 요점 |
|---|---|---|
| logprobs | 양쪽 | Responses: `top_logprobs`+include / CC: `logprobs`+`top_logprobs` |
| seed 재현성 | CC만 | `seed` + `system_fingerprint` (best-effort) |
| service tiers | 양쪽 | `flex`(Batch 단가, 10분 타임아웃·408 재시도·429 무과금), `priority`→`fast`(~2.5× 빠름·프리미엄), `scale`(약정), `ultrafast`(SDK 신규) |
| predicted outputs | CC만 | GPT-4o/4.1 계열만, tools·logprobs와 배타, rejected 토큰 과금 |
| audio in/out | CC만 | `modalities`, `audio:{voice,format}`, `input_audio`, gpt-audio-1.5 |
| background mode | Responses만 | 폴링/취소/`starting_after` resume |
| webhooks | 플랫폼 | Standard Webhooks 규격, `response.*`/`batch.*` |
| Batch API | 별도 | 8개 엔드포인트 지원, JSONL(custom_id), 24h 창, 50% 할인, 별도 토큰 풀 |
| 빌트인 툴 16종 | Responses만 | `web_search`(+preview), `file_search`(vector_store_ids), `code_interpreter`(container, 메모리 1g–64g, 네트워크 정책), `computer(-use_preview)`, `image_generation`(partial_images, input_fidelity, mask), `mcp`(server_url/connector_id[Dropbox·Gmail·GCal·GDrive·Teams·Outlook·SharePoint]/authorization/allowed_tools/require_approval/defer_loading), `local_shell`, `function_shell`(hosted), `apply_patch`, `custom`(자유형+grammar), `namespace`, `tool_search`, `programmatic_tool_calling` |
| prompt 템플릿 | Responses | 2026-11-30 셧다운 예정 |
| Conversations API | Responses | 영속 `conv_` 객체 |
| context_management | Responses만 | compaction |
| stream obfuscation | Responses | `stream_options.include_obfuscation` |

## H. 모델·capability 매트릭스 (2026-08 현행)

| 모델 | 컨텍스트/출력 | 엔드포인트 | 특이사항 |
|---|---|---|---|
| **gpt-5.6-sol** (= alias `gpt-5.6`) | 1.05M / 128K | Responses, CC, Batch | effort `none/low/medium(기본)/high/xhigh/max`(**minimal 없음**), `reasoning.mode: pro`(Responses 전용), 272K 초과 입력 프리미엄 단가(입력 2×/출력 1.5×), $5/$0.5/$30 per 1M |
| gpt-5.6-terra / gpt-5.6-luna | 동일 | 동일 | 균형형 / 저비용 |
| gpt-5-pro / gpt-5.4-pro | — | **Responses 전용** (CC 404) | multi-turn 내부 추론 |
| computer-use, deep research 계열 | — | Responses 전용 | |
| gpt-audio-1.5 | — | CC | audio in/out |
| 구세대 (gpt-5-2025-08-07, o3 등) | — | — | 2026-12-11 스냅샷 셧다운 공지 |

**capability 제약 핵심**: reasoning 모델은 `temperature`/`top_p`/penalties/`logit_bias` 400 거부 → 모델별 파라미터 게이트 필수 (Anthropic §9와 동일 패턴). `stop`은 o3/o4-mini 미지원. `max_tokens` deprecated → `max_completion_tokens`(CC)/`max_output_tokens`(Responses). effort 지원 레벨이 모델×API 표면별로 다름.

## I. 버전 / 베타 메커니즘

- URL 고정 `v1` — 날짜 기반 API 버저닝 없음. 진화는 **모델 스냅샷 + additive 파라미터**
- 인증: `Authorization: Bearer` (+ `OpenAI-Organization`, `OpenAI-Project`)
- 베타 게이팅: 현행은 주로 모델 단위(preview)와 파라미터 단위. Responses는 베타 헤더 불요
- deprecation 정책: GA 모델 최소 6개월, 특화 변형 3개월, **preview 모델은 2주 통보** → 게이트웨이는 preview 모델 의존 금지, 스냅샷 핀 + 폴백 체인 권장
- 전례: Assistants API 2026-08-26 셧다운, v1/prompts 2026-11-30, gpt-3.5/4 구 스냅샷 2026-10-23

## 결론: IR 표준 필드 후보 vs providerOptions.openai 후보

### IR 표준 후보

| IR 필드 | OpenAI 매핑 |
|---|---|
| model / system(instructions) / messages(items, **순서 보존 + opaque passthrough**) | `model`, `instructions`, `input[]` |
| **reasoning 블록 (opaque, `encrypted_content` 왕복)** | `reasoning` item — **Anthropic thinking signature와 동형 개념. IR 1급 보존 필수** |
| maxOutputTokens / temperature / topP | 모델별 reject 정책 동반 |
| tools(function)+strict / toolChoice / parallelToolCalls | |
| responseFormat(json_schema/strict) | `text.format` |
| reasoningEffort | `reasoning.effort` (3사 공통 개념) |
| 스트림 이벤트 (item 경계 + typed delta + usage-at-end + sequence_number) | Responses semantic events가 IR 스트림 모델의 기준형으로 적합 |
| usage {input, output, cachedInput, reasoning} | `*_tokens_details` |
| stop/finish reason | `status` + `incomplete_details` / CC `finish_reason` |
| 멀티모달 part {text, image(url/base64/fileId), file} | `input_text/input_image/input_file` |
| metadata / 에러 정규형 | |

### providerOptions.openai 후보

`store`(+conversation/previous_response_id), `background`, `include[]`, `reasoning.summary/context/mode`, `text.verbosity`, `service_tier`, `truncation`, `context_management`, `prompt_cache_key/options/retention`, `safety_identifier`, `prompt`(템플릿), `stream_options.include_obfuscation`, `max_tool_calls`, 빌트인 툴 16종 + 결과 item 타입들, CC 전용(`seed`, `logit_bias`, `n`, penalties, `stop`, `prediction`, `audio`/`modalities`, `web_search_options`), `top_logprobs`, `moderation`.

**게이트웨이 강제 정책 권고**: 아웃바운드 기본 `store: false` 고정 (encrypted reasoning을 IR에 실어 왕복) · `previous_response_id`/`conversation`은 opt-in passthrough · reasoning 모델 sampling 파라미터 자동 drop 여부는 명시적 설정으로.

**한계 고지**: shell 계열 스트리밍 이벤트 wire 문자열은 SDK 클래스명 기반 추정(신규), `ultrafast` tier는 SDK에만 확인 — 구현 직전 스트리밍 레퍼런스 재확인 권장.
