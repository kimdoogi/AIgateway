# Vercel AI SDK Provider Spec 심층 분석

- 날짜: 2026-08-20
- 분석 대상: `vercel/ai` shallow clone @ commit `c0595b45` (2026-08-19)
- 분석 관점: AI Gateway 설계 — (1) N+M 어댑터, (2) 대화 중간 모델 교체, (3) 프로바이더 고유 기능 전부 노출
- 관련 문서: [Portkey 분석](2026-08-20-portkey-gateway.md) · [LiteLLM 분석](2026-08-20-litellm.md) · [ADR-0001](../decisions/ADR-0001-adapter-architecture.md)

## 0. 버전 현황: V2가 아니라 **V4가 최신**이다

`packages/provider/src/language-model/` 아래에 `v2`, `v3`, `v4` 디렉토리가 공존하며, 현재 `@ai-sdk/provider` 4.0.7 (AI SDK 7 세대)의 최신 스펙은 **`LanguageModelV4`**다. `packages/anthropic/src/anthropic-language-model.ts:175`와 `packages/openai/src/responses/openai-responses-language-model.ts:195` 모두 `readonly specificationVersion = 'v4'`를 선언한다. 구버전 타입을 지우지 않고 나란히 유지하는 것 자체가 설계 포인트다 — 스펙 버전은 인터페이스의 `specificationVersion` 리터럴 필드로 discriminate되고, 코어(`ai` 패키지)가 구버전 모델을 감지해 어댑트하거나 거부할 수 있다.

### V1→V2→V3→V4 마이그레이션에서 "왜 바꿨는지" (CHANGELOG/마이그레이션 문서 근거)

`packages/provider/CHANGELOG.md`의 3.0.0 (line 290~349), 4.0.0 항목과 `content/docs/08-migration-guides/23-migration-guide-7-0.mdx`, `24-migration-guide-6-0.mdx`에서 확인한 변화의 방향성:

**V2→V3 (AI SDK 6):**
- `finishReason`이 문자열 enum → **`{ unified, raw }` 구조체**로 변경 (changelog `cbf52cd: feat: expose raw finish reason`). 정규화하면서 원본을 버리지 않는 방향.
- usage가 flat(`inputTokens: number`) → **중첩 구조**(`inputTokens: { total, noCache, cacheRead, cacheWrite }`, `outputTokens: { total, text, reasoning }`, `raw`)로 확장 (changelog `3bd2689: feat: extended token usage`). **Anthropic 전용 metadata였던 `cacheCreationInputTokens`가 표준 usage 필드로 승격**됐다 — 7.0 마이그레이션 가이드에 "provider-agnostic `usage` object에 이미 있는 정보를 중복했으므로 `providerMetadata.anthropic.cacheCreationInputTokens` 제거"라고 명시 (`23-migration-guide-7-0.mdx:1848`). 즉 **providerOptions/Metadata는 신기능 인큐베이션 레인이고, 여러 프로바이더가 공유하게 되면 스펙으로 흡수하는 사이클**이 명확하다.
- warning 통합(`SharedV3Warning`), tool 실행 승인(`tool-approval`), preliminary tool result, provider tool 명칭 정리, tool별 strict mode, tool input examples 추가.

**V3→V4 (AI SDK 7):**
- `reasoning-file` content type, `custom` content type(`kind: '{provider}.{provider-type}'`) 신설.
- file part의 `data`가 단순 문자열/URL → **tagged union `SharedV4FileData`** (`data | url | reference | text`)로 변경 + provider reference(파일 업로드 추상화) 도입 (changelog `9bd6512`, `c29a26f`).
- **top-level `reasoning` 파라미터** (`'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'`) 승격 (changelog `3887c70`) — 역시 providerOptions에 있던 reasoning effort가 표준으로 흡수된 사례.
- `doGenerate` 리턴이 인라인 객체 → `LanguageModelV4GenerateResult` 명명 타입으로 추출.

## A. Canonical 요청 포맷

### 메시지/프롬프트 구조 — `packages/provider/src/language-model/v4/language-model-v4-prompt.ts`

```
LanguageModelV4Prompt = Array<LanguageModelV4Message>
```

`LanguageModelV4Message`는 role별 content union + 공통 `providerOptions?: SharedV4ProviderOptions` (line 20~59):

| role | content 허용 파트 |
|---|---|
| `system` | `content: string` (파트 배열 아님!) |
| `user` | `LanguageModelV4TextPart \| LanguageModelV4FilePart` |
| `assistant` | `TextPart \| FilePart \| CustomPart \| ReasoningPart \| ReasoningFilePart \| ToolCallPart \| ToolResultPart` |
| `tool` | `ToolResultPart \| ToolApprovalResponsePart` |

