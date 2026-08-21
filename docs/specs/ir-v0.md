# IR 스키마 v0 — 게이트웨이 canonical 중간 표현 명세

- 상태: **초안 v0** (2026-08-20) — 검토 후 walking skeleton에서 zod 구현으로 파생
- 전제 결정: [ADR-0001](../decisions/ADR-0001-adapter-architecture.md)(D1~D10) · [IR 설계 게이트 G1~G8](../decisions/ir-design-gate.md) · [ADR-0005](../decisions/ADR-0005-stream-contract.md)(스트림 계약) · [ADR-0007](../decisions/ADR-0007-billing-envelope.md)(billing)
- 입력 자료: 프로바이더 인벤토리 4종 ([Anthropic](../research/2026-08-20-anthropic-api-coverage.md) · [OpenAI](../research/2026-08-20-openai-api.md) · [Gemini](../research/2026-08-20-gemini-api.md) · [xAI](../research/2026-08-20-xai-grok-api.md))의 "IR 표준 후보" 섹션 통합

표기: 본 문서의 타입은 TypeScript 표기법의 **wire 스키마 명세**다 (JSON 직렬화 형태가 진실 — D2). `?`는 생략 가능, 생략과 `null`은 구분하지 않는다(직렬화 시 생략). zod 스키마는 이 문서에서 파생하며, 불일치 시 이 문서가 우선한다.

## 0. 게이트 결정 요약 (이 스펙이 구현하는 결정들)

| 결정 | 반영 위치 |
|---|---|
| G1 passthrough opaque 수납 + PO 왕복 불변식 | §2, §4.9, §6 |
| G2 단일 후보 (n>1 없음) | §7 (message 단수) |
| G3 effort enum 합집합 + 클램프 | §6.3 |
| G4 usage 정규화 공식 | §8 |
| G5 tool id required + 결정론적 합성 | §4.3, §13.2 |
| G6 system = 블록 배열 + 위치 보존 | §3 |
| G7 unified finishReason | §9 |
| G8 버전 필드 최소안, 네임스페이스 키 | §1, §2 |
| ADR-0005 스트림 풀스펙 + pause 노출 | §10, §9 |
| ADR-0007 billing 라인아이템 | §11 |
| D5/D10 warning·passthrough 체계 | §5, §2, §4.9 |

## 1. 공통 규약

- **버전**: 요청/응답 envelope 최상위 `version: "0"` (문자열). 호환성 깨는 변경 시 증가. 협상 메커니즘 없음(연기).
- **네임스페이스 키**: `anthropic` | `openai` | `google` | `xai` (+2차: `bedrock`, `vertex` 등 상속 어댑터 키).
- **직렬화 결정론** (D10): 동일 IR 값 → 바이트 동일 JSON. 규칙: 객체 키는 스키마 정의 순서로 직렬화, 생략 가능 필드는 값이 없으면 키 자체를 출력하지 않음, 숫자는 JSON 표준 최단 표현. (프로바이더 프롬프트 캐시 프리픽스 보존의 전제 — 골든셋 검증 대상.)
- **바이너리**: base64 문자열 (개행 없음).
- **id 규약**: 게이트웨이 생성 id는 접두사로 종류 구분 — `req_`(게이트웨이 요청), `blk_`(블록), `synth:`(합성 tool id, §13.2).

## 2. providerOptions / providerMetadata

```ts
type NS<T = JSONObject> = { [providerKey: string]: T };
// 요청 방향: providerOptions — 클라이언트/게이트웨이가 프로바이더에 지시
// 응답 방향: providerMetadata — 프로바이더가 반환한 고유 정보
```

- 부착 지점: 요청 envelope, 메시지, 모든 블록, 툴 정의 (`providerOptions`); 응답 envelope, 응답 블록, finish 이벤트 (`providerMetadata`).
- **어댑터 규칙**: 자기 네임스페이스만 스키마 검증 후 소비. 타 네임스페이스는 무시(에러 아님).
- **미지 키 정책** (D5): 자기 네임스페이스 안의 스키마에 없는 키는 기본 4xx 거부. 요청 envelope의 `allowUnknownProviderOptions: true` 또는 테넌트 설정으로 통과 허용 — 통과 시 `warning(code: "unknown-provider-option-passed")`.
- **표준 필드와의 충돌** (2026-08-21 확정): PO 키가 표준 IR 필드와 **같은 wire 슬롯**을 지정하면 **PO가 우선**하고, 어댑터는 `warning(code: "provider-option-override")`를 반드시 낸다 — 조용한 우선은 D5 위반. 게이트웨이 강제 정책도 이 규칙을 따른다(예: OpenAI `store: false` 강제 — ADR-0002 §2 — 를 명시 PO가 뒤집는 것은 opt-in passthrough로 허용하되 warning 동반). 게이트웨이가 값이 **없어서 주입**한 경우는 충돌이 아니라 `parameter-defaulted`다.
- **왕복 불변식** (G1): 어댑터가 응답 `providerMetadata`로 방출하는 모든 키는 자기 요청측 `providerOptions` 스키마가 수용해야 한다. 히스토리 편입 시 게이트웨이/클라이언트는 블록의 `providerMetadata`를 `providerOptions`로 복사한다 (라운드트립 계약 — D2).
- **승격 사이클** (D3): 2개 이상 프로바이더가 공유하게 된 개념은 IR 표준 필드로 승격 + ADR 기록.

