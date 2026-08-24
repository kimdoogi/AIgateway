# Native IR 가이드 — 게이트웨이 고유 형식으로 호출하기

> 대상: API 소비자 (포털에서 키를 발급받았거나 관리자에게 받은 사람).
> 이 문서는 사용 가이드다 — 구현과 불일치하면 [스펙 ir-v0.md](../specs/ir-v0.md)가 우선한다.

## 왜 native IR인가

이 게이트웨이는 OpenAI 호환(`/compat/openai/...`)·Anthropic 호환(`/compat/anthropic/...`) 형식도 받지만,
호환 형식은 각 포맷의 표현력에 갇힌다 (OpenAI CC에는 reasoning 슬롯이 없고, Messages에는 폴백 체인이 없다).
**native IR은 게이트웨이의 canonical 형식**이라 전 기능이 노출된다:

- 4사(anthropic·openai·google·xai) 어디로든 같은 요청 — 프로바이더 고유 기능은 `providerOptions`로
- **대화 중간 모델 교체** — claude로 시작한 대화를 gpt가 이어받는다
- **폴백 체인** — 1차 타깃 장애 시 무중단 전환
- 스트림 **재개**(단선돼도 이어받기)와 **취소**(과금 중단)
- 조용한 변조 없음 — 드롭·클램프·강등은 전부 `warnings`로 보고된다

## 빠른 시작

```bash
# 비스트림
curl https://<gateway>/v0/responses \
  -H "authorization: Bearer gwk_..." \
  -H "content-type: application/json" \
  -d '{
    "version": "0",
    "model": "claude-haiku-4-5",
    "maxOutputTokens": 256,
    "messages": [
      { "role": "user", "blocks": [ { "type": "text", "text": "안녕!" } ] }
    ]
  }'

# 스트림 (SSE) — "stream": true만 추가
curl -N https://<gateway>/v0/responses -H "authorization: Bearer gwk_..." \
  -H "content-type: application/json" \
  -d '{ "version":"0", "model":"gpt-5.6-luna", "maxOutputTokens":256, "stream":true,
        "messages":[{ "role":"user", "blocks":[{ "type":"text", "text":"안녕!" }] }] }'
```

## 인증과 공통 헤더

| | |
|---|---|
| 인증 | `authorization: Bearer gwk_...` (가상 키). 게이트웨이가 개방 모드로 떠 있으면 생략 |
| 요청 상관관계 | 모든 응답에 `x-gateway-request-id: req_...` — 문의·재개·취소에 이 값을 쓴다 |
| 키에 빈도 한도가 있으면 | `x-ratelimit-limit` / `x-ratelimit-remaining`, 초과 시 429 + `retry-after` |
| 본문 상한 | JSON 10MB (초과 413) |

## 요청 envelope

최상위 미지 키는 **400**이다 (오타가 조용히 무시되지 않는다). 전체 필드:

| 필드 | 타입 | 설명 |
|---|---|---|
| `version` | `"0"` | 필수 |
| `model` | string | 필수 — 접두로 라우팅 (아래 표) |
| `fallbackModels` | string[] | 폴백 체인 — 순서 = 시도 순서 |
| `messages` | Message[] | 필수, 1개 이상 |
| `tools` / `toolChoice` / `parallelToolCalls` | | 툴 (아래 절) |
| `maxOutputTokens` `temperature` `topP` `topK` `stopSequences` `seed` `presencePenalty` `frequencyPenalty` | | 샘플링 — 타깃 미지원 값은 드롭+warning |
| `responseFormat` | `{type:"text"}` \| `{type:"json", schema?, name?, strict?}` | 구조화 출력 |
| `reasoning` | `{effort?}` | `none·minimal·low·medium·high·xhigh·max` (아래 절) |
| `metadata` | `{userId?, ...}` | userId는 프로바이더 사용자 식별 필드로 매핑 |
| `stream` | boolean | SSE 스트림 |
| `streamOptions` | `{includeRaw?, heartbeatSeconds?}` | raw 프로바이더 이벤트 병행 수신 / heartbeat 주기(최대 3600s) |
| `retarget` | `{reasoning?}` | 타사 reasoning 이식 정책: `drop`(기본)·`demote-to-text`·`strip-and-annotate` |
| `strictParameters` | boolean | true면 드롭+warning 대신 **400** |
| `allowUnknownProviderOptions` | boolean | PO 미지 키를 통과+warning (기본은 400) |
| `providerOptions` | `{<provider>: {...}}` | 프로바이더 고유 기능 (아래 절) |
| `passthroughParams` | `{provider, params, headers?, pinned?}` | wire body 직접 병합 — 최후 수단 |

