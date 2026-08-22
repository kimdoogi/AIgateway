# 부록 (a) — compat 인바운드 어댑터 명세 (openai-compat CC · anthropic-compat Messages)

- 상태: **확정** (2026-08-21 — 로드맵 4 compat 인바운드 구현 차단 해소, ir-v0 §13.4/§16-2a의 세부)
- 상위 규범: [ir-v0 §13.4](ir-v0.md) (왕복 규약 핵심 4항) · [ADR-0002](../decisions/ADR-0002-openai-outbound-responses-api.md)(표면 sticky)
- 구현: `src/inbound/openai-compat/` · `src/inbound/anthropic-compat/` + 서버 라우트

## 0. 원칙

1. **인바운드 어댑터도 순수 변환**: wire 요청 → `IRRequest`, `IRResponse`/IR 스트림 → wire 응답. 실행은 native와 같은 게이트웨이 경로(execute·startStreamSession)를 탄다 — 미터링·예산·가드레일 우회 없음 (G1).
2. **raw 우선 복원**: 응답 다운컨버트에서 `origin.provider`가 인바운드 포맷의 소유 프로바이더와 같으면 raw 값(finishReason.raw, usage.raw)을 우선 복원한다. 다르면 unified → 다운컨버트 표(§4·§5).
3. **미지 최상위 키 = 4xx** (D5) — native와 동일. 단 인바운드 포맷의 자체 필드는 그 포맷의 알려진 집합 기준.

## 1. 엔드포인트

| 포맷 | 경로 | 스트림 |
|---|---|---|
| anthropic-compat | `POST /compat/anthropic/v1/messages` | Anthropic SSE 이벤트 재합성 |
| openai-compat CC | `POST /compat/openai/v1/chat/completions` | `chat.completion.chunk` + `[DONE]` |

모델 라우팅은 native와 동일(`model` → 레지스트리) — anthropic-compat로 GPT를, openai-compat로 Claude를 호출할 수 있다 (이것이 compat 인바운드의 존재 이유).

## 2. gateway 확장 필드 (§13.4-1 상세)

### 2.1 openai-compat

- **응답 방향**: assistant message 객체에 `gateway: { ir: Block[] }` 부가 — 해당 턴의 IR 블록 원문 (origin·opaqueState·providerMetadata 포함, §13.1 편입 전 형태). 스트림에서는 마지막 chunk(finish_reason 실린 chunk)의 `choices[0].delta`가 아니라 **별도 최종 chunk의 `choices[0].message_gateway`가 아닌 — `gateway` 키를 최상위에 실은 전용 chunk**를 `[DONE]` 직전에 방출한다: `{ id, object: "chat.completion.chunk", gateway: { ir: [...] } }`.
- **요청 방향 복원 1순위**: assistant 메시지에 `gateway.ir`이 있으면 raw CC 필드(content/tool_calls) 대신 이를 IR 블록으로 직접 복원 (zod 검증 후). 검증 실패는 4xx (조용한 폴백 금지 — 절반 복원이 더 위험).
- **warnings·providerMetadata** (2026-08-21 리뷰 G2/G4): 비-strict 응답의 `gateway` 확장에 `warnings: Warning[]`(드롭·클램프 보고 — 출구에서 소멸시키면 D5가 무력화된다)와 `providerMetadata`(container 등 응답 레벨 PM — CC wire에 자리 없음)를 싣는다. 스트림에서는 [DONE] 직전 gateway chunk에 동일 필드.
- **strict 모드**: 요청 헤더 `x-gateway-compat: strict` → 응답에 gateway 확장 미부가 (순수 CC 응답). §13.4-4의 보장 하락이 적용된다.

### 2.2 anthropic-compat