## 3. 메시지

```ts
type Role = "system" | "user" | "assistant" | "tool";

type Message = {
  role: Role;
  blocks: Block[];
  origin?: Origin;            // assistant 메시지: 생성 주체 (§4.1)
  providerOptions?: NS;
};
```

- **system은 메시지 배열 안에 위치 보존으로 존재한다** (G6 — top-level system 필드 없음). 첫 위치 system = 통상 시스템 프롬프트, 중간 system = Anthropic mid-conversation system 등에 대응. 어댑터가 타깃 규칙에 맞게 배치(Anthropic top-level `system`/messages 내 system, OpenAI `instructions`, Gemini `systemInstruction` 병합 — 비텍스트 블록·중간 위치 처리 규칙은 재타게팅 패스 D6-4).
- OpenAI `developer` role은 별도 role이 아니다 — system 메시지 + `providerOptions.openai.role: "developer"`.
- role별 허용 블록: system = text(+passthrough). user = text, file, toolResult(인바운드 포맷에 따라), custom(요청 방향 고유 블록 — 예: `anthropic.search_result`), passthrough. assistant = text, reasoning, toolCall, toolResult(providerExecuted), file, source, custom, passthrough. tool = toolResult, passthrough.
- 역할 배치 제약(연속 role 병합, tool→user 재편성 등)은 IR이 강제하지 않는다 — 어댑터/재타게팅 패스가 흡수 (D6-7).

## 4. 블록 (콘텐츠 파트 union)

### 4.0 블록 공통 필드

```ts
type BlockBase = {
  id?: string;                 // 스트림 블록 스코프 id. 응답 블록에는 항상 존재
  origin?: Origin;             // 이 블록을 생성한 주체 — 재타게팅 판단 기준 (D6-1)
  opaqueState?: OpaqueState;   // 프로바이더 종속 서명/암호화 상태 (§4.10)
  providerOptions?: NS;        // 요청/히스토리 방향
  providerMetadata?: NS;       // 응답 방향
};

type Origin = { provider: string; model: string; surface?: string };
```

- **응답 방향의 `origin.surface`는 필수 계약** (2026-08-21 확정): 이중 표면 프로바이더의 표면 sticky 판별(ADR-0002 결과 절)이 여기에 의존한다. 어댑터는 응답·스트림 origin에 자기 표면을 항상 채운다 (타입은 optional 유지 — 요청/히스토리 방향은 미상 허용, 미상이면 기본 표면 + warning). `adapter-conformance`가 검증한다.

### 4.1 text

```ts
type TextBlock = BlockBase & {
  type: "text";
  text: string;
  citations?: Citation[];      // §4.8
};
```

### 4.2 reasoning

```ts
type ReasoningBlock = BlockBase & {
  type: "reasoning";
  text: string;                // 요약/평문 추론. redacted·omitted면 ""
  redacted?: true;             // Anthropic redacted_thinking 등
};
```

- 서명/암호화 상태는 `opaqueState`에 (Anthropic signature, OpenAI encrypted_content, Gemini thoughtSignature — 4사 공통 개념의 공통 슬롯). OpenAI `itemId`류 참조는 `providerMetadata.openai`.
- **OpenAI reasoning item 무손실 규칙**: summary 복수 파트·content 채널 등 item 원문 구조를 `providerMetadata.openai`에 통째로 보존하고, 동일 타깃(OpenAI) 재전송 시 단일 `text`가 아니라 **보존된 원문 구조를 우선 복원**한다 ("item을 손대지 않고 그대로 재전송" 왕복 규칙 충족). 보존 키(`providerOptions.openai.item` 등)는 **요청측 PO 스키마에 정식 등재**해야 한다 — 미등재 키는 D5 미지 키 정책이 4xx로 막아 왕복 불변식(G1)이 깨진다.
- 타 프로바이더로의 이식은 요청 `retarget.reasoning` 정책 적용 (D6-2: `drop` 기본 / `demote-to-text` / `strip-and-annotate`).

### 4.3 toolCall

```ts
type ToolCallBlock = BlockBase & {
  type: "toolCall";
  toolCallId: string;          // 필수 (G5). 프로바이더 미발급 시 결정론적 합성 (§13.2)
  toolName: string;            // 필수 — Gemini functionResponse.name 복원의 근거 (D6-3)
  input: { type: "json"; value: JSONValue }
       | { type: "text"; text: string };   // 비JSON 툴 입력 (OpenAI custom/grammar, code diff류)
  providerExecuted?: true;     // 서버측 실행 툴 (web_search 등)
};
```

- 프로바이더가 JSON으로 선언한 입력이 파싱 불가한 경우 어댑터는 `text` variant로 강등 + `warning(code: "tool-input-demoted")` — 조용한 날조(`"{}"` 삽입 — LiteLLM 반면교사) 금지.

### 4.4 toolResult

```ts
type ToolResultBlock = BlockBase & {
  type: "toolResult";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; text: string }
        | { type: "json"; value: JSONValue }
        | { type: "content"; blocks: (TextBlock | FileBlock | CustomBlock)[] }   // 멀티모달 툴 결과 (Custom: Anthropic tool_result 내 search_result 등 — D10)
        | { type: "errorText"; text: string }
        | { type: "errorJson"; value: JSONValue }
        | { type: "executionDenied"; reason?: string };
  providerExecuted?: true;
};
```