핵심 파트 타입 (모두 같은 파일):
- `LanguageModelV4TextPart` `{ type: 'text', text, providerOptions? }` (line 64)
- `LanguageModelV4ReasoningPart` `{ type: 'reasoning', text, providerOptions? }` (line 83) — **서명/암호화 데이터는 표준 필드가 아니라 providerOptions에 실린다**
- `LanguageModelV4FilePart` `{ type: 'file', filename?, data: SharedV4FileData, mediaType, providerOptions? }` (line 151). `SharedV4FileData`는 `packages/provider/src/shared/v4/shared-v4-file-data.ts`의 tagged union: `{type:'data', data: Uint8Array|string(base64)}` / `{type:'url', url: URL}` / `{type:'reference', reference: {[provider]: id}}` / `{type:'text', text}`. 별도 image part는 없음 — mediaType으로 구분.
- `LanguageModelV4ToolCallPart` `{ type: 'tool-call', toolCallId, toolName, input: unknown, providerExecuted?, providerOptions? }` (line 194)
- `LanguageModelV4ToolResultPart` `{ type: 'tool-result', toolCallId, toolName, output: LanguageModelV4ToolResultOutput, providerOptions? }` (line 229)
- `LanguageModelV4ToolResultOutput` (line 288): `text | json | execution-denied | error-text | error-json | content` union. `content`는 다시 `text | file | custom` 파트 배열 — 멀티모달 tool output 지원.
- `LanguageModelV4ToolApprovalResponsePart` `{ type: 'tool-approval-response', approvalId, approved, reason? }` (line 259)
- `LanguageModelV4CustomPart` `{ type: 'custom', kind: '${string}.${string}' }` (line 132) — 표준화 불가능한 프로바이더 고유 블록(예: `openai.compaction`)의 탈출구.

주의할 비대칭: **요청 방향 `ToolCallPart.input`은 `unknown`(객체)**인데, **응답 방향 `LanguageModelV4ToolCall.input`은 `string`(stringified JSON)** (`language-model-v4-tool-call.ts:24`)이다. 스트리밍 delta 누적과의 정합성 때문.

### 호출 옵션 — `language-model-v4-call-options.ts`

`LanguageModelV4CallOptions` = `prompt` + 정규화된 샘플링 파라미터(`maxOutputTokens, temperature, stopSequences, topP, topK, presencePenalty, frequencyPenalty, seed`) + `responseFormat`(`{type:'text'} | {type:'json', schema?, name?, description?}`) + `tools: Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool>` + `toolChoice`(`auto|none|required|tool`) + `reasoning`(effort enum) + `includeRawChunks` + `abortSignal` + `headers` + `providerOptions`.

- `LanguageModelV4FunctionTool` (`language-model-v4-function-tool.ts`): `{ type:'function', name, description?, inputSchema: JSONSchema7, inputExamples?, strict?, providerOptions? }`
- `LanguageModelV4ProviderTool` (`language-model-v4-provider-tool.ts`): `{ type:'provider', id: '<provider-id>.<tool-name>', name, args }` — 서버 실행 툴(web_search 등)은 별도 타입.

## B. 스트리밍 이벤트 모델

### 전체 이벤트 목록 — `language-model-v4-stream-part.ts`

`LanguageModelV4StreamPart` (line 14~110):

| 그룹 | 이벤트 |
|---|---|
| 수명주기 | `stream-start {warnings}` (최초 1회) → `response-metadata {id?, timestamp?, modelId?}` → … → `finish {usage, finishReason, providerMetadata?}` |
| 텍스트 블록 | `text-start {id}` / `text-delta {id, delta}` / `text-end {id}` |
| 추론 블록 | `reasoning-start` / `reasoning-delta` / `reasoning-end` (동일한 id 기반 3단계) |
| 툴 입력 | `tool-input-start {id, toolName, providerExecuted?, dynamic?, title?}` / `tool-input-delta {id, delta}` / `tool-input-end {id}` → 완성본 `tool-call` (LanguageModelV4ToolCall) |
| 툴 결과 | `tool-result`, `tool-approval-request` |
| 기타 콘텐츠 | `file`, `reasoning-file`, `source`(url/document citation), `custom` |
| 저수준 | `raw {rawValue}` (includeRawChunks 시), `error {error}` (스트림을 죽이지 않고 복수 에러 전달 가능) |

**설계 특징**: (1) 모든 콘텐츠가 **id 기반 블록 스코프** — 여러 블록이 병렬 진행 가능. (2) 거의 모든 이벤트에 `providerMetadata` 훅. (3) 툴 입력은 "delta 스트림 + 완성본 재전송"의 이중 전달 — 소비자는 delta를 무시하고 `tool-call`만 받아도 된다.

### Anthropic SSE → canonical 변환 — `packages/anthropic/src/anthropic-language-model.ts` doStream (line 1526~2717)

`TransformStream<ParseResult<anthropicChunkSchema>, LanguageModelV4StreamPart>` 하나로 구현. 매핑 표:

