# ADR-0001: 어댑터 아키텍처 — 자체 IR 허브 + 네임스페이스드 확장 + 히스토리 재타게팅 패스

- 상태: **승인** (2026-08-20 사용자 승인. 승인 시 반영 사항: 초기 프로바이더에 xAI(Grok) 추가, native IR 스펙 우선 확정, Anthropic API 100% 커버리지 하드 요구사항(D10) 추가. §5의 잔여 질문은 당일 후속 결정 라운드에서 전부 클로즈 — §5 참조)
- 날짜: 2026-08-20
- 근거 자료: [Vercel AI SDK 분석](../research/2026-08-20-vercel-ai-sdk.md) · [Portkey Gateway 분석](../research/2026-08-20-portkey-gateway.md) · [LiteLLM 분석](../research/2026-08-20-litellm.md) · [Anthropic API 커버리지 체크리스트](../research/2026-08-20-anthropic-api-coverage.md)

## 1. 컨텍스트

이 게이트웨이의 3대 목표:

1. 어댑터 패턴으로 N×M 변환을 N+M으로 (N = 인바운드 API 포맷, M = 아웃바운드 프로바이더)
2. **대화 중간에 모델/프로바이더를 바꿔도 히스토리가 동작**
3. 각 프로바이더의 고유 기능을 전부 노출 (최소공배수 게이트웨이 금지)
   - 보장 수준 차등: Anthropic은 day-1 하드 보장(D10), 타사(OpenAI/Google/xAI)는 providerOptions 스키마 갱신 릴리스 사이클을 따르는 best-effort

선행 사례 3개(Vercel AI SDK, Portkey Gateway, LiteLLM)를 소스 레벨로 분석한 결과, **허브 포맷 철학이 성패를 갈랐다**:

| 관찰 항목 | OpenAI 포맷 = 허브 (Portkey, LiteLLM) | 자체 스펙 = 허브 (Vercel AI SDK) |
|---|---|---|
| N+M 성립 여부 | 성립하지만 지속 부식 | 성립, 4개 버전 진화하며 클린 유지 |
| 고유 기능 확장 | 최상위 필드 오염, 인라인 확장 필드, 가짜 도구, 별도 허브 병설 — 최소 5가지 비일관 채널 | 네임스페이스드 providerOptions/Metadata 단일 채널 + 표준 승격 사이클 |
| 대표 부작용 | Anthropic 방언 `thinking`이 "유니버설" 파라미터가 되어 Gemini가 재해석; `/v1/messages` 별도 허브로 부분 2×M | reasoning의 프로바이더 간 이식은 여전히 lossy (warning + drop) |
| 파라미터 안전성 | 아는 파라미터는 조용히 드롭, 모르는 파라미터는 무검증 통과 (역방향 안전장치) | 자기 네임스페이스만 스키마 검증, 타 네임스페이스 무해 무시 |
| 변환 골든셋 테스트 | 사실상 0건 (라이브 스모크 뿐) | 픽스처 재생 + 스냅샷, 테스트 파일 하나에 어서션 238회 |

핵심 실증 3가지:

- **Portkey**: 허브 `Params` 인터페이스가 프로바이더 확장의 쓰레기장(`thinking`, `anthropic_beta`, `safety_settings` 최상위 혼입). Anthropic-native 클라이언트 수요로 `/v1/messages` 두 번째 허브가 생겨 Bedrock용 Anthropic Messages 변환을 통째로 별도 유지 — N+M이 부분적으로 2×M로 퇴행.
- **LiteLLM**: "supported openai params"에 `thinking`, `cache_control`, `speed`가 들어가며 개념 자체가 붕괴. 히스토리 정합성 보정이 전역 플래그(`modify_params`) 뒤의 사후 땜질 퇴적층. 한 번의 정독에서 출하된 회귀 버그 3건 발견 (동적 dict 파이프라인의 필연).
- **Vercel AI SDK**: 자체 스펙(LanguageModelV4)으로 부식 없이 유지. providerMetadata에서 인큐베이션 → 공통화되면 표준 승격하는 사이클이 실제로 작동 (캐시 usage, reasoning effort). 자사 게이트웨이의 wire protocol로 스펙을 그대로 사용 — **서버 프로토콜로의 승격 가능성 실증**.

## 2. 결정

### D1. 내부 표현(IR)은 자체 정의한다. 어떤 외부 wire 포맷과도 동일시하지 않는다.

