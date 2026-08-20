# Portkey Gateway 소스 레벨 심층 분석

- 날짜: 2026-08-20
- 분석 대상: `Portkey-AI/gateway` (shallow clone, 2026-08-20 기준 main)
- 분석 관점: AI Gateway 설계 — (1) N+M 어댑터, (2) 대화 중간 모델 교체, (3) 프로바이더 고유 기능 전부 노출
- 관련 문서: [Vercel AI SDK 분석](2026-08-20-vercel-ai-sdk.md) · [LiteLLM 분석](2026-08-20-litellm.md) · [ADR-0001](../decisions/ADR-0001-adapter-architecture.md)

## 전체 구조 한눈에 보기

- 런타임: Hono 기반, Cloudflare Workers / Node / Docker 멀티 런타임 (`src/index.ts`, `wrangler.toml`)
- 라우트: `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/messages`(Anthropic 포맷), `/v1/responses`, files/batches/finetune, 그리고 catch-all `/v1/*` proxy (`src/index.ts:135-295`)
- 프로바이더: `src/providers/`에 **78개** 디렉토리, `src/providers/index.ts`의 `Providers: { [key: string]: ProviderConfigs }` 맵에 등록
- 요청 파이프라인: handler → `tryTargetsRecursively`(라우팅 정책) → `tryPost`(hooks/cache/retry) → `transformToProviderRequest`(요청 변환) → fetch → `responseHandler`(응답/스트림 변환) — `src/handlers/handlerUtils.ts`, `src/handlers/responseHandlers.ts`

## A. 허브 포맷 철학 — "OpenAI 포맷이 canonical"은 사실인가?

**사실이다. 단, 순수한 단일 허브가 아니라 "1.5개 허브" 구조다.**

### 유니버설 시그니처

허브 타입은 `src/types/requestBody.ts`의 `Params` 인터페이스다. 필드 구성이 OpenAI Chat Completions 요청 바디의 슈퍼셋임: `model`, `messages: Message[]`, `tools`, `tool_choice`, `response_format`, `logprobs`... 여기에 비-OpenAI 확장이 그대로 병합돼 있다:

```ts
// src/types/requestBody.ts (Params)
safety_settings?: any;          // Google Vertex 전용
anthropic_beta?: string;        // Anthropic 전용
anthropic_version?: string;
thinking?: { type?: string; budget_tokens: number };  // Anthropic 스타일
reasoning_effort?: ...          // OpenAI 스타일
```

응답 허브는 `src/providers/types.ts`의 `ChatCompletionResponse`(OpenAI chat.completion 형태 + `provider`, `citations`, usage에 `cache_read_input_tokens`/`cache_creation_input_tokens` 확장).

**어댑터 방향은 항상 "OpenAI-슈퍼셋 → 프로바이더"(요청) / "프로바이더 → OpenAI-슈퍼셋"(응답)**. OpenAI 어댑터 자체는 사실상 항등 매핑이다(`src/providers/openai/chatComplete.ts`의 `OpenAIChatCompleteConfig`는 param 이름 그대로 whitelist, `OpenAIChatCompleteResponseTransform`은 에러 매핑 빼면 `return response`).

### 두 번째 허브: `/v1/messages`

`src/index.ts:135`에 **Anthropic Messages 포맷의 인바운드 라우트가 별도로 존재**한다(`messagesHandler` → `fn: 'messages'`). 각 프로바이더는 `messages`라는 별도 endpoint config를 가질 수 있고:

- `src/providers/anthropic/messages.ts` — 사실상 passthrough (`anthropic-base/messages.ts`의 `messagesBaseConfig` 재사용, 응답도 그대로 반환)
- `src/providers/google-vertex-ai/messages.ts` — Vertex 위의 Claude에 passthrough + `anthropic_version` 주입
- `src/providers/bedrock/messages.ts` — **Anthropic Messages 포맷 → Bedrock Converse 포맷 완전 변환** (`BedrockConverseMessagesConfig`), 응답은 `BedrockMessagesResponseTransform`으로 Converse → Anthropic 포맷 역변환, 스트림은 `BedrockConverseMessagesStreamChunkTransform`이 Converse 청크를 Anthropic SSE 이벤트(`message_start`/`content_block_start`/...)로 재합성

