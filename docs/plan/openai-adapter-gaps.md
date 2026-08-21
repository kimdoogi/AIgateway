# OpenAI 어댑터 착수 전 인터페이스 간극 점검 (2026-08-21)

- 목적: 로드맵 4(OpenAI 어댑터) 코드 착수 전에, 현재 어댑터 계약(`src/adapters/types.ts`)·레지스트리·IR v0가 **Responses API를 담지 못하는 지점**을 먼저 문서로 확정한다.
- 입력물: [ADR-0002](../decisions/ADR-0002-openai-outbound-responses-api.md) · [ADR-0004](../decisions/ADR-0004-xai-outbound-surface.md) · [OpenAI 인벤토리](../research/2026-08-20-openai-api.md) · [IR v0](../specs/ir-v0.md) · 현행 코드(`src/adapters/types.ts`, `src/gateway/registry.ts`, `src/gateway/execute.ts`, `src/adapters/shared.ts`)
- 판정 범례: **차단** = 결정 없이 코드 착수 불가 / **패치** = 스펙 한 줄 추가로 해소, 구현과 병행 가능 / **노트** = 구현 시 유의, 계약 변경 없음

## 요약

| # | 간극 | 판정 |
|---|---|---|
| A | 표면(surface) 축이 레지스트리·어댑터 계약에 없음 (Responses/CC 이중 경로) | **차단** |
| B | 모델별 파라미터 게이트·표면 접근성 힌트 부족 (`AdapterCapabilities` 3필드) | **차단** |
| C | `providerOptions`가 표준 필드와 같은 wire 슬롯을 다툴 때의 우선순위 규범 없음 | **차단** |
| D | reasoning item 원문 보존 슬롯이 D5 미지 키 거부와 충돌 | 패치 |
| E | `Origin.surface`가 optional — sticky 판별의 전제 | 패치 |
| F | 스트림 매핑 구멍 3종 (refusal, 서버툴 진행 이벤트, partial image) | 패치 |
| G | usage `cacheWrite` 관측 불가 → 캐시 쓰기 과금 산정 한계 | 노트 |
| H | 요청 wire 검증 범위(Responses 파라미터 30+·item 25종) | 노트 |
| I | background/Batches/Files/count_tokens | 범위 밖 (부록 (b)) |

## A. 표면 축 부재 — 차단

현행: `registerProvider()`는 `adapter.provider`를 키로 하는 **1 프로바이더 = 1 어댑터** 맵이고, `resolveModel()`은 모델 패턴 → provider 문자열만 돌려준다. `OutboundAdapter.surface`는 인스턴스 상수라 사실상 "어댑터 = 표면"이다. 반면:

- ADR-0002: OpenAI는 `responses`(주) + `chat-completions`(보조), **요청 기능 기반 자동 선택 + 명시 오버라이드**.
- ADR-0004: xAI는 반대 방향(CC 주, 기능 트리거 시 responses).
- 두 ADR 공통 **표면 sticky**: 직전 assistant 턴 `Origin.surface`로 고정, 전환은 opt-in 또는 warning(`surface-switched`).

빠진 것 3가지:

1. **provider당 복수 표면 등록**과 그중 하나를 고르는 선택자. 선택 기준(어떤 기능이 CC 전용인가)은 프로바이더 지식이므로 코어에 두면 D4 위반 — 어댑터 쪽 속성이어야 한다. 형태 후보: `ProviderRuntime { surfaces: OutboundAdapter[]; selectSurface(req, prev?: Origin): { adapter, warnings } }`.
2. **sticky 입력의 공급 경로**: 직전 assistant 메시지의 `origin.surface`를 읽는 코드가 아직 없다(execute는 히스토리를 어댑터에 그대로 넘길 뿐). 재타게팅 패스 소관이며 로드맵 4에서 같이 생긴다.
3. **선택 단계의 warning 회수 경로**: 현재 warning은 `transformRequest`가 만든다. 표면 선택은 그보다 앞이므로 선택자가 warning을 반환하고 게이트웨이가 합류시켜야 한다.

**대안(YAGNI 경로)**: v0에서 OpenAI를 `responses` 단일 표면으로만 구현하고, CC 전용 파라미터(`seed`/penalties/`stop`/`prediction`/audio)는 **drop + warning**으로 처리한다. 이 경우 표면 축 도입은 xAI(로드맵 5) 또는 CC 실수요 시점으로 미뤄지지만, **ADR-0002 §4(자동 CC 전환)와 코드가 달라지므로 ADR 개정 + problem log 기록이 선행**되어야 한다(문서 우선 규칙). IR 표준 필드인 `seed`·`presencePenalty`·`frequencyPenalty`·`stopSequences`가 Responses에 없다는 점이 이 결정의 실제 발화 지점이다.