OpenAI Chat Completions도 Anthropic Messages도 IR이 아니다. 둘 다 가장자리의 어댑터로 강등된다.

- **근거**: OpenAI-허브의 부식 경로가 두 코드베이스에서 동일하게 재현됐다. 살아있는 외부 API를 내부 표현으로 쓰면 그 API의 표현력 한계와 진화 속도에 우리 IR이 결박된다.
- **기각한 대안**: OpenAI-슈퍼셋 허브 (Portkey 방식). 초기 속도는 빠르지만(OpenAI-호환 프로바이더 수십 개가 공짜) 목표 3과 정면 충돌하고, 목표 2의 손실 지점(thinking, 중간 system, 멀티모달 tool result)이 전부 "허브 스키마에 자리가 없어서" 발생했다. OpenAI-호환 롱테일의 경제성은 D8의 base 어댑터 팩토리로 동일하게 확보한다.

### D2. IR은 블록 기반이며 요청·응답·히스토리가 동형(isomorphic)이다.

- 메시지 = role + 블록 배열. 블록 union: `text` / `reasoning` / `tool_call` / `tool_result`(멀티모달 콘텐츠 허용) / `file` / `source` / `custom` (+G1 결정으로 `passthrough` 추가 — ir-v0 §4.9, 총 8종).
- 응답 콘텐츠도 같은 블록 union → 응답을 히스토리에 붙이는 변환이 항등에 가깝다. Vercel `toResponseMessages`의 **`providerMetadata → providerOptions` 복사 계약**을 그대로 채택 (응답에서 나온 서명/itemId가 다음 요청에 자동으로 실려 돌아가는 메커니즘).
- 스트림 이벤트는 **id 기반 블록 스코프** (start/delta/end + 완성본 tool_call 재전송). 블록 경계와 인덱스를 절대 버리지 않는다 — LiteLLM이 "전부 choice 0으로 평탄화"해서 생긴 후속 핵들이 반면교사.
- `finishReason`은 `{unified, raw}` 이중 구조, usage는 중첩 구조(`inputTokens.{total, noCache, cacheRead, cacheWrite}` 등) + `raw` 원본 보존. 프로바이더별 같은 필드명의 의미 차이(Anthropic `input_tokens`=non-cached vs OpenAI=total)는 어댑터가 흡수.
- **wire 스키마(JSON)를 1급으로 설계**하고 TS 타입을 파생시킨다. Vercel의 사후 직렬화 땜질(Uint8Array base64 강제, Date 재수화, abortSignal strip)이 반면교사. 파일 데이터는 `SharedV4FileData`식 tagged union (`data | url | reference | text`).

### D3. 프로바이더 고유 기능은 네임스페이스드 확장 단일 채널로: `providerOptions`(요청) / `providerMetadata`(응답)

- 형태: `Record<providerName, JSONObject>`. 부착 지점: 호출 옵션, 메시지, 모든 블록, 툴 정의.
- 어댑터는 **자기 네임스페이스만 스키마 검증해서 읽고**, 타 네임스페이스는 무시한다. 멀티 프로바이더 히스토리가 오염 없이 공존하는 근거.
- **승격 사이클**: 확장에서 인큐베이션 → 2개 이상 프로바이더가 공유하는 개념이 되면 IR 표준 필드로 승격. 승격은 ADR로 기록한다. (Vercel의 캐시 usage → 표준 usage, reasoning effort → top-level 파라미터 승격 사례.)
- 금지: 최상위 필드 승격을 통한 방언 혼입(LiteLLM `thinking`), tools 배열 속 가짜 도구(Gemini `googleSearch`), 무검증 kwargs passthrough.

### D4. 어댑터는 타입드 순수 변환 함수다. 선언적 param 맵을 쓰지 않는다.