### 4.5 file (미디어·문서 — 입력/출력 공용)

```ts
type FileBlock = BlockBase & {
  type: "file";
  mediaType: string;           // IANA (image/png, application/pdf, audio/wav ...)
  filename?: string;
  data: { type: "base64"; data: string }
      | { type: "url"; url: string }
      | { type: "reference"; refs: NS<string> }   // 프로바이더별 file id (openai file_id, anthropic file_id, google fileUri)
      | { type: "text"; text: string };           // 텍스트 문서
  title?: string;              // Anthropic document title/context 대응
  context?: string;
  citationsEnabled?: boolean;  // Anthropic citations: {enabled}
};
```

- 별도 image 블록 없음 — mediaType으로 구분 (Vercel 방식). 비디오 입력(Gemini)도 file (`videoMetadata`는 `providerOptions.google`).
- `reference`는 프로바이더 종속 — 재타게팅 규칙 D6-8 (타깃 불일치 시 인라인 전환 또는 4xx).

### 4.6 source (인용 출처 블록 — 응답 방향)

```ts
type SourceBlock = BlockBase & {
  type: "source";
  sourceType: "url" | "document";
  url?: string; title?: string; snippet?: string;
};
```

서버 웹서치 결과의 출처 노출용. 히스토리 재전송 대상 아님(어댑터가 필요 시 재구성).

### 4.7 custom (게이트웨이가 아는 프로바이더 고유 블록)

```ts
type CustomBlock = BlockBase & {
  type: "custom";
  kind: `${string}.${string}`;   // 예: "anthropic.compaction", "openai.compaction", "anthropic.search_result"
  payload: JSONValue;
};
```

어댑터가 타입을 알고 라운드트립을 보장하는 고유 블록 (compaction 블록의 무변경 재전송 계약 등). 타 프로바이더 재타게팅 시 kind별 규칙, 기본은 drop+warning.

### 4.8 Citation (text 블록 부착)

```ts
type Citation = {
  source: { type: "url" | "document" | "file" | "search"; url?: string; title?: string;
            documentIndex?: number; fileId?: string };
  citedText?: string;
  location?: { type: "char" | "page" | "block" | "outputRange"; start: number; end: number };
};
```

Anthropic citations(char/page/content_block), OpenAI·xAI annotations(url_citation, start/end_index → outputRange), Gemini groundingSupports(segment)를 모두 수용. Gemini grounding의 `searchEntryPoint` 등 TOS 부속물은 `providerMetadata.google`로 무수정 전달 (로그·캐시 제외 — ADR-0008).

### 4.9 passthrough (게이트웨이가 모르는 블록 — G1/D10)

```ts
type PassthroughBlock = BlockBase & {
  type: "passthrough";
  provider: string;            // 원문이 속한 프로바이더 wire
  raw: JSONValue;              // 원문 그대로
};
```

- 생성 경로: (a) anthropic-compat 인바운드 passthrough 경로의 미지 블록 타입, (b) 어댑터가 응답에서 만난 미지 블록(warning 동반).
- 재타게팅: 타깃 == provider → 원문 복원. 타깃 상이 → drop + `warning(code: "passthrough-dropped")`.
- passthrough 블록이 있어도 usage 미터링·예산·가드레일은 항상 적용 (G1 — IR 우회 없음).

### 4.10 OpaqueState

```ts
type OpaqueState = { provider: string; data: string };  // 의미는 provider만 해석
```

- Anthropic thinking signature / OpenAI reasoning encrypted_content / Gemini thoughtSignature(**모든 파트에 부착 가능** — toolCall 블록 포함) / xAI encrypted reasoning.
- 규칙: 같은 provider 타깃 재전송 시 바이트 그대로 복원. 타깃 상이 시 재타게팅 정책 적용. Gemini 3 타깃에서 없는 경우 더미 삽입 (D6-9).

## 5. Warning

```ts
type Warning = {
  type: "unsupported" | "compatibility" | "deprecated" | "degraded" | "other";
  code: string;                // 표준 코드 하단
  message: string;
  path?: string;               // 관련 필드/블록 경로 (예: "messages[3].blocks[0]")
  details?: JSONValue;
};
```

표준 코드 (초기 집합): `parameter-dropped` · `parameter-clamped` · `reasoning-dropped` · `reasoning-demoted` · `reasoning-annotated` · `block-dropped` · `passthrough-dropped` · `passthrough-params-dropped` · `signature-synthesized` · `tool-pair-repaired` · `tool-input-demoted` · `surface-switched` · `system-repositioned` · `unknown-provider-option-passed` · `unknown-block-passthrough`(어댑터가 응답에서 만난 미지 블록/청크를 보존하며 보고 — §4.9 (b). 보존 수단이 없는 파싱 실패는 warning `details`에 원문을 실어 보존 의무를 이행) · `parameter-defaulted`(프로바이더 필수 필드에 게이트웨이 기본값 주입 시 — 예: Anthropic max_tokens) · `provider-option-override`(PO가 표준 필드와 같은 wire 슬롯을 덮어씀 — §2) · `server-state-unmanaged` · `server-state-inapplicable` · `cache-breakpoint-ignored` · `budget-soft-warning` · `budget-exhausted-next-request-blocked`.

## 6. 요청 envelope