### 모델 라우팅

모델 이름 접두로 프로바이더가 정해진다. 별도 등록 없이 새 스냅샷 id도 접두만 맞으면 라우팅된다.

| 접두 | 프로바이더 | 예 |
|---|---|---|
| `claude-` | anthropic | `claude-haiku-4-5`, `claude-opus-5` |
| `gpt-` `chatgpt-` `o<n>` | openai | `gpt-5.6-luna` (Responses 주 표면, audio류는 CC) |
| `gemini-` | google | `gemini-3.7-flash` |
| `grok-` | xai | `grok-4.6` |

모델별 제약(reasoning 모델의 temperature 거부 등)은 게이트웨이가 사전에 걸러 드롭+warning 하거나,
`strictParameters: true`면 400으로 알려준다.

## 메시지와 블록

메시지는 `role` + `blocks`(1개 이상). 텍스트도 블록이다 — 이 구조라서 멀티모달·툴·추론이 한 배열에 섞인다.

| role | 허용 블록 |
|---|---|
| `system` | text, passthrough |
| `user` | text, file, toolResult, custom, passthrough |
| `assistant` | text, reasoning, toolCall, toolResult(서버툴), file, source, custom, passthrough |
| `tool` | toolResult, passthrough |

### 블록 8종 요약

```jsonc
{ "type": "text",      "text": "..." }
{ "type": "reasoning", "text": "...", "opaqueState": { "provider": "...", "data": "..." } } // 서명·암호화 상태
{ "type": "toolCall",  "toolCallId": "...", "toolName": "...", "input": { "type": "json", "value": {...} } }
{ "type": "toolResult","toolCallId": "...", "toolName": "...", "output": { "type": "text", "text": "..." } }
{ "type": "file",      "mediaType": "image/png", "data": { "type": "base64", "data": "..." } }
{ "type": "source",    "sourceType": "url", "url": "..." }        // 서버 웹서치 출처 (응답 방향)
{ "type": "custom",    "kind": "anthropic.<...>", "payload": {} } // 프로바이더 고유 블록 (왕복 보장)
{ "type": "passthrough", "provider": "...", "raw": {} }           // 게이트웨이가 모르는 블록 (보존)
```

`file.data`는 `base64` · `url` · `text` · `reference` 4형.
`reference`는 `{ "refs": { "gateway": "gwf_..." } }`로 게이트웨이 파일 id를 쓰면
타깃 프로바이더의 실제 파일 id로 자동 치환된다 (`POST /v0/files`로 업로드).
타깃에 해당 파일이 없으면 조용히 넘어가지 않고 400으로 재업로드를 안내한다.

### 툴 호출 루프 (왕복 예시)

```jsonc
// ① 요청: 함수 툴 정의
{ "version": "0", "model": "claude-haiku-4-5", "maxOutputTokens": 512,
  "tools": [ { "type": "function", "name": "get_weather",
               "inputSchema": { "type": "object", "properties": { "city": { "type": "string" } } } } ],
  "messages": [ { "role": "user", "blocks": [ { "type": "text", "text": "서울 날씨?" } ] } ] }

// ② 응답 message.blocks에 toolCall이 온다 → 직접 실행한 뒤
// ③ 히스토리에 [②의 message 그대로] + [tool 롤 결과]를 붙여 재요청
{ "role": "tool", "blocks": [ { "type": "toolResult", "toolCallId": "<②의 id>",
    "toolName": "get_weather", "output": { "type": "text", "text": "맑음, 27도" } } ] }
```