즉 Claude Code 같은 Anthropic-native 클라이언트를 Bedrock/Vertex로 라우팅하는 유스케이스를 위해 Anthropic 포맷도 제한적 허브로 승격시켰다. 단 Gemini·OpenAI로 가는 `messages` 변환은 없다 — N×M을 피하려던 구조가 클라이언트 수요 때문에 부분적으로 2×M이 된 것.

### "욱여넣기" 구체 사례 (OpenAI에 없는 기능의 확장 방법)

Portkey의 확장 전략은 3가지다:

1. **`Params`에 필드 자체를 추가** — `thinking`, `anthropic_beta`, `safety_settings`. 어댑터가 알아서 집어간다. Gemini 어댑터조차 Anthropic 스타일 `thinking.budget_tokens`를 받아 `generationConfig.thinking_config`로 변환한다 (`src/providers/google/chatComplete.ts:82-89`) — 즉 프로바이더 A의 확장 필드가 사실상 허브 필드가 되어 프로바이더 B가 재해석함.
2. **메시지/툴 객체에 인라인 확장** — `PromptCache` 인터페이스(`cache_control?: { type: 'ephemeral' }`)를 `Message`, `ContentType`, `Tool`이 모두 extends (`src/types/requestBody.ts:329-331, 414`). Anthropic 어댑터는 system/text/tool/tool_call 각 위치의 `cache_control`을 찾아 옮긴다 (`src/providers/anthropic/chatComplete.ts:304-307, 345-357, 385-387`). Bedrock은 같은 필드를 `cachePoint: { type: 'default' }`로 변환 (`src/providers/bedrock/messages.ts:56-62`). `Function`에는 Anthropic 베타 필드 `defer_loading`, `allowed_callers`, `input_examples`까지 침투해 있다 (`src/types/requestBody.ts:366-384`).
3. **`strictOpenAiCompliance` 플래그(기본 true)로 응답 확장 게이팅** — `x-portkey-strict-open-ai-compliance: false`일 때만:
   - `choices[].message.content_blocks` — Anthropic thinking/서명 블록, Gemini thinking을 담는 확장 배열 (`src/providers/anthropic/chatComplete.ts:597-601`, `src/providers/google/chatComplete.ts:673-693`)
   - `finish_reason`을 OpenAI enum으로 접지 않고 프로바이더 원문 그대로 반환 (`src/providers/utils.ts:73-84` `transformFinishReason` — strict일 때 매핑, non-strict일 때 원문 통과)
   - `tool_calls[].function.thought_signature` (Gemini 서명, `src/providers/google/chatComplete.ts:665-668`)
   - `groundingMetadata` (Gemini 검색 grounding, `src/providers/types.ts:210-238`)
   - usage의 `cache_read_input_tokens`/`cache_creation_input_tokens`는 strict 여부와 무관하게 항상 부가 (`src/providers/types.ts:188-193`)

**장점이 코드에 드러나는 방식**: OpenAI-호환 프로바이더(Groq, Together, Fireworks 등 수십 개)는 `src/providers/open-ai-base/index.ts`의 `chatCompleteParams(exclude, defaults, extra)` / `responseTransformers()` 팩토리로 수십 줄이면 완성된다. 진짜 N+M이 성립하는 구간이다.

**단점이 드러나는 방식**: (1) `Params`가 모든 프로바이더 확장의 쓰레기장이 됨(주석으로 `// Anthropic specific` 표시하며 무한 증식), (2) `content_blocks`처럼 OpenAI 스키마에 없는 준-표준을 자체 발명해야 함, (3) 허브에 없는 정보는 응답→요청 왕복 시 소실됨(아래 E).

## B. 어댑터 모듈 구조 — 프로바이더 1개 추가 시 작성하는 것

프로바이더 = `ProviderConfigs` 객체 1개 (`src/providers/types.ts:149-160`). 구성 요소:

```
src/providers/<name>/
  api.ts          → ProviderAPIConfig  (getBaseURL, headers, getEndpoint, [transformToFormData, getProxyEndpoint])
  chatComplete.ts → <Name>ChatCompleteConfig: ProviderConfig      (요청 변환 — 선언적 파라미터 맵)
                    <Name>ChatCompleteResponseTransform           (비스트림 응답 변환)
                    <Name>ChatCompleteStreamChunkTransform        (SSE 청크 변환)
  embed.ts / complete.ts / imageGenerate.ts ...                   (endpoint별 동일 패턴)
  types.ts        → 프로바이더 응답 타입 + STOP_REASON enum
  index.ts        → 위를 ProviderConfigs로 조립
```