```ts
type IRRequest = {
  version: "0";
  model: string;                       // 레지스트리 키 (라우팅 트리는 정책 config — 본 스펙 밖)
  messages: Message[];
  tools?: Tool[];                      // §6.2
  toolChoice?: "auto" | "required" | "none" | { type: "tool"; toolName: string };
  parallelToolCalls?: boolean;         // 기본 true

  // sampling (모델 게이트로 사전 검증 — D10-4; 클램프/드롭은 warning)
  maxOutputTokens?: number;
  temperature?: number; topP?: number; topK?: number;
  stopSequences?: string[];
  seed?: number;
  presencePenalty?: number; frequencyPenalty?: number;

  responseFormat?: { type: "text" }
                 | { type: "json"; schema?: JSONSchema; name?: string;
                     description?: string; strict?: boolean };
  reasoning?: { effort?: Effort };     // §6.3
  metadata?: { userId?: string; [k: string]: JSONValue };  // 어뷰즈 추적·상관관계

  stream?: boolean;
  streamOptions?: { includeRaw?: boolean; heartbeatSeconds?: number };
                  // heartbeatSeconds 게이트웨이 상한 3600 — 초과는 클램프 + warning(parameter-clamped)
                  // (setInterval 2^31ms 오버플로 방지 — 2026-08-21 리뷰, problem log 참조)

  retarget?: { reasoning?: "drop" | "demote-to-text" | "strip-and-annotate" };  // D6-2, 기본 drop
  strictParameters?: boolean;              // D5 strict 모드: 미지원 파라미터를 드롭+warning 대신 4xx (기본 false)
  allowUnknownProviderOptions?: boolean;   // D5 opt-in

  providerOptions?: NS;
  passthroughParams?: {                    // G1 — compat passthrough 경로 전용
    provider: string;
    params: JSONObject;
    headers?: Record<string, string>;      // anthropic-beta 등 원문 헤더 보존 (D10-1)
    pinned?: boolean;                      // true면 해당 provider 외 폴백 타깃은 skipped 처리 (D10 보장 유지 우선)
  };
};
```

### 6.2 Tool

```ts
type Tool =
  | { type: "function"; name: string; description?: string;
      inputSchema: JSONSchema; strict?: boolean; inputExamples?: JSONObject[];
      providerOptions?: NS }                     // cache_control, defer_loading, eager_input_streaming 등
  | { type: "provider"; id: `${string}.${string}`;  // 예: "anthropic.web_search", "google.google_search", "xai.x_search", "openai.code_interpreter", "anthropic.bash"
      args?: JSONObject; providerOptions?: NS };
```

- JSON Schema는 프로바이더별 subset 차이(인벤토리 §C들)가 있으므로 어댑터가 검증·다운컨버트 (미지원 키워드는 warning). Gemini는 `parametersJsonSchema` 경로로 raw 통과.
- provider 툴은 재타게팅 불가가 기본 — 타깃 상이 시 4xx 또는 tool 제거+warning (요청 방향은 명시적 실패가 안전).

### 6.3 Effort (G3)