프로바이더 서버가 실행하는 툴(웹서치 등)은 `{ "type": "provider", "id": "anthropic.web_search", "args": {...} }`.
`id`는 `{provider}.{tool}` 형식이고 타깃 프로바이더와 일치해야 한다.

## 응답 envelope

```jsonc
{
  "version": "0",
  "id": "req_...",                          // = x-gateway-request-id
  "created": "2026-08-24T12:00:00.000Z",
  "model": { "requested": "claude-haiku-4-5",
             "resolved": { "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "surface": "messages" } },
  "message": { "role": "assistant", "blocks": [ ... ], "origin": { ... } },
  "finishReason": { "unified": "stop", "raw": "end_turn" },
  "usage": { "input":  { "total": 12, "noCache": 12, "cacheRead": 0, "cacheWrite": 0 },
             "output": { "total": 4, "text": 4, "reasoning": 0 },
             "totalTokens": 16, "raw": { ... } },               // raw = 프로바이더 원문 (재계산 근거)
  "billing": { "lineItems": [ { "kind": "tokens", "sku": "anthropic:...:input", "quantity": 12,
                                "unitCost": 1.0, "cost": 0.000012 } ],
               "total": 0.000032, "currency": "USD" },          // unitCost는 USD/1M tokens
  "warnings": [],                                                // 항상 배열
  "gateway": { "requestId": "req_...", "providerRequestId": "msg_...",
               "attempts": [ ... ] }                             // 리트라이·폴백 발생 시 시도 이력
}
```

`finishReason.unified`는 닫힌 집합: `stop · length · tool_call · content_filter · refusal · paused · tool_error · error · other`.
프로바이더 원문은 `raw`에 항상 보존된다.

### warnings — 조용한 변조 금지

게이트웨이가 요청을 손댄 모든 지점이 여기 보고된다. 자주 보게 될 코드:

| code | 의미 |
|---|---|
| `parameter-dropped` / `parameter-clamped` | 타깃 미지원 파라미터 드롭 / 값 클램프 (effort 등) |
| `reasoning-dropped` / `reasoning-demoted` | 타사 reasoning 블록 처리 (retarget 정책) |
| `surface-switched` | 표면 전환 (캐시 미스·reasoning 연속성 소실 가능) |
| `fallback-target-switched` | 폴백 체인이 다음 타깃으로 넘어감 |
| `billing-price-estimated` | 가격표 미등재 모델 — billing이 근사값 |
| `budget-soft-warning` | 키의 soft 예산 도달 |

`warnings`를 로그에 남겨두면 "왜 결과가 미묘하게 다르지"의 답이 대부분 여기 있다.

## 스트리밍

`"stream": true`면 SSE. 프레임 규칙: `event:` = 이벤트 타입, `id:` = `seq`(0부터 단조 증가), `data:` = 이벤트 JSON.

```
event: stream-start        ← 항상 첫 이벤트 (게이트웨이 warnings 동봉)
event: response-metadata   ← id·resolved 모델
event: text-start / text-delta / text-end          ← id 기반 블록 스코프
event: reasoning-start / reasoning-delta / reasoning-end
event: tool-input-start / -delta / -end → tool-call ← 완성본 재전송 (delta 무시하고 이것만 받아도 됨)
event: usage-interim / warning / heartbeat / provider-switched
event: finish | error-final | error-partial        ← 터미널 (반드시 온다)
```

- **finish**: 정상 종결 — usage·billing·(폴백 시) attempts 동봉
- **error-final**: 기방출분 무효
- **error-partial**: 기방출분은 유효. `willRetry: true`면 터미널이 **아니고** 폴백 타깃으로 이어진다
  (`provider-switched` 후 새 타깃의 이벤트가 계속 온다)

### 재개와 취소