| Anthropic SSE | Canonical |
|---|---|
| `message_start` | `response-metadata` + input usage 시딩. 중복 `message_start` 감지 시 `InvalidResponseDataError`를 `error` 파트로 (line 2441~2458) |
| `content_block_start` (`text`) | `text-start` — **id는 `String(value.index)`** (블록 인덱스) |
| `content_block_start` (`thinking`) | `reasoning-start` |
| `content_block_start` (`redacted_thinking`) | `reasoning-start` + `providerMetadata.anthropic.redactedData` (line 1706~1718) |
| `content_block_start` (`tool_use`) | `tool-input-start {id: part.id}` — 툴은 인덱스가 아니라 **provider가 준 tool id** |
| `content_block_start` (`server_tool_use`/`mcp_tool_use`/`*_tool_result` 등) | 즉시 `tool-input-start` or 완성된 `tool-call`/`tool-result`/`source` (line 1783~2192) |
| `content_block_delta` `text_delta` / `thinking_delta` / `input_json_delta` | `text-delta` / `reasoning-delta` / `tool-input-delta` (+ 내부적으로 input 누적) |
| `content_block_delta` **`signature_delta`** | **`reasoning-delta { delta: '', providerMetadata: { anthropic: { signature } } }`** (line 2331~2347) — 텍스트 없는 delta에 metadata만 실어 서명을 통과시키는 패턴 |
| `content_block_stop` | `text-end`/`reasoning-end`/`tool-input-end` + 누적 input으로 완성 `tool-call` enqueue (line 2203~2299) |
| `message_delta` | usage/stop_reason/container 누적 (이벤트 방출 없음) |
| `message_stop` | `finish { finishReason, usage: convertAnthropicUsage(...), providerMetadata: { anthropic: {usage(raw), stopSequence, container, contextManagement, iterations...} } }` (line 2609~2661) |

또 하나 중요한 패턴 (line 2678~2711): 스트림을 `tee()`해서 **첫 청크를 미리 읽고**, Anthropic이 HTTP 200으로 보내는 in-stream `overloaded_error`를 `APICallError(statusCode: 529, isRetryable: true)`로 승격시킨다. 게이트웨이 폴백 트리거에 그대로 필요한 로직.

### OpenAI Responses SSE → canonical — `packages/openai/src/responses/openai-responses-language-model.ts` doStream (line 1293~)

- `response.output_item.added/done`이 골격. **id 체계가 Anthropic과 다름**: item id(`msg_…`, `rs_…`, `fc_…`)를 canonical 블록 id로 쓰되, reasoning은 summary 단위로 **`${itemId}:${summaryIndex}`** 합성 id를 만든다 (line 1667, 2384).
- reasoning: `output_item.added(type:'reasoning')` → `reasoning-start` + `providerMetadata[providerOptionsName] = { itemId, reasoningEncryptedContent }` (line 1665~1675). `reasoning_summary_text.delta` → `reasoning-delta`. `store:false`면 summary part 종료를 미뤄서("can-conclude" 상태머신, line 2410~2439) **마지막 part의 `reasoning-end`에 encrypted_content를 실어 보낸다** — 다음 턴 재구성에 필요한 데이터를 metadata로 왕복시키기 위한 정교한 장치.
- `function_call` done → `tool-input-end` + `tool-call { toolCallId: call_id, providerMetadata: { [provider]: { itemId, namespace?, caller? } } }` (line 1699~1737).
- **JSON 합성 트릭**: code_interpreter/apply_patch처럼 provider가 JSON이 아닌 원시 텍스트(코드/디프)를 스트리밍하는 경우, `escapeJSONDelta`로 이스케이프한 delta를 흘리다가 마지막에 `'"}'` 같은 닫는 조각을 **가짜 delta로 주입**해 canonical `tool-input-delta` 누적 결과가 valid JSON이 되게 만든다 (line 2284~2320).
- OpenAI-compatible 서버가 item id를 이벤트마다 바꾸는 문제를 `output_index` 기반 `resolveOutputItemId`로 방어 (line 1398~1410).
- `response.completed/incomplete` → finishReason/usage 확정, `response.failed`/`error` 청크 → `error` 파트. 스트림 시작 전 에러는 `throwIfOpenAIStreamErrorBeforeOutput`으로 throw (line 1326).

SSE 파싱 공통 인프라: `packages/provider-utils/src/response-handler.ts:101` `createEventSourceResponseHandler(chunkSchema)` — SSE를 zod 스키마로 검증한 `ParseResult<T>`(성공/실패 태그) 스트림으로 만들고, 파싱 실패 청크는 스트림 중단이 아니라 `{type:'error'}` 파트가 된다.

## C. 고유 기능 노출: providerOptions(요청) / providerMetadata(응답)

### 타입과 규약

- `SharedV4ProviderOptions` = `SharedV4ProviderMetadata` = **`Record<string, JSONObject>`** (`packages/provider/src/shared/v4/shared-v4-provider-options.ts`, `-metadata.ts`). 외부 키 = 프로바이더 이름(네임스페이스), 내부 = 자유 JSON. JSDoc 예시가 바로 `{ "anthropic": { "cacheControl": { "type": "ephemeral" } } }`.
- 부착 지점: 요청 방향은 **CallOptions, 메시지, 모든 content part, tool output, function tool**에 `providerOptions?`; 응답 방향은 **모든 content/stream part와 finish**에 `providerMetadata?`.
- 어댑터는 `parseProviderOptions({ provider: 'anthropic', providerOptions, schema })` (`packages/provider-utils/src/parse-provider-options.ts`)로 **자기 네임스페이스만 zod 검증해서 꺼내고, 다른 네임스페이스는 존재 자체를 모른다**. 키가 없으면 `undefined`(무시), 키가 있는데 스키마 위반이면 `InvalidArgumentError` throw.