```ts
type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

모델 게이트가 미지원 값을 최근접으로 클램프 + `warning(parameter-clamped)`. 매핑 근거: Gemini thinkingLevel↔effort 공식 매핑, Anthropic effort, xAI reasoning_effort. `budget_tokens`류(레거시)는 `providerOptions`로만.

## 7. 응답 envelope (비스트림)

```ts
type IRResponse = {
  version: "0";
  id: string;                          // 게이트웨이 요청 id (req_...)
  created: string;                     // RFC3339
  model: { requested: string;
           resolved: { provider: string; model: string; surface: string } };
  message: { role: "assistant"; blocks: Block[]; origin: Origin };   // 단일 후보 (G2)
  finishReason: FinishReason;          // §9
  usage: Usage;                        // §8
  billing?: Billing;                   // §11 (게이트웨이 정책상 노출 제어 가능)
  warnings: Warning[];                 // 항상 배열 (빈 배열 허용)
  gateway: {
    requestId: string;
    providerRequestId?: string;        // 상관관계 (ADR-0008)
    attempts?: { provider: string; model: string;
                 outcome: "success" | "failed" | "skipped"; error?: string }[];
  };
  providerMetadata?: NS;
};
```

## 8. Usage (G4)

```ts
type Usage = {
  input: { total: number; noCache: number; cacheRead: number; cacheWrite: number };
  output: { total: number; text: number; reasoning: number };
  totalTokens: number;
  raw: JSONValue;                      // 프로바이더 원문 통째 보존
};
```

정규화 공식 (확정 — 어댑터 계약):

| 프로바이더 | input.total | input.noCache | input.cacheRead/Write | output.total | output.reasoning |
|---|---|---|---|---|---|
| Anthropic | `input_tokens + cache_read + cache_creation` (합성) | `input_tokens` | 각 필드. TTL별 분해는 PM | `output_tokens` | 미제공 → 0, text=total |
| OpenAI | `input_tokens` | `input − cached − cache_write` (역산) | `cached_tokens` / `cache_write_tokens` (2026-08-21 wire 확인 — 과거 미제공 전제 폐기) | `output_tokens` | `reasoning_tokens` |
| Gemini | `promptTokenCount` | `prompt − cachedContent` | `cachedContentTokenCount` / 0 | **`candidates + thoughts`** (합산) | `thoughtsTokenCount` |
| xAI | `prompt_tokens` | `prompt − cached` | `cached_tokens` / 0 | `completion_tokens` | `reasoning_tokens` |

부가 항목(모달리티 분해, toolUsePrompt, ticks, server tool 카운트)은 `raw`/`providerMetadata` + billing 라인아이템으로.

산식 (확정): `totalTokens = input.total + output.total` — **게이트웨이 산식이며 프로바이더 raw의 total 전사가 아니다** (Gemini `toolUsePromptTokenCount`처럼 정규화 필드 밖 항목 때문에 raw 합계와 다를 수 있고, 차이는 `raw`로 추적). `output.text = output.total − output.reasoning`.

## 9. FinishReason (G7)

```ts
type FinishReason = {
  unified: "stop" | "length" | "tool_call" | "content_filter" | "refusal"
         | "paused" | "tool_error" | "error" | "other";
  raw: string;                         // 프로바이더 원문
};
```

매핑 원칙: `pause_turn`→`paused`(항상 노출 — ADR-0005 §2; openai-compat 다운컨버트 시 `finish_reason: "paused"` 비표준 값 + raw 병기), `refusal`→`refusal`(`stop_details`는 PM), Anthropic `model_context_window_exceeded`→`length`, Gemini `SAFETY/RECITATION/SPII/IMAGE_*`→`content_filter`, `MALFORMED_FUNCTION_CALL/UNEXPECTED_TOOL_CALL/TOO_MANY_TOOL_CALLS/MISSING_THOUGHT_SIGNATURE`→`tool_error`, xAI `end_turn`→`stop`. **미지의 raw는 `other`로 + raw 보존** (개방형 — 닫힌 enum 파싱 금지).

## 10. 스트림 이벤트 (ADR-0005)

모든 이벤트: `{ type, seq: number, ... }` — `seq`는 스트림 내 단조 증가, 재개 커서.

### 10.1 수명주기

```
stream-start        { warnings: Warning[] }
response-metadata   { id, created, model: {requested, resolved}, providerRequestId?, providerMetadata? }   // PM: wire 선두에서만 얻는 프로바이더 고유 메타 (Anthropic message_start.container 등 — 2026-08-21)
...콘텐츠/운영 이벤트...
finish              { finishReason, usage, billing?, attempts?, providerMetadata? }   // 터미널 (attempts: §7 gateway.attempts와 동형 — 스트림/비스트림 대칭)
error-final         { error: IRError, usage?: Usage }                          // 터미널
error-partial       { error: IRError, usage?: Usage, willRetry: boolean }      // 터미널 또는 provider-switched로 계속
```

- 모든 스트림은 `finish` | `error-final` | (`error-partial` 후 미재시도) 중 하나로 끝난다 — 어댑터 계약.
- `error-partial` + `willRetry: true` 뒤에는 `provider-switched` → 새 타깃의 콘텐츠 이벤트가 이어질 수 있다 (블록 id는 새로 시작, 클라이언트는 switched 이전 부분 콘텐츠의 유효성을 유지). `provider-switched` 후에는 새 타깃의 `response-metadata`가 재방출된다 (새 providerRequestId 전달 — ADR-0008 상관관계).
- `error-final.usage`·`error-partial.usage`는 산출 불가한 경우에만 생략한다 — **과금이 발생한 시도는 반드시 포함** (ADR-0005).
- **다중 시도 회계**: `finish.usage` = 최종 성공 시도분. 실패 시도의 usage는 각 `error-partial.usage`에 실린다. `billing.lineItems`는 **과금된 전 시도 합산**이며, 원장(ADR-0006)에는 시도별 행으로 기록한다.
- **방출 타이밍**: `stream-start`는 게이트웨이가 요청을 수리한 직후(프로바이더 접속 전) 방출 가능. `response-metadata`는 프로바이더 first-chunk 프로브 통과 후 방출 — 프로브 실패 시 response-metadata 없이 `error-partial`/`error-final`로 진행.
- 명명 주기: ADR-0005의 `sequence_number` = 본 스펙의 `seq` (동일 개념).

### 10.2 콘텐츠 (id 기반 블록 스코프 — D2)

```
text-start      { id }                          text-delta   { id, delta }         text-end { id, opaqueState?, providerMetadata? }
reasoning-start { id, redacted? }               reasoning-delta { id, delta?, opaqueState?, providerMetadata? }
                                                reasoning-end   { id }
