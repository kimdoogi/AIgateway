# Google Gemini API Wire-레벨 기능 인벤토리

- 날짜: 2026-08-20 (ai.google.dev / docs.cloud.google.com 공식 문서 직접 조사)
- 목적: IR 스키마 설계 입력물 + Gemini 어댑터(Developer API 1차, Vertex 상속) 설계 근거
- 관련 문서: [ADR-0001](../decisions/ADR-0001-adapter-architecture.md) · [Anthropic 커버리지](2026-08-20-anthropic-api-coverage.md) · [OpenAI 인벤토리](2026-08-20-openai-api.md) · [xAI 인벤토리](2026-08-20-xai-grok-api.md)

> **최상위 발견 (게이트웨이 설계에 가장 중요)**: 2026년 6월부로 Gemini Developer API에 **Interactions API** (`POST /v1beta/interactions`)가 GA로 승격되어 "모든 신규 프로젝트에 권장"되는 1차 표면이 되었고, 기존 `generateContent`는 **"legacy이지만 완전 지원(not deprecated)"** 상태다. 두 표면은 wire 포맷이 완전히 다르다(camelCase Part 유니온 vs snake_case typed step/block). 어댑터를 `generateContent` 기준으로 만들면 당장은 동작하지만, 신기능(MCP, 멀티모달 함수 응답, 서버측 상태 등)은 Interactions에만 실린다. **IR 설계 시 두 표면 모두를 타겟으로 상정해야 한다.** — OpenAI의 Responses vs Chat Completions와 동일한 구도 (출처: https://ai.google.dev/gemini-api/docs/interactions)
>
> **정확도 주기**: FinishReason 확장값 목록과 MediaResolution/ServiceTier enum 원문은 레퍼런스 페이지 truncation으로 완전 verbatim 확보에 실패해 API errors 페이지 + 교차 출처로 구성 (F-3, B-2에 명시). IR 스키마 확정 전, 해당 enum 3종은 실제 API 응답으로 최종 검증할 것.

## A. API 표면

### A-1. 세 개의 wire 표면 (Developer API 내부)

| 표면 | 엔드포인트 | 상태 | 특징 |
|---|---|---|---|
| **generateContent 계열** | `POST /v1beta/models/{model}:generateContent`, `:streamGenerateContent` | legacy, 완전 지원 | `contents[]/parts[]` camelCase, stateless |
| **Interactions API** | `POST /v1beta/interactions`, `GET/DELETE /v1beta/interactions/{id}`, `POST .../{id}/cancel` | **GA (2026-06), 권장** | snake_case, typed step/block, `store`+`previous_interaction_id` 서버측 상태, `background` 실행, agent(`deep-research`, `antigravity`) 호출 겸용 |
| **Live API** | `wss://.../BidiGenerateContent` | GA | WebSocket 양방향, 실시간 오디오/비디오 |

### A-2. 전체 엔드포인트 인벤토리 (generativelanguage.googleapis.com)

| 엔드포인트 | 용도 | 비고 |
|---|---|---|
| `models.generateContent` / `:streamGenerateContent` | 생성 | `?alt=sse`로 SSE |
| `interactions` create/get/delete/cancel | 신형 생성+에이전트 | list 메서드 없음 |
| `models.countTokens` | 토큰 계산 | `contents` 또는 완전한 `generateContentRequest` 중 택1 (상호배타) |
| `models.embedContent` / `batchEmbedContents` / `asyncBatchEmbedContent` | 임베딩 | taskType, outputDimensionality |
| `cachedContents` CRUD | 명시적 캐싱 | TTL 또는 expireTime |
| `files` (resumable upload), get/list/delete, `files.register` | 파일 | register는 GCS URI 등록(신규) |
| `models.batchGenerateContent` + `batches` list/cancel/delete | 배치 | 50% 할인 |
| `fileSearchStores` CRUD + `uploadToFileSearchStore` / `importFile` | 관리형 RAG | |
| `auth_tokens` | Live API용 ephemeral token | 클라이언트 직결용 |
| `models` get/list | 모델 메타데이터 | |

### A-3. Developer API vs Vertex AI 차이 전수

| 항목 | Developer API | Vertex AI |
|---|---|---|
| 호스트 | `generativelanguage.googleapis.com` | `{region}-aiplatform.googleapis.com` (+global) |
| 경로 | `/v1beta/models/{model}:generateContent` | `/v1/projects/{p}/locations/{l}/publishers/google/models/{m}:generateContent` |
| 인증 | API key (`x-goog-api-key`) | OAuth2 Bearer(ADC) + express mode key |
| 버전 | `v1` / `v1beta` | `v1` / **`v1beta1`** (이름부터 다름) |
| 파일 | Files API (`fileData.fileUri` = Files URI) | **GCS URI(`gs://`)** 및 공개 HTTPS URL, Files API 없음 |
| 요청 전용 필드 | `store`, `serviceTier` | `labels`, `safetySettings.method`(SEVERITY/PROBABILITY), `modelArmorConfig`, `generationConfig.routingConfig` |
| SafetyRating 응답 | category, probability, blocked | + probabilityScore, severity, severityScore |
| usage | H절 | + `trafficType` |
| 전용 기능 | Interactions, Files API, File Search, ephemeral tokens, 티어 rate limit | Provisioned Throughput, 튜닝, Vertex Search/RAG grounding, VPC-SC, CMEK, 데이터 레지던시 |

**어댑터 상속 관점**: 코어 wire 포맷(contents/parts/generationConfig/safetySettings/tools)은 두 플랫폼이 사실상 동일. 차이는 (1) 경로/인증, (2) 미디어 참조 스킴, (3) Vertex 추가 필드, (4) 기능 가용성. "Developer 1차 + Vertex 상속" 계획 유효.

## B. 요청 스키마 전수 (generateContent 기준)

### B-1. 최상위 요청 필드

`contents[]`(role: `user`/`model`), `tools[]`, `toolConfig`(`functionCallingConfig`, `retrievalConfig`(latLng — Maps용), `includeServerSideToolInvocations`), `safetySettings[]`, `systemInstruction`(text part만), `generationConfig`, `cachedContent`(참조), `serviceTier`(2026 신규), `store`(로깅 오버라이드, 2026 신규)

### B-2. GenerationConfig 전 필드

| 필드 | 비고 |
|---|---|
| `temperature` (0–2) | **Gemini 3: 1.0 고정 강력 권장** — 1.0 미만 설정 시 루핑/성능 저하 공식 경고 |
| `topP`, `topK`, `candidateCount`, `maxOutputTokens`, `stopSequences[]`, `seed`, `presencePenalty`, `frequencyPenalty` | |
| `responseLogprobs`(bool), `logprobs`(int) | |
| `responseMimeType` | `application/json`, `text/x.enum` |
| `responseSchema` | OpenAPI subset, `propertyOrdering` 지원 |
| `responseJsonSchema` | **raw JSON Schema 수용** (신형, `$ref` 재귀 포함) |
| `responseModalities[]` | `TEXT` / `IMAGE` / `AUDIO` |
| `speechConfig` | TTS voice 설정, 멀티스피커 최대 2인 |
| `mediaResolution` | LOW/MEDIUM/HIGH; Gemini 3부터 part 단위 오버라이드 |
| `thinkingConfig` | `includeThoughts`(bool), `thinkingBudget`(int, 2.5 세대), `thinkingLevel`(`minimal/low/medium/high`, 3 세대). **둘 동시 지정 시 400** |
| `enableEnhancedCivicAnswers`, `audioTimestamp` | |

### B-3. SafetySettings

- HarmCategory: `HARASSMENT`, `HATE_SPEECH`, `SEXUALLY_EXPLICIT`, `DANGEROUS_CONTENT`, `CIVIC_INTEGRITY`, `JAILBREAK`(2026 신규 확인)
- HarmBlockThreshold: `BLOCK_NONE`, `BLOCK_ONLY_HIGH`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_LOW_AND_ABOVE` (+`OFF` 존재해온 점 유의)
- 응답 `safetyRatings[]`: category + probability(`NEGLIGIBLE/LOW/MEDIUM/HIGH`) + blocked
- **주의**: Interactions API는 "Custom safety settings not supported" (과도기 상태)

## C. 콘텐츠 Part 타입 전수 + thought signature

### C-1. Part 유니온

| Part | 구조 | 제약 |
|---|---|---|
| `text` | string | |
| `inlineData` | `{mimeType, data(base64)}` | 인라인 총량 ~20MB → 초과 시 Files API |
| `fileData` | `{mimeType, fileUri}` | Developer: Files URI / Vertex: gs:// |
| `functionCall` | `{id?, name, args}` | **id는 스키마에 있으나 generateContent에서는 미발급** — Live API에서만 채워짐 |
| `functionResponse` | `{id?, name, response, willContinue?, scheduling?}` | **name 필수, 매칭은 name+순서 기반**. scheduling(SILENT/WHEN_IDLE/INTERRUPT)은 Live 비동기 함수용 |
| `executableCode` | `{language(PYTHON), code}` | codeExecution 출력 |
| `codeExecutionResult` | `{outcome(OUTCOME_OK/FAILED/DEADLINE_EXCEEDED), output}` | |
| `thought` | boolean | 이 part가 thought summary임을 표시 (별도 타입이 아니라 플래그) |
| `thoughtSignature` | bytes(base64) | **모든 part에 붙을 수 있는 메타데이터** |
| `videoMetadata` | `{startOffset, endOffset, fps}` | |
| (Gemini 3) part-level `mediaResolution` | | |

### C-2. Thought Signature 정확한 동작

문서 원문: *"In the generateContent API, there are no dedicated thought blocks. Because of this, signatures are metadata that can be attached to any part."*

| 규칙 | 내용 |
|---|---|
| 함수 호출 | signature는 functionCall part에 부착. 재전송 시 **받은 그대로** 반환 필수 |
| **검증 (Gemini 3)** | **현재 턴의 함수 호출에 대해 엄격 검증. 누락 시 400** (`MISSING_THOUGHT_SIGNATURE`) |
| Gemini 2.5 | 반환 선택적, 검증 없음 |
| **병렬 함수 호출** | **signature는 첫 번째 functionCall part에만.** FC1(+sig), FC2, … 후 FR1, FR2, … — **호출/응답 인터리빙 시 400** |
| 순차 호출 | 현재 턴 내 각 스텝의 첫 functionCall에 필수, 이전 스텝 signature도 보존 |
| 텍스트 응답 | 마지막 content part에 올 수 있음. 반환 권장이지만 미검증 |
| 과거 턴 | **현재 턴만 검증** |
| **우회(bypass)** | 합성 히스토리/타사 이력 주입 시 공식 더미 문자열: `"context_engineering_is_the_way_to_go"` 또는 `"skip_thought_signature_validator"` |
| 스트리밍 | 함수 호출 없는 스트림에서 signature가 **빈 text part에 실려 올 수 있음** |
| 모델 간 | signature는 모델 종속 — 모델 패밀리 간 이전 불가 |
| OpenAI 호환 레이어 | `extra_content.google.thought_signature`로 노출 |
| Interactions | stateful이면 서버가 관리, stateless면 thought 블록 + 빌트인 툴 call/result 블록의 signature 재전송 대상 |

**알려진 실전 이슈**: 3+ 병렬 호출에서 signature 비일관 생성으로 400 유발 버그 리포트 존재 (Google AI 포럼, js-genai#1275) — 게이트웨이는 "있으면 보존, 없으면 더미" 전략이 안전.

(출처: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures )

## D. 툴

### D-1. Tool 오브젝트 멤버

`functionDeclarations[]`, `googleSearch`, `googleSearchRetrieval`(구형), `codeExecution`, `urlContext`, `googleMaps`, `computerUse`, `fileSearch`

### D-2. FunctionDeclaration

`name`, `description`, `behavior`(Live 비동기용 NON_BLOCKING), `parameters`(OpenAPI subset Schema), **`parametersJsonSchema`(raw JSON Schema — 변환 손실 없는 통과 경로)**, `response`/`responseJsonSchema`.

Schema subset: type, format, nullable, enum, items, properties, required, min/max 계열, pattern, anyOf, `propertyOrdering`(Gemini 고유 — JSON 키 순서 제어), default, `$ref` 재귀. oneOf/allOf 불확실. 대형/깊은 스키마 거부 가능(특히 ANY 모드).

### D-3. FunctionCallingConfig 모드

`AUTO`(기본), `ANY`(강제, +allowedFunctionNames[]), `NONE`, **`VALIDATED`**(2026 신규 — 스키마 준수 보장)

### D-4. 빌트인 툴 전수

| 툴 | 응답 아티팩트 | 비고 |
|---|---|---|
| `googleSearch` | `groundingMetadata` | Gemini 3는 쿼리당 과금, TOS 표시 의무 |
| `urlContext` | `urlContextMetadata` | 요청당 20 URL, URL당 34MB; 페이월·YouTube 불가 |
| `codeExecution` | executableCode + codeExecutionResult | Python 샌드박스, 최대 30초, 실패 시 5회 자동 재생성 |
| `googleMaps` | Maps annotation + widget token | latLng 주입, 영어 전용 |
| `fileSearch` | file_citation annotations | store names, AIP-160 metadata_filter |
| `computerUse` | UI 액션 루프 | 2.5-computer-use-preview |
| (Interactions 전용) `mcp_server` | mcp_server_tool_call/result steps | SSE 전송 미지원, Gemini 3 "coming soon" |

조합: Gemini 3부터 빌트인+커스텀+구조화 출력 동시 사용 가능 (2.5는 제한적).

### D-5. functionResponse의 name/id 재확인 (재타게팅 패스 근거)

`FunctionCall/Response` 스키마에 `id` 필드는 존재하지만 **generateContent 경로에서는 모델이 id를 발급하지 않고, `name`+순서가 매칭 키**다. id가 실제 발급·에코백되는 것은 Live API와 Interactions API. → "id 기반 IR → Gemini generateContent로 갈 때 name 기반 재매핑 필요" 설계 근거 **유효**. 단 IR에 id 슬롯을 유지해야 Live/Interactions에 손실 없이 매핑.

## E. 고유 기능 전수 (providerOptions.google 후보군)

### E-1. Grounding + groundingMetadata

응답 구조: `webSearchQueries[]`, `searchEntryPoint.renderedContent`(HTML 스니펫), `groundingChunks[].web.{uri,title}`, `groundingSupports[].{segment{partIndex,startIndex,endIndex,text}, groundingChunkIndices[], confidenceScores[]}`. Interactions에서는 `google_search_call/result` step + `url_citation` annotation으로 재편.

**약관상 의무 (메타데이터를 절대 drop하면 안 되는 이유)**:
- Grounded Results/Search Suggestions **수정·삽입 금지**, 인터스티셜 금지
- 개발자는 Grounded Result 텍스트 최대 2년 저장 가능(용도 한정), Maps는 90일
- **캐시·재판매·분석·학습 금지** — 게이트웨이가 groundingMetadata를 로깅·캐싱하는 것 자체가 약관 리스크
- 과금: Gemini 3는 모델이 실행한 **검색 쿼리당** 과금 (한 요청에 여러 쿼리 = 각각 과금)

### E-2. Context Caching

| 구분 | 내용 |
|---|---|
| Implicit | 2.5+ 기본 활성. 최소 프리픽스: 2.5 = 2,048 / Gemini 3.x = **4,096 tokens**. 적중 시 `cachedContentTokenCount` 반영 |
| Explicit | `cachedContents` 리소스 (model 불변 + contents/systemInstruction/tools), `ttl`(기본 1h)/`expireTime`, patch 연장. 과금 = 할인 토큰 + 시간당 스토리지 |
| 제약 | **Interactions API는 explicit caching 미지원** |

### E-3. 멀티모달 출력

- **이미지 생성**(Nano Banana 계열): `responseModalities:["TEXT","IMAGE"]` / Interactions `response_format:{type:"image", aspect_ratio, image_size}`. 512px~4K, 종횡비 10종, 참조 이미지 최대 14장, 멀티턴 편집, SynthID 워터마크. 이미지 모델도 thinking 수행(중간 이미지 최대 2장 — 과금됨).
- **TTS**: `responseModalities:["AUDIO"]` + speechConfig. 30개 보이스, 멀티스피커 2인, 24kHz PCM, 90+ 언어.

### E-4. Live API (요약)

setup(model, generationConfig, tools, `realtimeInputConfig`(VAD 세부), 입출력 transcription, `sessionResumption{handle}`, `contextWindowCompression`, `proactivity`, `enableAffectiveDialog`) ↔ 클라이언트 `clientContent`/`realtimeInput`/`toolResponse` ↔ 서버 `serverContent`/`toolCall{functionCalls[](id 포함)}`/`toolCallCancellation`/`goAway`/`sessionResumptionUpdate`/`usageMetadata`. 오디오 입력 16kHz/출력 24kHz PCM.

### E-5. 기타

`mediaResolution`(요청/파트), `videoMetadata`, YouTube URL 직접 입력, Batch API(인라인 ≤20MB vs JSONL ≤2GB, 50% 할인, 24h 목표, 결과 6주 보관).

## F. 스트리밍

### F-1. 프레이밍 이중성 (함정 #1)

| 호출 | 프레이밍 |
|---|---|
| `:streamGenerateContent` (기본) | **JSON 배열** `[{...},{...}]` — SSE 아님. SSE 파서로 읽으면 즉사 |
| `:streamGenerateContent?alt=sse` | 표준 SSE, 각 data는 완전한 GenerateContentResponse |
| Interactions `stream:true` | typed SSE 이벤트: `interaction.created`, `interaction.status_update`, `step.start`, `step.delta`, `step.stop`, `interaction.completed`, `error` |

### F-2. 청크 구조 (generateContent SSE)

- 각 이벤트 = 완전한 GenerateContentResponse (parts에 델타 텍스트). 별도 델타 타입 없음 — **parts를 append 병합**
- `usageMetadata`: 중간 청크에 부분 값 가능, **마지막 청크가 확정치**
- functionCall parts는 스트림에서도 통짜 도착(인자 부분 델타 없음)
- thoughtSignature가 빈 text part로 도착 가능
- 스트림 중간 에러: error JSON이 스트림 내에 나타날 수 있음

### F-3. FinishReason 전수 (개방형!)

레퍼런스 확인분: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`. 추가 확인(errors 페이지 교차): `SPII`, `MALFORMED_FUNCTION_CALL`, `MALFORMED_TOOL_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `NO_IMAGE`, `MISSING_THOUGHT_SIGNATURE`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER`.

**IR 함의**: finishReason은 개방형 enum으로 (신값 계속 추가). SAFETY/RECITATION/SPII/IMAGE_* → content-filter, MALFORMED_*/UNEXPECTED_/TOO_MANY_ → tool-error 계열 정규화 + 원값 보존.

**PromptFeedback.blockReason** (프롬프트 차단, candidates 빈 배열): `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY` — **HTTP 200으로 오는 soft error** → 게이트웨이가 에러로 승격 필요.

## G. 에러 모델

- classic: google.rpc 스타일 `{"error": {"code": 429, "message", "status": "RESOURCE_EXHAUSTED", "details"}}`
- **Interactions: snake_case 코드** `{"error": {"code": "rate_limit_exceeded", "message"}}` — **같은 프로바이더 안에서 에러 포맷 이원화**
- 429 하위 구분: `rate_limit_exceeded`(분당 — 백오프 유효) vs `quota_exceeded`(일일 — 백오프 무의미, 자정 PT 리셋). **Retry-After 헤더 없음**
- Rate limit 차원: RPM/TPM/RPD/IPM/TPD, 티어제(Free→Tier3, 자동 승급), **프로젝트 단위** 적용
- 400 `INVALID_ARGUMENT`, `FAILED_PRECONDITION`(결제 미설정), 403, 404, 416, 500 `INTERNAL`, 503 `UNAVAILABLE`, 504 `DEADLINE_EXCEEDED`

## H. Usage 구조

### generateContent `usageMetadata`

`promptTokenCount`(**캐시 포함**), `cachedContentTokenCount`(부분집합), `candidatesTokenCount`, `thoughtsTokenCount`(**출력과 별도 필드**), `toolUsePromptTokenCount`, `totalTokenCount`, `serviceTier`, 모달리티별 분해 4종(`promptTokensDetails[]` 등, `{modality, tokenCount}`). Vertex는 +`trafficType`.

### Interactions `usage`

`total_input_tokens`, `total_output_tokens`, `total_thought_tokens`, `total_cached_tokens`, `total_tool_use_tokens`, `total_tokens`, + `*_tokens_by_modality` 4종.

**IR 함의**: thoughts는 별도 집계 — 합산 여부를 IR에서 명시해야 청구 정합. cached는 prompt에 포함된 부분집합 (Anthropic과 또 다른 의미 — 3사 3색). 모달리티별 분해는 옵셔널 배열로 수용.

## I. 모델·capability 매트릭스 (2026-08)

| 모델 | 상태 | 비고 |
|---|---|---|
| `gemini-3.7-flash` | Stable | 현행 플래그십 워크호스 |
| `gemini-3.6-flash`, `3.5-flash(-lite)`, `3.1-flash-lite` | Stable | 속도/비용 스펙트럼 |
| `gemini-3.1-pro-preview` | Preview | 최상위 추론 (thinkingLevel 기본 high, minimal 미지원) |
| `gemini-3-pro-image`, `3.1-flash(-lite)-image` | 이미지 생성 | 4K는 Pro |
| `gemini-2.5-pro/flash/flash-lite` | Stable 구세대 | thinkingBudget 세대 |
| TTS/Live/임베딩 모델군 | | `gemini-embedding-001` 등 |
| 에이전트(Interactions `agent`): `deep-research-preview-04-2026`, `antigravity-preview-05-2026` | | 모델이 아니라 **agent** — 별도 축 |

기능 경계: thinking·함수·구조화·grounding·caching = 2.5+ / 빌트인+커스텀 조합·멀티모달 함수응답·MCP = Gemini 3 전용. 버전 관례: Stable / Preview(2주 사전 폐기 공지) / Latest(hot-swap) / Experimental.

## J. 버전 정책

- REST 경로 버전: `v1` / `v1beta`. **SDK 기본값 v1beta**. 신기능은 v1beta 선출시. Vertex는 `v1beta1`.
- 게이트웨이 권장: **v1beta 고정** (기능 커버리지 최대, Google SDK도 동일 선택).

## K. IR 표준 필드 후보 vs providerOptions.google 후보

### IR 표준 후보

| IR 후보 | Gemini 매핑 |
|---|---|
| messages/role | `contents[].role` = user/**model** (**system role 없음**) |
| system prompt | `systemInstruction` |
| text·image·audio·video·document part | text / inlineData / fileData |
| tool 정의 (JSON Schema) | `parametersJsonSchema` (raw 통과 — 변환 손실 최소 경로) |
| tool_choice | functionCallingConfig.mode AUTO/ANY(+allowed)/NONE |
| tool call/result | functionCall / functionResponse (**IR에 id 슬롯 유지**, generateContent 타깃은 name+순서 재매핑) |
| sampling 일체 | generationConfig.* |
| 구조화 출력 | responseMimeType + responseJsonSchema |
| reasoning effort | `thinkingLevel` ← OpenAI reasoning_effort와 공식 상호 매핑 존재 |
| reasoning budget | `thinkingBudget` (2.5 한정, thinkingLevel과 배타) |
| **opaque reasoning 아티팩트** | `thoughtSignature` — **IR part 공통 슬롯** 강력 권장 (Anthropic signature·OpenAI encrypted_content와 동형 개념 — 3사 수렴) |
| usage / finish reason / 스트림 델타 / citations | 각 절 매핑 |

### providerOptions.google 후보

`safetySettings`(+Vertex method), 빌트인 툴 일체(googleSearch/urlContext/codeExecution/googleMaps/fileSearch/computerUse), `groundingMetadata` 원본(TOS상 무수정 패스스루 필수), `cachedContent` 참조 + cachedContents 수명 관리, `responseModalities`/`speechConfig`/`imageConfig`/`mediaResolution`, `enableEnhancedCivicAnswers`/`audioTimestamp`/`videoMetadata`/YouTube URL, `propertyOrdering`, `serviceTier`/`store`, Vertex `labels`/`modelArmorConfig`, Interactions 전용(`previous_interaction_id`, `background`, `agent`/`agent_config`, `webhook_config`, MCP), Live 세션 설정 일체, `logprobs`/`candidateCount`.

## L. 게이트웨이 어댑터 구현 시 함정 목록

1. **스트리밍 프레이밍 이중성**: 기본이 JSON 배열, `?alt=sse` 강제 필요. Interactions는 typed SSE로 또 다름.
2. **Thought signature**: Gemini 3 현재 턴 functionCall signature 누락 = 400. **병렬 호출은 첫 functionCall에만** signature. FC 전부 → FR 전부 순서(인터리빙 400). 타사 이력 주입 시 공식 더미 문자열 삽입. 스트리밍에선 빈 text part로 올 수 있음. **IR이 signature를 바이트 그대로 왕복 보존하지 않으면 Gemini 3 툴 루프가 통째로 깨진다.**
3. **functionResponse 매칭**: generateContent는 id 미발급 → name+순서 기반. 동일 함수 병렬 다중 호출 시 순서가 유일한 매칭 키. IR id 슬롯은 유지 (Live/Interactions용).
4. **system role 부재**: 대화 중간 system 메시지는 systemInstruction 병합 또는 user 변환 정책 필요.
5. **HTTP 200 soft-block**: promptFeedback.blockReason + 빈 candidates, finishReason SAFETY/RECITATION 등이 200으로 옴 → 정규화 에러/finish로 승격.
6. **finishReason 개방형**: 닫힌 enum 파싱 금지.
7. **usage 정합**: thoughtsTokenCount 별도 필드, cached는 prompt의 부분집합. 스트리밍은 마지막 청크가 확정.
8. **temperature 함정**: Gemini 3는 1.0 이외 공식 경고 → 모델 세대별 가드. thinkingBudget+thinkingLevel 동시 지정 400 (세대별 변환: 2.5↔3).
9. **grounding TOS**: renderedContent 무수정 표시, 캐시/학습 금지 — **게이트웨이 응답 캐시에서 groundingMetadata 제외 설계 필요**.
10. **에러 포맷 이원화** + Retry-After 부재 + 429 분당/일일 구분을 코드에서 추출.
11. **Vertex 상속 시**: fileData.fileUri 의미 변화(Files URI ↔ gs://) — 미디어 참조 IR 추상화 필요. `v1beta`↔`v1beta1`.
12. **Interactions 병행 추적**: 신기능이 Interactions 전용으로 실리는 추세 + explicit caching·custom safety는 Interactions 미지원 — 기능 조합에 따른 표면 선택 라우팅 필요 가능성.
13. **빈/특수 part 보존**: 빈 text part(+signature), thought:true part, executableCode/Result가 히스토리에 섞임 — 재전송 시 보존.
14. **캐시 최소 토큰 세대별 상이**: 2,048(2.5) vs 4,096(3.x).

## 주요 출처

- https://ai.google.dev/api/generate-content · /api/caching · /api/interactions-api · /api/live · /api/files · /api/embeddings · /api/tokens
- https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures · /docs/thinking · /docs/gemini-3 · /docs/interactions · /docs/function-calling · /docs/structured-output · /docs/google-search · https://ai.google.dev/gemini-api/terms · /docs/url-context · /docs/code-execution · /docs/maps-grounding · /docs/file-search · /docs/image-generation · /docs/speech-generation · /docs/batch-api · /docs/api-errors · /docs/rate-limits · /docs/models · /docs/api-versions
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/migrate-google-ai · /docs/model-reference/inference
- 실전 이슈: https://discuss.ai.google.dev/t/gemini-3-flash-preview-inconsistent-thought-signature-generation-in-parallel-function-calls-causes-400-errors-and-potential-silent-data-loss/118936 · https://github.com/googleapis/js-genai/issues/1275 · https://github.com/BerriAI/litellm/issues/15293 · https://github.com/musistudio/claude-code-router/issues/1315
