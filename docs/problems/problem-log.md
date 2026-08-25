# Problem Log

작업 중 실제로 문제가 됐던 것들의 기록. 새 항목은 위에 추가한다.

형식:

```
## YYYY-MM-DD — 한 줄 요약
- 증상:
- 원인:
- 해결:
- 교훈: (재발 방지 규칙이 나오면 ADR/CLAUDE.md로 승격)
```

---

## 2026-08-20 — 경계 교차 지점의 미정의 동작 15건 (E2E 워크스루로 검출) + 증분 수정 잔재 14건

- 증상: 개별 기능·블록 레벨 검증을 전부 통과한 상태에서, 8개 E2E 시나리오를 문서 규칙만으로 굴리자 미정의/충돌 15건 발견. 구현 차단 2건: (F1) compat 인바운드 왕복에서 IR 전용 필드(origin·서명)가 증발해 재타게팅 전제 붕괴, (F2) "취소 즉시 전파"(D7)와 "스트림 재개"(ADR-0005)의 정면 충돌 — 둘 다 각각의 리뷰에서 **정당하게 추가된 규칙**이었다. 별도로 정합성 검사에서 증분 수정 잔재 14건 (같은 문서 §10만 고치고 §1 표를 놓치는 패턴 등).
- 원인: 구멍이 기능 내부가 아니라 **레이어 규칙들이 동시에 발화하는 조합 지점**(특히 폴백×{재개, 예산, passthrough, BYO 키, 서버 상태})에 몰려 있었음. 규칙을 하나씩 추가할 때마다 기존 규칙과의 교차 검증이 없었다.
- 해결: compat 왕복 규약(ir-v0 §13.4 — gateway 확장 필드) 신설, grace window 30초로 취소·재개 조정, [폴백 경합 매트릭스](../decisions/fallback-interaction-matrix.md) 한 장으로 경합 규칙 10종 통합. 잔재는 전건 정리.
- 교훈: ① **새 규칙 추가 시 "이 규칙이 폴백/스트림/과금과 동시에 발화하면?"을 묻는 교차 체크를 습관화** — 경합 매트릭스를 살아있는 문서로 유지. ② 표현력 검증(개별)과 시나리오 워크스루(조합)는 서로를 대체하지 못한다 — 둘 다 표준 절차. ③ 증분 수정은 같은 사실이 기록된 모든 위치를 grep으로 찾아 함께 고칠 것.

## 2026-08-20 — IR v0 초안의 스키마 구멍 7건, 구현 전 검출

- 증상: IR v0 초안이 실 트래픽 케이스를 표현하지 못하는 구멍 7건 — 대표: (A-1) Gemini 스트림의 "빈 text part + thoughtSignature"를 실을 스트림 이벤트 슬롯 부재(비스트림은 표현 가능해서 더 위험한 비대칭), (A-2) 합성 tool id에 턴 축이 없어 멀티턴 Gemini 툴 히스토리에서 id 충돌, (A-3) tool_result 안의 search_result 블록 표현 불가(D10 위반 소지).
- 원인: 스트림 이벤트를 블록 타입별로 나눠 설계하면서 공통 필드(opaqueState)의 전파를 reasoning에만 붙임. 합성 id 규칙을 게이트 결정(G5)의 예시에서 옮기며 턴 스코프를 누락.
- 해결: "이 기능을 IR로 표현할 수 있는가" 시뮬레이션 검증(어려운 케이스 22종)으로 검출, 스펙 전건 개정 (text-end에 opaqueState 슬롯, responseScope 포함 합성 id, content union에 CustomBlock 등).
- 교훈: **스키마류 산출물은 작성 직후 표현력 시뮬레이션 검증을 표준 절차로.** 결정 준수 체크만으로는 부족 — 통과 항목이 많아도(G1~G7 전부 준수) 표현력 구멍은 별개로 존재한다. 골든셋(구현 단계) 이전의 문서 단계 검증이 값싸게 잡아냄.

---

# 사전 경고 워치리스트

선행 사례 리서치(2026-08-20)에서 확인된, 구현 시 반드시 부딪힐 지뢰 목록. 실제로 만나면 위의 본 로그로 승격하고 여기서 체크 표시한다. 상세 근거는 [research/](../research/) 문서 참조.