```bash
# 단선됐다 — 마지막으로 받은 seq 이후부터 재생 + 라이브 테일
curl -N https://<gateway>/v0/streams/req_XXXX \
  -H "authorization: Bearer gwk_..." -H "Last-Event-ID: 42"

# 취소 — 즉시 업스트림 중단 (과금 중단)
curl -X POST https://<gateway>/v0/streams/req_XXXX/cancel -H "authorization: Bearer gwk_..."
```

- 연결이 끊겨도 **30초(grace)** 동안 업스트림을 유지하며 버퍼링한다 — 그 안에 재접속하면 이어서 라이브
- 종료된 스트림 버퍼는 **5분** 보관 (만료 후 410)
- 재개·취소는 스트림을 만든 계정(테넌트)만 가능 — 남의 것은 410

## 대화 중간 모델 교체

핵심 사용법: **응답의 `message`를 그대로 히스토리에 붙이고 `model`만 바꾼다.**

```jsonc
// 1턴 — claude
{ "version":"0", "model":"claude-haiku-4-5", ... }
// → 응답 response1

// 2턴 — gpt가 이어받기: response1.message를 통째로 넣는다
{ "version": "0", "model": "gpt-5.6-luna", "maxOutputTokens": 256,
  "messages": [
    { "role": "user", "blocks": [ { "type": "text", "text": "1턴 질문" } ] },
    response1.message,                                    // ← 그대로
    { "role": "user", "blocks": [ { "type": "text", "text": "이어지는 질문" } ] }
  ] }
```

게이트웨이의 재타게팅 패스가 자동 처리하는 것:

- 같은 프로바이더로 돌아가면 서명·암호화 상태(`opaqueState`)·원문 item을 **바이트 그대로 복원** (무손실)
- 다른 프로바이더로 가면 타사 reasoning은 `retarget.reasoning` 정책대로 (기본 drop + warning)
- 고아 툴 쌍(결과 없는 toolCall 등)은 프로바이더 400의 원인이라 수리 + warning
- 타깃에 적용 불가한 서버 상태 참조(previousResponseId 등)는 드롭 + warning

## 폴백 체인

```jsonc
{ "model": "claude-haiku-4-5", "fallbackModels": ["gpt-5.6-luna", "gemini-3.7-flash"], ... }
```

- 진행 조건: 프로바이더 귀책의 일시 장애(rate_limit·overloaded·provider_error·timeout 등 `fallbackEligible`)
  일 때만. 400류·취소는 폴백하지 않는다
- 같은 타깃 리트라이(백오프·Retry-After 존중)를 소진한 뒤에 다음 타깃으로
- 스트림은 **콘텐츠 방출 전 실패만** 무중단 전환 — 이미 받은 텍스트가 있으면 전환하지 않는다 (중복 방출 금지)
- 시도 이력은 `gateway.attempts`(비스트림) / `finish.attempts`(스트림)에: `success · failed · skipped`
- 자격증명 없는 타깃, `pinned` passthrough와 불일치하는 타깃은 `skipped`

## providerOptions — 프로바이더 고유 기능

네임스페이스 키(`anthropic`·`openai`·`google`·`xai`) 아래에 넣는다. **타깃 프로바이더 것만 소비**되고
나머지 네임스페이스는 무시된다(에러 아님) — 그래서 히스토리에 여러 프로바이더의 PO가 섞여 있어도 안전하다.

```jsonc
"providerOptions": {
  "anthropic": { "thinking": { "type": "enabled", "budget_tokens": 2048 },
                 "serviceTier": "standard_only", "betas": ["..."] },
  "openai":    { "surface": "chat-completions",        // 표면 강제
                 "store": true, "previousResponseId": "resp_...",
                 "reasoning": { "summary": "auto" }, "textVerbosity": "low" },
  "google":    { "thinkingConfig": { "thinkingBudget": 1024 },  // 2.5세대 예산 지정
                 "cachedContent": "cachedContents/...", "safetySettings": [ ... ] },
  "xai":       { "xGrokConvId": "...", "store": true }
}
```