- **근거**: Portkey의 `ParameterConfig` whitelist 모델은 다:1 매핑(Gemini `generationConfig`)에서 같은 변환을 8회 중복 실행하고, `(params: any) => any`로 타입 안전성을 포기했으며, 미등록 필드를 침묵 드롭한다. LiteLLM의 dict 파이프라인은 내부 키 혼입("잊으면 400") 버그의 배양지.
- 어댑터 계약 (LiteLLM `BaseConfig`의 검증된 관심사 목록을 타입드로 정제):
  - `transformRequest(ir) → wire` / `transformResponse(wire) → ir` — 순수 함수. **양방향 모두 wire 스키마(zod)로 검증**.
  - `createStreamTransformer() → { framing: 'sse' | 'ndjson' | 'json-array' | 'aws-eventstream', onEvent(evt) → IRStreamEvent[] }` — 프레이밍 지식은 어댑터 소유, 상태는 타입드 구조체. Portkey의 `getStreamModeSplitPattern` 하드코딩·`streamState: {}`·`Function` 전달 전부 금지.
  - `mapError(wire) → IRError` — `isRetryable` boolean을 넘어 `{ retryAfter?, fallbackEligible, billed, category }` 구조화. Anthropic의 "HTTP 200 스트림 속 overloaded_error → 529 승격" 같은 first-chunk 프로브 포함.
  - credential 스키마 선언 + 서명 훅(Bedrock SigV4) — 코어의 `Options` 평면 비대화(Portkey 340줄 함수) 금지.
  - **코어에 프로바이더 분기문 금지**: `if (provider === X)`가 코어에 등장하면 어댑터 인터페이스에 속성이 빠진 것이다.
- 재배포 프로바이더(Bedrock/Vertex 위의 Claude 등)는 **어댑터 상속/합성**으로: 기반 어댑터 + 오버라이드 (Portkey의 Vertex-Claude 스프레드 상속 패턴).

### D5. 조용한 변조 금지

- 미지원 파라미터: 드롭하되 응답 메타 `warnings`에 반드시 보고 (스펙 확정 코드명: `parameter-dropped` / `parameter-clamped` — ir-v0 §5). strict 모드(요청 `strictParameters`)에서는 **4xx** (LiteLLM은 500을 던진다 — 반면교사).
- 미지의 최상위 키: 무검증 통과 금지. 프로바이더 고유값은 네임스페이스로만.
- **providerOptions 미지 키** (2026-08-20 결정): 기본 거부 — 4xx + 명확한 에러 메시지 (오타 즉시 발견). 요청/테넌트 단위 opt-in 플래그로 통과 허용 가능하며, 통과 시 warning 보고. 신기능 day-1은 이 opt-in으로 커버 (Anthropic passthrough 경로는 D10 별도).
- 스트림 파싱 실패: 빈 델타 대체·광역 except 금지. `error` 이벤트로 시끄럽게 전달 (스트림 전체를 죽이지 않되 소실을 숨기지 않는다 — Vercel `ParseResult` 패턴).
- warning 태그 체계: `unsupported | compatibility | deprecated | degraded | other` (Vercel 차용 + `degraded` 추가 — ir-v0 §5).

### D6. 히스토리 재타게팅(retargeting) 패스 — IR 레벨의 독립 단계. **이 게이트웨이의 핵심 차별화.**

세 프로젝트 모두 이 문제를 어댑터 내부에 암묵적으로 흩어놨고, 그 결과가 가짜 함수명(`'gateway-tool-filler-name'`), 조용한 thinking 드롭, `modify_params` 400 지옥이다. 우리는 `(IR 히스토리, 타깃 프로바이더/모델) → 정규화된 IR 히스토리`를 만드는 **명시적 패스**로 분리한다:

1. **origin 태그**: 모든 생성 블록에 `origin: { provider, model }`을 기록. 같은 프로바이더로 돌아가면 서명/상태를 복원하고, 다른 프로바이더면 아래 정책 적용.
2. **reasoning 이식 정책**을 요청 단위 옵션으로 (셋 모두 D5에 따라 warning 보고 동반, 전역 가변 플래그 금지):
   - `drop` (기본): 외래 reasoning 블록을 제거 (Vercel 방식 + 보고 의무화)
   - `demote-to-text`: 추론 텍스트를 일반 텍스트 블록으로 강등해 컨텍스트 보존 (origin 주석 유지)
   - `strip-and-annotate`: 제거하되 제거 사실을 짧은 주석 블록으로 히스토리에 남김 (모델이 "추론이 있었다"는 사실은 알게 함)