### 왕복(round-trip)의 숨은 계약

`packages/ai/src/generate-text/to-response-messages.ts:45~128` — 모델 응답을 히스토리 메시지로 되돌릴 때 **모든 파트의 `providerMetadata`를 그대로 `providerOptions`로 복사**한다 (`providerOptions: part.providerMetadata`). 이 한 줄이 "응답에서 나온 signature/itemId/encrypted_content가 다음 요청에 자동으로 실려 돌아가는" 메커니즘의 전부다. **게이트웨이가 히스토리를 직접 관리한다면 이 라운드트립을 반드시 재현해야 한다.**

### Anthropic `cache_control` 추적 (전 경로)

1. 사용자가 파트/메시지 `providerOptions.anthropic.cacheControl = { type: 'ephemeral', ttl?: '5m'|'1h' }` 지정 (스키마: `packages/anthropic/src/anthropic-language-model-options.ts:163`).
2. `convertToAnthropicPrompt`가 파트→메시지 순 fallback으로 읽는다: 파트 우선, 메시지 레벨은 마지막 파트에만 적용 (`convert-to-anthropic-prompt.ts:226~238`, tool result는 part→output→message 3단 fallback, line 435~454).
3. `CacheControlValidator` (`packages/anthropic/src/get-cache-control.ts`)가 (a) `cacheControl`/`cache_control` 둘 다 허용, (b) **최대 4개 breakpoint 초과 시 warning 후 무시**, (c) thinking 블록처럼 캐시 불가 컨텍스트(`canCache: false`)에 붙이면 warning 후 무시.
4. 변환된 Anthropic 블록의 `cache_control` 필드로 방출.
5. 응답의 캐시 사용량은 providerMetadata가 아니라 **표준 usage**(`usage.inputTokens.cacheRead/cacheWrite`)로 돌아온다 — `convert-anthropic-usage.ts`.

### Anthropic thinking 추적

- 요청: `providerOptions.anthropic.thinking` discriminated union `adaptive {display} | enabled {budgetTokens} | disabled` (`anthropic-language-model-options.ts:130~151`). `getArgs`에서: top-level `reasoning` effort는 providerOptions가 없을 때만 `resolveAnthropicReasoningConfig`로 매핑되고 **providerOptions가 항상 우선** (`anthropic-language-model.ts:442~465`); enabled인데 budget 없으면 warning + 기본 1024; `max_tokens += thinkingBudget`; temperature/topK/topP는 warning과 함께 제거 (line 672~716).
- 응답: thinking 블록 → `{ type:'reasoning', text, providerMetadata: { anthropic: { signature } } }`, redacted → `{ text:'', providerMetadata: { anthropic: { redactedData } } }` (line 1034~1057). 스트리밍에서는 `signature_delta`를 빈 delta+metadata로 전달.
- 다음 턴 요청: `convert-to-anthropic-prompt.ts:670~723`이 `providerOptions.anthropic`을 `anthropicReasoningMetadataSchema`(`anthropic-api.ts:1458`: `{signature?, redactedData?}`)로 파싱해 `thinking`/`redacted_thinking` 블록으로 복원. **signature도 redactedData도 없으면 warning 내고 드롭.**

### OpenAI 쪽 대응물

- 요청 옵션(`openai-responses-language-model-options.ts:155~`): `store`, `conversation`, `previousResponseId`, `promptCacheKey`, `promptCacheOptions/Retention`, `reasoningEffort/Summary/Mode/Context`, `serviceTier`, `logprobs`, `parallelToolCalls`, `include`, `strictJsonSchema`, `textVerbosity`, `truncation` 등.
- 응답 metadata: `itemId`(모든 item), `reasoningEncryptedContent`, `phase`, `annotations`, `namespace`, `caller`. 다음 요청에서 `itemId`는 `store:true`면 `{type:'item_reference', id}`로 압축되고(`convert-to-openai-responses-input.ts:336~338, 775~787`), `store:false`면 `encrypted_content`로 reasoning item을 풀 재구성한다 (line 806~849).
- 흥미로운 디테일: custom provider 이름을 쓰는 재포장 프로바이더를 위해 `providerOptionsName`이 동적이고, Anthropic 어댑터는 canonical `anthropic` 키와 custom 키를 **둘 다 읽고 병합**하며 응답 metadata도 두 키에 미러링한다 (`anthropic-language-model.ts:289~313, 1517~1519`).

## D. 대화 중간 모델 교체

### 구조 확인: 완전 stateless 재변환