tool-input-start{ id, toolCallId, toolName, providerExecuted? }
tool-input-delta{ id, delta }                   tool-input-end  { id }
tool-call       { block: ToolCallBlock }        // 완성본 재전송 — 소비자는 delta 무시 가능
tool-result     { block: ToolResultBlock }      // 서버 툴 결과
file            { block: FileBlock }
source          { block: SourceBlock }
custom          { block: CustomBlock }
passthrough     { block: PassthroughBlock }
citation-delta  { id, citation: Citation }      // id = 대상 text 블록
```

규칙: 블록 id는 스트림 내 유일, 서로 다른 블록의 병렬 진행 허용. **내용 없는 delta/end에 opaqueState·metadata만 실어 보내는 패턴 허용** (Anthropic signature_delta, Gemini의 signature-only text part 대응 — reasoning뿐 아니라 text에도 적용). **빈 text 블록(text="")이라도 opaqueState가 있으면 보존한다 — 프루닝 금지** (Gemini 3 재전송 요구). tool-input delta 누적 결과가 JSON이 아닐 수 있는 툴(input.type=text)은 어댑터가 완성본 `tool-call`에서 확정.

추가 규칙 (2026-08-20 리뷰 반영):
- **미지 스트림 요소의 보존**: 미지 블록 타입의 시작 스냅샷뿐 아니라 **후속 delta들도** `passthrough` 이벤트(원문 청크)로 방출한다. 알려진 블록에 도착한 미지 delta 타입, 미지 top-level 이벤트도 동일. warning(`unknown-block-passthrough`)은 미지 타입별 1회만 (스팸 방지).
- **refusal의 스트림 표현** (2026-08-21 확정): 프로바이더 refusal 파트(OpenAI `response.refusal.delta/done`)는 전용 이벤트 없이 **text 블록으로 강등**해 방출하고(`text-start`/`text-delta`), `text-end`의 `providerMetadata`에 refusal 표식을 싣는다 (비스트림 §14와 동일 규약). finishReason `refusal`과는 별개 축이다.
- **서버 실행 툴의 진행 이벤트** (2026-08-21 확정): `providerExecuted` 툴의 중간 상태(OpenAI `web_search_call.in_progress/searching`, `code_interpreter_call.*`, `mcp_call.*` 등)는 IR에 대응 이벤트가 없다. 조용한 드롭은 금지(D5) — `passthrough` 이벤트로 원문을 방출하거나(기본), 방출하지 않을 경우 스트림당 1회 `warning(unknown-block-passthrough)`로 보고한다. 확정된 툴 호출·결과는 기존대로 `tool-call`/`tool-result`로 방출한다.
- **터미널 이후 프로바이더 이벤트**: 터미널 방출 후 도착하는 프로바이더 이벤트는 **무시(방출 금지)** — "모든 스트림은 터미널 하나로 끝난다"를 어댑터 레벨에서 보장.

### 10.3 운영 (게이트웨이 발신)

```
heartbeat         { }                                        // 기본 15s
provider-switched { from: Origin, to: Origin, reason: string }
usage-interim     { usage: Partial<Usage> }
warning           { warning: Warning }
raw               { provider: string, value: JSONValue }     // streamOptions.includeRaw 시
```

### 10.4 전송·재개·백프레셔

- native 전송: SSE, `id:` 필드 = `seq`. 재개: `Last-Event-ID` 헤더로 재접속 → Redis 버퍼(TTL 5분)에서 이어서 방출. 버퍼 만료 시 410.
- **단선 처리**: 비정상 단선 시 grace window 30초 동안 업스트림 유지 + 버퍼링 지속, 초과 시 업스트림 취소 (재접속은 버퍼 재생만). 클라이언트의 **명시적 abort는 즉시** 업스트림 취소 (ADR-0005 §1 / D7).
- 백프레셔: 재개 버퍼 상한(기본 8MB, **스트림 총 방출 바이트 기준** — 재개를 위해 전 이벤트를 보존하므로 소비-지연이 아닌 총량이 메모리 상한이다, 2026-08-21 확정) 초과 → 업스트림 취소 + `error-partial` 기록(재개 버퍼에는 남음).
- **abort 계열 터미널의 회계 (2026-08-21 확정)**: 취소·grace 만료·백프레셔의 터미널 `error-partial`은 **펌프가 어댑터의 절단 처리(onStreamEnd)에서 회수한 usage/billed를 실어** 적재한다 — 세션/버퍼 계층은 회계를 모르므로 터미널을 합성하지 않는다 (abort 사유만 기록: 취소·grace=499, 백프레셔=507). 펌프 부재·실패 시에만 게이트웨이 방어 터미널(usage 없는 error-partial, `gatewayException: true`)이 적재된다.
- **410 통합**: 미지 스트림 id와 만료 버퍼는 구분하지 않고 동일하게 410 (재개·취소 엔드포인트 공통). 취소 엔드포인트 `POST /v0/streams/{id}/cancel`은 진행 중 스트림이면 `{canceled: true}`, 이미 종료된 스트림이면 `{canceled: false}`.
- 예산 hard 초과가 스트림 중 발생: **현재 스트림은 완료시키고 다음 요청부터 차단** (ADR-0007 채택). `warning(code: "budget-exhausted-next-request-blocked")`를 스트림에 방출. **집행 단위는 게이트웨이 요청당 1회 평가** — 같은 요청 내 폴백 시도는 현재 스트림의 연속으로 간주해 차단하지 않음 (초과분은 원장 기록).

## 11. Billing (ADR-0007)

```ts
type Billing = {
  lineItems: { kind: "tokens" | "server_tool" | "iterations" | "cache_storage" | "search";
               sku: string;            // "anthropic:claude-opus-5:input:cache_read:1h"
               quantity: number; unitCost: number; cost: number;
               markup?: number }[];    // 리셀 마진 필드 예약 (ADR-0007 §5 — v0는 필드만)
  total: number;
  currency: "USD";                     // v0 고정, 환산은 정산 리포트에서
};
```

## 12. 에러 모델

```ts
type IRError = {
  category: "invalid_request" | "auth" | "permission" | "not_found"
           | "rate_limit" | "quota_exhausted" | "content_too_large"
           | "overloaded" | "provider_error" | "timeout"
           | "budget_exceeded" | "gateway_error";
  httpStatus: number;
  message: string;
  retryAfter?: number;                 // 초
  fallbackEligible: boolean;           // 폴백 트리 판단 입력
  billed: boolean;                     // 이 실패가 과금됐는가
  gatewayException?: boolean;          // 게이트웨이 내부 결함 마킹 — 폴백 오염 방지 (Portkey 차용)
  provider?: { key: string; status?: number; code?: string; raw?: JSONValue };
};
```

- `rate_limit`(분당 — 백오프 유효) vs `quota_exhausted`(일일 — 백오프 무의미, 폴백 적격) 구분 (D7).
- HTTP 200 속 에러(Anthropic in-stream overloaded, Gemini promptFeedback.blockReason)는 어댑터가 이 모델로 승격.

## 13. 어댑터 계약 부속 규칙

### 13.1 응답→히스토리 편입

응답 `message`를 히스토리에 붙일 때: 블록 `providerMetadata` → `providerOptions` 복사, `origin`·`opaqueState` 보존. 이 변환은 게이트웨이 유틸로 제공(클라이언트가 안 해도 native 인바운드가 수행 가능해야 함). compat 인바운드에서 이 계약이 성립하는 조건은 §13.4.

**빈 응답 규칙** (2026-08-20 리뷰 반영): `message.blocks`가 빈 응답(§7은 빈 배열 허용 — max_tokens 즉시 도달 등)은 히스토리 메시지를 **생성하지 않는다** (유틸은 null 반환, 호출자는 해당 턴을 생략). 빈 blocks 메시지를 만들면 `MessageSchema.min(1)`에 걸려 정상 응답이 왕복 한 번에 무효 히스토리가 되기 때문.

**스트림 draft enrich 계약** (2026-08-20 리뷰 반영): 어댑터의 스트림 draft에서 `seq`뿐 아니라 `response-metadata`의 `id`·`created`·`model.requested`도 **게이트웨이가 부여/enrich**한다 — 어댑터는 wire에서만 얻을 수 있는 것(`model.resolved`, `providerRequestId`)만 draft에 싣는다 (게이트웨이 envelope 소유 필드의 어댑터 조립 금지 — 비스트림 `TransformedResponse`와 대칭).

### 13.2 tool id 결정론적 합성 (G5)

프로바이더가 tool call id를 발급하지 않는 경우(설계 시점 예: Gemini generateContent — 단 2026-08-21 실측로 `call_` id 발급 시작이 확인됨, problem log 참조. 합성은 미발급 응답에 대한 방어 규칙으로 유지): `synth:{provider}:{responseScope}:{blockIndex}:{toolName}` — `responseScope`는 프로바이더 응답 id(있으면) 또는 응답 콘텐츠 SHA-256의 앞 8자. 같은 응답을 재변환하면 같은 id(랜덤 금지 — D10 결정론)이면서, **멀티턴 히스토리에서 턴 간 id 충돌이 없다** (blockIndex만으로는 서로 다른 assistant 턴의 같은 위치·같은 함수가 충돌). Gemini 타깃 재전송 시 **모든 toolCallId**(합성·비합성 불문 — `toolu_`, `call_` 포함)를 드롭하고 name+순서로 재배열 (G5).

### 13.3 재타게팅 패스 소비 규칙 (D6 매핑)

| IR 요소 | 재타게팅 동작 |
|---|---|
| `origin` ≠ 타깃 | 블록별 이식성 판단 진입 |
| `reasoning` + `opaqueState` | origin==타깃: 복원 / 상이: `retarget.reasoning` 정책 |
| `toolCall.toolName` | Gemini functionResponse.name 복원 |
| `opaqueState` 부재 + Gemini 3 타깃 | 더미 삽입 + warning (D6-9) |
| `file.data.reference` | 타깃 불일치 시 인라인 전환 또는 4xx (D6-8) |
| `passthrough`/`custom` | origin==타깃: 원문 복원 / 상이: drop+warning |
| `passthroughParams` (provider ≠ 타깃) | params·headers 드롭 + `warning(passthrough-params-dropped)`. `pinned: true` 시 해당 provider 외 타깃은 `attempts: skipped` (폴백 경합 매트릭스 참조) |
| 서버 상태 참조 PO (anthropic.container, openai.conversation/previousResponseId, xai store 참조) + 타깃 상이 | 드롭 + `warning(server-state-inapplicable)` — 조용한 무시 금지 (D5, ADR-0006 §3) |
| `toolResult.output.content` 멀티모달 | 타깃 미지원 파트는 텍스트 강등 + warning (D6-5) |
| `providerExecuted` toolCall/toolResult | origin==타깃: 복원 / 상이: 텍스트·주석 강등 + warning (D6-6) |
| 고아 tool 쌍 | 쌍 단위 제거/강등 (D6-10) |
| system 위치 | 타깃별 배치 + `system-repositioned` warning (D6-4). 중간 system의 Gemini 타깃 기본 정책: **user 턴 변환** (systemInstruction 병합은 프리픽스를 바꿔 캐시를 깨므로 비기본) |

### 13.4 compat 인바운드 왕복 규약 (규범 핵심 — 세부는 부록 (a))

compat 포맷(openai-compat CC, anthropic-compat)에는 IR 전용 필드(`origin`, `opaqueState`, `providerMetadata`)를 실을 자리가 없다. 무규약이면 재타게팅의 전제가 compat 경로에서 붕괴하므로(E2E 검증 F1 — 구현 차단급), 다음을 규범으로 한다:

1. **게이트웨이 확장 필드**: compat 응답의 assistant 메시지에 `gateway` 확장 객체를 부가한다 — openai-compat: `gateway: { ir: Block[] }` (해당 턴의 IR 블록 원문 — origin·opaqueState 포함); anthropic-compat: 블록 구조가 wire에 이미 있으므로 `gateway: { origin: Origin }`만.
2. **복원 1순위**: 클라이언트가 히스토리 재전송 시 `gateway` 확장을 포함하면, 인바운드 어댑터는 raw compat 필드 대신 이를 우선 복원한다 (무손실 왕복 — reasoning 서명·origin·표면 sticky가 전부 이 경로로 성립).
3. **확장 부재 시**: raw 필드에서 최선 복원하되, **origin 없음 = 항상 이식성 판단 진입**(안전측 — 서명 없는 reasoning은 정책 적용, Gemini 타깃은 더미 삽입). reasoning·서명 소실은 warning으로 보고.
4. **strict 호환 모드**: 테넌트/요청 설정으로 확장 필드 미부가 가능 (순수 CC/Messages 응답). 그 경우 3의 보장 하락이 문서화된 계약이다 (Portkey `strictOpenAiCompliance` 패턴 차용).

필드 상세·매핑표는 부록 (a)에서 확정한다 — **로드맵 4(compat 인바운드) 착수 전 완료가 구현 차단 해소 조건**.

## 14. 커버리지 매핑 개요 (상세는 인벤토리 문서)

| 프로바이더 기능 | IR 표현 |
|---|---|
| Anthropic cache_control | 블록/툴 `providerOptions.anthropic.cacheControl` |
| Anthropic thinking display / budget | `providerOptions.anthropic` (effort는 표준 §6.3) |
| Anthropic compaction 블록 | `custom(kind: "anthropic.compaction")` — 무변경 재전송 |
| Anthropic container (코드 실행 샌드박스 id·만료) | 응답 `providerMetadata.anthropic.container` + 스트림 `response-metadata.providerMetadata` (2026-08-21 — neuro 연동에서 유실 발견). 요청 방향 `container`는 compat passthroughParams 또는 PO |
| OpenAI store/conversation/background | `providerOptions.openai` + 서버 상태 레지스트리 (ADR-0006) |
| OpenAI reasoning encrypted_content | `opaqueState` |
| Gemini safetySettings / grounding 옵션 | `providerOptions.google` |
| Gemini groundingMetadata | `providerMetadata.google` (로그·캐시 제외) + 표준 Citation |
| xAI Live Search 후속(agent tools) | `Tool{type:"provider", id:"xai.*"}` |
| 서버 툴 사용량 과금 | billing 라인아이템 (`server_tool`, `search`, `iterations`) |
| 베타 헤더 | `providerOptions.anthropic.betas` + passthrough 경로는 `passthroughParams.headers`로 원문 보존 |
| Gemini executableCode / codeExecutionResult | `custom(kind: "google.executable_code" / "google.code_execution_result")` — 무변경 라운드트립, signature는 opaqueState |
| OpenAI item_reference (store:true 옵트인 시) | `custom(kind: "openai.item_reference")` |
| OpenAI refusal content part | text 블록 강등 + `providerMetadata.openai.refusal: true` (finishReason `refusal`과 별개) |

## 15. v0에서 의도적으로 제외 (2차)

다중 후보(G2), 오디오/이미지 **출력** 블록(v1 범위 밖 — 단 블록 union은 확장 가능하게 설계됨. 따라서 출력 블록을 전제하는 빌트인 툴 — OpenAI `image_generation`의 `partial_image` 등 — 도 v0 범위 밖이며, 요청 시 4xx 또는 tool 제거+warning), Live/Realtime(WebSocket) 표면, 임베딩, IR 버전 협상.

**본 스펙의 범위 밖 (v1 범위이지만 별도 부록에서 정의)**: count_tokens·Batches·Files 프록시 envelope, **비동기 실행 핸들**(xAI deferred, OpenAI background — "잡 수리됨 + 핸들 + 폴링" 응답 형태와 잡 상태 모델). 본 스펙은 동기 생성 envelope만 다룬다 — §16-2.

## 16. 다음 단계

1. 이 문서 검토·확정 → zod 스키마 구현 (walking skeleton, 로드맵 3)
2. 부록 2종을 skeleton~로드맵 4단계에서 추가:
   - (a) **인바운드 어댑터 명세** — openai-compat/anthropic-compat ↔ IR 매핑표. 필수 요구사항: §13.4 `gateway` 확장 필드 상세 규약, compat에서의 providerOptions 부착 경로(cache_control 등)와 `cache-breakpoint-ignored` 발동 조건, usage/finishReason 다운컨버트 표, 스트림 이벤트 재합성 표
   - (b) **EP·비동기 부록** — count_tokens/Batches/Files 프록시 envelope + 비동기 핸들(xAI deferred, OpenAI background, 잡 상태 모델). 필수 요구사항: 배치의 항목 단위 라우팅 여부, 크로스 프로바이더 fan-out/재집계 모델, custom_id 매핑·결과 순서 무보장 처리, 부분 실패·취소의 프로바이더별 전파, 배치 할인 SKU 라인아이템, 항목별 attempts
3. 골든셋 픽스처 형식(§10 이벤트 배열 스냅샷)은 캡처 하네스와 함께 정의