### 핵심 타입 (`src/providers/types.ts`)

- **`ProviderConfig`** = `{ [openAIParamName]: ParameterConfig | ParameterConfig[] }`. `ParameterConfig` = `{ param: string(타깃 키, dot-path 지원), default?, min?, max?, required?, transform?: (params, providerOptions) => any }`. 하나의 소스 필드가 배열로 여러 타깃을 만들 수 있음 — Anthropic의 `messages: [ {param:'messages',...}, {param:'system',...} ]`이 대표 사례 (`src/providers/anthropic/chatComplete.ts:274-367`).
- 이 선언을 실행하는 범용 엔진이 `src/services/transformToProviderRequest.ts`의 `transformUsingProviderConfig()` — whitelist 순회 + `setNestedProperty()`로 타깃 조립. **config에 없는 인바운드 필드는 조용히 버려진다.**
- **응답/스트림**: `index.ts`의 `responseTransforms: { chatComplete, 'stream-chatComplete', complete, messages, 'stream-messages', ... }`. 스트림 transform 시그니처는 `(chunkString, fallbackId, streamState, strictOpenAiCompliance, gatewayRequest) => string | string[] | undefined`.
- **`getConfig`(동적 디스패치)**: Vertex처럼 모델명으로 하위 어댑터를 고르는 프로바이더용. `src/providers/google-vertex-ai/index.ts:64-204`가 `getModelAndProvider(params.model)`로 `google | anthropic | meta | endpoints | mistralai` 분기 — Vertex-Claude는 `VertexAnthropicChatCompleteConfig = { ...AnthropicChatCompleteConfig, anthropic_version: {...}, model: {transform: () => undefined} }`처럼 **Anthropic 어댑터를 스프레드 상속**한다 (`src/providers/google-vertex-ai/chatComplete.ts:395-416`).
- **`requestHandlers`**: fetch 파이프라인 자체를 대체하는 탈출구 (Vertex 파일 업로드 등, `src/providers/google-vertex-ai/index.ts:205-210`).

### 실측: anthropic 디렉토리

`api.ts`(43줄) / `chatComplete.ts`(832줄 — 요청 config + 응답 + 스트림 transform 전부) / `complete.ts` / `messages.ts`(22줄, passthrough) / `types.ts`(32줄, `AnthropicStreamState`, `ANTHROPIC_STOP_REASON`) / `index.ts`(34줄). `getAnthropicChatCompleteResponseTransform(provider)`가 **팩토리**인 이유: Bedrock/Vertex가 provider 라벨만 바꿔 재사용하기 위함.

### 실측: google (Gemini AI Studio)

`api.ts` / `chatComplete.ts`(892줄) / `embed.ts` / `index.ts` / `types.ts`. 특징: OpenAI 파라미터 8개(`temperature`, `top_p`, `max_tokens`, `stop`, `response_format`, `thinking`, `seed`...)가 전부 `param: 'generationConfig'`를 가리키고 같은 `transformGenerationConfig(params)`를 호출 — 엔진이 마지막 값으로 덮어쓰므로 결과는 맞지만 **같은 변환이 파라미터 개수만큼 중복 실행**된다 (`src/providers/google/chatComplete.ts:375-506`). 선언적 1:1 매핑 모델이 "여러 소스 → 한 타깃 객체" 케이스와 안 맞아서 생긴 워크어라운드다.

## C. 스트리밍 변환 파이프라인

경로: `handleStreamingMode()` → `readStream()` / `readAWSStream()` → 프로바이더별 `...StreamChunkTransform` (`src/handlers/streamHandler.ts`).