- **응답 방향**: 응답 객체 최상위에 `gateway: { origin: Origin }`. 블록 구조는 Anthropic wire가 IR과 1:1이므로 블록 재부착은 불요 — 단 **비-anthropic origin의 reasoning**은 wire `thinking` 블록에 signature가 없으므로 `gateway.origin`이 복원 판단의 근거다.
- **요청 방향**: wire 블록 → IR 블록 정변환(아래 §3). 요청의 assistant 메시지에 `gateway.origin`이 있으면 그 턴의 `Message.origin`으로 복원 — 표면 sticky(ADR-0002)가 이 경로로 성립.
- **strict 모드**: 동일 헤더.
- **container 복원** (2026-08-21): 응답 `providerMetadata.anthropic.container`를 wire 최상위 `container`로, 스트림은 `response-metadata.providerMetadata`를 `message_start.message.container`로 복원 — 코드 실행 샌드박스 재사용 계약. **턴 중 생성·교체분**(Anthropic이 top-level/`message_delta.delta.container`로 후송 — 실관측)은 어댑터가 finish PM으로 실어 `message_delta` 최상위 `container`로 복원 (리뷰 G1).
- **warnings** (2026-08-21 리뷰 G2): 비-strict 응답의 `gateway.warnings`에 IR warnings 전량. 스트림은 warning 이벤트를 누적해 finish의 `message_delta.gateway.warnings`로 — Anthropic SSE에 warning 이벤트 좌석이 없기 때문.
- **message_start usage 원문** (2026-08-21 실테스트): input·cache 토큰은 Anthropic wire 계약상 message_start에서만 오므로, 어댑터가 message_start usage 원문을 `response-metadata.providerMetadata.anthropic.usage`로 실어 스트림 재합성 시 `message_start.message.usage`로 복원한다 — 스텁 0이면 소비자 과금 집계의 input이 0이 된다. 비 anthropic origin(gpt 크로스)은 선두 usage가 없어 스텁 유지 (최종 usage는 message_delta — 소비자가 input을 message_start에서만 읽으면 크로스 턴의 로컬 집계는 0, 정확한 소스는 게이트웨이 원장).
- **usage raw 복원** (2026-08-21 리뷰 G3): `origin.provider == anthropic`이면 정규화 평면값 대신 `usage.raw` 원문을 복원한다 (비스트림 = wire 원문 그대로, 스트림 = message_start·message_delta 병합) — `cache_creation` TTL 내역(5m/1h) 등 정규화 밖 필드의 무손실 왕복. 타 origin은 평면 다운컨버트(§5 표).

## 3. 요청 방향 매핑표

### 3.1 openai-compat CC → IR