히스토리는 canonical `LanguageModelV4Prompt`로 유지되고, **매 호출마다 어댑터가 전체 히스토리를 프로바이더 포맷으로 새로 변환**한다 (`convertToAnthropicPrompt`, `convertToOpenAIResponsesInput`은 순수 함수). 프로바이더 상태성(OpenAI `store`/`previousResponseId`)은 providerOptions로만 opt-in되는 예외다.

역할 배치 재조정도 어댑터 책임: Anthropic 어댑터의 `groupIntoBlocks` (`convert-to-anthropic-prompt.ts:1304~1370`)는 연속된 `user`+`tool` 메시지를 하나의 user 메시지로 합치고, `moveToolUseBlocksToEnd`로 Anthropic이 요구하는 블록 순서(thinking 먼저, tool_use는 세그먼트 끝)를 강제한다. 즉 canonical 포맷은 role 배치 규칙을 강제하지 않고 어댑터가 흡수한다.

### A 프로바이더 히스토리를 B 어댑터에 넣으면 — 코드 근거별 결과

**잘 되는 것:**
- 텍스트/파일/시스템 메시지: 완전 이식.
- **tool-call/tool-result 쌍**: `toolCallId`가 양쪽 모두 **원문 그대로 통과**된다 — Anthropic은 `tool_use.id = part.toolCallId` (`convert-to-anthropic-prompt.ts:848~855`), OpenAI는 `function_call.call_id = part.toolCallId` (`convert-to-openai-responses-input.ts:605~614`). id 재매핑 계층이 없다. Anthropic의 `toolu_…` id가 OpenAI로, OpenAI의 `call_…` id가 Anthropic으로 가도 두 API 모두 클라이언트 함수 호출 id에 자유 문자열을 허용하므로 동작한다(단, 프로바이더측 포맷/길이 검증은 API에 위임 — 어댑터는 검증하지 않음).
- **타 프로바이더 네임스페이스의 providerOptions**: `parseProviderOptions`가 자기 키만 읽으므로 **조용히 무시**된다. 오염이 에러를 내지 않는 구조.
- tool output union: 각 어댑터가 자체적으로 변환 (Anthropic: `json`→`JSON.stringify`, `content`→멀티모달 블록, `execution-denied`→텍스트, `convert-to-anthropic-prompt.ts:456~591`).

**손실되는 것 (warning + drop, 요청은 계속 진행):**
- **reasoning 파트가 양방향 모두 드롭**된다. 이것이 최대 손실.
  - Anthropic 어댑터: `providerOptions.anthropic.signature`나 `redactedData`가 없으면 → `warnings.push({message: 'unsupported reasoning metadata'})` 후 스킵 (`convert-to-anthropic-prompt.ts:704~715`). OpenAI가 만든 reasoning은 `anthropic` 키가 없으므로 무조건 여기 걸린다.
  - OpenAI 어댑터: `openai.itemId`도 `reasoningEncryptedContent`도 없으면 → `'Non-OpenAI reasoning parts are not supported. Skipping reasoning part: …'` (`convert-to-openai-responses-input.ts:850~855`). Anthropic이 만든 reasoning(서명은 있지만 `anthropic` 네임스페이스)이 여기 걸린다.
  - 결론: 모델 교체 시 **추론 텍스트는 있어도 컨텍스트에 실리지 않는다**. 대화 자체는 안 깨진다.
- **provider-executed 툴 활동**: Anthropic `web_search`/`code_execution` 등의 tool-call은 `providerExecuted: true`인데, OpenAI 어댑터는 provider-executed tool-call을 itemId 없으면 사실상 스킵하고 (`convert-to-openai-responses-input.ts:439~448`), 매칭 안 되는 tool-result는 warning 후 드롭한다. 반대 방향도 동일 (Anthropic 어댑터는 자기가 아는 서버 툴 이름이 아니면 `'provider executed tool call for tool X is not supported'` warning, `convert-to-anthropic-prompt.ts:837~842`). **서버 툴 히스토리는 프로바이더 간 이식 불가**가 스펙의 현실이다 (단, web_search 결과가 `source` 파트로도 방출되는데 source는 히스토리로 되돌아가지 않음 — `to-response-messages.ts:27~30`에서 스킵).
- `custom` 파트: `kind`가 `openai.compaction`이 아니면 OpenAI 어댑터가 무시, Anthropic도 자기 것만 처리. 설계상 의도된 격리.

**깨질 수 있는 것:**
- OpenAI `store:true`로 진행하던 대화에서 itemId 기반 `item_reference` 최적화가 텍스트 파트의 실제 내용 보존과 함께 가긴 하지만, reasoning은 summary 텍스트+encrypted_content가 전부라 **Anthropic으로 갔다가 돌아오면 reasoning 체인이 끊긴다** (OpenAI는 허용, 품질 저하만).
- Anthropic으로 돌아올 때: interleaved thinking 상태에서 assistant 턴의 tool_use 앞 thinking 블록이 (드롭돼서) 없으면 Anthropic API가 400을 낼 수 있다 — 어댑터는 이를 막지 않고 API 검증에 맡긴다.
- 요약: **"동작하지만 lossy"**. Vercel의 답은 (1) warning으로 강등, (2) 요청 차단 없음, (3) provider 상태는 metadata로 캡슐화.