## B. capability 힌트 부족 — 차단

`AdapterCapabilities`는 `midConversationSystem` / `supportedEfforts` / `defaultMaxTokens` 3개뿐이다. OpenAI가 요구하는 게이트:

- **reasoning 모델의 sampling 거부**: `temperature`/`top_p`/penalties/`logit_bias`를 보내면 400. 모델별 값이므로 레지스트리 소관(리뷰 A3/D10-4)인데 실을 자리가 없다 → `unsupportedParams?: readonly string[]` 같은 일반 슬롯 추가가 최소 변경.
- **표면 접근성**: `gpt-5-pro`·computer-use·deep research 계열은 Responses 전용(CC 404), `gpt-audio-*`는 CC 전용 → 표면 선택자의 입력으로 `surfaces?: readonly string[]` 필요(A와 한 묶음).
- `supportedEfforts`는 재사용 가능(GPT-5.6은 `minimal` 없음, `xhigh`/`max` 있음).

힌트 없이 어댑터가 모델명 정규식으로 자체 판단하는 것도 가능하지만, 그러면 레지스트리 이관 대상이 어댑터 내부로 한 번 더 흩어진다.

## C. providerOptions 우선순위 규범 없음 — 차단

ir-v0 §2는 미지 키 정책(D5)과 왕복 불변식(G1)만 정하고, **PO가 표준 필드와 같은 wire 슬롯을 건드릴 때 누가 이기는지**를 정하지 않았다. OpenAI에서 즉시 발화하는 실물 3건:

- `toolChoice`: IR 표준은 `auto|required|none|{tool}`뿐. OpenAI `{type:"allowed_tools"}`·`{type:"mcp"}`는 PO로만 표현 가능 → 표준 필드와 PO가 동시에 오면?
- `store`: 게이트웨이가 `false` 강제(ADR-0002 §2)인데 `providerOptions.openai.store: true`는 opt-in passthrough(§3). 즉 PO 우선이 의도지만 규범 문장이 없다.
- `text.format` vs 표준 `responseFormat`, `reasoning.effort` vs PO `reasoning.*`.

**제안**: §2에 "동일 wire 슬롯 충돌 시 PO 우선 + `warning(code: "provider-option-override")`" 한 줄과 표준 코드 신설. 조용한 우선은 D5 위반이므로 warning은 필수.

## D. reasoning item 원문 보존 슬롯 — 패치

ir-v0 §4.2는 OpenAI reasoning item 원문 구조를 `providerMetadata.openai`에 통째 보존하고 동일 타깃 재전송 시 우선 복원하라고 규정한다. §13.1이 히스토리 편입에서 PM → PO를 복사하므로 경로는 성립한다. 다만 **어댑터의 PO 스키마에 그 키가 없으면 D5가 4xx로 막는다** — `providerOptions.openai.item`(또는 동등 키)을 요청측 스키마에 정식 등재해야 왕복 불변식(G1)이 성립한다. 구현 시 스키마 필드로 확정할 것.

## E. `Origin.surface` optional — 패치

`Origin.surface`는 optional이고, `execute.ts:340`은 없으면 `adapter.surface`로 채운다. 표면 sticky 판별이 origin.surface에 의존하므로(ADR-0002 결과 절), **응답 방향에서는 어댑터가 항상 채우는 것을 계약으로 승격**하고 `adapter-conformance.ts`에 검증을 추가하는 편이 안전하다. 게이트웨이 폴백은 유지.

## F. 스트림 매핑 구멍 3종 — 패치

1. **refusal**: `response.refusal.delta/done`. 비스트림은 커버리지 표(§14)가 "text 블록 강등 + `providerMetadata.openai.refusal`"로 정했지만 **스트림 방향 문장이 없다** → text-start/delta + text-end PM으로 명시 필요.
2. **서버 툴 진행 이벤트**: `web_search_call.in_progress/searching`, `code_interpreter_call.*`, `mcp_call.*` 등은 IR에 "providerExecuted 툴의 진행 상태" 이벤트가 없다. 조용한 드롭은 D5 위반 → `passthrough` 이벤트로 방출(§10.2 미지 요소 보존 규칙 준용)을 명시하거나, 진행 이벤트는 무시하되 warning 1회를 규정해야 한다.
3. **partial image**: `image_generation_call`의 `partial_image`는 이미지 **출력** 블록을 전제하는데 §15에서 v0 제외다 → 빌트인 툴 16종 중 image_generation은 v1 범위 밖임을 명시(요청 시 4xx 또는 tool 제거 + warning).

## G. usage cacheWrite 관측 불가 — 노트 (**2026-08-21 실측으로 폐기**: `input_tokens_details.cache_write_tokens`가 wire에 존재. convertUsage·§8 반영 완료 — 아래는 기록용 원문)