3. **tool_call id↔name 매핑 테이블** 유지: Gemini `functionResponse.name` 역참조 복원, 프로바이더별 id 포맷 제약(길이·문자셋) 흡수를 위한 id 정규화 계층.
4. **system 메시지 정규화 규칙** 명시: 위치 보존 수집 → 타깃별 배치 (Gemini 어댑터가 첫 메시지만 봐서 중간 system이 증발하는 Portkey 사례 방지).
5. **tool_result 멀티모달 콘텐츠**의 타깃별 다운컨버트 규칙 (이미지 미지원 타깃이면 명시적 강등 + warning).
6. **서버 실행 툴(web_search 등) 히스토리**: 프로바이더 간 이식 불가가 현실 — 타깃이 다르면 text/annotation으로 강등하는 규칙 명시.
7. interleaved thinking처럼 **타깃의 블록 배치 제약을 사전 검증하고 능동 수리**한다 — 검출만 하고 끝나는 게 아니라 타깃 제약에 맞춘 재배치(블록 순서 조정, 역할 병합 — Vercel의 `groupIntoBlocks`/`moveToolUseBlocksToEnd`에 해당하는 작업)까지 수행. 수리 불가능한 경우에만 4xx (목표 2 "동작한다"의 요구).
8. **프로바이더 종속 파일 reference**(OpenAI file_id, Anthropic file_id, Gemini fileUri): 타깃 프로바이더가 다르면 이식 불가 — 게이트웨이가 원본 bytes/url을 보유하면 인라인으로 전환, 아니면 조용한 드롭 대신 명시적 4xx + 안내 (D5 원칙).
9. **Gemini 3 타깃의 signature 요구**: 타사 이력의 함수 호출에는 Google 공식 더미 문자열(`skip_thought_signature_validator`)을 삽입하고 warning으로 보고 (D5의 변조 보고 원칙 적용).
10. **짝 잃은 tool 쌍 수리**: reasoning 드롭·서버 툴 강등 실행 후 고아가 된 tool_call/tool_result는 쌍 단위로 함께 제거하거나 텍스트로 강등한다 — 짝 없는 잔존은 타깃 API 400의 원인이므로 금지.

### D7. 정책 레이어와 어댑터 레이어는 두 개의 진입점으로만 만난다

- 정책 레이어(라우팅/폴백/LB/캐시/가드레일/예산)는 **IR만 다룬다**. 어댑터는 `transform*`과 stream transformer로만 노출. 폴백이 프로바이더 경계를 넘어 동작하는 근거가 바로 이 분리다 (Portkey에서 실증).
- 라우팅 config는 **재귀 target 트리** (`single | fallback | loadbalance | conditional` 중첩 가능) + **게이트웨이 내부 예외 마킹**으로 어댑터 버그가 폴백 비용을 태우며 전파되는 것 방지 (Portkey 차용).
- **모델 레지스트리**를 선언적 데이터로: 모델별 capability 플래그(reasoning, structured output, tool streaming, 지원 mediaType, max tokens, 서버 툴 목록) + 다단계 가격 + deprecation. 라우터가 **사전 질의**("이 요청을 어느 모델이 수용 가능한가") 가능해야 한다 — Vercel의 최대 공백(capability가 어댑터 내부 테이블에 은닉)을 LiteLLM의 최대 자산(`model_prices_and_context_window.json`, MIT — 데이터 차용 검토)으로 메운다.
- retry는 `Retry-After` 헤더 존중 + 총 시간 상한. 단 429는 **분당(rate)과 일일(quota)을 구분**한다 — Gemini처럼 Retry-After 없이 코드로만 구분되는 케이스가 있고, 일일 쿼터 소진은 백오프가 무의미하므로 폴백 대상이다. 과금/테넌시는 usage.raw에 얹지 않고 별도 envelope 층으로.
- **취소 전파는 파이프라인 1급 요구사항**: 클라이언트의 명시적 abort는 업스트림 프로바이더 요청 취소로 즉시 전파한다 (스트리밍 중 방치 시 비용 낭비가 그대로 발생). **예외**: 비정상 단선은 스트림 재개를 위해 grace window 30초 동안 업스트림을 유지한다 — ADR-0005 §1 (재개 기능과의 충돌 해소).
- **폴백 타깃의 자격증명 해소**: 라우팅 트리 평가의 사전 질의에 credential 해소를 포함한다 — 해당 타깃의 키(테넌트 BYO 또는 허용된 풀 키)가 없으면 `attempts: "skipped"`로 마킹하고 건너뛴다. **풀 키 대체는 기본 금지**, 테넌트 opt-in 시에만 허용 (과금 주체가 바뀌므로 고지 필수 — ADR-0007 원장에 키 소스 구분 기록). 전 타깃 skip 시 원 에러 반환.
- **게이트웨이 응답 캐시·로그는 프로바이더 TOS 제약을 존중**: Gemini grounding 응답(groundingMetadata 포함)은 약관이 캐시뿐 아니라 저장·분석도 금지하므로, 캐시 제외 규칙을 캐시 레이어에, **로그·트레이스 제외 규칙을 관측성 레이어에** 각각 내장한다.
- 레지스트리 갱신 소스: 4사 모두 공식 모델 메타데이터 API를 제공하므로(Anthropic `/v1/models`의 capabilities, OpenAI Models API, Gemini `models.list`, xAI `/v1/language-models` — xAI는 가격까지 노출) **공식 API를 1차 소스, LiteLLM 데이터를 보조**로 한다. 레지스트리에 모델별 타임아웃 힌트도 포함한다 (xAI reasoning 모델 3600s 권장, Fable 5 장시간 턴 등 — 문서로 확인된 요구). capability에는 `countTokens: native | local-estimate | unsupported`도 포함한다 — OpenAI는 공개 토큰 카운트 API가 없으므로 크로스 프로바이더 count_tokens의 동작 정의가 필요하다.

