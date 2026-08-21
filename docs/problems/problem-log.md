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