1. **청크 경계 분리**: `getStreamModeSplitPattern(provider, requestURL)` (`src/utils.ts:14-`)이 프로바이더별 구분자를 반환 — 기본 `\n\n`, Google `\r\n`, Perplexity `\r\n\r\n`, Vertex는 URL에 `/publishers/google` 포함 여부로 다시 분기. **하드코딩된 프로바이더 지식이 공용 유틸에 새어 있는 지점.**
2. **버퍼링 루프**: `readStream()`은 TextDecoder로 누적하며 splitPattern 기준으로 완성된 이벤트 단위만 transform에 넘긴다. `streamState = {}` 객체를 루프 스코프에 만들어 **모든 청크 변환 호출에 같은 레퍼런스로 전달** — 이것이 상태 관리의 전부다(타입은 프로바이더가 임의 정의). Bedrock은 SSE가 아니라 AWS eventstream 바이너리 프레이밍이라 별도 경로 `readAWSStream()`이 `readUInt32BE`로 프레임 길이를 읽고 base64 payload를 푼다 (`src/handlers/streamHandler.ts:19-137`).
3. **Anthropic → OpenAI 청크 변환** (`getAnthropicStreamChunkTransform`, `src/providers/anthropic/chatComplete.ts:636-832`):
   - `event: ping`, `content_block_stop` → `undefined` 반환(청크 드롭), `message_stop` → `data: [DONE]`
   - `event:` 프리픽스를 정규식으로 벗겨내고 JSON 파싱
   - `message_start` → `streamState.model`, `streamState.usage`(input/cache 토큰) 저장 후 role 청크 방출
   - `content_block_start(tool_use)` → `streamState.toolIndex++` 하고 `tool_calls[{index, id, name, arguments:''}]` 방출; `content_block_delta.partial_json` → `tool_calls[{index, arguments: partial_json}]` — **Anthropic의 블록 index를 버리고 게이트웨이가 센 toolIndex로 재번호**하는 게 핵심 (OpenAI tool_calls index는 툴만 세지만 Anthropic content block index는 텍스트 블록 포함이므로)
   - `message_delta` → 저장해둔 `streamState.usage`와 합산해 최종 usage 청크 방출
   - thinking/서명 델타는 non-strict일 때 `delta.content_blocks[{index, delta}]`로 통과
4. **Gemini**: 스트림이 SSE가 아니라 JSON 배열 조각(`[`, `,`, `]`)로 오는 케이스를 문자열 트리밍으로 처리하고(`src/providers/google/chatComplete.ts:748-758`), 변환 후 `handleStreamingMode`가 응답 content-type을 `text/event-stream`으로 강제 교체한다 (`src/handlers/streamHandler.ts:392-409`). streamState는 `containsChainOfThoughtMessage` 불리언 하나로 thinking 블록이 있었는지 기억해 text 블록 index를 0→1로 시프트한다.
5. **역방향 재합성**(OpenAI형 JSON → SSE): 캐시 히트 + `stream:true`일 때 `OpenAIChatCompleteJSONToStreamResponseTransform` 또는 `anthropicMessagesJsonToStreamGenerator`(generator 함수, `src/providers/anthropic-base/utils/streamGenerator.ts`)로 완성 응답을 청크로 쪼개 방출 (`src/handlers/responseHandlers.ts:81-100`). Bedrock Converse 스트림 → Anthropic SSE 재합성(`BedrockConverseMessagesStreamChunkTransform`)은 `streamState.currentContentBlockIndex` 변화를 감지해 `content_block_stop`/`content_block_start` 이벤트를 **합성 생성**하는, 이 코드베이스에서 가장 정교한 상태 머신이다 (`src/providers/bedrock/messages.ts:546-618`).

주의 깊게 볼 결함: `readStream()`에 첫 청크 25ms, (Azure 한정) 청크당 1ms의 인위적 `setTimeout` sleep이 있다 (`src/handlers/streamHandler.ts:182-186`) — 주석 없는 경험적 워크어라운드. 또한 스트림 transform 안의 `JSON.parse`가 try/catch 없이 호출돼 비정형 청크 하나가 스트림 전체를 죽일 수 있다(외곽 `catch`가 console.error 후 스트림을 닫음, `streamHandler.ts:376-388`).

## D. 게이트웨이 기능 레이어 (라우팅/폴백/LB/리트라이/캐시/가드레일)

### Config 스키마

`x-portkey-config` 헤더의 JSON이 `Targets` 트리다 (`src/types/requestBody.ts:186-241`):

```
{ strategy: { mode: 'single'|'fallback'|'loadbalance'|'conditional', onStatusCodes?, conditions? },
  targets: [ { provider, api_key, weight, retry: {attempts, onStatusCodes, useRetryAfterHeader},
               cache: {mode, maxAge}, overrideParams, input_guardrails, ..., targets: [재귀] } ] }
```