### D8. 인바운드도 어댑터다

- 프론트엔드 3종: `native`(우리 IR 스펙 그대로) / `openai-compat`(`/v1/chat/completions`) / `anthropic-compat`(`/v1/messages`).
- 각 프론트엔드는 "요청 → IR", "IR 스트림 → 해당 포맷" 변환기 — 아웃바운드 어댑터와 대칭 구조. Portkey와 LiteLLM이 결국 `/v1/messages`를 병설한 것이 인바운드 수요의 실증이며, 우리는 이를 처음부터 1급 구조로 만들어 **N(인바운드)+M(아웃바운드)을 완성**하고 2×M 중복을 구조적으로 차단한다.
- OpenAI-호환 아웃바운드 롱테일(Groq, Together 등)은 base 어댑터 팩토리(`chatCompleteParams(exclude, defaults, extra)` 발상 차용)로 수십 줄에 처리.

### D9. 골든셋 테스트가 어댑터의 완성 정의(Definition of Done)다

- 픽스처 = 실 API 캡처: `*.json`(non-stream body) + `*.chunks.txt`(raw SSE 줄 단위 녹화) — Vercel 방식.
- **4종 골든셋**:
  1. 요청 방향: IR 입력 → 프로바이더 wire body 스냅샷
  2. 응답 방향: SSE 픽스처 재생 → IR 이벤트 배열 스냅샷
  3. **인바운드 응답 방향**: IR 이벤트 배열 픽스처 → 인바운드 어댑터 → 클라이언트 포맷 SSE 스냅샷 (openai-compat·anthropic-compat 각각) — Portkey 분석이 실증했듯 스트림 **재합성**이 가장 정교한 상태 머신인데 테스트가 가장 비어 있던 영역
  4. **크로스 프로바이더 왕복**: A의 응답 픽스처 → IR → 재타게팅 → B의 `transformRequest`가 B wire 스키마 검증을 통과하는지 (+응답측: A 응답 → IR → C 인바운드 포맷 재합성 스냅샷). 스키마 통과가 의미 정합까지 보증하지는 못하므로, 재타게팅 결과를 실제 타깃 API에 1회 투척하는 **옵트인 라이브 검증 티어**를 별도로 둔다 — 목표 2를 보증하는 자동화 수단
- **공유 conformance suite**: 모든 어댑터가 동일 시나리오 세트(툴콜, JSON mode, 멀티모달, 캐싱, reasoning, 스트림 중단)를 통과해야 함 (LiteLLM `BaseLLMChatTest` 상속 패턴).
- 라이브 API 테스트는 옵트인 (record/replay 기본). import 시 네트워크 의존 금지, 프로덕션 코드에 테스트 심(mock_response) 금지.

### D10. Anthropic API 기능 100% 커버리지는 하드 요구사항이다 (2026-08-20 사용자 지정)

"Claude API 기능 중 안 되는 것이 없어야 한다." 기준 문서: [Anthropic API 커버리지 체크리스트](../research/2026-08-20-anthropic-api-coverage.md). 이를 보증하는 구조적 장치 4가지:

