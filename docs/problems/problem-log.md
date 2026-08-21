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