`constructConfigFromRequestHeaders()`(`src/handlers/handlerUtils.ts:836-1180`)가 헤더를 camelCase config로 정규화 — 프로바이더별 자격증명 헤더(`awsConfig`, `vertexConfig`, `azureConfig`...)를 조건부 병합하는 340줄짜리 함수다.

### 실행: `tryTargetsRecursively()` (`src/handlers/handlerUtils.ts:476-834`)

- 트리를 재귀 순회하며 상속 config(`overrideParams`, `retry`, `cache`, guardrails, `strictOpenAiCompliance`...)를 자식에 병합(자식 우선)
- `FALLBACK`: targets 순차 시도, `strategy.onStatusCodes` 불일치 또는 `response.ok`면 중단. **게이트웨이 내부 예외는 `x-portkey-gateway-exception: 'true'` 응답 헤더로 표시해 폴백 루프를 끊는다** — 어댑터 버그로 인한 실패가 비용을 태우며 다음 프로바이더로 전파되는 걸 막는 실전적 디테일
- `LOADBALANCE`: weight 비례 랜덤 선택 후 재귀 (중첩 가능: LB 안에 fallback)
- `CONDITIONAL`: `ConditionalRouter`(`src/services/conditionalRouter.ts`)가 MongoDB 스타일 연산자(`$eq,$ne,$gt,$in,$regex,$and,$or`)로 `metadata.*`/`params.*`(모델명 등)를 평가해 named target 선택
- 리프에서 `tryPost()` 호출. 서킷브레이커는 target의 `isOpen` 필터로 훅만 있음(구현은 상용 측, `handlerUtils.ts:646-658`)

### 리프 파이프라인: `tryPost()` (`handlerUtils.ts:288-474`)

`RequestContext`/`ProviderContext`/`HooksService`/`CacheService`/`LogsService`/`ResponseService` 클래스로 서비스화되어 있다 (`src/handlers/services/`). 순서: beforeRequestHooks(가드레일/뮤테이터, deny 시 446) → 요청 변환 → 캐시 조회(구현은 middleware로 주입, OSS는 SHA-256(body+url) 키의 인메모리 맵 — `src/middlewares/cache/index.ts`) → PreRequestValidator(가상키 예산, 상용 훅) → `retryRequest()`(async-retry 지수 백오프, `Retry-After` 헤더 존중 + `MAX_RETRY_LIMIT_MS` 상한, `src/handlers/retryHandler.ts`) → `responseHandler`(변환) → afterRequestHooks(출력 가드레일; 스트리밍이면 본문 검사 없이 상태코드 246 "Hooks failed"로만 표시).

### 레이어 분리 평가

정책 레이어와 어댑터 레이어의 분리는 **양호하다**. 정책 레이어는 어댑터를 `Providers[provider][fn]`와 `responseTransforms[fn]` 두 진입점으로만 만진다. 핵심 통찰: **폴백/LB가 프로바이더 경계를 넘어 동작할 수 있는 이유가 바로 허브 포맷** — 요청이 항상 OpenAI-슈퍼셋으로 보관되고 각 target에서 그때그때 변환되므로, Anthropic 실패 → OpenAI 재시도가 요청 재작성 없이 된다. 다만 가드레일(hooks)은 허브 포맷 JSON을 전제로 검사하므로 `messages`(Anthropic 포맷) 라우트에서는 훅 결과 청크 포맷만 분기하는 등(`streamHandler.ts:478-494`) 어색한 접합부가 보인다.

## E. 대화 중간 모델 교체 관점 — 변환 품질과 손실 지점

OpenAI 포맷 히스토리를 들고 프로바이더를 바꿀 때의 실측 문제 지점:

1. **Gemini tool 히스토리의 함수명 소실** — OpenAI `role:'tool'` 메시지에는 `tool_call_id`만 있고 함수명이 없는데, Gemini `functionResponse`는 `name`이 필수다. Portkey는 `name: message.name ?? 'gateway-tool-filler-name'` 으로 **가짜 이름을 박는다** (`src/providers/google/chatComplete.ts:253-261`). 직전 assistant의 `tool_calls`에서 id→name 역참조가 가능한데도 안 한다. 멀티턴 툴 히스토리를 Gemini로 넘기면 모델이 어떤 함수의 결과인지 못 보는 품질 저하가 실제로 발생.
2. **tool_call_id 왕복 문제** — Gemini 응답의 tool call id는 게이트웨이가 발급한 `'portkey-' + crypto.randomUUID()` (`google/chatComplete.ts:660`). Gemini→Anthropic 교체 시 이 합성 id가 `tool_use.id`/`tool_result.tool_use_id`로 들어가는데 Anthropic은 id 포맷에 관대해 동작하지만, 반대로 Anthropic의 `toolu_...` id를 Gemini로 가져가면 Gemini는 id 개념이 없어 그냥 버려진다(손실은 없지만 재현 불가).
3. **thinking 블록의 서명 문제** — Anthropic 응답의 thinking은 non-strict일 때 `content_blocks`로 나가고, `transformAssistantMessage`가 `msg.content_blocks ?? msg.content`를 우선 소비해 되돌린다 (`anthropic/chatComplete.ts:141-162`). **같은 프로바이더로 돌아갈 때만 서명이 유효**하다. Gemini에서 온 `{type:'thinking'}` 블록(서명 없음)을 Anthropic으로 보내면 thinking 활성 상태에서 API 에러 소지가 있고, 역으로 Anthropic thinking 블록을 Gemini에 보내면 Gemini contents transform이 `text`/`image_url`/`input_audio`만 처리하므로 **thinking이 통째로 무시**된다 (`google/chatComplete.ts:262-307` — `else if` 체인에 thinking 분기 없음). Gemini의 `thought_signature`는 `tool_calls[].function.thought_signature`로 왕복 지원되지만(`requestBody.ts:279`, `google/chatComplete.ts:248-250`) 이것도 Gemini 전용.
4. **system 메시지 위치·복수 처리 불일치** — Anthropic 어댑터는 히스토리 내 모든 `system`/`developer` 메시지를 모아 `system` 배열로 합친다(`anthropic/chatComplete.ts:327-366`). 반면 Gemini 어댑터의 `systemInstruction` transform은 **`params.messages[0]`만 본다** — 첫 메시지가 system이 아니면(또는 system이 중간에 있으면) contents에서도 스킵되고 systemInstruction에도 안 들어가 **조용히 증발**한다 (`google/chatComplete.ts:330-372`). 또 배열 콘텐츠 system은 `content[0].text`만 취해 나머지 파트 소실.
5. **tool_result 내용의 포맷 검증 부재** — `transformToolMessage`는 OpenAI tool 메시지의 `content`를 Anthropic `tool_result.content`에 **그대로** 넣는다 (`anthropic/chatComplete.ts:184-196`). 문자열/`{type:'text'}` 배열은 우연히 호환되지만 `image_url` 파트가 섞이면 Anthropic이 400을 뱉는다. Bedrock messages 경로는 tool_result 안의 image까지 명시 변환하는 것과 대조적 (`bedrock/messages.ts:194-229`).
6. **파라미터 클램핑의 침묵 변조** — `temperature`는 OpenAI 0–2, Anthropic 0–1. 엔진이 `min`/`max`로 **조용히 클램프**한다 (`transformToProviderRequest.ts:50-70`, `anthropic/chatComplete.ts:442-447`). 교체 후 `temperature: 1.5`가 1.0이 되어도 아무 신호가 없다. `n>1`, `presence_penalty` 등 미지원 파라미터도 whitelist에서 조용히 탈락.
7. **usage 의미 불일치** — Anthropic `total_tokens`에 cache 토큰을 합산해 넣는데(`anthropic/chatComplete.ts:615-619`) OpenAI의 `prompt_tokens`는 cached 포함 의미라, 교체 전후 토큰 회계가 미묘하게 어긋난다.
8. **finish_reason 라운딩** — `pause_turn`→`stop` 등 다대일 매핑(`src/providers/utils/finishReasonMap.ts`)으로 정보가 접힌다. non-strict 모드로 원문을 받을 수는 있으나 그러면 클라이언트가 프로바이더별 enum을 다 알아야 함 — 허브 포맷의 표현력 한계가 그대로 드러나는 지점.