## E. 어댑터 인터페이스 계약

`packages/provider/src/language-model/v4/language-model-v4.ts` — 인터페이스 전체가 **필드 4개 + 메서드 2개**로 극단적으로 얇다:

```ts
type LanguageModelV4 = {
  readonly specificationVersion: 'v4';
  readonly provider: string;
  readonly modelId: string;
  supportedUrls: PromiseLike<Record<string, RegExp[]>> | Record<string, RegExp[]>;
  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult>;
  doStream(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4StreamResult>;
};
```

- `doGenerate` 결과(`language-model-v4-generate-result.ts`): `content: LanguageModelV4Content[]`(**순서 있는** 파트 배열 — 응답도 요청과 동형), `finishReason: {unified, raw}`, `usage`, `providerMetadata?`, `request.body`/`response.{id,modelId,headers,body}`(텔레메트리용), `warnings`(필수 배열).
- `doStream` 결과: `{ stream: ReadableStream<LanguageModelV4StreamPart>, request?, response? }`.
- **capability 선언은 `supportedUrls` 하나뿐**이다. media type 패턴 → URL 정규식 배열 (예: Anthropic `packages/anthropic/src/anthropic-provider.ts:165~168`은 `'image/*': [/^https?:\/\/.*$/], 'application/pdf': [...]`). 코어의 `downloadAssets` (`packages/ai/src/prompt/convert-to-language-model-prompt.ts:442~`)가 이 표에 매칭 안 되는 URL 파일을 **SDK가 대신 다운로드해서 bytes로 인라인**한다. 즉 supportedUrls는 "네이티브 URL 전달 vs 프록시 다운로드"의 분기 스위치.
- 그 외 capability는 **사전 협상이 아니라 사후 warning으로 처리** (`SharedV4Warning`: `unsupported | compatibility | deprecated | other`, `shared-v4-warning.ts`). 모델별 세부 능력(adaptive thinking 지원, structured output, max tokens 등)은 어댑터 내부의 capability 테이블(`getModelCapabilities`, `openai-language-model-capabilities.ts`)로만 존재하고 스펙에 노출되지 않는다.
- 에러 정규화: `packages/provider/src/errors/` — `AISDKError` 계열, cross-realm 안전한 `Symbol.for` marker 기반 `isInstance`. 핵심은 `APICallError` (`api-call-error.ts`): `statusCode, responseHeaders, responseBody, requestBodyValues`, 그리고 **`isRetryable` 기본 휴리스틱 = 408/409/429/5xx** (line 28~32). 어댑터별 HTTP 에러 매핑은 `createJsonErrorResponseHandler + errorSchema(zod)` 조합 (`anthropic-error.ts` 26줄이 전부).
- finishReason 정규화: 어댑터별 매핑 함수 (`map-anthropic-stop-reason.ts`: `end_turn/stop_sequence/pause_turn→stop`, `refusal→content-filter`, `max_tokens/model_context_window_exceeded→length`, `tool_use→tool-calls`(단 json response tool이면 `stop`), 나머지 `other`) + `raw`에 원문 보존.
- usage 정규화: `convertAnthropicUsage` — Anthropic의 `input_tokens`는 non-cached만이므로 `total = input + cacheWrite + cacheRead`로 합성; `convertOpenAIResponsesUsage` — OpenAI `input_tokens`는 total이므로 `noCache = total - cached - cacheWrite`로 역산. **같은 필드명의 의미 차이를 어댑터가 흡수하는 대표 사례.** `raw`에 원본 usage 통째 보존.
- 부속 스펙: `ProviderV4` (모달리티별 팩토리, `provider/v4/provider-v4.ts`), `LanguageModelV4Middleware` (`language-model-middleware/v4/`: `transformParams / wrapGenerate / wrapStream / overrideSupportedUrls` — 게이트웨이의 요청 변환/로깅/가드레일을 끼울 수 있는 합성 계층), `BatchLanguageModelV4` (`language-model-v4-batch.ts`).

## F. 테스트 전략

세 층 구조로, 골든셋 기반 게이트웨이 테스트에 거의 그대로 이식 가능한 패턴이다:

1. **HTTP 목킹**: `packages/test-server/src/create-test-server.ts` — **msw** (`setupServer`) 기반. URL별로 `json-value | stream-chunks | binary | empty | error | controlled-stream` 응답 타입 선언. `controlled-stream`은 청크 타이밍을 테스트가 제어(백프레셔/중단 테스트용). `server.calls[n].requestBodyJson`으로 어댑터가 만든 요청 본문을 검사할 수 있다.
2. **픽스처 = 실제 캡처된 프로바이더 응답**: `packages/anthropic/src/__fixtures__/`에 `*.json`(non-stream body)과 `*.chunks.txt`(**raw SSE 이벤트를 줄 단위로 저장**, 테스트가 `data: ` 접두어를 붙여 재생 — `anthropic-language-model.test.ts:53~63`). Anthropic 테스트 파일 하나에서만 픽스처 로드가 167회. 픽스처 이름이 기능 단위(`anthropic-clear-thinking.1.chunks.txt` 등)로 관리된다.
3. **스냅샷 이중 검증**:
   - 요청 방향: `expect(await server.calls[0].requestBodyJson).toMatchInlineSnapshot(...)` — canonical 입력 → 프로바이더 요청 본문 골든셋.
   - 응답 방향: `convertReadableStreamToArray(stream)`으로 canonical 스트림 파트 배열을 만들어 스냅샷 (`__snapshots__/anthropic-language-model.test.ts.snap`) — 프로바이더 SSE → canonical 이벤트 골든셋. 파일 하나에 inline/외부 스냅샷 어서션 238회.
   - 추가로 `*.test-d.ts` 타입 테스트, `mockId`로 ID 생성 결정론화, `vi.mock('./version')`으로 헤더 안정화.

**게이트웨이 골든셋에 가져갈 요점**: "raw SSE 텍스트 파일 → 재생 → canonical 이벤트 배열 스냅샷"은 변환기 회귀 테스트의 최소비용 최대효과 구조다. 실전 트래픽에서 새 이벤트 타입이 나올 때 chunks.txt 한 장 추가로 케이스가 늘어난다.

## G. 게이트웨이 용도로서의 한계 (클라이언트 라이브러리 태생의 갭)

먼저 반전 하나: **Vercel 자신의 게이트웨이(`packages/gateway/src/gateway-language-model.ts`)는 이 스펙을 그대로 wire protocol로 쓴다.** `LanguageModelV4CallOptions`를 JSON으로 POST하고, 서버가 `LanguageModelV4StreamPart`를 그대로 SSE로 돌려준다. 즉 스펙이 게이트웨이 프로토콜로 승격 가능함은 실증돼 있다. 단, 그 과정에서 드러나는 갭들:

1. **비-JSON 값**: `Uint8Array` 파일 데이터(gateway가 `maybeEncodeFileParts`로 base64 강제 변환, line 199~220), `URL` 객체, `Date`(`response-metadata.timestamp`를 수신 측에서 `new Date()` 재수화, line 166~172), `supportedUrls`의 `RegExp`, `abortSignal`(직렬화 불가, 명시적으로 strip — line 61). wire 스키마를 새로 정의해야 한다.
2. **멀티테넌시/과금 부재**: 인증·테넌트·쿼터·요금 개념이 스펙에 없다. usage는 `raw`까지 잘 정규화돼 있지만(과금 원장 소스로 충분), 모델별 단가표·비용 계산은 완전히 외부 책임. Anthropic `iterations`(다른 단가로 과금되어 top-level에 합산 안 됨 — `convert-anthropic-usage.ts` 주석)처럼 **단일 usage 숫자로 과금이 안 되는 케이스**가 이미 존재한다.
3. **라우팅/폴백 계약 없음**: 재시도 판단은 `APICallError.isRetryable` 휴리스틱뿐. idempotency key, 스트림 중간 실패 시 재개(cursor/offset), 부분 과금 처리 같은 개념이 없다. `stream-start` 이후 실패하면 소비자는 이미 이벤트를 받은 상태다 (Anthropic 어댑터의 first-chunk 프로브는 이 문제를 일부만 완화).
4. **capability 협상 부재**: `supportedUrls` 외의 기능 매트릭스(structured output, thinking 지원, strict tools, max output tokens)는 어댑터 내부 테이블에 숨어 있어, **라우터가 "이 요청을 어느 모델이 수용 가능한가"를 스펙 수준에서 물어볼 방법이 없다**. warning은 사후적이다.
5. **reasoning 히스토리 이식성**: D에서 본 대로 프로바이더 간 교체 시 reasoning 드롭이 스펙의 공식 입장이다. seamless switch를 파는 게이트웨이라면 자체 정책(예: 외래 reasoning을 text로 강등 주입, 혹은 명시적 제거)이 필요하다.
6. **프로바이더 서버 상태 누수**: OpenAI `store`/`conversation`/`previousResponseId`, Anthropic `container.id` 같은 서버측 상태가 providerOptions/Metadata로 새어 나온다. 멀티테넌트 게이트웨이는 이들의 수명·소유권을 관리할 계층이 없다.
7. **스트림 운영성**: keepalive/heartbeat, 진행 중 usage(과금 미터링용 중간 집계), 서버 푸시 취소 통지가 없다. `raw` 파트는 있지만 크기 제어·필터 정책이 없다.

---

## 우리 게이트웨이에 가져올 것