| CC 필드 | IR |
|---|---|
| `model` | `model` |
| `messages[].role: system/developer` | system 메시지 (+developer는 `providerOptions.openai.role`) |
| `messages[].content` (string \| parts) | text/file 블록 (image_url→file(url\|base64), input_audio→file(audio/*), file→file(reference\|base64)) |
| `messages[].tool_calls[]` | toolCall 블록 (arguments JSON 파싱, 실패 시 text variant + warning) |
| `messages[] role:tool` | tool 메시지 + toolResult(text) |
| assistant `gateway.ir` | **블록 직접 복원 (1순위)** |
| `max_completion_tokens`/`max_tokens`(deprec) | `maxOutputTokens` |
| `temperature`/`top_p`/`stop`/`seed`/penalties | 표준 필드 |
| `tools[].function` | Tool(function) |
| `tool_choice` | `toolChoice` (`{type:"function"}` → `{type:"tool"}`) |
| `response_format` | `responseFormat` |
| `reasoning_effort` | `reasoning.effort` |
| `stream`/`stream_options` | `stream` (include_usage는 게이트웨이가 항상 보장) |
| `user` | `metadata.userId` |
| `n`, `logit_bias`, `logprobs`, `top_logprobs`, `prediction`, `audio`, `modalities`, `web_search_options`, `service_tier`, `store`, `metadata` | `providerOptions.openai.*` (아웃바운드 어댑터의 동일 키) |
| 미지 키 | 4xx (D5. `allowUnknownProviderOptions` 상당의 opt-in은 헤더 `x-gateway-allow-unknown: true`) |

### 3.2 anthropic-compat Messages → IR

| Anthropic 필드 | IR |
|---|---|
| `model`/`max_tokens`/`system`(top-level) | `model`/`maxOutputTokens`/선두 system 메시지 |
| `messages[].content[]` 블록 | IR 블록 정변환 (text/image→file/document→file/tool_use→toolCall/tool_result→toolResult/thinking→reasoning(+opaqueState)/redacted_thinking) |
| 블록 `cache_control` | 블록 `providerOptions.anthropic.cacheControl` |
| `tools` | Tool(function \| provider `anthropic.*`) |
| `tool_choice` | `toolChoice` (+`disable_parallel_tool_use` → `parallelToolCalls:false`) |
| `temperature`/`top_p`/`top_k`/`stop_sequences` | 표준 필드 |
| `output_config.effort` / `thinking` | `reasoning.effort` / `providerOptions.anthropic.thinking` |
| `metadata.user_id` | `metadata.userId` |
| `service_tier` | `providerOptions.anthropic.serviceTier` |
| 헤더 `anthropic-beta` | `providerOptions.anthropic.betas` |
| 함수 툴 정의·**히스토리 `tool_use` 블록**의 비표준 키 (`allowed_callers`, `caller` 등 PTC/신필드) | `providerOptions.anthropic.wireExtras` — 아웃바운드가 wire 재병합. 조립 키와 충돌 시 드롭 + `warning(parameter-dropped)` (조용한 스킵 금지 — 2026-08-21 리뷰 G5/G6) |
| **미지 top-level 키** (`container`, `context_management`, `mcp_servers`, 베타 신필드) | **`passthroughParams { provider: "anthropic", pinned: true }` 통과가 기본** (2026-08-21 개정 — D10-1 compat passthrough 경로. anthropic-compat는 D10 100% 커버리지 대상이라 4xx가 아닌 원문 통과가 규범. `pinned`라 폴백 시 타 프로바이더는 skipped). openai-compat는 기존대로 4xx/opt-in 드롭 |

### 3.3 providerOptions 부착 경로와 cache-breakpoint-ignored

- anthropic-compat의 `cache_control`은 항상 `providerOptions.anthropic.cacheControl`로 실린다. **타깃이 anthropic이 아니면** 아웃바운드 어댑터는 타 네임스페이스를 무시하므로(§2) 캐시 지시가 조용히 사라진다 — 이를 막기 위해 **인바운드 어댑터가 라우팅 결과를 알 수 없으므로, 재타게팅 패스가 타깃 상이 시 `warning(cache-breakpoint-ignored)`를 낸다** (retarget.ts의 서버 상태 PO 처리와 동일 지점, 데이터 테이블에 `anthropic.cacheControl` 추가).
- openai-compat의 CC 전용 파라미터가 비-openai 타깃으로 가면 아웃바운드 어댑터의 표준 드롭 경로(D5 warning)가 처리한다.

### 3.4 빈 content 메시지 — 2026-08-22 리뷰

`content`가 빈 문자열/빈 배열인 메시지는 **역할과 무관하게 메시지 자체를 생략**한다. IR `MessageSchema.blocks`는 `min(1)`이라 빈 블록 메시지를 만들면 검증 실패로 4xx가 되는데, OpenAI/Anthropic은 빈 system을 정상 수용하므로 게이트웨이만 거부하는 비대칭이 생긴다 (user/assistant에는 이미 적용돼 있었고 system/developer만 빠져 있었다).

## 4. 응답 방향 — finishReason 다운컨버트 표

### 4.1 → CC `finish_reason`

| IR unified | finish_reason | 비고 |
|---|---|---|
| stop | `stop` | |
| length | `length` | |
| tool_call | `tool_calls` | |
| content_filter | `content_filter` | |
| refusal | `stop` | refusal 텍스트는 `message.refusal` 필드로 (CC 규약) |
| paused | `paused` | **비표준 값** + `gateway.finish_reason_raw` 병기 (ir-v0 §9 명시) |
| tool_error / error / other | `stop` + `gateway.finish_reason_raw` | CC에 대응 없음 — raw 보존 |

### 4.2 → Anthropic `stop_reason`

| IR unified | stop_reason |
|---|---|
| stop | `end_turn` (origin이 anthropic이면 raw 그대로 — stop_sequence 등 보존) |
| length | `max_tokens` |
| tool_call | `tool_use` |
| refusal | `refusal` |
| paused | `pause_turn` |
| content_filter / tool_error / error / other | `end_turn` + `gateway.finish_reason_raw` 병기 |

## 5. 응답 방향 — usage 다운컨버트 표

| IR | CC | Anthropic |
|---|---|---|
| input.total | `prompt_tokens` | (합산 전 분해 복원) |
| input.noCache | — | `input_tokens` |
| input.cacheRead | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` |
| input.cacheWrite | — (CC 무표현) | `cache_creation_input_tokens` |
| output.total | `completion_tokens` | `output_tokens` |
| output.reasoning | `completion_tokens_details.reasoning_tokens` | — |
| totalTokens | `total_tokens` | — |

origin 일치 시 usage.raw를 우선 복원 (무손실).

## 6. 스트림 재합성 표

### 6.1 IR → CC chunks

| IR 이벤트 | CC chunk |
|---|---|
| response-metadata | 첫 chunk의 `id`/`model`/`created` + `delta.role:"assistant"` |
| text-start | — (delta로 충분) |
| text-delta | `delta.content` |
| reasoning-* | **드롭** (CC 무표현 — 최종 gateway.ir에는 포함. warning 없음: 포맷 계약) |
| tool-input-start | `delta.tool_calls[{index, id, function:{name, arguments:""}}]` |
| tool-input-delta | `delta.tool_calls[{index, function:{arguments}}]` |
| tool-call | — (delta 누적으로 재현 완료. input.type=text인 경우만 보정 chunk) |
| citation-delta | `delta.annotations` 근사 — v0는 드롭 + 최종 gateway.ir |
| finish | finish_reason chunk → usage chunk → gateway.ir chunk(비-strict) → `[DONE]` |
| error-partial(`willRetry:false`)/error-final | CC 에러 JSON을 SSE data로 (OpenAI 관례) 후 `[DONE]` |
| error-partial(`willRetry:true`) | **종결 금지** — SSE 주석 `: retrying:{category}`만. 폴백 트리가 다음 타깃으로 이어가는 중이므로(§6.4) `[DONE]`을 내보내면 SDK가 스트림을 끊어 폴백 성공분이 통째로 유실된다 |
| provider-switched | SSE 주석 + finish의 `gateway.warnings`에 `fallback-target-switched` (CC wire에 전환 슬롯이 없다 — 조용한 전환 금지, D5) |
| heartbeat/usage-interim/warning | 드롭 (heartbeat는 SSE 주석 `: ping`으로) |
| passthrough/custom/file/source | 드롭 + 최종 gateway.ir에 포함 |

### 6.2 IR → Anthropic SSE

| IR 이벤트 | Anthropic 이벤트 |
|---|---|
| stream-start + response-metadata | `message_start` (usage는 0 스텁 — 최종 usage는 message_delta) |
| text-start/-delta/-end | `content_block_start(text)` / `content_block_delta(text_delta)` / `content_block_stop` |
| reasoning-start/-delta(-opaqueState)/-end | `content_block_start(thinking)` / `thinking_delta`·`signature_delta` / `content_block_stop` |
| tool-input-start/-delta/-end | `content_block_start(tool_use)` / `input_json_delta` / `content_block_stop` |
| citation-delta | `content_block_delta(citations_delta)` |
| finish | `message_delta`(stop_reason·usage) → `message_stop` |
| error-partial(`willRetry:false`)/error-final | `error` 이벤트 |
| error-partial(`willRetry:true`) | **미방출** — 폴백 진행 중이며 터미널이 아니다 (§6.4). `error`를 내면 SDK가 턴을 실패로 종결한다 |
| provider-switched | `ping`(연결 유지) + finish의 `gateway.warnings`에 `fallback-target-switched` |
| heartbeat | `ping` |
| passthrough(provider==anthropic) | 원문 이벤트 복원 |
| 기타 (custom/file/source/provider-switched 등) | 드롭 — `gateway` 확장(§2.2)과 native 재개 API로 보완 |

블록 인덱스: IR 블록 id 등장 순서대로 0부터 재부여 (Anthropic wire는 index 기반).

## 7. 에러 다운컨버트

| | CC | Anthropic |
|---|---|---|
| 형태 | `{"error": {"message", "type", "code"}}` | `{"type":"error","error":{"type","message"}}` |
| category 매핑 | invalid_request→`invalid_request_error`, auth→`authentication_error`, rate_limit→`rate_limit_error`, quota_exhausted→`insufficient_quota`, overloaded→`server_error`(503), 기타 5xx→`server_error` | invalid_request→`invalid_request_error`, auth→`authentication_error`, rate_limit→`rate_limit_error`, overloaded→`overloaded_error`(529), 기타→`api_error` |

httpStatus는 IRError 그대로. `x-gateway-request-id` 헤더는 모든 경로 공통 (ADR-0008).

## 8. v0 구현 범위 밖 (기록)

- CC `n>1` 인바운드: 400 (G2 단일 후보 — drop이 아니라 명시 거부: 응답 형태가 달라지므로).
- anthropic-compat count_tokens/Batches/Files: 부록 (b).
- openai-compat Responses 형식 인바운드(신형): 수요 확인 후 — CC가 호환 생태계의 사실상 표준.