1. **보존 passthrough 경로**: anthropic-compat 인바운드 → anthropic 아웃바운드 조합에서는 미지 파라미터·미지 블록 타입·`anthropic-beta` 헤더를 보존 통과한다. 이는 D5("미지 키 4xx")의 **명시적 예외**로 계약화한다 — 신기능이 게이트웨이 업데이트 전에도 day-1 동작해야 하기 때문. **폴백으로 타깃이 anthropic이 아니게 되면 이 보장은 소멸한다** — passthrough 요소는 드롭+warning되며, `passthroughPinned` 설정 시 anthropic 외 타깃을 건너뛴다 (ir-v0 §13.3, 폴백 경합 매트릭스 참조).
2. **커버리지 매트릭스 CI**: 체크리스트 전 항목 × 어댑터 지원 여부를 기계 검증하는 표를 유지하고, 미커버 항목 발생 시 CI가 실패한다.
3. **베타 헤더 매트릭스**: 기능×전달 여부를 선언적 데이터로 관리 (LiteLLM `anthropic_beta_headers_config.json` 방식 차용).
4. **모델×파라미터 허용 매트릭스**: 같은 프로바이더 안에서도 모델 세대별로 같은 파라미터가 400을 유발하므로(체크리스트 §9 — `budget_tokens`, `temperature`, prefill 등) 모델 레지스트리에 파라미터 게이트를 포함하고, 사전 검증으로 400을 예방하되 변조는 D5 원칙대로 보고한다.
5. **기준 문서 신선도 장치**: 커버리지 매트릭스 CI는 "체크리스트×어댑터"만 검증하고 "체크리스트×실제 API"의 드리프트는 잡지 못하므로 별도 트리거를 둔다 — Anthropic changelog·신규 베타 헤더 값 모니터링 주기 + **픽스처 재녹화 시 미지 필드 검출을 CI 경고로 승격** (골든셋 하네스와 결합하면 저비용).

이 결정의 파생 효과: **재타게팅 패스(D6)는 프로바이더 간뿐 아니라 같은 프로바이더의 모델 세대 간 교체에도 동작해야 한다.** 또한 프롬프트 캐싱이 프리픽스 바이트 매치이므로 **어댑터 직렬화의 결정론(동일 IR → 바이트 동일 wire)이 골든셋 항목에 포함**된다 — 게이트웨이가 재조립한 요청이 바이트 안정성을 깨면 사용자의 프로바이더 캐시가 전부 미스난다.

## 3. 프로바이더 1개 추가 = 디렉토리 1개 + 레지스트리 항목 1건 (코어 수정 0곳)

LiteLLM은 실측 7~9곳을 수정해야 했다. 우리의 목표 형태:

```
adapters/anthropic/
  wire.ts        — 프로바이더 wire 스키마 (요청/응답/SSE 이벤트, zod)
  request.ts     — IR → wire (순수 함수)
  response.ts    — wire → IR (순수 함수)
  stream.ts      — 프레이밍 선언 + 타입드 상태 머신 (SSE evt → IR 이벤트)
  errors.ts      — 에러/finishReason/usage 매핑
  auth.ts        — credential 스키마 선언, 헤더/서명
  options.ts     — providerOptions.anthropic 스키마 (zod)
  retarget.ts    — (선택) 이 프로바이더 타깃 재타게팅 특례
  fixtures/      — 골든셋 (*.json, *.chunks.txt)
registry/anthropic.json — 모델·capability·가격 데이터
```

## 4. 파이프라인 전경

```
클라이언트
  → 인바운드 어댑터 (native | openai-compat | anthropic-compat)   … 요청 → IR
  → 정책 레이어 (인증/테넌트 → 라우팅 트리 → 캐시 → 가드레일)      … IR만 취급
  → 재타게팅 패스 (IR 히스토리를 타깃 프로바이더 기준으로 정규화)
  → 아웃바운드 어댑터 (IR → wire / 스트림 상태 머신 / 에러 매핑)
  → 프로바이더 API

응답(스트림): 프로바이더 SSE
  → 아웃바운드 어댑터 (wire 이벤트 → IR 이벤트)
  → 정책 레이어 (usage 미터링, 가드레일, 폴백 판단)
  → 인바운드 어댑터 (IR 이벤트 → 클라이언트 포맷 다운컨버트)
  → 클라이언트
```

## 5. 결정 완료 및 미해결 질문

### 결정 완료 (2026-08-20)

