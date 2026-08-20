# IR 설계 게이트 — 스키마 작성 전에 닫아야 할 결정 레지스터

- 상태: **클로즈 완료** (2026-08-20 사용자 승인 — G1~G7 권고안 일괄 승인, G8 확정. ADR-0002의 `n>1` 문구는 G2에 따라 수정됨) · 날짜: 2026-08-20
- 배경: 전체 계획 적대적 리뷰(2026-08-20)에서 "이 결정들 없이 IR 스키마를 쓰면 각 항목이 구현 중 암묵 결정으로 새어 나간다 — LiteLLM 부식의 시작점과 동일 패턴"으로 지적됨. IR 스키마 문서는 이 레지스터의 결정을 서두에 인용하며 시작한다.

각 항목: 질문 / **권고안** / 출처. 승인·수정 후 결정란에 기록.

## G1. passthrough의 파이프라인상 위치 (리뷰 finding 1 — 치명)

D10의 보존 passthrough(anthropic-compat→anthropic) 요청이 IR을 우회하는가, IR에 실려 가는가? 우회하면 미터링·예산·가드레일·감사가 사일런트하게 빠지고, 실리면 IR에 미지 요소의 1급 표현이 필요하다.

**권고안**: IR 경유 유지. IR에 `passthrough` opaque 블록(미지 블록 타입용)과 opaque 파라미터 bag(미지 최상위 파라미터용)을 1급으로 추가하고, 미터링·정책은 항상 적용. 미지 요소가 낀 히스토리의 재타게팅은 D6 규칙과 동일하게 "강등+warning". **PO 왕복 불변식**을 명문화: 어댑터가 응답 providerMetadata로 방출하는 모든 키는 자기 요청측 providerOptions 스키마로 재수용 가능해야 한다 (위반 시 D2의 metadata→options 복사 계약이 다음 턴 자기 검증에서 깨짐). D10이 미지 **엔드포인트**(신규 Anthropic API 표면)까지 커버하는지도 확정 — 권고: v1은 Messages 계열만, 신규 엔드포인트는 커버리지 문서 갱신 프로세스로.

## G2. 다중 후보(n>1 / candidateCount) (finding 2 — 높음)

IR에 choices 축이 없는데 ADR-0002가 CC 보조 경로 사유로 `n>1`을 들었다.

**권고안**: v1 IR은 **단일 후보로 고정**. `n>1`/`candidateCount`는 D5에 따라 drop+warning. ADR-0002의 해당 문구에서 `n>1` 삭제 (CC 보조 경로 사유는 audio/predicted outputs/seed 등으로 충분). 다중 후보를 나중에 지원하려면 스트림 이벤트 계약 전면 개정이 필요하므로, 수요 확인 전에는 넣지 않는다.

## G3. reasoning effort enum 통일 (finding 6-1)

4사 값 집합: Anthropic `low~max`(xhigh 포함) / OpenAI `none~max`(모델별 부분집합) / Gemini `minimal~high` / xAI `low~xhigh`(none 불가 다수).

**권고안**: IR enum = 합집합 `none | minimal | low | medium | high | xhigh | max`. 모델 게이트(레지스트리)로 미지원 값을 **클램프+warning** (400 아님 — 모델 교체 시나리오에서 effort 때문에 요청이 죽으면 목표 2 위반). Gemini의 공식 상호 매핑(thinkingLevel↔effort)을 클램프 테이블의 근거로 사용. xAI 인벤토리가 `xhigh`를 PO로 분류한 것은 IR 표준 채택으로 정정 (coverage 문서 분류가 우선).

## G4. usage 정규화 공식 (finding 6-2)

**권고안**: IR usage는 `inputTokens.{total, noCache, cacheRead, cacheWrite}` / `outputTokens.{total, text, reasoning}` + `raw` (Vercel V3 구조 차용). 프로바이더별 공식을 명문화:
- Anthropic: `input.total = input_tokens + cache_read + cache_creation` (합성), `cacheWrite`는 TTL별 분해를 PM(providerMetadata)으로
- OpenAI: `input.noCache = input_tokens - cached_tokens` (역산), `output.reasoning = reasoning_tokens`
- Gemini: `input.total = promptTokenCount`(캐시 포함이므로 그대로), `input.cacheRead = cachedContentTokenCount`, **`output.total = candidatesTokenCount + thoughtsTokenCount`** (합산 정의), `toolUsePromptTokenCount`·모달리티 분해는 PO
- xAI: OpenAI형 + `cost_in_usd_ticks`/`num_sources_used`/서버 툴 카운트는 PM
과금 로직은 항상 `raw`가 아니라 정규화 필드를 소비하되, 라인아이템(서버 툴 횟수, iterations)은 PO에서 추출.

## G5. tool call id 정책 (finding 6-3)

Gemini generateContent만 id 미발급(name+순서 매칭).