종합: **"히스토리가 그대로 동작"의 실제 달성도는 텍스트+표준 tool call까지는 높고, thinking/서명/멀티모달 tool result/중간 system에서 급락**한다. 원인은 대부분 "허브 스키마에 해당 개념의 자리가 없어서"이며, 이는 목표 (2)를 설계할 때 허브 스키마에 무엇을 1급 시민으로 넣을지의 체크리스트로 쓸 수 있다.

## F. 테스트 전략

**어댑터 변환에 대한 골든셋/fixture 테스트는 사실상 없다.**

- `src/tests/common.test.ts` + `src/tests/routeSpecificTestFunctions.ts/chatCompletion.ts`: **실제 API 키가 env에 있을 때만 실행되는 라이브 스모크 테스트**. 프로바이더당 2개(문자열 메시지 / content 배열)이고 검증은 `expect(res.status).toEqual(200)` 뿐. 키 없으면 skip.
- `tests/integration/src/handlers/tryPost.test.ts`(574줄): 역시 라이브 호출 기반, provider-specific 블록은 `describe.skip` 처리.
- `tests/unit/src/handlers/services/*.test.ts`: `requestContext`, `cacheService`, `hooksService` 등 **파이프라인 서비스 클래스**의 순수 유닛 테스트 — 어댑터가 아니라 오케스트레이션 검증.
- 프로바이더 디렉토리 내 유일한 유닛 테스트: `src/providers/google-vertex-ai/utils.test.ts` — JSON schema `$ref` deref/Gemini 스키마 변환 유틸만 다룸.
- 스트림 청크 변환(상태 머신!)에 대한 테스트 0건. plugins(가드레일)는 별도 `npm run test:plugins`.

즉 회귀 안전망이 가장 필요한 곳(포맷 변환, 스트림 상태)이 가장 비어 있다. 78개 프로바이더의 변환 정합성은 사실상 프로덕션 트래픽으로 검증되는 구조.

## G. 구조적 약점 진단

1. **타입 안전성 부재가 설계 수준**: `ProviderConfigs`가 `[key: string]: any` (`src/providers/types.ts:151`), `ParameterConfig.transform`이 `(params: any) => any`, 스트림 transform은 `Function` 타입으로 전달 (`streamHandler.ts:141`), `streamState`는 `{}`로 시작해 임의 확장. 요청 변환 결과와 프로바이더 실제 스키마 사이에 컴파일 타임 검증이 전혀 없다. `Message.tool_calls?: any`도 마찬가지.
2. **선언적 매핑 모델의 한계 노출**: 필드→필드 1:1 whitelist 모델이라, "여러 필드 → 한 객체"(Gemini generationConfig)는 같은 transform을 8번 호출하는 중복으로, "한 필드 → 여러 필드"(Anthropic messages/system)는 `ParameterConfig[]` 배열로 우회. transform이 개별 값이 아닌 `params` 전체를 받는 순간 선언적이라는 장점이 상당 부분 무의미해진다.
3. **알 수 없는 파라미터의 침묵 드롭**: whitelist에 없으면 경고조차 없이 소멸. min/max 클램핑도 무통보. 디버깅 난이도를 크게 올리는 특성.
4. **프로바이더 지식의 코어 누수**: `getStreamModeSplitPattern`의 하드코딩 분기, `handleStreamingMode`의 `if (proxyProvider === BEDROCK)`, `handlerUtils.ts`의 `isSleepTimeRequired = proxyProvider === AZURE_OPEN_AI`, `constructConfigFromRequestHeaders`의 프로바이더별 340줄 — 어댑터 인터페이스에 들어가야 할 속성(스트림 프레이밍, 인증 스키마)이 코어에 산재.
5. **`Options` 인터페이스 비대화**: 프로바이더별 자격증명 필드 100여 개가 한 인터페이스에 평면 나열 (`requestBody.ts:45-180`). 프로바이더 추가마다 코어 타입 수정 필요 — N+M 원칙 위반.
6. **스트림 견고성**: transform 내 `JSON.parse` 무방비, 인위적 sleep, 청크 드롭 시 `undefined` 반환 규약이 `readAWSStream`에서는 체크 안 됨(`streamHandler.ts:89-95`는 undefined도 yield).
7. **중복**: cache_control 처리 로직이 anthropic/bedrock/vertex에 3벌, finish reason 맵이 방향별 2벌, `open-ai-base`의 거의 동일한 ResponseTransformer 팩토리 6벌.
8. **허브 포맷 종속 표현력 한계**: Gemini `groundingMetadata`·`safetyRatings`, Anthropic `pause_turn`·서버 툴(web_search 등) 결과 블록은 non-strict 확장으로만 노출되거나 드롭(Bedrock messages의 `// not supported` 주석 블록, `bedrock/messages.ts:272-278`). "고유 기능 전부 노출" 목표엔 미달이며, 탈출구는 (a) 필드 인라인 확장, (b) `/v1/messages` 별도 라우트, (c) proxy passthrough 3종뿐.