1. **N+M 어댑터 토폴로지 그 자체**: canonical prompt(요청)와 canonical content/stream part(응답)가 **동형(파트 union이 요청·응답에서 재사용)**이라 히스토리 라운드트립이 공짜가 되는 구조. `toResponseMessages`의 `providerMetadata → providerOptions` 복사 계약 포함.
2. **네임스페이스형 providerOptions/providerMetadata** (`Record<providerName, JSONObject>`): 모르는 네임스페이스는 조용히 무시 → 멀티 프로바이더 히스토리가 오염 없이 공존. 우리 라우팅 게이트웨이에 특히 적합 — 클라이언트가 후보 프로바이더 전부의 옵션을 미리 실어 보낼 수 있다.
3. **"metadata 인큐베이션 → 스펙 승격" 사이클**: cache usage(V3), reasoning effort(V4)가 걸어온 길. 우리도 canonical 스키마를 최소로 시작하고 공통화된 것만 승격.
4. **`{unified, raw}` 이중 finishReason과 중첩 usage + `raw`**: 정규화와 원본 보존을 동시에. 과금·디버깅에 필수.
5. **id 기반 블록 스코프 스트림 이벤트 문법** (start/delta/end + 완성본 tool-call 재전송, 빈 delta에 metadata만 싣는 signature 패턴, `${itemId}:${summaryIndex}` 합성 id).
6. **warning 기반 성능 저하(graceful degradation)**: 지원 안 되는 기능은 요청 차단이 아니라 `warnings` 배열로. 4종 태그(`unsupported/compatibility/deprecated/other`)도 그대로 쓸 만하다.
7. **테스트 전략 전체**: raw SSE 픽스처 재생 + canonical 이벤트 배열 스냅샷 + 요청 본문 인라인 스냅샷. msw급 HTTP 목킹과 controlled-stream.
8. **어댑터 방어 패턴들**: first-chunk 프로브로 200-에러를 APICallError로 승격(Anthropic 529), non-JSON 스트림의 JSON 합성(escape + 닫는 delta 주입), output_index 기반 id 안정화, cache breakpoint 검증기(한도·컨텍스트 체크).
9. **`SharedV4FileData` tagged union** (bytes/url/reference/text) + `supportedUrls` 기반 "네이티브 전달 vs 게이트웨이 다운로드" 분기.
10. **Middleware 스펙** (`transformParams/wrapGenerate/wrapStream`): 게이트웨이의 정책 주입(가드레일, 로깅, 캐싱) 합성 지점으로 차용.

## 다르게 갈 것

1. **wire 스키마를 1급으로 설계**: Vercel은 TS 타입이 진실이고 직렬화는 사후 땜질(base64 강제, Date 재수화, abortSignal strip)이다. 우리는 처음부터 JSON 스키마를 canonical로 정의하고 TS 타입을 파생시킨다.
2. **capability를 선언적 매트릭스로 노출**: `supportedUrls`뿐인 스펙 대신, 라우터가 사전 질의 가능한 기능 매트릭스(structured output, reasoning, tool streaming, max tokens, 지원 mediaType, 서버 툴 목록)를 모델 레지스트리에 둔다. 어댑터 내부 테이블에 숨기지 않는다.
3. **reasoning 이식 정책을 명시적 옵션으로**: warning-drop이 아니라 사용자가 고르게 한다 — `drop`(Vercel 방식) / `demote-to-text` / `strip-and-annotate`. 특히 A→B→A 왕복 시 서명 무효화 시나리오를 게이트웨이가 감지·처리.
4. **스트림 운영 이벤트 추가**: heartbeat, 중간 usage 집계(과금 미터링), 재시도/폴백 발생 통지(`provider-switched` 이벤트), 스트림 재개 커서. `stream-start` 이전 실패만이 아니라 mid-stream 폴백 계약 정의.
5. **과금/테넌시 전용 envelope**: usage.raw에 얹지 말고 요청/응답 envelope에 tenant, 요금 라인아이템(Anthropic `iterations`류 다중 단가 반영), 비용 산출 결과를 별도 층으로.
6. **tool-call id 정규화 계층**: 현재는 verbatim pass-through라 프로바이더 API 검증에 운을 맡긴다. 게이트웨이는 id 매핑 테이블(원본 id ↔ 정규화 id)을 유지해 프로바이더별 포맷 제약(길이·문자셋)을 흡수한다.
7. **프로바이더 서버 상태의 수명 관리**: OpenAI store/conversation, Anthropic container 같은 상태 참조를 게이트웨이 리소스로 등록해 TTL/소유권/삭제를 관리 (providerOptions로 그냥 흘려보내지 않음).
8. **에러 분류 체계 확장**: `isRetryable` boolean 대신 retry-after, 폴백 적합성(같은 프로바이더 재시도 vs 타 프로바이더 폴백 vs 사용자 오류), 과금 여부(요청이 과금됐는가)를 가진 구조화 에러 코드.
9. **버전 공존 전략은 차용하되 단순화**: v2/v3/v4 디렉토리 병존 + `specificationVersion` discriminator는 좋지만, 우리는 서버이므로 wire 버전 협상(헤더 기반)으로 대체하고 내부 canonical은 단일 최신만 유지 + 경계에서 업/다운컨버트.