- **초기 프로바이더 셋**: **Anthropic + OpenAI + Google(Gemini) + xAI(Grok)** 4개 직접 API. 재배포 변형(Bedrock/Vertex)은 상속 어댑터로 2차. xAI는 OpenAI-호환 + 확장이므로 openai-compat base 어댑터 상속 구조(D8)의 첫 실전 검증 케이스가 된다.
- **인바운드 착수 순서**: **native IR 스펙을 먼저 확정**한다 (IR 설계가 외부 포맷에 끌려가지 않도록). 서빙 순서는 IR 확정 후 결정.
- **Anthropic 100% 커버리지**: D10으로 승격.
- **OpenAI 아웃바운드 주 경로 = Responses API + `store: false` 강제** — [ADR-0002](ADR-0002-openai-outbound-responses-api.md) 승인.
- **Gemini 아웃바운드 = generateContent(`?alt=sse` 강제)로 시작, IR은 Interactions 표현 수용 가능하게** — [ADR-0003](ADR-0003-gemini-outbound-generatecontent.md) 승인.
- **xAI 아웃바운드 = CC 주 경로 + 기능 트리거 시 responses 스위칭 + `store: false`** — [ADR-0004](ADR-0004-xai-outbound-surface.md) 승인.
- **IR 설계 게이트 G1~G8 클로즈** — [결정 레지스터](ir-design-gate.md) 권고안 일괄 승인 (passthrough의 IR opaque 수납 + PO 왕복 불변식, v1 단일 후보, effort enum 합집합+클램프, usage 정규화 공식, tool id 결정론적 합성, system 블록 배열+위치 보존, unified finishReason 값 집합, 버전 필드 최소안, 네임스페이스 키).
- **v1 기능 범위** (구 질문 5): 텍스트 생성(이미지·문서·오디오 *입력* 포함) + count_tokens + **Message Batches + Files 프록시**. 이미지/비디오/음성 *생성*·임베딩·Agent Skills/Managed Agents는 2차. Batches/Files 포함으로 상태 계층 결정이 walking skeleton 단계로 앞당겨짐 (구현 순서는 코어 파이프라인 이후).
- **테넌트 자격증명 = 하이브리드** (구 질문 6): 게이트웨이가 가상 키를 발급하고, 백엔드는 테넌트 BYO 프로바이더 키와 게이트웨이 풀 키를 모두 지원.
- **providerOptions 네임스페이스 키** (구 질문 8): `anthropic` / `openai` / `google` / `xai` 확정.
- **스트림 v1 계약 = 풀스펙** — 터미널 3종 + heartbeat + provider-switched + 중간 usage + 재개 API + 백프레셔. **pause_turn은 항상 노출**(자동 계속 없음), 이중 폴백은 게이트웨이 트리 기본 + 서버측 fallbacks는 opt-in 위임 마킹 — [ADR-0005](ADR-0005-stream-contract.md).
- **상태 계층 = 처음부터 PostgreSQL + Redis** (인터페이스 추상화 + 테스트용 인메모리 유지), **프로바이더 서버측 상태는 v1부터 게이트웨이 관리형**(리소스 레지스트리·테넌트 격리·TTL·삭제 대행) — [ADR-0006](ADR-0006-state-layer.md).
- **과금 envelope = 정산까지 v1** — 라인아이템 + 가상 키 예산 집행(soft/hard) + 테넌트별 정산 리포트/익스포트 — [ADR-0007](ADR-0007-billing-envelope.md).
- **관측성 = 본문 로깅 기본 on(테넌트 opt-out)** + 3층 로그 + OTel + 데이터 주권(테넌트별 허용 리전) — [ADR-0008](ADR-0008-observability.md).
- **providerOptions 미지 키 = 기본 거부 + opt-in 통과** — D5에 반영.

### 미해결 질문 (단일 원장)

**2026-08-20 현재 전부 클로즈.** 위 7건은 ADR-0005~0008과 D5 보강으로 결정 완료 (스트림 중 예산 hard 초과 처리도 ir-v0 §10.4에서 채택 완료). E2E 워크스루에서 발견된 경계 교차 규칙들은 [폴백 경합 매트릭스](fallback-interaction-matrix.md)로 확정. 새 질문은 이 목록에 추가한다.

> IR 스키마 설계 착수 전에 닫아야 할 결정 묶음은 [IR 설계 게이트 결정 레지스터](ir-design-gate.md)에 별도 정리.