**권고안**: IR `tool_call.id`는 **required**, `toolName`도 항상 보존. Gemini 응답 변환 시 게이트웨이가 **결정론적 합성 id**(최종 형식은 ir-v0 §13.2: `synth:{provider}:{responseScope}:{blockIndex}:{toolName}` — 스키마 검증 A-2로 응답 스코프 추가됨)를 발급 — 랜덤 UUID 금지 (같은 응답 재변환 시 같은 id가 나와야 D10 바이트 결정론과 골든셋 재현성이 성립). Gemini 타깃 재전송 시 id는 드롭하고 name+순서로 재배열 (D6-3의 재매핑 테이블).

## G6. system 메시지 표현 (finding 6-4)

Vercel V4는 system content가 string인데, 우리 요구(Anthropic system 블록 배열 + cache_control, mid-conversation system 위치 보존)와 다르다.

**권고안**: **Vercel에서 의도적으로 이탈** — IR system 메시지는 블록 배열(text 블록 + providerOptions per-블록) + 히스토리 내 위치 보존. OpenAI `developer` role은 IR system의 렌더링 변형으로 어댑터가 처리(별도 role 아님, PO로 지정 가능). Gemini 타깃: systemInstruction은 text만 허용하므로 비텍스트 블록은 warning+강등, 중간 system은 D6 규칙대로 병합 또는 user 변환.

## G7. unified finishReason 값 집합 (finding 6-5)

**권고안**: `stop | length | tool_call | content_filter | refusal | paused | tool_error | error | other` + `raw` 원문. 매핑 원칙: Anthropic `pause_turn`→`paused`(처리는 ADR-0005 §2에서 "항상 노출"로 결정), `refusal`→`refusal`(stop_details는 PM), Gemini `MALFORMED_FUNCTION_CALL`류→`tool_error`, `SAFETY/RECITATION/SPII/IMAGE_*`→`content_filter`, xAI `end_turn`→`stop`. **개방형 파싱**: 미지의 raw 값은 `other`로 접되 raw 보존 (Gemini가 계속 신값 추가 중).

## G8. 기존 미해결 질문 중 IR 선행 의존분 — 확정 결과 (2026-08-20)

- **Q5 (v1 기능 범위)**: **기본안보다 넓게 확정** — v1 = 텍스트 생성(이미지·문서·오디오 *입력* 포함) + count_tokens + **Message Batches + Files 프록시**. 이미지/비디오/음성 *생성*, 임베딩, Agent Skills/Managed Agents는 2차. 파급: Batches(잡 상태)·Files(파일 매핑) 때문에 상태 계층 결정(ADR-0001 §5)이 walking skeleton 단계로 앞당겨짐. 단 Batches는 4사 wire 구조가 완전히 달라(xAI는 OpenAI Batch와 비호환 — 인벤토리 B-2 #14) 별도 브리지 설계가 필요하므로 구현 순서는 코어 파이프라인(로드맵 3~4) 이후.
- **Q2 (스트림 이벤트 v1 범위 + 종료 계약)**: 이벤트 스키마의 일부이므로 IR 문서에서 함께 확정 (유일하게 열어둔 항목).
- **Q1 (버전 정책)**: 최소안 채택 — wire 최상위에 `version` 필드 1개. 협상 메커니즘은 연기.
- **Q8 (네임스페이스 키)**: `anthropic`/`openai`/`google`/`xai` 확정.

## 이후 로드맵 (리뷰 권고 채택안 — docs/README.md에도 게시)

1. **본 게이트 클로즈** (권고안 승인/수정)
2. **IR 스키마 v0**: 블록 union·스트림 이벤트·에러/usage/warning의 wire 스키마(zod) + 문서. 4사 전체를 *표현 가능*하게, 구현 범위는 코어 서브셋(텍스트·툴·reasoning·파일 입력)부터
3. **Walking skeleton**: native 인바운드 → Anthropic 아웃바운드 (non-stream + stream) + **골든셋 캡처 하네스**(녹화 스크립트·픽스처 새니타이저·명명 규약·바이트 결정론 테스트)를 같은 단계 1급 산출물로. 커버리지 CI·베타 헤더 매트릭스는 의도적으로 이 단계 뒤로 연기
4. **OpenAI(Responses) 어댑터 + 재타게팅 패스 v0 + 크로스 왕복 골든셋** — 두 번째 프로바이더가 어댑터 인터페이스 결함을 드러내는 단계. openai-compat·anthropic-compat 인바운드 추가로 N+M 대칭 완성
5. **폭 확장 + 운영 평면**: Gemini·xAI 어댑터(ADR-0004 선행), 레지스트리·파라미터 게이트, 커버리지 CI 가동 (운영 결정들은 이후 결정 라운드에서 당일 전부 클로즈됨 — ADR-0004~0008. **현행 로드맵은 README가 기준**)

순서 원칙 (리뷰 지적 채택): 4사 동시 착수 금지 — 어댑터 인터페이스 결함은 2번째 프로바이더에서 드러나므로 2사 검증 후 확장. 골든셋 하네스는 어댑터보다 늦으면 DoD가 소급 적용이 되므로 skeleton 단계에 포함.