- 블록 단위 PO도 있다: 예) anthropic 캐시 브레이크포인트 `"providerOptions": { "anthropic": { "cacheControl": { "type": "ephemeral" } } }`
- 네임스페이스 안의 **미지 키는 400** — 신기능을 먼저 쓰려면 `allowUnknownProviderOptions: true`로 통과시키면 warning과 함께 wire에 실린다
- 그래도 안 되는 최후 수단이 `passthroughParams`(wire body 직접 병합). 게이트웨이 조립 키와 충돌하면 400

## reasoning effort

`reasoning.effort`는 4사 공통 축이다: `none < minimal < low < medium < high < xhigh < max`.

- 모델이 지원하지 않는 값은 **최근접**으로 클램프 + warning
- 단 `none`(추론 끄기)은 경계를 넘지 않는다 — 표현 불가 모델이면 켜지 않고 드롭+warning
  (끄기 요청이 켜기+과금으로 반전되지 않게)
- `strictParameters: true`면 클램프 대신 400

## 에러 모델

에러는 항상 같은 형태다:

```jsonc
{ "error": { "category": "rate_limit", "httpStatus": 429, "message": "...",
             "retryAfter": 29,                    // 초 — 있으면 그만큼 쉬고 재시도
             "fallbackEligible": true, "billed": false,
             "provider": { "key": "anthropic", "status": 429, "code": "..." } } }
```

| category | 뜻 · 대응 |
|---|---|
| `invalid_request` 400 | 요청 자체 문제 — 재시도 무의미 |
| `auth` 401 / `permission` 403 | 키 문제 |
| `rate_limit` 429 | 분당 한도 — `retryAfter` 후 재시도. `provider.key: "gateway"`면 게이트웨이 자체 한도 |
| `quota_exhausted` 429 | 일일/잔액 소진 — 백오프 무의미, 폴백 적격 |
| `budget_exceeded` 402 | 키의 hard 예산 초과 — 다음 기간까지 차단 |
| `overloaded` / `provider_error` / `timeout` | 프로바이더 일시 장애 — 폴백 적격 |
| `content_too_large` 413 | 컨텍스트/본문 초과 |

**한도에 막혀도 자기 상태 조회는 항상 된다**: `GET /v0/usage` (Bearer 키) — 예산·지출·rpm·차단 여부.
429/402의 원인을 보는 창구라 쿼터를 소모하지 않는다.

## 나머지 엔드포인트

| 엔드포인트 | 용도 |
|---|---|
| `POST /v0/count-tokens` | 호출 전 입력 토큰 수 (anthropic·google. 그 외 501) |
| `POST /v0/files` → `gwf_` | 파일 업로드 → `refs.gateway`로 참조 (타깃 프로바이더 명시) |
| `POST /v0/batches` → `gwb_` | 비동기 배치 (단일 프로바이더, customId 매핑, 50% 할인 SKU) |
| `GET /v0/streams/:id` / `POST .../cancel` | 스트림 재개 / 취소 |
| `GET /v0/usage` | 내 키 상태 (한도 면제) |
| `/compat/openai/v1/chat/completions` `/compat/anthropic/v1/messages` | 호환 인바운드 — 실행은 native와 동일 경로. 응답의 `gateway.ir` 확장에 IR 원본이 실려 온다 |

## 부록 — 자주 하는 실수

- **`version: "0"` 누락** → 400. envelope 필수 필드다
- **assistant 히스토리를 손으로 재조립** — 하지 말 것. 응답 `message`를 그대로 쓰면 서명 왕복까지 자동이다
- **warnings 무시** — 드롭·클램프가 전부 여기 온다. 최소한 로그에는 남길 것
- **미지 최상위 키** → 400은 의도된 동작 (D5). 프로바이더 고유 키는 최상위가 아니라 `providerOptions.<provider>` 아래로
- **스트림 소비 시 `error-partial.willRetry` 미확인** — true면 끝이 아니다. 폴백이 이어진다