OpenAI usage는 `input_tokens_details.cached_tokens`(읽기)만 준다. IR `input.cacheWrite`는 0 고정(§8 표대로)이지만, GPT-5.6+는 캐시 **쓰기 1.25×** 단가가 있으므로 billing 라인아이템에서 쓰기분을 usage로부터 산정할 수 없다. 정산 정확도의 알려진 한계로 기록하고, 필요 시 레지스트리 단가표 + 캐시 히트율 추정으로 별도 처리(로드맵 5).

## H. 요청 wire 검증 범위 — 노트

Responses 요청은 파라미터 30+·item 타입 25종이다. Anthropic `wire.ts`처럼 **게이트웨이가 실제로 생성할 수 있는 부분집합만 strict 검증**하고, PO passthrough·미지 키 구역은 loose로 두는 방침을 유지한다(전수 스키마 이식은 비용 대비 이득 없음). D10-5 신선도 장치(`known-fields.ts`)는 Anthropic 100% 커버리지 요구에 묶인 장치이므로 OpenAI에는 **응답 방향 미지 필드 검출만** 얕게 적용한다.

## I. 범위 밖 확인

`background`(비동기 핸들)·Batches·Files·count_tokens·Conversations는 ir-v0 §15가 부록 (b)로 밀어둔 항목이다. v0 OpenAI 어댑터는 `previous_response_id`/`conversation`/`background`를 **PO passthrough로만** 수용하고, 타깃 상이 시 `server-state-inapplicable` warning(§13.3)으로 처리한다.

## 결정 (2026-08-21 사용자 확정)

1. **표면 전략** (A) = **처음부터 이중 표면**. ADR-0002 원안 유지(개정 불요) — 레지스트리에 표면 축을 도입하고, provider당 어댑터 복수 등록 + 프로바이더 소유 선택자(`selectSurface(req, prevOrigin) → { adapter, warnings }`)로 고른다. 재타게팅 패스의 `Origin.surface` sticky 판별도 로드맵 4에 포함. ADR-0002 결과 절에 구현 형태 반영 완료.
2. **capability 슬롯** (B) = **`unsupportedParams` + `surfaces` 둘 다** `AdapterCapabilities`에 추가. 모델별 값은 레지스트리 MODEL_ROUTES가 공급(리뷰 A3/D10-4 이관 경로 유지), 어댑터는 drop+warning만 수행.
3. **PO 우선순위** (C) = **PO 우선 + warning 신설**. ir-v0 §2에 충돌 규범 추가, 표준 코드 `provider-option-override` 신설(§5 + `src/ir/common.ts`).

### 결정에 따른 문서 패치 (완료)

- ir-v0 §2 PO 충돌 규범 · §5 `provider-option-override` · §4.0 응답 방향 `origin.surface` 필수 계약 · §4.2 reasoning 보존 키 PO 등재 · §10.2 refusal·서버툴 진행 이벤트 규칙 · §15 image_generation 범위 밖
- [폴백 경합 매트릭스](../decisions/fallback-interaction-matrix.md) 표면 전환 × 폴백·리트라이 행 · ADR-0002 결과 절 구현 형태
- [problem log](../problems/problem-log.md) 2026-08-21 항목

### 구현 결과 (2026-08-21 — 로드맵 4 코드 완료)

1. ✅ 계약 변경 — `AdapterCapabilities`(`unsupportedParams`·`surfaces`), 레지스트리 표면 축(`registerProvider` 복수 어댑터 + `selectSurface` 공통 규칙: 오버라이드 > required > sticky > 기본 + capability 게이트), conformance `origin.surface` 검증. Anthropic 회귀 0.
2. ✅ OpenAI 이중 표면 — `src/adapters/openai/`: responses(주)·chat(보조) 요청/응답/스트림 + PO 스키마(§4.2 `item` 보존 키 포함) + 프로바이더 소유 선택자.
3. ✅ 재타게팅 패스 v0(`src/gateway/retarget.ts`) — 고아 tool 쌍(D6-10)·서버 상태 PO(§13.3)·cache-breakpoint-ignored. 크로스 왕복 골든셋(`cross-roundtrip.test.ts`).
4. ✅ [부록 (a)](../specs/appendix-a-compat-inbound.md) + compat 인바운드 2종(`src/inbound/`) + 서버 라우트 + E2E.
5. ⏳ **실 녹화 대기** — `.env`에 OPENAI_API_KEY 추가 후 `pnpm capture oai-...` (케이스 22종 준비 완료). 골든셋 ②(openai)와 실 E2E 스모크가 로드맵 4 DoD의 잔여 항목.