1. **thinking/reasoning 서명 검증** — Anthropic thinking 블록은 서명이 암호학적으로 검증됨. 서명 없는(타 프로바이더 출신) 블록을 보내면 400. interleaved thinking에서 tool_use 앞 thinking이 빠져도 400. LiteLLM은 조용한 드롭으로 얼버무렸고(#14194, #15601, #18926), Vercel도 warning+drop이 공식 입장. → 우리는 재타게팅 패스의 명시적 reasoning 정책으로 처리 (ADR-0001 D6).
2. **tool 히스토리의 함수명 소실** — OpenAI 포맷 tool 메시지에는 `tool_call_id`만 있고 함수명이 없음. Gemini `functionResponse`는 `name` 필수. id→name 역참조 테이블이 없으면 Portkey처럼 `'gateway-tool-filler-name'` 가짜 이름을 박게 됨.
3. **usage 필드의 의미 차이** — Anthropic `input_tokens`는 non-cached만, OpenAI `input_tokens`는 total 포함. 어댑터가 흡수하지 않으면 과금 회계가 어긋남. Anthropic `iterations`처럼 단일 usage 숫자로 과금이 안 되는 케이스도 존재.
4. **스트림 프레이밍 다양성** — SSE 구분자가 `\n\n` vs `\r\n`로 갈리고, Gemini는 JSON 배열 조각(`[`, `,`, `]`)으로 오는 경우가 있고, Bedrock은 AWS eventstream 바이너리 프레이밍. 코어에 하드코딩하면 Portkey처럼 프로바이더 지식이 누수됨 → framing은 어댑터 선언 속성.
5. **HTTP 200 속 에러** — Anthropic은 200 스트림 안에 `overloaded_error`를 넣음. 첫 청크 프로브로 529 승격해야 폴백이 트리거됨 (Vercel의 tee() 패턴).
6. **tool call index 의미 차이** — Anthropic content block index는 텍스트 블록 포함 전체 순번, OpenAI `tool_calls` index는 툴만 셈. 재번호 로직 필수 (Portkey의 `streamState.toolIndex`).
7. **스트림 청크 JSON.parse 무방비** — 비정형 청크 1개가 스트림 전체를 죽임 (Portkey 실사례). 파싱 실패는 error 이벤트로, 광역 except 빈 델타 대체 금지 (LiteLLM 실사례).
8. **system 메시지 위치 처리** — 프로바이더마다 수집 규칙이 다름. Gemini 어댑터가 `messages[0]`만 보면 중간 system이 조용히 증발 (Portkey 실사례).
9. **tool call 스트리밍의 "빈 인자" 케이스** — 인자 없는 툴콜에서 `arguments`가 빈 문자열/`"{}"` 처리 불일치 (LiteLLM은 날조로 대응). 완성본 tool_call 재전송(Vercel 패턴)으로 소비자 부담 제거.
10. **finish_reason/usage의 청크 내 위치** — 프로바이더마다 종료 정보가 실리는 청크가 다르고, finish 이후 usage-only 청크가 오는 경우도 있음 (LiteLLM #13348, #25389). 내부 계약으로 "finish 이벤트에 무엇이 실리는가"를 고정.
11. **temperature 등 파라미터 범위 차이** — OpenAI 0–2 vs Anthropic 0–1. 조용한 클램프 금지, `clamped_params` 보고 (ADR-0001 D5).
12. **비-JSON 스트리밍 툴 입력** — code_interpreter류는 JSON이 아닌 원시 텍스트(코드/디프)를 스트리밍. Vercel은 escape + 닫는 조각 주입으로 valid JSON을 합성. IR 설계 시 "툴 입력 delta가 JSON 조각이 아닐 수 있음"을 전제할 것.
13. **OpenAI-호환 서버의 item id 불안정** — 이벤트마다 id를 바꾸는 구현이 존재. output_index 기반 id 안정화 필요 (Vercel 방어 패턴).
14. **재배포 프로바이더의 3중 배포** — 같은 Claude가 직접 API/Bedrock/Vertex에서 포맷·인증·스트림 프레이밍이 다름. 어댑터 상속 구조를 처음부터 설계에 포함해야 중복 3벌(Portkey의 cache_control 3벌)을 피함.

프로바이더 인벤토리(2026-08-20)에서 추가 확인:

15. **Gemini thought signature** — Gemini 3는 현재 턴 functionCall의 signature 누락 시 400. **병렬 호출은 첫 functionCall에만 signature**, FC 전부→FR 전부 순서(인터리빙 400). 타사 이력 주입 시 공식 더미 문자열(`"skip_thought_signature_validator"`) 삽입. 스트리밍에선 빈 text part로 도착 가능. IR이 signature를 바이트 그대로 보존하지 않으면 Gemini 3 툴 루프가 통째로 깨짐.
16. **Gemini 스트리밍 기본 프레이밍은 SSE가 아님** — `:streamGenerateContent`는 기본 JSON 배열, `?alt=sse` 명시 필수.
17. **HTTP 200 soft-block 3사 공통** — Anthropic in-stream overloaded_error(→529 승격), Gemini promptFeedback.blockReason + 빈 candidates, xAI 200 내 오류. "200 = 성공"이라 가정하면 안 됨.
18. **xAI는 미지원 파라미터를 무시하지 않고 400으로 거부** — OpenAI-호환이라고 그대로 넘기면 `store`/`metadata` 등에서 즉사. allowlist strip + 보고 필요. 에러 바디도 평면 구조(`{"code","error"}`)로 다르고, 인증 오류가 400으로 오는 실측 존재.
19. **OpenAI Responses는 기본 `store: true`** — 게이트웨이가 명시적으로 `store: false`를 강제하지 않으면 사용자 대화가 조용히 OpenAI 서버에 30일 저장됨 (ADR-0002).
20. **Gemini grounding TOS** — groundingMetadata/searchEntryPoint는 무수정 패스스루 의무 + **캐시·학습 금지** → 게이트웨이 응답 캐시에서 grounding 응답 제외 설계 필요.
21. **reasoning 모델의 sampling 파라미터 거부는 4사 공통 패턴** — Anthropic 5세대 temperature 400, OpenAI reasoning 모델 temperature/top_p 400, xAI reasoning 모델 penalties/stop 400, Gemini 3 temperature≠1.0 성능 경고. 모델×파라미터 게이트가 레지스트리 필수 항목.
22. **이중 API 표면이 3사에서 진행 중** — OpenAI(CC→Responses), Gemini(generateContent→Interactions), xAI(chat→responses). 신기능이 신형 표면에만 실림. 어댑터가 기능 조합에 따라 표면을 선택하는 내부 라우팅 필요.

## 2026-08-21 — 골든셋 첫 녹화: 신선도 장치(D10-5)가 미지 wire 필드 2건 검출

- **증상**: `pnpm capture` 첫 실행에서 known-fields 검출기가 경고 — ① `tool_use` 블록의 `caller` 필드(`{"type":"direct"}`), ② `usage.output_tokens_details`(`{"thinking_tokens":N}`). 리서치 인벤토리(2026-08-20) 이후 등장했거나 당시 누락된 필드.
- **처리**: known-fields 인지 목록에 등재(경고 해소). 어댑터 동작은 무변경 — `caller`는 looseObject라 원문 보존되고 IR로는 미변환, `output_tokens_details.thinking_tokens`는 usage 정규화(§8)에 미반영.
- **후속 과제**: ① `thinking_tokens`를 `usage.output.reasoning`에 매핑하면 §8 공식 표의 "Anthropic은 reasoning 분리 미제공" 전제가 깨짐 — **ir-v0 §8 표 갱신 + convertUsage 수정 검토** (adaptive 모델 한정 제공으로 보임). ② `caller`는 programmatic tool calling(코드 실행 내 툴 호출) 판별 신호 — 커버리지 체크리스트 대조 필요.
- **교훈**: 신선도 장치가 첫 실행에서 바로 밥값 함. 재녹화 시 경고 승격 정책(CI화)은 로드맵 5 유지.


## 2026-08-21 — 리뷰 2~3라운드: 코드에서 먼저 내려진 스펙 레벨 결정 4건 소급 문서화

- **증상**: 게이트웨이 구현·리뷰 중 스펙에 없는 운영 의미론이 코드에서 확정됨 — ① `streamOptions.heartbeatSeconds` 상한 3600(초과 클램프+warning, setInterval 2^31ms 오버플로 방지), ② abort 계열(취소 499·grace 499·백프레셔 507) 터미널 `error-partial`의 회계 주체 = 펌프(어댑터 onStreamEnd 회수분), 세션은 터미널 합성 금지, ③ 미지 스트림 id도 만료와 동일 410 + cancel 엔드포인트 `{canceled: boolean}` 의미론, ④ 게이트웨이 방어 터미널(터미널 없는 스트림 종료 시 error-partial + gatewayException).
- **처리**: ir-v0 §6(heartbeat 상한)·§10.4(abort 회계·410 통합) 패치 완료 — "문서가 진실" 위반 소급 해소.
- **로드맵 4 지뢰 (기록)**: `TERMINAL_EVENT_TYPES`가 `error-partial`을 무조건 터미널로 취급 — **`willRetry: true`는 논리적으로 터미널이 아니다**. 폴백 트리 구현 시 세션 done 처리에 예외를 넣지 않으면 provider-switched 이후 이벤트가 done 게이트에 전부 드롭된다 (ir/stream.ts 주석 참조).
- **7단계 구현 예고 (ADR-0006 관련, 2026-08-21 갱신)**: ~~① append/get 비동기화 필요~~ → **write-through로 확정 구현** — 인메모리 세션이 fast path(동기 append, 단일 스탬퍼 유지), Redis는 persistTail 체인으로 순서 보장하며 비동기 미러링, 재시작 후 재개는 **재생 전용**(라이브 테일 없음, append 실패 시 버퍼 무효화→410). 비동기화 재설계 불필요 — 이 노트를 따라 push를 async로 바꾸지 말 것. ② cancel()/detach() 크로스 노드 시그널(pub/sub) 필요는 유효. ExecuteDeps.fetchImpl은 signal을 존중해야 취소 터미널이 즉시 적재됨.


## 2026-08-21 — 7단계 리뷰(4라운드): 스펙 레벨 결정 소급 문서화 + 회계 구멍 수정

- **소급 문서화**: ① 리트라이 정책 수치(3회, 백오프 500ms×attempt² — maxDelayMs 10s 클램프, Retry-After가 상한 초과 시 즉시 포기) + 적격 카테고리(rate_limit/overloaded/provider_error/timeout) — 매트릭스에 행 추가. ② 백프레셔 8MB는 소비-지연이 아닌 **총 방출 바이트 기준** — ir-v0 §10.4 문구 정정. ③ 업스트림 접속 타임아웃 120s(헤더 수신까지, category timeout 504) 신설. ④ 재시작 후 재개 = 재생 전용 + 절단 버퍼는 방어 터미널 합성.
- **회계 수정**: 200 수신 후 body/변환 실패도 billed 원장 행 기록(과금 유출 차단), attempt 번호 전 경로 전파(충돌 행 제거), `gateway.attempts`/`finish.attempts` 스펙 좌석 구현(리트라이 이력 클라이언트 노출), TTFT·warnings·surface 메타 로그 배선.
- **신뢰성**: pg Pool error 리스너(유휴 단절 크래시 방지), PG/Redis 캐시된 거부 프라미스 리셋, Redis expire 터미널 경합 — persistTail 직렬화로 해소, append 실패 시 버퍼 무효화(틀린 재생 대신 410), RUNNING_TTL 7200(heartbeat 최대 주기와 경계 분리).
- **로드맵 4 좌석 (기록)**: 폴백 트리에서 attempt는 타깃별로 재시작 — LedgerRow에 targetIndex 열 추가 필요. recordTerminal은 willRetry:true error-partial에도 발화 — 트리 구현 시 판정 이전 기록 금지.


## 2026-08-21 — 로드맵 4 착수 전 간극 점검: 어댑터 계약이 Responses API를 못 담는 지점 3건 (차단급)

- **증상**: OpenAI 어댑터 코드 착수 전 계약 점검([간극 문서](../plan/openai-adapter-gaps.md))에서 결정 없이는 진행 불가한 구멍 3건 검출. ① **표면 축 부재** — `registerProvider()`가 `adapter.provider` 키의 1:1 맵이고 `OutboundAdapter.surface`는 인스턴스 상수라, ADR-0002/0004가 요구하는 이중 표면(Responses/CC, chat/responses)과 sticky 선택을 실을 자리가 없음. ② **capability 힌트 부족** — reasoning 모델의 sampling 400 거부, pro 계열 Responses 전용(CC 404) 같은 모델별 게이트를 레지스트리가 공급할 슬롯 없음(`AdapterCapabilities` 3필드). ③ **PO 우선순위 규범 없음** — `store` 강제 false vs `providerOptions.openai.store`, 표준 `toolChoice` vs `allowed_tools`처럼 같은 wire 슬롯을 다투는 경우의 승자가 ir-v0 §2에 미정의.
- **처리** (사용자 결정 3건 확정): ① 표면을 레지스트리 1급 축으로 도입(ADR-0002 결과 절에 구현 형태 기록, 매트릭스에 표면 전환×폴백 행 추가), ② `AdapterCapabilities`에 `unsupportedParams`·`surfaces` 추가(레지스트리 공급 유지), ③ ir-v0 §2에 **PO 우선 + `provider-option-override` warning** 규범 신설(§5·`src/ir/common.ts` 동기화).
- **동반 패치**: §4.0 응답 방향 `origin.surface` 필수 계약(sticky의 전제), §4.2 reasoning 원문 보존 키의 요청측 PO 스키마 등재 의무(미등재 시 D5가 4xx로 왕복 불변식 파괴), §10.2 refusal의 스트림 표현·서버 실행 툴 진행 이벤트 처리(조용한 드롭 금지), §15 `image_generation`(partial_image)은 이미지 출력 블록 부재로 v0 범위 밖.
- **잔여 한계 (기록만)**: OpenAI usage에 캐시 **쓰기** 카운트가 없어(`cached_tokens`=읽기만) GPT-5.6+ 캐시 쓰기 1.25× 단가를 usage로부터 산정 불가 — `input.cacheWrite`는 0 고정, 정산 정확도 한계로 남긴다(로드맵 5 단가표에서 재검토).
- **교훈**: 계약 간극 점검을 코드 앞에 두니 스펙 패치 6곳이 구현 전에 정리됨. 두 번째 프로바이더는 첫 어댑터가 굳혀놓은 암묵 가정(1 provider = 1 표면)을 드러내는 자리 — 세 번째(Gemini) 착수 전에도 같은 점검을 반복할 것.


## 2026-08-21 — 로드맵 4 구현 중 확정한 스펙 레벨 세부 (부록 (a) 동시 작성으로 소급 없음)

- **부록 (a)를 코드보다 먼저 작성** — §13.4의 "compat 인바운드 착수 전 완료" 차단 조건을 지켰고, 이번에는 소급 문서화가 발생하지 않았다. 구현 중 확정한 세부: ① `gateway.ir` 검증 실패는 4xx(조용한 절반 복원 금지), ② strict 모드는 요청 헤더 `x-gateway-compat: strict`, ③ 미지 키 opt-in은 `x-gateway-allow-unknown: true`, ④ CC 스트림의 gateway.ir은 [DONE] 직전 전용 chunk, ⑤ `cache-breakpoint-ignored` 발동 지점은 재타게팅 패스(인바운드는 라우팅 결과를 모름).
- **OpenAI 스트림 구현 노트**: 진행 이벤트(`response.queued/in_progress`)는 Anthropic `ping`과 동급으로 무시(§10.2 미지 요소 아님 — 알려진 무의미 이벤트). `mcp_call_arguments.delta`는 블록 미개설 상태라 delta 방출 생략, 완성 item에서 tool-call로 확정. reasoning 요약 파트 경계는 `\n\n` 구분자.
- **CC 절단의 이중 경로**: `[DONE]` 없는 절단에서 finish_reason을 이미 받았으면 finish로 종결(정상 종료 근사), 미수신이면 provider-error — 절단 오탐으로 폴백 트리를 오염시키지 않기 위함.
- **재타게팅 D6-10 예외**: 마지막 assistant 툴콜 턴의 결과 없는 toolCall은 제거하지 않는다 — 진행 중 툴 루프(결과가 이번 요청에 실림)를 수리로 오인하면 정상 루프가 망가진다.
- **잔여**: OpenAI 실 녹화(키 대기) 전까지 골든셋 ②는 todo 자리표시. `oai-gate-pro-on-cc`(404)·`oai-gate-sampling-reasoning`(400)이 녹화되면 registry capability 데이터의 실증 근거가 된다.


## 2026-08-21 — OpenAI 첫 녹화 + 스모크: 신선도 장치·실측이 문서 전제 4건 갱신

- **`input_tokens_details.cache_write_tokens` 존재** — 인벤토리(2026-08-20)와 간극 문서 G 항목의 "OpenAI는 캐시 쓰기 카운트 미노출, cacheWrite=0 고정, 정산 한계" 전제가 실 API에서 이미 낡았음. convertUsage에 반영(noCache = total − cached − cache_write), ir-v0 §8 표 갱신, 간극 문서 G 폐기 표기. GPT-5.6 캐시 쓰기 1.25× 단가 산정이 usage만으로 가능해짐.
- **GPT-5.6 CC + 함수 툴 = `reasoning_effort: "none"` 필수** — 기본(effort medium)으로 tools를 보내면 400 ("use /v1/responses or set reasoning_effort to 'none'"). 게이트웨이는 v0에서 400 패스스루(명시적 실패 — 조용한 effort 주입은 D5 위반 소지). CC 표면으로 툴+reasoning을 함께 쓰려는 요청은 구조적으로 불가 → 표면 선택자의 Responses 우선 원칙(ADR-0002)이 실측으로 재확인됨. 캡처 케이스에 `reasoning_effort:"none"` 반영.
- **미지 모델 = 400** (404 아님) — Responses의 모델 미존재 응답. expectStatus 갱신. mapOpenAIError는 code 기반(`model_not_found`→404 매핑 유지)이라 영향 없음 — 실 응답은 code 없이 400이라 invalid_request로 분류(수용).
- **`$.tool_usage` 신필드 + `response.output_text.done` 미처리** — tool_usage는 known-fields 등재(서버 툴 사용량 요약 — billing 라인아이템 후보, 로드맵 5). output_text.done/refusal.done은 완성본 재통지라 무시 처리(오탐 제거). known-fields가 CC 응답 형태(choices)를 Responses 키셋으로 스캔하던 오탐도 수정(형태 자동 판별).
- **스모크 스크립트**: `pnpm smoke:roadmap4` (실 과금 소액, opt-in — walking skeleton 8단계와 동일 지위). 크로스 프로바이더 대화 연속성(claude→gpt 같은 숫자 유지)이 목표 2의 첫 실증.

## 2026-08-21 — 캐시 히트 스모크: 프로바이더 우회 후 캐시 보존 실증 (D10)

- **시나리오**: claude(cache_control 프리픽스 ≈8.4k토큰) → openai 우회(동일 히스토리) → claude 복귀. **3턴이 1턴 캐시 8402토큰 전량 히트** (`cache_read_input_tokens=8402`, 신규 과금 52토큰) — 직렬화 결정론(D10) + §13.1 히스토리 편입 + 재타게팅 패스의 참조 보존이 실 API에서 합격. 우회 구간에는 `cache-breakpoint-ignored` warning 정상 발화.
- **부수 실측**: Haiku 4.5 최소 캐시 프리픽스 — 3377토큰에서 write 0, 8402토큰에서 write 성공. 최소 단위가 구세대 문서값(2048)보다 큰 4096으로 추정. 캡처/스모크 필러 산정 시 참고.
- **비용**: 스모크 1회 ≈ $0.04 (필러 재전송 3회 + openai 우회 전액).

## 2026-08-21 — neuro 연동 준비: compat 인바운드의 커버리지 구멍 3건 (첫 실소비자가 검출)

- **배경**: neuro(프로덕션 에이전트 루프 — container·skills·PTC·context management 풀사용)를 anthropic-compat 인바운드에 붙이는 사전 점검에서, 부록 (a) 초판의 보수적 미지 키 정책이 실워크로드와 충돌.
- **① 미지 top-level 키 증발** — `container`/`context_management`/`mcp_servers`가 400(기본) 또는 드롭(opt-in). 드롭이 최악: 에러 없이 샌드박스가 매턴 재생성되는 조용한 오동작. **개정**: anthropic-compat는 미지 top-level 키를 `passthroughParams(provider:"anthropic", pinned:true)`로 원문 통과가 기본 (D10-1 — D10 100% 커버리지 대상이라 4xx가 아닌 통과가 규범. openai-compat는 기존 유지). 부록 (a) §3.2 개정.
- **② 응답 container 유실** — 아웃바운드가 응답 `container`(id·만료)를 IR로 안 실음 → 컨테이너 재사용·복구 루프 파괴. **수정**: 응답 `providerMetadata.anthropic.container` + 스트림은 `response-metadata.providerMetadata` 신설(ir-v0 §10.1 패치 — wire 선두에서만 얻는 고유 메타 좌석). compat 출구에서 최상위 `container`/`message_start.message.container` 복원. D10 커버리지 구멍의 소급 수정.
- **③ 함수 툴 비표준 키 유실** — PTC `allowed_callers` 등이 인바운드 툴 변환에서 증발. **수정**: 툴 `providerOptions.anthropic.wireExtras`로 보존, 아웃바운드가 wire 재병합(조립 키는 안 덮음).
- **검증**: neuro형 요청(베타 헤더+container+PTC+thinking) 왕복 테스트 + container 스트림 경로 단위 테스트. 테스트 265개.
- **교훈**: compat 인바운드의 "미지 키 4xx" 기본값은 native(IR)에는 맞지만 compat에는 과보수 — compat의 존재 이유가 원문 수용이다. 실소비자 1호가 스펙의 방어 기본값을 두 시간 만에 뒤집음.


## 2026-08-21 — 리뷰 라운드(8앵글×검증): CONFIRMED 13건 수정 — compat 출구의 D5 무력화가 최대 구멍

- **게이트웨이 수정 6건**: ① compat 출구 warnings 전멸(G2) — 비스트림 `gateway.warnings` + 스트림은 누적 후 finish로 (Anthropic SSE에 warning 좌석 없음. openai-compat는 gateway chunk). 이게 없으면 이번에 만든 모든 드롭+warning 계열이 클라이언트에게 무증상. ② container 스트림 캡처가 message_start 한정(G1) — 턴 중 생성·교체분(top-level·message_delta.delta 실관측 2경로)을 finish PM으로 후송, 다운컨버터가 message_delta 최상위로 복원. ③ usage TTL 내역 증발(G3) — origin 일치 시 raw 우선 복원(스트림은 start·delta 병합). ④ 히스토리 tool_use의 caller 소실(G6) — 블록에도 wireExtras 보존·재병합. ⑤ wireExtras 충돌 조용한 스킵(G5) — 드롭 + parameter-dropped warning으로. ⑥ CC 크로스의 container·PM(G4) — gateway 확장 providerMetadata로.
- **neuro 수정 6건**: ① isGatewayRoutedModel을 프리픽스에서 **CLAUDE_GATEWAY_MODELS 허용목록**으로(N2 — 기존 프로덕션 gpt 채팅의 sessionItems 히스토리를 Claude 경로가 못 읽어 resume 0건 사고 차단). ② 미지 모델 단가 폴백 유음화(N1). ③ gpt max_tokens 엔트리 + 낙하 error 로그 + effort 무캡 통과(N3 — 클램프는 게이트웨이 레지스트리 소관). ④ tool_search_tool_bm25 게이트 + gpt 타깃 allowed_callers/defer_loading 스트립(N6). ⑤ 컨테이너 복구 4경로 applyContainer 게이트(N4). ⑥ 장기 세션 gpt 전환 경고(N5 — 감축 수단은 게이트웨이 compaction 로드맵).
- **미수정 잔여 (기록)**: G7 `pinned` 의미론은 폴백 트리 구현 시(문서화된 유예). G8 KNOWN 키 내부 부분 매핑(output_config/metadata/tool_choice의 미지 하위 키 무경고 증발)은 "미지 키는 어디서 발견되든 보존 또는 warning"으로 일반화 필요 — 로드맵 5 좌석. N5의 근본 해결(크로스 프로바이더 compaction)은 재타게팅 패스 확장 과제.
- **교훈**: 드롭+warning 체계를 아무리 정교하게 만들어도 **출구가 warning을 버리면 전부 조용한 변조**가 된다 — warning의 전달 경로는 warning 생성만큼 1급 관심사. 테스트 273개.


## 2026-08-21 — xAI 어댑터: base 상속을 "네임스페이스 리맵 래퍼"로 구현

- **설계 선택**: ADR-0004의 "openai-compat base 상속"을 클래스 상속이나 복붙이 아니라 **순수 함수 리맵 래퍼**(`src/adapters/xai/remap.ts`)로 실현 — 요청은 xai 표식(PO/PM 네임스페이스 키, origin.provider, opaqueState.provider, `xai.*` 툴 id, passthrough provider)을 openai로 바꿔 base를 통과시키고, 응답·스트림 이벤트는 역방향 복원. wire가 OpenAI 패턴 호환(인벤토리 B-1)이라 가능한 구조. 어댑터 계약이 순수 변환 함수(D4)였기에 합성이 공짜로 됐다 — 클래스였으면 오버라이드 지옥.
- **base 공용 지점 확장 3곳** (openai 모듈에 xai 주석 명시): CC `end_turn`→stop, `message.reasoning_content`→reasoning 블록, `delta.reasoning_content`→reasoning 이벤트. OpenAI는 발행하지 않는 필드라 무해. base의 파라미터 게이트에 stopSequences 편입(xAI reasoning 모델이 stop을 400 거부 — 레지스트리가 공급).
- **warning 라벨 정정**: base가 만드는 warning 메시지의 "openai" 문자열을 "xai"로 치환(relabelWarning) — 무식하지만 정직. 라벨 오표기는 조용한 변조는 아니나 오진단 유발.
- **미녹화 잔여**: XAI_API_KEY 대기. 게이트 케이스 4종이 인벤토리의 실측 주장(미지원 파라미터 400, 인증 오류 400, Live Search 410)을 검증할 것 — 특히 B2-2(문서 401 vs 실측 400)는 녹화가 판정.
- **재검토 좌석**: 리맵 래퍼는 xai wire가 OpenAI 패턴과 갈라질수록 postprocess가 자람 — strip 목록이 10개를 넘으면 독립 어댑터로 전환 검토 (현재 CC 6·responses 6).

## 2026-08-21 — xAI 실 녹화 12케이스: 게이트 판정 3확인·1반증 + id 4형 발견

- **녹화**: 12케이스 전부 성공, 총 ≈$0.021 (web_search가 $0.017로 대부분). 골든셋 ② 자동 편입(스냅샷 12), `reasoning_content`→reasoning 블록·툴콜 파편 조립·responses encrypted reasoning 전부 실픽스처로 검증. 테스트 323개.
- **게이트 판정** (전 항목의 "녹화가 판정" 예고에 대한 답): ① 인증 오류 = **400 확인** (B2-2 — 문서 401 반증, 이중 파서 휴리스틱 유효). ② penalty+reasoning = **400 확인** (B2-3). ③ Live Search = **410 확인** (B2-18). ④ **미지원 파라미터(store)는 400 아닌 200 묵살 — 인벤토리 B2-7 반증(드리프트)**. 응답은 정상 완성이라 store가 저장으로 이어졌는지는 wire만으로 불명. strip의 근거를 "400 회피"에서 **ADR-0004 store:false 정책**으로 이전(어댑터 주석·케이스 note 갱신, expectStatus 200 — 이제 무과금 게이트는 3종). metadata/audio 등 나머지 strip 키의 400 여부는 이번에 미검증 — 재녹화 시 개별 판정 좌석.
- **xAI id 형태 4형 실측** — 인벤토리에 없던 세부: ① responses item `접두사_UUID`(rs_/msg_), ② body.id bare UUID(CC·responses 공통 — chatcmpl- 아님), ③ CC tool call `call-UUID-n`(하이픈형), ④ 서버툴 복합 `ws_UUID_call-UUID-n`·`tco_`(신규 접두사). 기존 새니타이저 앵커 패턴(hex형 가정)이 전부 미스 → **잔류 id 검출기(F9-r3)가 경고 5건으로 잡아냄** — 자동 치환 금지+사람 검토 설계가 의도대로 작동한 첫 사례. 새니타이저에 UUID 앵커 패턴 3형+tco 등재, 잔류 검출기에 UUID 추가, raw에서 단일 패스 재생성으로 번호 결정론 복구.
- **usage 신필드 (기록만)**: `num_sources_used`·`cost_in_usd_ticks` — 프로바이더가 응답에 USD 비용을 직접 실어주는 사례(billing 라인아이템 대사 후보, ADR-0007 좌석). xai 미지 필드 검출은 의도적 no-op(신선도 하드 보장은 Anthropic 한정)이라 경고 없음 — 정상.
- **잔여**: ~~xAI 실 E2E 스모크는 스크립트 부재(smoke:roadmap4는 openai 한정) — 로드맵 5 후속.~~ → `pnpm smoke:xai` 신설·통과 (아래 항목).

## 2026-08-21 — xAI 실 E2E 스모크: 표면 스위칭·크로스 왕복 전부 1차 통과

- **스크립트**: `pnpm smoke:xai` (`tools/smoke-xai.ts` — smoke:roadmap4와 동일 패턴, opt-in 실 과금 ≈$0.01). 6단계: ① CC 비스트림 ② 스트림 완주(seq 단조) ③ CC reasoning(effort만으로는 CC 유지 + reasoning_content→블록) ④ **표면 스위칭**(PO `xai.include` → responses 강제, encrypted reasoning 왕복, 2턴은 히스토리 opaqueState 트리거로 responses 유지) ⑤ 크로스 프로바이더(claude가 고른 숫자를 grok이 히스토리로 읽음 — 목표 2의 xai 방향 첫 실증) ⑥ compat CC→grok(gateway.ir 부착).
- **의미**: ADR-0004 표면 선택자(명시 트리거 → responses required, 기본 CC)와 리맵 래퍼(요청 xai→openai→base, 응답 역방향)가 실 API에서 전 경로 검증됨. 골든셋(픽스처)과 스모크(실 API)의 이중 안전망이 xAI에도 성립.

## 2026-08-21 — Gemini 어댑터 착수: 설계 선택 4건 + v1 한계 기록

- **soft-block 승격 메커니즘 신설**: promptFeedback.blockReason(HTTP 200 + 빈 candidates)의 IRError 승격(§12)은 기존 `AdapterInvalidRequestError`(고정 invalid_request/400)로 표현 불가 → shared 예외에 `irError` 오버라이드 슬롯 추가(전 어댑터 공용 — 코어 무변경, execute의 instanceof 처리 그대로). category는 invalid_request/400 + `provider.code: prompt_blocked:{reason}` + fallbackEligible false(같은 프롬프트는 타깃 불문 차단 가능성 — 폴백 재과금 방지 안전측).
- **finish 지연 적재**: generateContent SSE는 종료 이벤트가 없다(message_stop·[DONE] 부재) → finishReason·usage(마지막 청크 확정, F-2)를 기억했다가 **onStreamEnd에서 finish 적재**. 터미널 보장 계약(ADR-0005)과 정합 — finishReason 미수신 절단은 provider-error.
- **thought part 재전송 = 원문 복원**: reasoning(opaqueState google) → `{text, thought:true, thoughtSignature}` 그대로. 서명 없는 크로스 히스토리 functionCall은 **턴의 첫 FC에만** 공식 더미(`skip_thought_signature_validator`) 삽입(D6-9 — 병렬 규칙 준수, 2.5는 검증 없어 무해). passthrough/custom 원문 오염 방지를 위해 삽입은 교체 방식(D4 순수성).
- **2.5 세대 effort 정책**: thinkingLevel은 3세대 전용 → 레지스트리가 supportedEfforts `[]` 공급, 어댑터는 effort **드롭+warning**(클램프 아님 — 2.5는 thinkingBudget이 정도(正道)라 PO 경유 안내를 warning 메시지에 명시). 세대 자동 변환(effort→budget)은 조용한 변조 소지가 있어 배제.
- **v1 한계 (기록)**: ① 스트림에서 grounding citation(groundingSupports) 미방출 — partIndex↔블록 정렬이 스트림에서 불안정, 원문은 finish PM에 보존(비스트림은 표준 Citation 채움). ② candidateCount>1 미노출(G2 단일 후보 — 첫 후보 외 드롭+warning). ③ Vertex 상속(경로·인증·fileUri 스킴)은 미착수.
- **잔여**: ~~GEMINI_API_KEY 확보 후 11케이스 실 녹화~~ → 완료 (아래 항목). 크로스 왕복 + 스모크 잔여.

## 2026-08-21 — Gemini 실 녹화 11케이스: 게이트 3확인 + functionCall id 발급 드리프트

- **녹화**: 11케이스 전부 성공, 총 ≈$0.005 (플래시급 단가). 골든셋 ② 자동 편입(스냅샷 11) — thought part + 서명(536B), grounding(표준 Citation + source 블록 + PM 원문), STOP→tool_call 승격, google.rpc 에러 3형 전부 실픽스처 검증. 테스트 367개. 첫 시도는 유효하지 않은 키(다른 발급처 추정)로 전 케이스 400 — AI Studio 재발급으로 해소 (키 형식만으론 판별 불가, `ErrorInfo.reason: API_KEY_INVALID`가 판정 근거).
- **게이트 판정 3확인** (드리프트 없음): ① thinkingBudget+thinkingLevel 동시 지정 = **400 확인** (B-2). ② 인증 오류 = **400 INVALID_ARGUMENT + ErrorInfo.API_KEY_INVALID** (google.rpc details 구조 실증). ③ 미지 모델 = **404 확인** (openai 400과 대조 — 프로바이더별 상이 실증).
- **functionCall id 발급 드리프트** — 인벤토리 D-5("generateContent는 id 미발급, name+순서 매칭") 반증: 2026-08 현재 `call_` 접두 id를 발급한다 (비스트림·스트림 공통). 어댑터는 wire id 우선·부재 시 합성(§13.2)이라 무수정 — 합성 경로는 방어용으로 강등. 재전송 시 id 드롭+name·순서 재배열은 유지(스키마상 id 수용은 여전히 Live/Interactions 문서 소관 — 재검증 좌석). ir-v0 §13.2 예시 문구에 실측 각주.
- **responseId 새니타이저 확장**: 접두사 없는 bare base64url(22자)이라 값 형태만으론 서명과 구분 불가 → **키 스코프 앵커**(`"responseId":` lookbehind) 방식 신설 + 잔류 검출기 동형 추가. `call_` id는 기존 openai 패턴이 그대로 처리(수렴의 부수 효과).

## 2026-08-21 — Gemini 크로스 왕복 + 스모크: 서명 검증 실통과로 로드맵 5의 Gemini 완료

- **골든셋 ④ 3방향**: ① gemini 실픽스처→anthropic (외래 reasoning drop·demote 정책, google 서버툴 아티팩트 강등) ② anthropic 실픽스처→gemini — **서명 없는 tool_use 히스토리에 더미 삽입이 실제로 발화**(D6-9 경로 검증, `signature-synthesized` warning) ③ 동일 타깃 재전송 — text part 서명 **바이트 그대로** 복원(§4.10) + functionCall 실서명 보존(더미 미발화) + wire 발급 `call_` id 드롭·name+순서 매칭(§13.2). 테스트 375개.
- **`pnpm smoke:gemini` 6단계 1차 통과** (≈$0.01): 핵심은 4단계 — toolChoice required로 functionCall+실서명 수신 → toolResult와 함께 재전송 → **200 (MISSING_THOUGHT_SIGNATURE 없음)**. 함정 #2(서명 왕복 실패 시 Gemini 3 툴 루프 전멸)가 실 API에서 방어됨을 실증. thinking은 thoughts 토큰 분리 집계(§8 — output.reasoning 120)까지 확인. 크로스(claude→gemini 숫자 연속성 — 목표 2의 google 방향 첫 실증)·compat CC→gemini 포함.
- **의미**: 4사 어댑터 전부 "골든셋(픽스처) + 실 스모크" 이중 안전망 성립. 남은 로드맵 5는 Batches/Files 부록 (b)와 운영 평면.

## 2026-08-21 — 리뷰 라운드(10앵글×검증 6·스윕): CONFIRMED 15건 전건 수정 — 스트림/비스트림 비대칭이 최대 구멍

- **compat 스트림 툴콜 공백(최대)**: gemini 스트림이 tool-input-delta를 안 내 delta-기반 compat 다운컨버터가 arguments:""를 재현 → **직렬화 인자를 단일 delta로 방출**. 같은 뿌리의 비대칭 일괄 수정: 순수 빈 text part 프루닝(유령 블록·synth 인덱스 시프트 — 실 픽스처 트리거), fileData part 스트림 브랜치 신설, urlContextMetadata finish PM 편입, 다중 후보 warning 코드 통일(block-dropped).
- **서명 보존 강화 3건**: ① 병합 text 블록의 last-wins 서명 유실 → **서명 = part 경계**(즉시 close, 서명별 1블록 — 비스트림과 대칭) ② 미디어 part(inlineData/fileData) 서명을 file 블록 opaqueState로 왕복(요청 방향 재방출 포함) ③ 무서명 google-origin reasoning의 '외래' 오분류 → **origin==타깃은 thought part 원문 복원**(§13.3 — 실측: 서명은 별도 part로 오는 게 흔해 실사용 경로였음).
- **soft-block 정합**: 스트림도 비스트림처럼 "생성물 없음"일 때만 승격(parts·usage 처리 후 판정 + usage 동봉), promptBlockedError **billed:true**(200 수신 = 프롬프트 처리 — 비스트림 원장 true/스트림 false/클라이언트 false 3원 모순 해소). 첫 청크 에러는 sawAnyChunk 갱신 전 검사로 billed:false.
- **D5 계약**: strictParameters 배선(전 드롭 지점 — strict면 4xx, shared 규약과 동일 메시지), **effort 'none'은 on/off 경계라 클램프 금지**(minimal 승격 + includeThoughts:true로 반전되던 것 → thinking 미방출 + 드롭 보고), file 블록 title/context/citationsEnabled/filename 드롭 보고.
- **주변 인프라**: retarget SERVER_STATE_KEYS에 google(cachedContent·store), 레지스트리 gemini catch-all에 supportedEfforts:[](레거시 세대 thinkingLevel 400 방지), PO google.surface 등재(400 거부·wire 유출 해소), 새니타이저 AIza 패턴, 200+에러 body의 빈 성공 둔갑 방지(비스트림 in-body error 승격 — 스트림과 대칭), RetryInfo·startIndex proto3 엣지(nanos 합산·빈 값 undefined·startIndex 0 기본 — 실 픽스처의 선두 세그먼트가 트리거), 빈 contents 사전 400, responseId "" 3원 불일치 통일, synth 스코프 'unknown' → 수신 연쇄 해시(§13.2 턴 간 충돌 방지; 비스트림 SHA와의 완전 동일화는 스트림 구조상 불가 — 잔여 한계로 기록).
- **검증**: 테스트 380개(스트림 신규 5 포함) + 실 스모크 재통과(실서명 수신을 로그에서 **assert로 승격** — 더미 경로가 회귀를 은폐하던 갭). 잔여(보고 컷): 캡처 defaultPath 템플릿화·modelVersion 추출·4어댑터 중복 헬퍼 추출(reasoningToWire/clampEffort/mergeExternal/warnOnce)·smoke 스캐폴드 공유화 — 로드맵 5 후속 좌석.

## 2026-08-21 — 부록 (b) 구현: 브리지는 파이프라인 재사용 — 설계 선택과 미검증 좌석

- **핵심 설계**: 배치 항목·count 본문이 동기 경로와 **같은 어댑터 순수 변환**을 통과 — 브리지가 새로 만든 것은 잡 수명(BatchStore)·gwf/gwb 매핑·상태 정규화뿐. anthropic 실 스모크에서 배치 결과가 골든셋과 같은 IR로 나오는 것으로 실증(60초 실 완료 — 폴링·결과·usage까지).
- **v1 단순화 결정 3건** (부록 (b) 명문화): ① 배치 = 단일 프로바이더·단일 표면 — 크로스 fan-out은 부분 실패·취소·SKU·정산이 프로바이더 수만큼 곱해지는데 실수요 미확인이라 2차. ② 파일 업로드는 타깃 프로바이더 명시 필수(자동 복제 2차) — 파일은 모델 라우팅 대상이 아님. ③ 비동기 핸들(xai deferred·openai background)은 잡 상태 모델 공유로 **정의만** — v1은 PO 통과 유지.
- **미검증 좌석 (정직 기록)**: google(batchGenerateContent 인라인 wire)·xai(요청 등록형) 배치 브리지는 **인벤토리 기반 가정 + mock 검증만** — 실 계정 배치 실행으로 wire 확정 필요(비용·시간 소요라 기회 채집). openai 배치는 문서 확실도 높으나 실 녹화 대기. xai Files는 업로드 wire 세부 미확보로 501(`files-unsupported`).
- **테넌트 좌석**: FileStore/BatchStore는 tenant 축을 스키마에 갖되 v1은 "default" 고정 — 가상 키(운영 평면) 도입 시 실테넌트 치환. ADR-0006 §3의 미등록 외부 id 차단·TTL 삭제 대행은 운영 평면의 서버 상태 레지스트리와 함께.
- **원장**: 배치 결과는 수확 시점에 항목별 1행(requestId = `gwb:customId`), 재조회 중복 방지 플래그(bridgeState.ledgerRecorded). 배치 할인 SKU 라인아이템은 billing 엔진(운영 평면)에서.

## 2026-08-21 — 운영 평면 구현: 코어 무수정 배선이 원칙, D2는 권고 뒤집힘

- **사용자 결정 기록**: D1 관리 API = 마스터 키 env(권고안), D3 본문 로깅 = 기본 on(권고안). **D2 BYO 키는 권고(헤더 패스스루)와 달리 DB 암호화 저장 채택** — AES-256-GCM + `GATEWAY_KEY_ENCRYPTION_KEY`(32바이트) env 마스터 키, GCM 태그로 변조 검출, KMS·키 로테이션은 2차. 시크릿 취급 원칙: 가상 키는 sha256 해시만 저장(발급 응답 1회 노출), BYO 키는 암호문만, 복호화는 요청 스코프 캐시.
- **배선 원칙 — 코어 무수정**: ① 지출 집계는 **원장 데코레이터**(withSpendTracking — record 훅에서 트래커 갱신, aggregate 위임 보존) ② 테넌트·자격증명은 ExecuteDeps 슬롯(tenantContext/preWarnings/credentials)로 주입 — execute 코어는 프로바이더도 테넌트도 모른다 ③ 요청별 운영 컨텍스트는 WeakMap<Request>(Hono 제네릭 오염 회피) ④ 인증은 keys 스토어 설정 시에만 활성(개방 모드 보존 — 스모크·로컬 무설정 호환, 서버 조립은 GATEWAY_ADMIN_KEY 유무로 게이트).
- **§10.4 예산 의미론 구현**: 평가는 PreRequest 1회(hard 402 `budget_exceeded` — "다음 요청부터 차단"이므로 진행 중 스트림은 건드리지 않음), soft는 `budget-soft-warning`을 preWarnings로 stream-start/응답 warnings에 병합. 지출은 근사 가격표(costUsd) 기준 — 확정 정산은 원장 raw 재계산.
- **리소스 레지스트리 경계**: 인바운드 검증은 PO 참조 키 데이터 테이블(재타게팅 SERVER_STATE_KEYS와 동족·용도 상이 — 저긴 드롭, 여긴 소유권), 타 테넌트는 404(존재 노출 금지). 응답 등록은 **생성 opt-in일 때만**(openai/xai store:true; anthropic container는 존재 자체가 증거). 삭제 API 없는 리소스(anthropic container·google cachedContent)는 참조 차단으로 대체 — 한계 명문화.
- **잔여 좌석**: compat 인바운드 인증 미적용(현재 /v0/*만 — compat 소비자 neuro는 개방 모드 전제), 스트림 응답 본문 로그(요청만)·스트림 finish 리소스 등록·Redis 지출 집계·TTL 스윕 자동화. 테스트 421개(운영 단위 10 + E2E 3 포함).

## 2026-08-22 — 폴백 트리 v1: 래퍼 오케스트레이션 — 단일 타깃 코드는 무수정

- **구조 선택**: 기존 `executeNonStream`/`executeStream`을 `*Target`(단일 타깃, 무수정)으로 내부화하고 공개 함수를 폴백 래퍼로 — 타깃별 원장 행·span·리트라이·터미널 보장이 기존 검증 그대로 재사용된다. 래퍼가 새로 만드는 것은 체인 순회·skip 판정·이벤트 변환(error-final→error-partial(willRetry:true)+provider-switched)·attempts 병합뿐.
- **v1 정책 결정 2건** (스펙 §6.4 명문화): ① 체인 정의는 요청 명시(`fallbackModels`)만 — 레지스트리 기본 체인(모델 동급 판정)은 제품 결정이라 2차. ② 스트림은 **콘텐츠 방출 전 실패만 자동 전환** — 방출 후 전환은 중복 콘텐츠 자동 재방출이라 D5(조용한 변조) 소지, 기방출분 유효 종결 유지. mid-stream continuation(partial을 히스토리로 붙인 이어쓰기)은 2차 좌석.
- **예고 해소**: stream.ts의 "error-partial+willRetry:true는 논리적 터미널 아님 — 세션 done 예외 필요"(2026-08-21) → session.push에 예외 구현. TERMINAL_EVENT_SET 자체는 불변(재생·컨포먼스 계약 유지).
- **회계 각주**: 타깃별 리트라이 attempt 번호는 타깃 내 1부터 — 원장 행은 (requestId, provider, attempt)로 구분(requestId는 전 타깃 공유). 폴백 실패 시도의 warning들은 성공 타깃 응답에 미노출(스트림은 후속 타깃 변환 경고를 warning 이벤트로 전달 — stream-start 1회 규약 유지).
- **잔여**: compat 인바운드의 fallbackModels 노출(§13.4 gateway 확장 후보), 레지스트리 기본 체인, mid-stream continuation, BYO 폴백 시 "풀 키 대체 opt-in + 과금 주체 고지"(매트릭스 행 — v1은 대체 없이 skip만).

## 2026-08-22 — 배치 wire 실판정 (smoke:batches): google 가정 적중·xai 3중 반증 후 확정

- **google: 가정 그대로 적중** — `batchGenerateContent` 생성(`BATCH_STATE_PENDING`)→폴링(`RUNNING`)→취소(`CANCELLED`) 전 경로 200. 인벤토리 기반 추정 wire가 무수정 통과.
- **xai: 반증 3중첩 → 확정** — 등록 wire가 실측으로 3번 교정됨: ① 최상위 필드 `requests`→**`batch_requests`**(422 missing field) ② 항목 필드 `body`→**`batch_request`**(422) ③ batch_request는 **태그드 유니온**(`chat_get_completion`|`responses`|`image_generation`|…) — CC body를 변형 키로 감싸야 함. 교정 후 생성(pending)→폴링(running)→취소 200. **"에러 메시지가 스키마를 가르쳐주는" serde 역직렬화 오류 덕에 프로브 3회로 확정** — 등록 실패는 무과금이라 비용 0.
- **xai 배치 모델 게이트 발견**: grok-4.6/4.5/grok-build-0.1 = 400 "not supported for batch processing", **grok-4.3·grok-4.20 계열 = 지원**. `/v1/language-models`에 배치 capability 필드는 미노출 — 레지스트리 capability(`batchUnsupported`?) 등재 후보 좌석.
- **openai: 미판정** — `.env`에서 OPENAI_API_KEY가 제거된 상태(로드맵 4 녹화 이후). 키 재투입 시 `pnpm smoke:batches openai`로 판정 가능. 완료·결과 경로의 실검증은 여전히 anthropic만 (google·xai는 취소 경로까지 — 24h 창 내 완료 관찰은 기회 채집).
- **부수**: 취소 직후 xai raw status는 `running` 유지 — 취소는 비동기(§3.2 명세와 정합). 검증 도구는 `pnpm smoke:batches [providers]`로 상시 재실행 가능(비중단·전사 수집형).

## 2026-08-22 — 전면 코드리뷰 (src·tools 21k LOC): 결함은 "계층 경계"에 몰려 있었다

리뷰 방식: 10각도 탐색 → 1표 적대적 검증 → 갭 스윕. 확정 15건 전부 수정 + 회귀 테스트 32개 추가(430→462). **단일 결함 유형이 아니라 세 개의 축**으로 묶였고, 축마다 원인이 같았다 — *기능을 추가할 때 그 기능이 통과해야 할 다른 평면을 함께 배선하지 않았다*.

### 축 1 — compat 평면이 운영 평면·폴백 트리를 따라가지 못했다

- **무인증 유료 경로**: 인증·예산 미들웨어가 `app.use("/v0/*")`로만 걸려 있어 `/compat/*` 2종이 통째로 우회 — 인증을 켠 배포에서 무키 요청이 **게이트웨이 풀 키로 실행**되고 원장 행에 tenant·keyId가 비어 과금 귀속과 hard 예산이 동시에 무력화. ops-plane의 "잔여 좌석"으로 등재돼 있었으나, 인증을 켠 상태에서 우회로가 열려 있다는 사실이 좌석 문구에 드러나지 않았다.
  → 미들웨어를 `authenticate`로 추출해 `/compat/*`에도 적용. 더 근본적으로 **인바운드 전처리(`prepareInbound`)를 native·compat 공용**으로 올림 — 파일 ref 치환·BYO 자격증명·리소스 소유권 검증이 한 곳을 지나간다(부록 (a) §0 "실행 경로 동일"의 실제 이행).
- **폴백 중 스트림 조기 종결**: 폴백 트리(2026-08-22)가 신설한 `error-partial{willRetry:true}`를 compat 다운컨버터 2종이 모르고 종결로 처리 — openai-compat은 `[DONE]`, anthropic-compat은 `error` 이벤트를 방출했다. 세션은 done이 아니라서 뒤이어 후속 타깃의 청크가 계속 흘렀고, SDK는 이미 스트림을 닫은 뒤 → **폴백으로 성공한 응답이 통째로 유실**. 새 IR 이벤트 의미론을 추가할 때 다운컨버터 2종을 소비자로 세지 않은 것이 원인.
  → 부록 (a) §6.1/6.2에 willRetry 규범 명문화 + `fallback-target-switched` warning 코드 신설(ir-v0 §5) — compat wire에 전환 슬롯이 없으므로 `gateway.warnings`로 보고(D5).

### 축 2 — `deps.credentials` 계약을 실행부만 지켰다

count_tokens·Files·Batches 브리지가 리졸버를 무시하고 `credentialHeaders(rt)`(env 풀 키)를 직접 호출. count_tokens는 `withOps()`가 리졸버를 **넘겨주는데도** 안 썼다. 실 피해: BYO 테넌트가 올린 파일이 풀 계정에 생성되고, 그 `gwf_` id를 참조한 본 요청은 BYO 키로 나가 프로바이더 404. 배치는 풀 계정으로 제출.
→ `resolveCredentials(rt, deps)` 단일 해소 지점 신설, 4개 경로 전부 경유. 브리지 ops 시그니처에 `auth` 주입(Files 브리지의 기존 모양으로 통일 — "어댑터·브리지는 비밀을 만지지 않는다").

**배치 회계 누락(동반 발견)**: 배치 원장 행이 `recordAttempt`를 우회해 직접 조립되면서 tenant·keyId·costUsd가 전부 빈 채로 적재 — `withSpendTracking`은 `keyId && costUsd>0`에서만 트래커를 갱신하므로 **배치 지출이 예산에 한 푼도 안 잡히고**, 정산 리포트는 배치를 $0·`(none)` 그룹으로 집계했다. 부록 (b) §3.4의 배치 할인 SKU 경로(`buildBilling(..., {batch:true})`)도 호출자가 없어 사문화. → 세 필드 병기 + 할인 SKU 경유 costUsd 산출로 동시 해소.

### 축 3 — effort 클램프가 어댑터마다 달랐다 (on/off 경계 반전)

`none`(추론 비활성)은 강도 축의 한 눈금이 아니라 스위치인데, 이를 아는 것은 gemini 어댑터뿐이었다.

- anthropic: 미지원 값을 **최근접이 아닌 `'low'` 고정**. `effort:'none'` → `'low'` → **끄기 요청이 켜기 + thinking 토큰 과금으로 반전**.
- openai/xai(공유 `clampEffort`): `none` 가드 없음 → grok-4.6(supported에 none 없음)에서 같은 반전.
- **골든셋이 반대 방향 반전을 정답으로 굳혀두고 있었다**: `effort:'minimal'` + supported에 `none` 포함 → 거리 동률 tie-break로 `'none'` 선택 → 켜기 요청이 조용히 꺼짐. 스냅샷이 이 wire를 정답으로 저장 중이었고, 리뷰 수정 중 스냅샷 diff로 드러났다. **골든셋은 "현재 동작"을 굳히므로 결함도 함께 굳힌다** — 스냅샷 갱신 시 diff를 규범과 대조해야 한다는 교훈.
  → `shared.gateEffort` 단일 구현으로 통합 + ir-v0 §6.3에 **양방향 on/off 경계 규범** 명문화(`none`은 클램프 출발점도 도착점도 아니다). 어댑터 3종 재구현 금지.

### 그 밖의 확정 결함

- **명시 표면 오버라이드가 조용히 무시**: `surface-switched` warning이 `prev`(직전 턴 표면) 있을 때만 발화 — 신규 대화에서 `providerOptions.openai.surface`가 모델 capability 게이트에 막히면 **경고 0건**으로 다른 표면 실행. D5 정면 위반. → 오버라이드 무시와 sticky 파기를 별개 사실로 각각 보고.
- **xai 리맵이 타사 네임스페이스를 소비**: `remapNS`가 `xai` 키 부재 시 NS를 그대로 반환 → `providerOptions.openai.*`가 base 어댑터에 그대로 도달해 **xAI wire로 방출**(ir-v0 §2 "자기 네임스페이스만 소비" 위반). opaqueState·origin·custom.kind도 동일 — 타사 encrypted reasoning이 xAI로 갈 수 있었다. → 요청 방향 리맵에 **중립 라벨(`openai~foreign`) 밀어내기** 도입: 진짜 openai 표식은 base가 "외래"로 취급 → 재타게팅 정책이 정상 작동.
- **스트림 세션에 소유자가 없었다**: Files/Batches는 `store.get(tenant, id)`로 격리하는데 세션만 id 조회 — 타 테넌트가 재개(본문 전량 열람)·취소(파괴적) 가능. id는 128bit 랜덤이나 응답 헤더·로그로 노출된다. → 세션에 tenant 기록, 불일치는 미지와 동일한 410(존재 노출 금지). 영속 버퍼 키도 테넌트 스코프(재시작 후 재생 경로에는 대조할 객체가 없으므로 키 자체를 분리).
- **콘텐츠 방출 후 provider-error가 error-final**: `finalizeDraft`가 `contentEmitted`를 모른 채 항상 final로 접었다 — 같은 파일의 절단 경로는 partial/final을 구분하는데 이 경로만 달랐다. final은 "기방출분 무효" 의미라 클라이언트가 유효한 델타를 폐기. → 두 경로 동일 규칙.
- **고아 toolCall 예외 범위 초과**: D6-10의 "진행 중 툴 루프" 예외가 *마지막 assistant-with-calls*이기만 하면 성립 — 뒤에 user 턴이 붙어도 보존돼 프로바이더 400(수리 패스가 막으려던 바로 그 실패). → 예외를 *대화의 마지막 메시지*일 때로 한정. **크로스 왕복 골든셋도 이 형태(결과 없는 툴콜 + user 턴)를 스냅샷 중이었다** — 히스토리에 실제 tool_result 턴을 합성해 진짜 쌍 왕복을 검증하도록 교정.
- **빈 system content가 400**: user/assistant에는 있던 빈 블록 생략 가드가 system/developer에만 없어, OpenAI가 수용하는 `{"role":"system","content":""}`를 게이트웨이만 거부. → 부록 (a) §3.4 규범화.
- **`error.param` 사문화**: `mapOpenAIError`에 `...(param ? {} : {})` — 양 분기 모두 빈 객체인 죽은 삼항. 파싱해 놓고 버렸다. → ir-v0 §12 error 모델에 `provider.param` 정식 슬롯 추가 후 적재(실 400 픽스처에서 `text.format.schema`·`model`·`temperature`가 드러남).
- **지출 트래커 무한 증가**: `InMemorySpendTracker.add`가 append만 — 예산 기간이 지난 항목이 영구 잔류하고 요청마다 도는 `spentSince` 스캔이 계속 길어진다. → 조회 시 창 밖 선두 정리.
- **가격표 매 호출 정렬**: `lookupPrice`가 조회마다 배열 복사+정렬. 시도마다·응답마다 불린다. → 모듈 로드 시 1회.

### 리뷰 자체에서 얻은 것

1. **"잔여 좌석" 문구는 위험도를 담아야 한다** — "compat 인바운드 인증(현재 /v0/*만)"은 미구현으로 읽히지만 실제로는 *인증을 켜면 열리는 우회로*였다. 좌석 등재가 곧 안전 표시가 아니다.
2. **새 IR 이벤트 의미론을 추가하면 소비자 전수를 세어야 한다** — willRetry는 세션(`push`)에는 반영했으나 다운컨버터 2종을 놓쳤다. 이벤트 타입별 소비자 목록이 없다는 게 구조적 원인.
3. **골든셋은 결함도 굳힌다** — 이번에 스냅샷 3건이 "프로바이더가 거부하거나 의미가 반전된 wire"를 정답으로 보관 중이었다. 갱신 시 diff를 규범과 대조하는 절차가 필요하다.

## 2026-08-22 — 프로덕션 배포 심사: 코드는 익었는데 배포 표면이 단일 프로세스 전제였다

오케스트레이터(k8s/ECS) 타깃 심사 15건 전건 수정. 직전 코드리뷰(계층 경계)와 성격이 다르다 —
**코어 로직에는 문제가 없었고**(462 테스트가 받치고 D4/D5/D9가 실제로 지켜지고 있었다),
막힌 것은 전부 "프로세스 하나로 로컬에서 돌린다"는 전제가 코드에 굳어 있던 지점들이었다.

### 검증 방식이 결함을 잡았다 — 두 번

1. **이미지를 실제로 띄웠더니** `@hono/node-server`가 devDependencies에 있었다. 프로덕션
   엔트리포인트가 import하는데 `--prod` 설치에서 빠지니 `ERR_MODULE_NOT_FOUND`. `tsc`는
   타입만 보고 `vitest`는 dev 설치로 도니 **둘 다 원리적으로 못 잡는 종류**다. → CI에 이미지
   빌드+기동+SIGTERM 잡을 신설. 소스 외부 import × dependencies 교차 대조도 수행(누락 0).
2. **실 Redis로 돌렸더니** 설계대로 동작함을 확인 — 별도 트래커 인스턴스 2개가 집계를 공유하고
   크로스노드 취소가 도달했다. mock만 믿었으면 "구현했다"까지만 알았을 것이다.

교훈: **런타임 결함은 런타임에서만 잡힌다.** 타입·단위 테스트가 아무리 촘촘해도 패키징·프로세스
경계·프로세스 간 상태는 실제로 띄워야 검증된다.

### 축 1 — 배포 산출물이 없었다 (P0)

Dockerfile·start 스크립트·health 엔드포인트·Node 버전 고정이 전부 없었다. "어떻게 띄우는가"가
코드가 아니라 사람 머릿속에 있었다는 뜻이다. 설계 판단 2개를 기록해 둔다:

- **`/health`는 의존성과 무관하게 200.** DB 장애에 liveness가 503을 내면 오케스트레이터가
  컨테이너를 계속 재시작하는데 재시작이 DB를 고치지 않는다. 트래픽 이탈은 `/ready`가 담당.
- **CMD는 exec 형식 + node 직접 실행.** `sh -c`나 `pnpm start` 래퍼를 끼우면 SIGTERM이
  PID 1에서 멈춰 아래의 드레인 로직이 통째로 건너뛰어진다 — 이미지가 조용히 드레인을 무력화한다.

**graceful shutdown의 순서가 핵심**이다: ready=503(LB 이탈 유도) → 신규 수용 중단 → 진행 중
스트림 완주 대기 → 시한 초과분 취소(회계 터미널 적재 기회) → 커넥션 종료. 이전 코드는
`server.close()` 직후 `pool.end()` + `exit(0)`이라 재배포마다 스트림이 끊기고 그 시점 과금
원장 write가 유실됐다.

**pg 커넥션 23개/레플리카**(스토어마다 독립 풀)도 여기서 잡았다 — 4레플리카면 92개로
`max_connections=100` 직전이었다. 공유 풀 + DDL advisory lock(동시 부팅 시 ALTER TABLE
ACCESS EXCLUSIVE 경합 해소)으로 정리.

### 축 2 — 예산·취소·레이트리밋이 프로세스 로컬이었다 (P1)

`InMemorySpendTracker`가 프로덕션 조립에 그대로 들어가 있었다. hardUsd=$100 키를 4레플리카에
올리면 실제 상한이 $400이 된다 — **돈이 새는 구조적 결함**인데 "인터페이스 뒤"라는 주석 때문에
해결된 것처럼 읽혔다. 취소도 같은 형태로, 다른 파드로 간 취소 요청은 410을 받고 업스트림은
계속 과금됐다(ADR-0001 D7 "취소 전파 1급 요구사항" 미달성).

- 지출 집계는 **분 단위 버킷 해시** — 요청당 1필드면 바쁜 키에서 폭발하지만 분당 1필드면 창
  크기로 유계(periodDays=1이면 1440필드). 경계 오차 최대 1분어치이고 **과다 집계 방향**이라
  예산을 늦게가 아니라 이르게 막는다. 돈 문제에서 안전한 쪽을 골랐다.
- 취소는 pub/sub. **권한 판정은 수신 측**에서 한다 — 메시지의 tenant는 발신자 주장일 뿐이고,
  세션을 가진 레플리카만 실제 소유권을 대조할 수 있다. 로컬에 없는 세션은 202로 응답해
  미지 id와 타 레플리카 세션이 구분되지 않게 했다(존재 노출 금지).
- 레이트리밋을 신설하면서 **처음부터 공유 저장소 계약**으로 뒀다 — 예산에서 겪은 실패를
  반복하지 않기 위해서다. 예산은 지출 발생 *후* 평가라 순간 폭주를 못 막으므로, 빈도 제한이
  예산보다 앞에 서야 프로바이더 호출 자체가 일어나지 않는다.

### 축 3 — 정책이 한 곳에만 적용돼 있었다 (P2)

업스트림 타임아웃·취소 전파가 `execute.dispatch`에만 있고 count_tokens·Files(7)·Batches(16)·
리소스 스윕은 생 fetch였다. 프로바이더가 응답을 안 주면 핸들러가 무한정 점유되고 클라이언트가
끊어도 업스트림이 계속 돌았다. → `withUpstreamTimeout` 데코레이터로 통일하고 **브리지 경계에서
1회 감싸** 내부 24개 호출 지점을 고치지 않고 적용했다.

나머지: 바디 상한(인증보다 **앞** — 미인증 요청이 힙을 채우는 것을 막는 게 목적) · 본문 로그
비블로킹 + 보관 정책(응답 경로에서 DB 왕복 2회 제거; 감사 자산이지 응답의 일부가 아니다) ·
OTel SDK 실등록(API만 선배선돼 있고 붙이는 쪽이 없어 **전 span이 no-op**이었다) ·
가격표 미등재 모델의 `billing-price-estimated` warning(없는 단가를 지어내는 대신 조용한 근사를
소리나게 — 돈의 근사는 D5가 금지하는 변조다) · google·xai 드리프트 감지기(4사 중 절반이
wire 변경에 무감각했다).

### 어댑터 패턴 전수조사 — 구조는 건강, 등록 표면이 위험

계약은 `OutboundAdapter` 6멤버뿐이고 어댑터 6개(프로바이더 4사)가 전부 conformance를 통과한다.
**코어에 프로바이더 분기문 0건** — D4는 실제로 지켜지고 있다. xAI는 openai 상속 래퍼로 변환 로직
재구현이 0이라 D8도 실증됐다.

문제는 다른 데 있다. 프로바이더 지식이 키 기반 데이터 테이블 **9곳**에 흩어져 있고
(bootstrap·MODEL_ROUTES·PRICE_TABLE·SERVER_STATE_KEYS·REFERENCE_KEYS·RESPONSE_RESOURCES·
DELETE_PATHS·FILE_PROVIDERS·BATCH_PROVIDERS), **어느 것도 완전성을 강제하지 않는다.**
"N+M" 약속의 실제 비용은 어댑터 1개가 아니라 어댑터 1개 + 등록 9곳이다.

누락의 위험도는 균일하지 않다 — FILE_PROVIDERS·BATCH_PROVIDERS 누락은 명시적 501이지만,
PRICE_TABLE 누락은 **조용히 틀린 금액**, SERVER_STATE_KEYS 누락은 **조용한 PO 누수**다
(직전 리뷰에서 고친 xai 네임스페이스 누수가 정확히 이 계열이었다). `PROVIDER_KEYS`가
선언만 되고 아무도 안 쓰는 죽은 상수로 남아 있는 것도 이 구멍의 증상이었다.

**→ 같은 날 해소**: `provider-registration.test.ts` 신설 (31 케이스). 설계 원칙은
"누락은 실패하고, 통과하려면 **사유를 적어야 한다**" — 조용한 빠뜨림을 의도적 결정으로 바꾼다.

- 등록 프로바이더 × 6개 테이블 존재 검사. 빠지면 실패하고, 정당한 예외는 `EXEMPT`에 사유
  문자열과 함께 적어야 통과한다. **역방향 검사도 있다** — 등록됐는데 면제로 남은 유령 항목,
  테이블에만 있는 오타 키를 잡는다 (첫 실행에서 `REFERENCE_KEYS.anthropic`이 실제로 걸렸다.
  면제가 아니라 `{}`로 명시 등록돼 있었다 — "검토했고 해당 없음"을 빈 객체로 표현하는 쪽이
  생략보다 낫고, 이 스위트가 그 차이를 강제한다)
- `ModelRoute`에 **`sample` 필수 필드** 도입 — 각 라우트가 대표 모델 id를 선언한다. 이걸로
  ① 정규식이 정말 자기 모델을 잡는지 ② **앞 라우트에 가려지지 않는지**(참조 동일성 비교)
  ③ 가격표에 단가가 있는지를 검증한다. 정규식 테이블의 순서 의존 버그를 잡는 장치가 이전엔 없었다
- 가격표는 `UNPRICED_KNOWN`에 사유를 적어야 통과 — 현재 11개 모델이 실단가 미확보로 등재돼
  있고, 이것이 `billing-price-estimated` warning의 발동 범위와 일치한다
- **변이 검증**: 테스트가 장식이 아님을 확인하기 위해 일부러 ① SERVER_STATE_KEYS에서 xai 제거
  ② 라우트 정규식을 sample과 어긋나게 ③ PRICE_TABLE에서 grok 단가 제거 — 셋 다 실행 가능한
  메시지와 함께 실패했다. **검증자를 검증하지 않으면 검증자도 결함이다.**

## 2026-08-22 — 스키마 마이그레이션 버전화: 내 CLI의 버그를 실 DB가 잡았다

프로덕션 심사 #8의 "부분 해소"로 남겨뒀던 것(동시 부팅 락 경합은 advisory lock으로 닫았으나
**버전 관리가 없다**)을 마저 했다. 남아 있던 실제 문제는 세 가지였다: ① 어떤 스키마 버전이
떠 있는지 알 방법이 없다(롤백·감사 경로 부재) ② 스키마가 코드 배포 순서에 종속 — 먼저 돌릴
수단이 없었다 ③ 이미 적용된 DDL을 나중에 편집해도 아무도 모른다.

- **baseline 채택**: 기존 idempotent DDL 4블록을 그대로 `0001~0004`로 옮겼다. 전부
  `IF NOT EXISTS`라 이미 테이블이 있는 배포에서도 무해하게 "적용됨"으로 기록되고 채택된다
  (실 DB로 검증 — 테이블 존재 + 이력 없음 상태에서 4건 채택 성공). 테스트가 baseline의
  `IF NOT EXISTS` 누락을 강제한다
- **체크섬**: 적용분의 sql이 바뀌면 실행을 거부한다. 하나라도 어긋나면 **아무것도 적용하지 않는다** —
  부분 적용 상태로 진입하는 것이 드리프트보다 나쁘다
- **락·트랜잭션**: 전역 advisory lock으로 레플리카 간 직렬화, 항목마다 트랜잭션 1개.
  실 DB에서 동시 2프로세스 실행 → 중복 적용 없이 4건, 늦은 쪽은 "다른 프로세스가 먼저 적용함"
- **주체 분리**: `MIGRATE_ON_BOOT=false`면 앱은 스키마를 **바꾸지 않고 검사만** 한다.
  미적용/드리프트면 `/ready` 503 — 스키마가 뒤처진 파드에 LB가 붙지 않는다(실검증)

### 실 DB가 잡은 것

가짜 클라이언트 단위 테스트(11건)는 전부 통과했는데, **실 Postgres에 붙이자 CLI 버그가 나왔다**:
미적용분이 0건이면 `runMigrations`를 아예 호출하지 않아 **드리프트 검사가 건너뛰어졌다.**
정작 그 검사가 필요한 때가 "전부 적용된 것처럼 보이는" 상태인데 말이다. 체크섬을 손으로
변조해 놓고 돌렸더니 "스키마 최신 — 변경 없음"에 exit 0이 나왔다.

단위 테스트가 이걸 못 잡은 이유가 명확하다 — 테스트는 `runMigrations`를 **직접** 불렀고,
버그는 "그 함수를 부르지 않는 경로"에 있었다. 함수의 계약은 맞았고 호출자가 틀렸다.

교훈은 앞선 Dockerfile 건과 같은 계열이다: **단위 테스트는 함수를 검증하고, 실행은 배선을
검증한다.** 이번 세션에서 실제로 잡힌 결함 3건(@hono/node-server devDependency, 이 CLI 버그,
그리고 골든셋이 굳혀둔 effort 반전) 중 둘이 "실제로 돌려봐야만 나오는" 종류였다.

## 2026-08-24 — 전수 감사 (API 패리티 웹 대조 + 코드 모순 6렌즈): 93건

멀티에이전트 감사 2트랙(에이전트 70·툴콜 1,306): ① 4사 공식 문서를 웹에서 실조회해 커버리지와
양방향 대조(빠진 것 + **과잉 드롭**) ② 코드 모순 6렌즈 탐색 후 전건 적대적 검증.
결과: 트랙 A 갭 45건, 트랙 B 결함 48건(47 CONFIRMED). 전체 목록·우선순위·근거는
[전수 감사 보고서](../research/2026-08-24-full-audit.md) + 동명 .data.json(검증 근거 전문).

계열이 아니라 **패턴**으로 기록한다 — 다음 다섯이 93건의 대부분을 만든다:

1. **인바운드에 warning 채널이 구조적으로 없다** — compat 변환기가 IRRequest만 반환해
   강등·날조(arguments 파싱 실패→text, ""→{})가 전부 무증상. D5가 아웃바운드에만 구현된 셈.
2. **블록·툴 레벨 PO가 2급 시민** — envelope PO만 D5 검증. 툴 레벨 PO는 어느 어댑터도 안 읽어
   output_schema·responseJsonSchema·defer_loading이 4사 공통으로 도달 불가.
3. **표면 간 D5 비대칭** — openai Responses는 드롭 보고, CC는 조용히 무시(4종+verbosity 과잉드롭).
4. **"문서가 진실"의 부채** — ADR-0005 fallbacks·부록(b) deferred·§4.5 videoMetadata·§0-2 raw
   복원·§10.1 billing 합산이 문서엔 확정, 코드엔 부재. coverage-matrix가 분류 문자열 존재만
   검사해 이 드리프트를 원리적으로 못 잡는다.
5. **테스트가 결함을 고정** 세 번째 사례 — xGrokConvId 골든셋이 opt-in 우회를 내장.

돈이 틀리는 P0가 6건 포함: billing 전 시도 합산 위반(ir-v0 §10.1), gpt-5.6-pro 접두 오매칭
과금, anthropic reasoning 토큰 0 고정(자기 problem-log가 이미 반증한 전제), 배치 원장 2배
경합, 스윕 실패의 성공 계상, 64MB 업로드 상한 사문화.

## 2026-08-25 — 전수 감사 수정 캠페인: 문서 선행 5 + P0 14 + P1 24/26 + P2 16/18

하루 만에 감사 93건 중 코드 79건 + 문서 선행 5건 처리 (커밋 940dd7a·839def4·이후 P2).
잔여는 전부 외부 의존 — 라이브 녹화/probe(D9 opt-in) 또는 IR 설계 라운드가 필요한 것들.

재발 방지 장치로 남긴 것 두 가지가 핵심이다:

1. **coverage-matrix 'PO 분류→구현 실존' 교차 검증** — "문서가 진실"의 부채(관통 패턴 #4)는
   분류 문자열 존재 검사로는 원리적으로 못 잡는다. 이제 §2에서 PO로 분류된 키가
   KnownOptionsSchema에 없으면 CI가 사유를 요구한다 (UNPRICED_KNOWN과 같은 완전성 강제 패턴).
2. **인바운드 warning 채널** — D5가 아웃바운드에만 구현된 구조적 반쪽(관통 패턴 #1)을
   시그니처 레벨에서 해소. 이후 인바운드 강등·날조는 채널 부재가 아니라 개별 누락의 문제다.

교훈: 감사가 잡은 5대 패턴 중 셋(warning 채널 부재·툴 PO 2급 시민·문서 부채)은 개별 결함이
아니라 **구조**였다 — 개별 패치 79건보다 구조 수정 3건(채널·파티셔너·교차 검증)이 재발을 막는다.
테스트가 결함을 고정한 세 번째 사례(xGrokConvId)는 "결함 수정 시 그 결함을 정답으로 삼던
테스트를 반드시 찾아 교정"을 표준 절차로 만들 근거가 됐다.

## 2026-08-25 — 라이브 probe 세션: 감사 잔여 실측 14건 ($0.003)

probe 케이스 14건(+정상형 1건 추가) 실행 — 판정표는 [probe 계획](../plan/live-probe-2026-08-25.md),
실측 표는 xai 인벤토리 실측 부록. 반증·확정된 전제:

1. **Live Search 410 확정** — 레퍼런스 잔존은 문서 지연이었다. errors.ts 문구 확정형 복원.
2. **B2-7 '400 거부' 전제 5건 반증** — metadata·modalities·audio·prediction·safety_identifier
   전부 **200 묵살**. strip의 근거가 '400 방지'에서 '조용한 묵살 방지(D5)'로 바뀌었다 —
   행동은 같아도 이유가 다르면 문서에 그렇게 적어야 다음 감사가 헛돌지 않는다.
3. **background는 진짜 400** ("Argument not supported") — responses strip 목록에 추가.
4. **xai context_management는 배열형** — OpenAI 객체형과 wire가 다르다 (422 "expected a sequence").
   거부가 아니라 형태 차이. 인벤토리에 기록, strip하지 않음 (xAI 형태 지정은 유효해야 한다).
5. **deferred `{request_id}` 단독 응답 실증** — 부록 (b) §4 계약이 실물로 확인됐고,
   P1에서 구현한 어댑터 deferred 분기가 골든셋 픽스처를 얻었다.
6. **anthropic output_config.format은 type/schema만** — name/description/strict는
   "Extra inputs are not permitted" 400. 어댑터 드롭+warning 전환. **주의**: 1차 probe는
   schema에 additionalProperties:false가 빠져 그것 때문에 400이 났다 — probe는 한 번에
   하나만 다르게. 부수로 schema에 additionalProperties:false 필수임도 확인.
7. **gpt-5.6 minimal 없음 확정** — 400 메시지가 지원 집합을 그대로 나열 (registry와 일치).
8. **grok-4.3 effort none 수용** — registry 유지 확정.

잔여: gemini 2건 (mcpServers 실재·멀티모달 FR) — **GEMINI_API_KEY 부재로 미실행**.
키 확보 시 `pnpm capture gemini-probe-mcp-servers gemini-probe-multimodal-fr gemini-tool-call`.

## 2026-08-25 — gemini probe 3건 (라이브 세션 마감, $0.002): 반증 셋

1. **generateContent functionCall에 id가 실려 왔다** — 인벤토리 D-5 '미발급' 전제 반증
   (gemini-tool-call 재녹화). §13.2 결정론적 합성은 **유지** — 감사 판정대로 에코백 보장·요청
   방향 수용이 미확인인 채 전환하면 안전장치를 잃는다. 스펙 개정은 에코백 실측 후.
2. **tools[].mcp_servers 실존** — 'Interactions 전용' 전제 실효. 3라운드 스키마 탐침:
   {url,...} → "Unknown name url" (필드 실존 확정) → {} → "name cannot be empty" →
   {name} → "No transport configured". 배열형 + name·transport 필수까지 확정, transport
   키는 공식 레퍼런스로 (probe 룰렛은 여기서 중단 — 실존 판정이 목적이었다).
3. **멀티모달 functionResponse.parts 수용 확정** — inlineData PNG가 IMAGE 모달리티
   1089 토큰으로 실소비. P0 #14 세대 게이트 구현이 실물로 검증됐다. 1차 400은 probe 자신의
   결함(히스토리 functionCall thoughtSignature 부재) — D6-9 더미 삽입 규칙의 실증이기도 하다.

anthropic 건과 합쳐 이번 세션의 probe 결함 2건이 준 교훈: **probe body는 어댑터를 통과시키지
않은 raw wire라서, 어댑터가 자동으로 해주는 것(D6-9 더미, additionalProperties)이 빠진다.**
probe 설계 시 "게이트웨이가 보정해 주는 것" 목록을 대조할 것.