---

## 우리 게이트웨이에 가져올 것

1. **허브-스포크 자체와 "호환 모드 vs 확장 노출 모드" 게이팅 전략** — N+M은 실증됐다. `strictOpenAiCompliance` 같은 스위치 발상은 채택 가치 높음.
2. **`content_blocks` 류의 통합 블록 배열** — 단, 우리는 처음부터 blocks를 1급으로.
3. **endpoint별 어댑터 분해** (`chatComplete`/`embed`/`imageGenerate`...) + **base config 팩토리** (`open-ai-base`의 `chatCompleteParams(exclude, defaults, extra)`) — OpenAI-호환 롱테일 프로바이더를 수십 줄로 처리하는 메커니즘.
4. **어댑터 상속에 의한 재배포 프로바이더 처리** — Vertex-Claude = Anthropic config 스프레드 + 오버라이드, 응답 transform은 provider 라벨만 주입하는 팩토리. Bedrock/Vertex/직접 API 3중 배포 시대에 필수 패턴.
5. **정책 레이어의 재귀 target 트리** — fallback/LB/conditional을 중첩 가능한 하나의 트리로 통일한 config 스키마, 그리고 **게이트웨이 내부 예외를 폴백에서 제외하는 exception 마킹**.
6. **스트림 재합성 대칭성** — JSON→SSE 생성기(캐시 히트도 스트림으로 응답), Converse→Anthropic SSE 재합성처럼 양방향 스트림 변환을 어댑터 계약에 포함.
7. **finish reason의 중앙 매핑 테이블** (`finishReasonMap.ts`) + 원문 보존 옵션.
8. **`Retry-After` 존중 리트라이 + 상한(`MAX_RETRY_LIMIT_MS`)**, 훅 실패 시 본문 유지한 채 상태코드(246/446)로 신호하는 방식.

## 다르게 갈 것

1. **내부 허브 IR을 어느 외부 포맷과도 동일시하지 않기.** Portkey의 고통 대부분은 "허브 = OpenAI wire format"이라서다. 자체 IR을 두면 `/v1/messages`용 Bedrock 변환 별도 구현 같은 2×M 중복이 사라진다.
2. **선언적 param 맵 대신 타입드 변환 함수.** `ProviderConfig` whitelist는 중복 실행·any 지옥·침묵 드롭의 근원. 미지원 필드는 드롭하되 **응답 메타에 `dropped_params`/`clamped_params` 경고를 남긴다**.
3. **스트림 어댑터를 명시적 상태 머신 인터페이스로**: framing 선언 + 타입드 상태. splitPattern 하드코딩·`streamState:{}`·`Function` 전달 전부 제거, 프레이밍 지식을 어댑터로 이동.
4. **변환 골든셋 테스트를 1급 요구사항으로.** 프로바이더별 fixture 쌍 + **크로스 프로바이더 왕복 테스트**. Portkey의 최대 공백.
5. **모델 교체 시 히스토리 정규화 단계를 명시 도입**: id→name 역참조, 서명 없는 thinking 블록 정책, 중간 system 메시지 규칙 — 어댑터 안에 암묵적으로 흩어놓지 않고 IR 레벨의 "재타게팅 패스"로 분리.
6. **자격증명/엔드포인트 해석을 어댑터 소유로**: 프로바이더가 자기 credential 스키마를 선언하고 코어는 불투명하게 전달.
7. **고유 기능 노출은 네임스페이스드 확장으로**: `provider_options: { anthropic: {...} }` + 응답 `provider_metadata` (Vercel AI SDK 방식).
8. **스모크 테스트의 라이브 API 의존 축소**: 녹화(VCR) 기반 재생을 기본으로, 라이브는 옵트인.
