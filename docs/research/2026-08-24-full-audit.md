# 전수 감사 2026-08-24 — API 패리티(4사 웹 대조) + 코드 모순

> 요청: "코드 전수조사 + 각 모델 API 확인(인터넷 검색) — 빠진 기능·에이전트 루프·파라미터·코드 모순 전부"
> 상태: **전건 종결** (2026-08-25) — §5 문서 선행 5건 + P0 14 + P1 26 + P2 18, 93건 전부. 라이브 probe 실측 17건 반영. 마지막 2건: #18은 ir-v0 §13.5 신설(클라이언트 실행 빌트인 툴 — providerExecuted 구분·*_output 조립·왕복 단위 테스트, computer-use 라이브 녹화만 별도 좌석), #24는 gateBlockLevelOptions로 블록·메시지 레벨 D5 완성 (envelope·툴·블록 3레벨 전부 커버). 남은 외부 좌석: computer-use-preview 골든셋 녹화, gemini mcp_servers transport 스키마 공식 확인, functionCall id 에코백 실측 → §13.2 재평가.

## 방법론

| 트랙 | 구성 | 규모 |
|---|---|---|
| A — API 패리티 | 프로바이더별 [공식 문서 웹 조사 ∥ 저장소 커버리지 추출] → 갭 분석 → 저장소 반증 | 에이전트 16 · 툴콜 410 |
| B — 코드 모순 | 6렌즈 병렬 탐색(스펙대조·어댑터×2·인바운드·코어·운영) → 후보 전건 적대적 검증 | 에이전트 54 · 툴콜 896 |

갭 판정에는 이스케이프 해치(opt-in PO·passthrough·응답 보존)와 §15 설계상 제외를 반영해 가짜 갭을 걸렀다.
**정직 노트**: 트랙 B 검증자에게 "애매하면 REFUTED가 아니라 PLAUSIBLE"을 지시해 반증 0건이 나왔다 — 47건 CONFIRMED은 전부 코드 라인 인용을 동반하지만, 구현 착수 시 일부는 약화될 수 있다.

## 1. 우선순위 수정 계획

### P0 — 돈·데이터가 조용히 틀리는 것 (스펙 위반 포함) — 14건 전건 수정 완료 2026-08-25

| # | 항목 | 위치 | 왜 P0 |
|---|---|---|---|
| 1 | billing 전 시도 합산 위반 | `gateway/execute.ts:387,431` | ir-v0 §10.1이 '과금된 전 시도 합산'을 명시 — 폴백 시 클라이언트 노출 금액이 원장 합계보다 과소 |
| 2 | 가격표 접두 `gpt-5.6`이 `gpt-5.6-pro`까지 매칭 | `gateway/pricing.ts:21` | pro 모델을 비-pro 단가로 과금 + isPricedModel=true라 근사 warning까지 억제 |
| 3 | anthropic usage.output.reasoning 항상 0 | `adapters/anthropic/errors.ts:40` | thinking_tokens 미소비 — problem-log가 2026-08-21 실녹화로 반증한 전제가 코드에 잔존. 정산 필드 오보 |
| 4 | 배치 원장 중복 적재 경합 | `bridge/batches.ts:615` | ledgerRecorded 플래그가 루프 후 저장 — 동시 결과 조회 2건이면 원장·지출 2배 |
| 5 | 리소스 스윕이 HTTP 실패를 성공 계상 | `ops/resources.ts:153` | res.ok 미검사 — 401/429여도 deleted+1 후 레지스트리 제거 → 프로바이더에 고아 리소스 잔존 |
| 6 | MAX_UPLOAD_BYTES 사문화 | `server/app.ts:141` | 업로드 리미터 뒤에 /v0/* 공통 10MB 리미터가 중첩 — 64MB 설정이 무의미, 10MB 초과 업로드 전부 413 |
| 7 | tool_result is_error가 content 배열/json에서 소실 | `inbound/anthropic-compat/request.ts:91` | 실패한 툴 호출이 성공으로 둔갑 — 에이전트 루프 정합성 직격 (D10 100% 커버리지 경로) |
| 8 | openai reasoning item 복원이 opaqueState에 게이트 | `adapters/openai/responses/request.ts:137` | store:true 멀티턴에서 보존된 item이 외래로 강등·드롭 — 추론 연속성 파손 |
| 9 | CC url_citation 언랩이 type 소실 | `adapters/openai/chat/response.ts:39` | URL 인용이 빈 file 인용으로 변조 |
| 10 | 세션 영속 부활 경합 | `gateway/session.ts:137` | invalidate 후 큐잉된 append가 삭제된 Redis 키 부활 — 틀린 재생 방지 장치 우회 |
| 11 | compat output_config 부분 소비 유실 | `inbound/anthropic-compat/request.ts:209` | task_budget 등 잔여 서브키 무경고 소멸 — §8-1 보존 통과 계약 위반 |
| 12 | anthropic container PO 부재 | `adapters/anthropic/options.ts:8` | §14 요청 방향 경로가 기본 4xx — G1 왕복 불변식 위반 (retarget SERVER_STATE_KEYS와 자기모순) |
| 13 | xai xGrokConvId 기본 4xx + body 누출 | `adapters/xai/index.ts:44` | 자기 네임스페이스 키가 opt-in 필요 — 골든셋 테스트가 이 결함을 정답으로 고정 중 |
| 14 | gemini 멀티모달 functionResponse 드롭 | `adapters/gemini/request.ts` | 프로바이더가 지원(3세대)하는데 드롭 — 툴 결과에 이미지 반환하는 에이전트 루프 불가 |

### P1 — 계약 위반·비대칭 (조용하지만 트리거가 좁음) — 2026-08-25 수정: 26건 중 24건 완료, 잔여 2건 하단 표기

**전건 종결** (2026-08-25 2차): **#18** — ir-v0 §13.5 신설(IR 스키마 무변경 확인 — §4.4가 이미 1급 표현),
4종 client-executed 분리(providerExecuted 구분), *_output 조립(computer 스크린샷·acked/셸 문자열/
apply_patch status), 왕복 단위 테스트 3건. computer-use-preview 라이브 골든셋만 별도 좌석(§13.5-4).
**#24** — gateBlockLevelOptions 공통 게이트로 블록·메시지 레벨 완성 (어댑터별 인지 키 = 소비 PO ∪
블록 방출 PM — §13.1 편입 왕복 불변식 기준).

1. compat 스트림 3종의 gateway.origin 부재 — 비스트림과 불일치, 표면 sticky 왕복 파손 (openai-compat/stream.ts:147, anthropic-compat/stream.ts:144)
2. 인바운드 warning 채널 자체 부재 — arguments 파싱 강등·빈 문자열 {} 날조가 전부 무증상 (openai-compat/request.ts:93)
3. 빈 content 생략 규칙(§3.4) anthropic-compat 미적용 — 두 인바운드 비대칭 (anthropic-compat/request.ts:121,144)
4. anthropic 세대별 파라미터 게이트 전무 — 4사 중 유일하게 registry capabilities 없음 (registry.ts:93)
5. CC 표면 over-dropping 4종: moderation·prompt_cache_options·prompt_cache_retention·include_obfuscation + verbosity는 CC도 지원 (openai/chat/request.ts)
6. keySource가 최초 타깃으로 고정 — 폴백 시 원장 정산 분리 오염 (server/app.ts:256)
7. graceful drain이 비스트림 요청 미대기 (server/index.ts:187)
8. 취소 터미널 타입이 경로별 불일치 — dispatch 취소는 partial, body 취소는 final (execute.ts:578)
9. 리트라이 sleep 중 취소 시 (requestId,attempt) 원장 행 중복 (execute.ts:295)
10. retarget cache-breakpoint 검사가 툴 정의 PO 누락 (retarget.ts:164)
11. gemini 연속 서명 thought part의 last-wins 서명 유실 — text 경로와 비대칭 (gemini/stream.ts:90)
12. anthropic 히스토리 citations 무경고 드롭 — 응답은 보존, 요청은 유실 (anthropic/request.ts:202)
13. mcp_tool_result is_error 유실 (anthropic/response.ts:121)
14. openai 표면 선택자가 강등 가능 파라미터를 required 강제 — pro 모델에서 하드 400 (openai/index.ts:69)
15. stop_details 미보존 — 거부 분기·폴백 정책 연결 불가 (anthropic response/stream)
16. max_tokens:0 캐시 프리워밍 표현 불가 — ir-v0 §6 positive 완화 필요 (문서 선행)
17. 파트 레벨 캐시 브레이크포인트(openai promptCacheBreakpoint) 부재 — explicit 모드 함정
18. 클라이언트 실행 빌트인 툴 output 제출(computer_call_output 등) 1급 표현 불가
19. 툴 레벨 providerOptions 미독취 — 4사 공통 (output_schema·responseJsonSchema·defer_loading 등)
20. x_search_call 응답 item 미등록 — providerExecuted 강등 (openai/responses/response.ts SERVER_TOOL_CALL_TYPES)
21. xai deferred completions 미구현 — 자체 부록 (b) §4 계약 부채
22. compat→grok 경로 foreign PO 무경고 소실 (xai/remap.ts)
23. grok 기본 라우트 supportedEfforts 미지정 — xhigh 무클램프 통과 (registry.ts)
24. 블록·툴 레벨 PO에 D5 미지 키 정책 미적용 — envelope만 검사 (shared/options 전반)
25. gemini videoMetadata 계약(§4.5) 미구현 — 클리핑 무시로 전체 비디오 과금
26. part extras가 미디어 part에 미배선 (gemini/request.ts fileToWire)

### P2 — 저위험·문서 드리프트·정리 — 2026-08-25 수정: 18건 중 16건 완료 + 2건 부분

**#17·#18 종결** (2026-08-25 라이브 probe 전건 완료): Live Search 410 확정, xai B2-7 표(5건
200 묵살 반증·background 400·context_management 배열형), openai minimal 400 확정, anthropic
format 잉여 키 400 → 드롭+warning, gemini mcp_servers 실존 확정('Interactions 전용' 반증 —
transport 스키마만 공식 레퍼런스 확인 후 승격), 멀티모달 FR 수용 실증(P0 #14 검증),
functionCall id 등장(D-5 반증 — §13.2는 감사 판정대로 유지). coverage-matrix 교차 검증 +
anthropic PO군 승격 포함.

1. openai-compat usage/finishReason raw 복원(§0-2) 미구현
2. stop_sequence 미보존 + compat null 하드코딩 자기모순
3. strict 모드 finish_reason_raw 3경로 모순
4. xai 리라벨 누락 2건(에러 메시지·synth id)
5. CC n>1 delta 혼합(설계상 n=1이나 방어 부재)
6. anthropic in-stream 에러 시 열린 블록 미폐쇄(gemini와 비대칭)
7. 이미지 file 블록 메타 무경고 드롭
8. known-fields container 누락(자기 오탐)
9. reasoning 텍스트 보정 가드 죽은 코드
10. passthrough 재합성이 §6.2와 상이
11. D10 직렬화 키 순서(billing spread)
12. provider-switched to 오표기(다음 타깃 skip 시)
13. budget-exhausted warning 스트림 방출(§10.4) 미구현
14. 포털 로그인 리밋 키 무상한 이메일
15. 포털 maxKeys TOCTOU
16. response.cancelled 터미널 미처리(PLAUSIBLE)
17. Live Search(search_parameters) 라이브 probe 필요
18. 인벤토리 문서 드리프트 다수(anthropic §2·§3·§6, openai 3건, gemini MCP·id에코, xai B2-7) — coverage-matrix에 'PO 분류→구현 실존' 교차 검증 추가

## 2. 트랙 A — API 패리티 갭 전체 (프로바이더별)

### anthropic — 10건

| verdict | sev | kind | 갭 | 권고 |
|---|---|---|---|---|
| CONFIRMED | high | over-dropping | output_config.task_budget이 anthropic-compat 인바운드에서 조용히 유실 (D5 위반) | inbound/anthropic-compat/request.ts에서 output_config의 effort/format 외 잔여 서브키를 providerOptions.anthropic.outputConfigExtras로 보존하고 adapters/anthropic/request.ts:428 조립 시 재병합. 최소한 parameter-dropped warnin |
| CONFIRMED | high | missing-feature | 모델 세대별 파라미터 게이트 전무 — temperature/top_p/top_k·xhigh·prefill이 신세대 모델에서 업스트림 400으로 누수 | registry.ts anthropic 라우트를 세대별 분리(4.7+ unsupportedParams:[temperature,topP,topK], 4.6 supportedEfforts:[low..max], 4.5이하 supportedEfforts:[]), adapters/anthropic/request.ts:390 부근에 gateUnsupportedPara |
| CONFIRMED | high | agent-loop | stop_details(refusal category/explanation) 미보존 — 거부 분기·폴백 트리거 정책 연결 불가 | transformResponse와 stream message_delta에서 stop_details를 providerMetadata.anthropic.stopDetails로 보존(1단계), 이후 폴백 정책 레이어 연결(ADR-0005 §3)·폴백 경합 매트릭스 행 추가. finishReason 확장 여부는 ir-v0 문서 결정 먼저. |
| CONFIRMED | medium | wrong-mapping | usage.output.reasoning이 항상 0 — output_tokens_details.thinking_tokens 미소비 | convertUsage에서 wire.output_tokens_details?.thinking_tokens → output.reasoning, text = total - reasoning. mergeUsage에 output_tokens_details 병합 추가. ir-v0 §8 표 anthropic 행 갱신(문서 먼저) + 골든셋 픽스처. |
| CONFIRMED | medium | missing-feature | 서버측 fallbacks의 ADR-0005 §3 확정 정책(PO opt-in + 위임 마킹) 미구현 | options.ts에 fallbacks 추가(PO opt-in), 응답 fallback 블록·usage.iterations 근거로 providerMetadata에 위임 마킹, 폴백 경합 매트릭스에 행 확정, batches 경로 사전 400, 베타 헤더 정합 검증. |
| CONFIRMED | medium | doc-drift | 인벤토리 문서 §2·§3·§6의 'PO' 분류 주장 vs 실제 구현 드리프트 — CI가 못 잡는 구조 | problem-log에 드리프트 기록 후 (a) 구현으로 충족 또는 (b) 해당 행을 'PT(승격 로드맵 각주)'로 정정. coverage-matrix.test.ts에 'PO 분류 행의 키가 KnownOptionsSchema에 실존' 교차 검증 추가. |
| CONFIRMED | medium | over-dropping | max_tokens: 0 (캐시 프리워밍) 표현 불가 — IR이 positive 강제라 게이트웨이가 400 | ir-v0 §6 문서 먼저 nonnegative로 완화 → ir/request.ts:35와 anthropic wire.ts:10을 nonnegative로. 타 프로바이더 어댑터에는 0 미지원 게이트(드롭+warning). 인벤토리 §2 max_tokens 행에 프리워밍 동작 추기. |
| PARTIAL | medium | missing-param | 문서가 'PO'로 확정한 파라미터군의 1급 부재 — context_management·mcp_servers·container·top-level cache_control·inference_geo·speed·diagnostics | KnownOptionsSchema에 contextManagement·mcpServers·container·cacheControl·inferenceGeo·speed·diagnostics를 wire 원문 통과 record로 승격(우선순위: context_management > container > mcp_servers > cache_control). 정책 연동 |
| CONFIRMED | low | wrong-mapping | output_config.format에 name/description/strict 키 방출 — Anthropic wire 미정의 필드 | format에는 type/schema만 방출, name/description/strict는 드롭+parameter-dropped warning. 골든셋 라이브 녹화(D9 opt-in)로 업스트림이 미지 키를 400하는지 무시하는지 확정 후 픽스처 반영. |
| CONFIRMED | low | over-dropping | anthropic-compat 인바운드에서 미지 tool_choice type 조용한 드롭 | tool_choice 분기에 else 절: 미지 type이면 원문을 passthroughParams.tool_choice로 보존(단 어댑터 RESERVED_BODY_KEYS 충돌 주의 — toolChoice 미설정이므로 body에 tool_choice가 없어 통과 가능) 또는 400. KNOWN_TOP_KEYS 각 키의 부분 소비 경로 점검 테스트 추가. |

### openai — 11건

| verdict | sev | kind | 갭 | 권고 |
|---|---|---|---|---|
| CONFIRMED | high | over-dropping | CC 표면에서 moderation·prompt_cache_options·prompt_cache_retention·stream_options.include_obfuscation 4종이 무경고 조용히 무시됨 | chat/request.ts CC PO 방출부에 3종 body 방출 추가 + stream_options에 include_obfuscation 병합(chat/wire.ts는 looseObject라 통과되나 타입 검증용으로 스키마 확장 권장). index.ts:47 responsesOnly에서 moderation 제거는 공식 문서 재확인 후. 최소한 4종을 드 |
| CONFIRMED | high | missing-param | prompt_cache_breakpoint(파트 레벨 명시적 캐시) 양 표면 표현 불가 — explicit 모드 결합 시 조용한 캐시 전멸 함정 | 블록 PO openai.promptCacheBreakpoint를 양 표면 파트 조립에서 읽어 방출. promptCacheOptions.mode===explicit인데 브레이크포인트 0개면 warning. retarget.ts에 openai 브레이크포인트→타 타깃 대칭 검사 추가 |
| CONFIRMED | high | agent-loop | function 툴 신규 필드 output_schema·allowed_callers·defer_loading 방출 불가 — 툴 레벨 providerOptions를 어댑터가 아예 읽지 않음 | responses/request.ts 함수 툴 조립에서 툴 레벨 PO openai.{outputSchema,allowedCallers,deferLoading} 읽어 방출, 미지 툴 레벨 openai PO 키는 D5 공통 정책 적용. CC 경로는 툴 PO 도달 시 drop+warning 추가 |
| PARTIAL | high | agent-loop | 클라이언트 실행 빌트인 툴 루프(computer_use·local_shell·shell local·apply_patch)의 *_call_output 제출이 1급 표현 불가 | 클라이언트 실행형 4종을 providerExecuted:false로 구분(computer_use_preview 툴 정의·item 필드 기반)하고 toolResult 매핑에 computer_call_output{computer_screenshot, acknowledged_safety_checks}·local_shell_call_output 등 조립 추가. 골 |
| CONFIRMED | medium | over-dropping | text.verbosity가 CC 표면에서 drop되지만 공식 문서는 chat에 top-level verbosity 지원 | chat/request.ts에 body[verbosity] 방출 추가 + :332 드롭 목록과 index.ts responsesOnly에서 textVerbosity 제거, chat/wire.ts에 verbosity 필드 추가, 인벤토리 §1 대조표 갱신 + problem-log(문서 우선 규칙) |
| CONFIRMED | medium | missing-param | 메시지/파트 레벨 phase(commentary/final_answer) 미지원 — 왕복 소실 | 응답 매퍼에서 message item의 phase를 PM openai.phase로 보존하고, 요청 방향 messageToItems에서 메시지 레벨 PO openai.phase를 message item에 방출해 §13.1 히스토리 편입 왕복 성립 |
| CONFIRMED | low | wrong-mapping | D5 비대칭 2건: CC metadata 비문자열 무경고 필터, CC tool.inputExamples 무경고 드롭 | chat/request.ts:351에 Responses와 동일한 warning 루프, :244-248에 inputExamples 존재 시 warning 추가. ir-v0 §5 표준 코드(parameter-dropped) 사용 |
| CONFIRMED | low | over-dropping | openai.custom 툴이 CC 표면에서 일괄 reject — CC 전용 기능과의 조합 봉쇄 | chat/request.ts 툴 조립에서 t.id===openai.custom을 {type:custom,...args}로 방출 허용, index.ts 선택자에서 custom만 Responses 강제 예외로 완화 |
| CONFIRMED | low | missing-feature | 모델 capability 게이트 누락: o3/o4-mini stop 미지원·reasoning 모델 logit_bias가 업스트림 400으로 새어나감 | o3/o4-mini 라우트 분화로 unsupportedParams에 stopSequences 추가, PO용 unsupportedProviderOptions 축 신설 또는 어댑터에서 capabilities 기반 logitBias drop+warning. 라이브 opt-in 테스트로 400 실검증(D9) |
| PARTIAL | low | over-dropping | CC 이미지 detail 조용히 무시 + Responses input_file detail 미방출 | chat fileToPart에서 블록 PO openai.detail을 image_url.detail로 방출, responses input_file 조립에 detail 전달 — 기존 :75-77과 동일 패턴 3줄 수준 |
| PARTIAL | low | doc-drift | 인벤토리 문서 드리프트 3건(ultrafast 공식화·§1 대조표 누락·gpt-5.6 minimal 제외 근거) | §1 대조표에 CC 파라미터 행 추가(코드 수정과 동시 — 문서가 진실 규칙), ultrafast 한계 고지 해소, minimal은 :186 근거가 이미 있으므로 공식 모델 문서와의 재대조만 수행 후 problem-log 기록 |

### google — 11건

| verdict | sev | kind | 갭 | 권고 |
|---|---|---|---|---|
| CONFIRMED | high | over-dropping | 멀티모달 functionResponse(FunctionResponse.parts) 드롭 — generateContent가 이미 지원 | 갭 권고 유효. toolResultToWire content 케이스에서 file 블록을 functionResponse.parts(inlineData/fileData)로 방출. 단 문서상 Gemini 3 세대 한정이므로 세대 게이트(registry capabilities) 필수 — 2.5 이하는 현행 드롭 유지. 라이브 재검증 + 골든셋 + 인벤토리 D-4  |
| PARTIAL | high | agent-loop | tools[].mcpServers 미지원 — reject-400, 해치로도 사실상 도달 불가 | 1단계: 공식 generate-content 레퍼런스에서 tools[].mcpServers 실재 확인(라이브 400/200 실측 포함). 실재 시 PROVIDER_TOOL_KEYS 방식이 아닌 배열형 특수 처리로 승격(갭 권고안 유효) — 그 전까지는 'MCP 단독은 opt-in 해치 가능, 병용 불가'로 등급 재조정(인체공학 갭). |
| PARTIAL | high | missing-param | generationConfig 내부 신좌석 구조적 도달 불가(responseLogprobs·imageConfig·responseFormat 등) | po:responseLogprobs/logprobs/imageConfig/responseFormat 개별 known 키 추가(§K에 이미 후보 등재) 또는 po:generationConfig deep-merge 좌석 신설 — 갭 권고안 유효하되 심각도는 high→medium(해치 존재)으로 재조정 여지. imageConfig는 §15 이미지 출력 범위 결정 |
| CONFIRMED | medium | missing-param | part 레벨 extras(videoMetadata 등)가 미디어 part에 미배선 — 무경고 무시 | 갭 권고안 그대로: fileToWire 반환 직전 withPartExtras 적용(+toolResult part 동일 검토), 비디오 fps/구간 골든셋 픽스처, known-fields PART_KEYS에 mediaProcessing 추가. |
| PARTIAL | medium | over-dropping | tool.strict 드롭 — functionCallingConfig.mode=VALIDATED 미매핑 | 인체공학 개선으로 추진: 전 함수 툴 strict=true + toolChoice auto/tool 지정 시 VALIDATED 자동 방출, 혼재 규범은 ir-v0 §13/폴백 매트릭스에 선기록. po:toolConfig의 전량 오버라이드→병합 전환도 별도 개선으로 유효. |
| PARTIAL | medium | doc-drift | 인벤토리 doc-drift: 'MCP·멀티모달 함수응답은 Interactions 전용' 실효 | 인벤토리 §A-1/D-4/:247 갱신 + problem-log 기록은 유효(멀티모달 FR 한정 실증). MCP는 재조사 후 갱신. id 에코 전환은 기각 — §13.2 재검증 좌석(라이브 재녹화) 절차를 따르고, 전환하려면 스펙 §13.2 개정이 선행. |
| REFUTED | medium | missing-feature | Interactions API 표면 부재 | 갭 목록에서 제외. 단 갭 1 확증으로 '멀티모달 FR=Interactions 전용' 전제가 실효된 만큼, ADR-0003 트리거 조건의 재평가 노트(멀티모달 FR은 generateContent로 충족 가능해져 오히려 긴급도 하락) 1줄을 ADR 결과 절에 추가할 가치는 있음. |
| CONFIRMED | low | missing-param | functionDeclarations.response/responseJsonSchema 미방출 — 툴 레벨 PO 좌석 미독취 | 갭 권고안 그대로: 함수 툴 루프에서 t.providerOptions.google의 responseJsonSchema 등을 def에 병합, 미지 키는 D5 정책. |
| CONFIRMED | low | doc-drift | known-fields 응답 계약 누락(modelStatus·serviceTier·part 신키 5종) | 3개 집합에 키 추가(인지 등재). toolCall/toolResponse의 custom 블록 승격은 별도 판단 — 재녹화로 실물 확인 후. |
| CONFIRMED | low | wrong-mapping | finishReason 신값 4종 unified 미매핑 | 라이브 재녹화로 4종 실값 확인 후 매핑 추가(확인 전 선반영은 금물 — 개방형이라 급하지 않음). ESCALATION→content_filter 등 매핑 정책은 실 응답 문맥 보고 결정. |
| PARTIAL | low | doc-drift | 3.6+ temperature/topP/topK deprecated — 세대 게이트·경고 부재 | 인벤토리 B-2에 변경로그 확인 후 반영(미확인 시 반영 보류). parameter-deprecated warning 메커니즘은 실거부 전환 징후가 잡힐 때 xAI식 unsupportedParams로 — 지금 신설은 시기상조. |

### xai — 13건

| verdict | sev | kind | 갭 | 권고 |
|---|---|---|---|---|
| CONFIRMED | high | over-dropping | openai-compat 인바운드 → grok 타깃에서 CC 호환 po(service_tier·prompt_cache_key 등) 무경고 소실 | 최소 수정은 warning: 어댑터 진입 시 미소비 foreign NS(잔여 openai~foreign 키)에 대해 D5 warning 발행 — appendix-a:84의 계약 이행. 승계(화이트리스트 relabel)를 하려면 '인바운드 신선 요청 vs 히스토리 재타게팅' 구분이 필요하고 기존 회귀 테스트(:239-248)와의 의미론 조정을 ADR/prob |
| CONFIRMED | high | wrong-mapping | xGrokConvId po가 base 스키마에 없음 — 기본 reject-400 + opt-in 시 wire body에 미지 키 누출 | 원안 채택: remap requestToBase에서 xai NS의 xGrokConvId를 추출·보관 후 base 전달 전 제거, postprocess에서 헤더만 주입. 테스트에 'opt-in 없이 동작 + body 부재 + 헤더 존재' assertion 추가. |
| CONFIRMED | high | wrong-mapping | x_search_call 응답 item 미등록 — providerExecuted toolCall이 passthrough로 강등 (요청/응답 비대칭) | SERVER_TOOL_CALL_TYPES에 x_search_call 추가(OpenAI 미발행이라 base 무해) + xai goldenset.response 픽스처. 동시에 known-fields.ts를 테스트에 실연결(anthropic/gemini 패턴)하는 별도 작업 권장 — 이번 갭의 재발 방지 장치가 죽어 있었다. |
| CONFIRMED | medium | missing-feature | CC 응답 최상위 citations[] / output_files[] 확장 필드 유실 | 원안 채택: xai responseFromBase 후처리에서 citations[] → IR citations 승격, output_files[] → PM 보존. CC_RESPONSE_KEYS xai 오버레이 추가 + openai/xai known-fields를 실제 테스트에 연결. |
| CONFIRMED | medium | missing-param | deferred completions po 부재 — 자체 스펙(appendix-b §4)의 PO 통과 계약 미구현 | 원안 채택: xai po 확장에 deferred(CC 전용, responses 도달 시 drop+warning, stream과 동시 지정 4xx) + CC 응답 파서에 {request_id} 단독 분기 → PM xai.requestId. appendix-b 계약 문구와 일치시킬 것. |
| CONFIRMED | medium | wrong-mapping | grok-4.3 기본 라우트 supportedEfforts 미지정 — xhigh 등 미지원 effort 무클램프 통과로 프로바이더 400 | 원안 채택: 기본 grok 라우트에 supportedEfforts:["none","low","medium","high"](grok-4.3 레퍼런스 기준 — none 포함 여부는 문서 재확인) 지정. grok-4.20 계열(effort=에이전트 수 의미 변형, 배치 지원 계열이기도 함 — problem-log:217)은 별도 라우트 검토. |
| CONFIRMED | medium | wrong-mapping | 'Not Actively Used' 명기 필드(background/context_management/top_logprobs)를 무경고 wire 방출 | 원안 채택(3키 xai 전용 warning 또는 strip 이동 + contextManagement responses 강제 제거 검토). background는 문서상 '(Unsupported)'라 400 가능성도 있으니 라이브 probe 대상에 포함. |
| PARTIAL | medium | over-dropping | Responses 표면 top_k/min_p over-dropping — 프로바이더는 지원, 게이트웨이는 드롭/부재 | 원안대로 1급 승격(registry capabilities 게이트 or xai postprocess 재주입 + xai po 확장 minP) 진행하되, 우선순위는 high가 아닌 medium — warning 동반 드롭 + opt-in 우회 존재. goldenset에 opt-in 경로 스냅샷부터 추가하면 현행 동작 고정에 유용. |
| PARTIAL | medium | doc-drift | Live Search(search_parameters) 1급 표현 불가 + '410 폐기' 전제가 최신 문서와 충돌 | 원안의 라이브 probe가 유일한 판정 수단 — 레퍼런스 잔존 vs 410 실거동 중 어느 쪽이 진실인지 실측 후 problem-log 기록. 지원 확인 전에는 errors.ts 410 메시지를 단정형에서 추정형으로 완화하는 것만 선행 가능. |
| PARTIAL | medium | agent-loop | max_turns 미구현 — 에이전트 루프 턴 상한 제어 불가 | 1급 승격 시 xai po 확장 maxTurns + responsesOnly 목록 포함(표면 강제까지 해야 해치의 반쪽 문제 해소). 우선순위는 서버 툴 사용 고객 비중에 따라. |
| CONFIRMED | low | wrong-mapping | selectXAISurface responsesOnly 누락 3종 + xAI에 없는 prompt/conversation의 wire 방출 | 원안대로 라이브 검증 후 prompt·conversation을 XAI_REJECTED_RESPONSES_KEYS에 추가, maxToolCalls는 수용 확인 시 responsesOnly 등재. instructions×previous_response_id 상호배타 사전검증은 별도 저비용 개선. |
| CONFIRMED | low | missing-feature | POST /v1/responses/compact(컨텍스트 압축) 미지원 | 원안의 후순위 처리 동의 — 최소한 docs/README.md 로드맵 또는 appendix-b에 '설계상 보류' 명시 기록부터. 구현 시 bridge/batches.ts 패턴 재사용. |
| CONFIRMED | low | doc-drift | 인벤토리 전제 재검증 부채: B2-7 '미지원 파라미터 400' 일부 반증 + 툴 상한 128/200 혼재 | 원안 채택: opt-in 라이브 probe로 키별 실거동 표 작성 → research 문서·problem-log 갱신, warning 문구를 '거부/묵살 방지'로 교정. 툴 상한 미검증 유지 명문화. |

## 3. 트랙 B — 코드 모순 전체 (심각도순)

| # | verdict | sev | 위치 | 요약 |
|---|---|---|---|---|
| 1 | CONFIRMED | high | `src/inbound/anthropic-compat/request.ts:91` | tool_result의 is_error:true가 content가 배열(콘텐츠 블록)·객체(json)일 때 조용히 소실된다 — output.type이 "text"일 때만 errorText로 승격하고, content variant에는 에러 표식을 보존할 경로도 warning도 없다 (ir-v0 §4.4에 error+content 조합 자체가 없음). 아웃바운드 anthropic request.ts toolRes |
| 2 | CONFIRMED | high | `src/gateway/execute.ts:431` | 폴백 다중 시도에서 billing.lineItems가 '과금된 전 시도 합산'(ir-v0 §10.1 다중 시도 회계 명시)이 아니라 최종 성공 시도분만 담긴다 — finalizeDraft(431행)·비스트림(387행) 모두 buildBilling(최종 usage)만 호출하고, 폴백 체인(executeStream/executeNonStream)은 finish.attempts만 병합할 뿐 billing을 재합산하 |
| 3 | CONFIRMED | high | `src/adapters/anthropic/options.ts:8` | KnownOptionsSchema에 container가 없어 §14가 규정한 요청 방향 PO 경로(providerOptions.anthropic.container)가 기본 설정에서 4xx로 거부됨 — G1 왕복 불변식(§2: PM 방출 키는 요청측 PO 스키마가 수용) 위반이며, gateway/retarget.ts:15의 SERVER_STATE_KEYS는 anthropic.container를 정식 PO 키로  |
| 4 | CONFIRMED | high | `src/adapters/openai/chat/response.ts:39` | CC url_citation 언랩이 type 필드를 잃어 URL 인용이 빈 file 인용으로 조용히 변조됨 |
| 5 | CONFIRMED | high | `src/adapters/openai/responses/request.ts:137` | reasoning item 원문 복원이 opaqueState 존재에 게이트되어 store:true 멀티턴에서 보존된 item이 외래로 강등·드롭됨 |
| 6 | CONFIRMED | high | `src/adapters/xai/index.ts:44` | xGrokConvId(오버라이드 #7)가 base PO 스키마에 없어 기본 4xx, opt-in 시엔 wire body로 누출됨 |
| 7 | CONFIRMED | high | `src/inbound/openai-compat/stream.ts:147` | CC 스트림의 finish gateway chunk에 origin이 없고, 델타로 조립한 text/reasoning 블록에도 origin이 부착되지 않는다 — 비스트림(toChatResponse는 gateway.origin + §4.0 블록 origin 포함)과 같은 개념을 다르게 처리하며, §13.4-1 'gateway.ir = origin 포함 블록 원문' 위반 |
| 8 | CONFIRMED | high | `src/inbound/anthropic-compat/stream.ts:153` | anthropic-compat 스트림은 gateway.origin을 어디에서도 방출하지 않는다(message_start에도, message_delta.gateway에도 없음) — 비스트림 toMessagesResponse(response.ts:134)는 부가하므로 두 경로 불일치, §2.2가 '비-anthropic origin reasoning 복원 판단의 근거'로 지정한 필드가 스트림에서 통째로 빠짐 |
| 9 | CONFIRMED | high | `src/inbound/openai-compat/stream.ts:66` | CC 다운컨버터에 text-start 케이스가 없어 델타 0회 text 블록이 blocks 맵에 생성되지 않고, text-end의 opaqueState/providerMetadata(blocks.get(event.id)===undefined)가 조용히 유실된다 — Gemini '빈 text part + thoughtSignature' 패턴(ir/stream.ts:69 주석이 명시한 A-1 대응)이 gatewa |
| 10 | CONFIRMED | high | `src/inbound/anthropic-compat/request.ts:121` | contentToBlocks가 빈 문자열 content를 빈 text 블록 1개로 변환하고, system은 무조건 push(143-145행)라 §3.4('빈 문자열/빈 배열 content 메시지는 역할 무관 생략')를 위반 — openai-compat(request.ts:74-75)은 올바르게 생략해 두 포맷이 비대칭 |
| 11 | CONFIRMED | high | `src/gateway/session.ts:137` | 영속화 체인의 appendEvent 클로저가 실행 시점에 persistBroken을 재확인하지 않고 invalidate()도 체인 밖(fire-and-forget)이라, append 실패로 버퍼를 무효화한 직후 이미 큐잉된 후속 append가 삭제된 Redis 키를 부활시킨다 |
| 12 | CONFIRMED | high | `src/server/app.ts:141` | MAX_UPLOAD_BYTES(64MB) 사문화 — /v0/files 업로드가 바로 다음 줄의 /v0/* 공통 JSON 리미터(10MB)에 중첩 적용되어 10MB에서 413난다. hono bodyLimit는 미들웨어마다 독립 실행되므로(라인 140의 업로드 리미터 통과 후 라인 141 리미터가 같은 요청을 다시 검사) 더 작은 상한이 항상 이긴다. |
| 13 | CONFIRMED | high | `src/ops/resources.ts:153` | 리소스 스윕이 프로바이더 DELETE의 HTTP 실패(401/404/429/5xx)를 성공으로 계상 — fetch는 비-2xx에서 throw하지 않는데 res.ok 검사가 없어 deleted+=1 후 레지스트리에서 제거한다. '실패 리소스는 레지스트리 유지 — 다음 스윕 재시도'(라인 160 주석) 계약은 네트워크 예외에만 성립. |
| 14 | CONFIRMED | medium | `src/adapters/gemini/options.ts:55` | ir-v0 §4.5가 명시한 비디오 입력 계약("videoMetadata는 providerOptions.google")이 미구현 — gemini 어댑터는 블록 PO에서 partExtras 키만 읽어 wire part에 병합하고(readPartExtras→request.ts withPartExtras), 스펙이 문서화한 videoMetadata 키는 어떤 경로에서도 소비·경고·거부되지 않는다 (known-fie |
| 15 | CONFIRMED | medium | `src/inbound/anthropic-compat/request.ts:144` | appendix-a §3.4(빈 문자열/빈 배열 content 메시지는 역할 무관 생략 — "system/developer만 빠져 있었다"며 확정한 규칙)가 anthropic-compat에서 미적용: top-level system은 무조건 push되고(144행), contentToBlocks(121행)는 빈 문자열을 text:"" 블록으로 만들어 생략하지 않는다. openai-compat 쪽만 빈 문자열을 생 |
| 16 | CONFIRMED | medium | `src/inbound/openai-compat/request.ts:93` | 히스토리 tool_calls의 arguments 처리에서 appendix-a §3.1("JSON 파싱, 실패 시 text variant + warning")의 warning이 누락됐고, 빈 문자열은 {}로 조용히 날조된다 — ir-v0 §4.3이 명시적으로 금지한 패턴('{}' 삽입, LiteLLM 반면교사). 인바운드 변환기에 warning 채널 자체가 없어 강등이 무증상이다. |
| 17 | CONFIRMED | medium | `src/adapters/anthropic/options.ts:38` | 블록·툴 레벨 providerOptions에 D5 미지 키 정책(ir-v0 §2: 자기 네임스페이스 안의 스키마 밖 키는 기본 4xx, opt-in 통과 시 warning)이 전혀 적용되지 않는다 — partitionProviderOptions는 envelope 레벨에서만 호출되고, 블록 PO는 4사 모두 readBlockCacheControl/readItem/readPartExtras류의 무검증 조회만 한다 |
| 18 | CONFIRMED | medium | `src/inbound/openai-compat/response.ts:23` | appendix-a §0-2·§5("origin.provider가 인바운드 포맷 소유 프로바이더와 같으면 finishReason.raw·usage.raw 우선 복원 — 무손실")가 openai-compat에서 미구현: toChatUsage/toChatFinishReason은 origin을 받지도 않고 항상 정규화 평면값으로 합성한다. anthropic-compat(toMessagesUsage/toMessage |
| 19 | CONFIRMED | medium | `src/inbound/anthropic-compat/stream.ts:144` | anthropic-compat 스트림 응답에는 gateway.origin이 어디에도 실리지 않는다(finish의 message_delta.gateway에 finish_reason_raw·warnings만) — 비스트림 응답은 gateway:{origin}을 부가하는데(appendix-a §2.2, ADR-0002 표면 sticky·§13.4-2 복원 1순위의 근거) 스트림 턴은 그 계약이 성립 불가. 같은 응 |
| 20 | CONFIRMED | medium | `src/adapters/anthropic/request.ts:202` | 히스토리 text 블록의 citations를 warning 없이 조용히 드롭 — 응답 방향(response.ts:73-81)은 citations를 IR로 보존하는데 요청 방향은 {type:'text', text}만 방출해 D5(조용한 드롭 금지)와 G1 왕복이 동시에 깨짐 (Anthropic wire는 요청 히스토리의 text 블록 citations를 수용함) |
| 21 | CONFIRMED | medium | `src/adapters/gemini/stream.ts:90` | 서명 실린 thought part가 연속 도착하면 하나의 reasoning 블록에 opaqueState delta 2건으로 실려 소비자 last-wins로 앞 서명이 유실 — 같은 파일의 text part 경로(105행)는 정확히 이 유실을 막으려고 서명마다 블록을 닫는데(스트림 테스트 106행이 이를 고정) thought 경로만 미적용, 비스트림(partToBlock: part당 1블록·서명별 보존)과도 I |
| 22 | CONFIRMED | medium | `src/adapters/anthropic/response.ts:168` | wire의 stop_sequence(발동한 정지 시퀀스 값)를 IR 어디에도 싣지 않고 무보고 드롭 — known-fields.ts는 인지 필드로 등재(8행·48행)했지만 transformResponse·stream(message_delta.delta) 모두 stop_reason만 읽어, anthropic-compat 다운컨버트가 stop_sequence를 null로 하드코딩(inbound/anthropic- |
| 23 | CONFIRMED | medium | `src/adapters/anthropic/response.ts:121` | *_tool_result 수납 시 tool_use_id·content만 보존해 mcp_tool_result의 is_error가 유실 — G1 왕복 복원(request.ts:112-114)도 {type, tool_use_id, content}만 재조립해 실패한 서버 툴 결과가 성공으로 둔갑 (known-fields.ts:30은 is_error를 인지 필드로 등재) |
| 24 | CONFIRMED | medium | `src/adapters/openai/index.ts:69` | 표면 선택자가 강등 가능한 파라미터(seed/penalties/stop, CC 전용 PO)를 required로 강제해 responses 전용 모델에서 하드 400 발생 |
| 25 | CONFIRMED | medium | `src/adapters/openai/chat/stream.ts:140` | CC 스트림이 choices[].index를 무시해 n>1 시 두 후보의 delta가 한 text 블록에 무경고 혼합됨 |
| 26 | CONFIRMED | medium | `src/adapters/xai/remap.ts:191` | xai 응답 방향 리라벨 누락 2건 — provider-error.message의 'openai' 문구, synth toolCallId의 'synth:openai:' 접두 |
| 27 | CONFIRMED | medium | `src/inbound/openai-compat/stream.ts:144` | strict 모드에서 finish_reason_raw 처리가 3개 경로에서 서로 모순: CC 비스트림은 strict 가드 밖에서 병기(response.ts:71), CC 스트림은 gateway chunk 전체가 !strict 안이라 raw 전멸, anthropic-compat 스트림(stream.ts:154)은 strict에서도 병기 — §4.1 'paused/tool_error → raw 병기 (ir-v0  |
| 28 | CONFIRMED | medium | `src/inbound/anthropic-compat/response.ts:148` | stop_sequence가 항상 null로 하드코딩(스트림 message_delta도 동일 — stream.ts:147)되어, raw 복원으로 stop_reason:"stop_sequence"를 내보내면서 짝 필드 stop_sequence는 null인 자기모순 wire를 생성 — 매치 문자열은 아웃바운드 어댑터(adapters/anthropic/response.ts transformResponse가 wire. |
| 29 | CONFIRMED | medium | `src/inbound/openai-compat/request.ts:95` | tool_calls arguments JSON 파싱 실패 시 text variant로 조용히 강등 — 부록 (a) §3.1 표가 명시한 '실패 시 text variant + warning'의 warning이 없고, compatChatToIR엔 warning 채널 자체가 없다(D5 조용한 변조 금지 위반) |
| 30 | CONFIRMED | medium | `src/gateway/execute.ts:295` | 리트라이 대기(sleep) 중 취소되면 이미 원장에 기록된 시도 번호를 canceled.attempt로 재사용해, 같은 (requestId, attempt)에 원장 행이 2개 적재된다 — '시도별 1행' 회계 불변식 위반 |
| 31 | CONFIRMED | medium | `src/gateway/execute.ts:431` | finish.billing이 최종 성공 시도의 usage만으로 계산된다 — ir-v0 §10.1 'billing.lineItems는 과금된 전 시도 합산' 위반으로 클라이언트 노출 금액이 과소 |
| 32 | CONFIRMED | medium | `src/gateway/pricing.ts:21` | 접두 "gpt-5.6"이 라우팅 가능 모델 gpt-5.6-pro까지 매칭해 pro 모델을 비-pro 단가로 조용히 과금하고, isPricedModel이 true가 되어 D5가 요구하는 billing-price-estimated warning까지 억제된다 |
| 33 | CONFIRMED | medium | `src/gateway/execute.ts:578` | 콘텐츠 방출 전 취소의 터미널 타입이 경로마다 다르다 — dispatch 단계 취소는 error-partial(529행), body 소비 단계 취소는 error-final(578행). ir-v0 §10.4와 session.ts abortError 주석은 abort 계열 터미널을 error-partial로 규정 |
| 34 | CONFIRMED | medium | `src/gateway/retarget.ts:164` | cache-breakpoint-ignored 검사가 메시지 블록 PO만 훑고 툴 정의 PO(tools[].providerOptions.anthropic.cacheControl)는 건너뛴다 — 부록(a) §3.3·ir-v0 §14('블록/툴') 위반 |
| 35 | CONFIRMED | medium | `src/server/app.ts:256` | keySource(정산 분리 기준)가 최초 라우팅 타깃 프로바이더로 1회만 계산되어 tenantContext에 고정 — 크로스 프로바이더 폴백 시도의 원장 행(execute.ts rowBase 186-192)에 틀린 keySource가 스탬프된다. 배치 경로는 batchDeps(app.ts:480-491)에 keySource가 아예 없어 배치 원장 행은 항상 keySource 누락. |
| 36 | CONFIRMED | medium | `src/bridge/batches.ts:615` | 배치 결과 원장 적재의 중복 방지 플래그(ledgerRecorded)가 전체 항목 기록 루프가 끝난 뒤에야 저장돼(라인 647), 동시 getBatchResults 2건(멀티탭 폴링·크로스 레플리카)이 모두 플래그 미설정을 관측하면 원장 행과 spendTracker 지출이 2배로 적재된다. |
| 37 | CONFIRMED | medium | `src/server/index.ts:187` | graceful shutdown의 drain이 스트림 세션만 대기(sessions.drain) — 진행 중 비스트림 요청은 아무도 기다리지 않아 server.close()도 await 없이 지나가고 process.exit(0)에 잘린다. '진행 중 요청의 과금 원장 write 유실 방지'라는 라인 159-163 주석의 목표가 비스트림 경로에서 깨진다. |
| 38 | PLAUSIBLE | medium | `src/adapters/openai/responses/stream.ts:343` | response.cancelled 터미널 미처리 — 취소가 502 절단 오류(fallbackEligible)로 둔갑 |
| 39 | CONFIRMED | low | `src/adapters/anthropic/stream.ts:350` | in-stream error·절단(onStreamEnd) 터미널에서 열린 블록을 닫지 않음 — gemini 어댑터는 동일 상황에서 closeOpen으로 text-end/reasoning-end를 방출(gemini/stream.ts:232·334)해, 같은 계약(터미널 보장)을 두 어댑터가 다르게 처리 |
| 40 | CONFIRMED | low | `src/adapters/anthropic/request.ts:100` | 이미지 file 블록(isImage)의 title·context·citationsEnabled·filename을 warning 없이 조용히 드롭 — 문서 경로는 세 필드를 wire에 싣고, gemini 어댑터는 같은 개념(좌석 없는 문서 메타)을 필드별 parameter-dropped warning으로 보고(gemini/request.ts:94-100)하는 것과 비대칭 (D5) |
| 41 | CONFIRMED | low | `src/adapters/anthropic/known-fields.ts:47` | MESSAGE_DELTA_KEYS·MESSAGE_DELTA_DELTA_KEYS에 container가 없어, stream.ts:317이 '실관측 2경로'라며 소비하는 message_delta의 container(top-level·delta 양쪽)를 신선도 장치가 미지 필드로 오탐 — 어댑터가 아는 필드를 드리프트로 보고하는 자기모순 |
| 42 | CONFIRMED | low | `src/adapters/openai/responses/stream.ts:262` | reasoning 텍스트 보정 가드가 죽은 코드 — added 후 delta 없이 done에만 summary가 오면 텍스트 소실 |
| 43 | CONFIRMED | low | `src/inbound/anthropic-compat/stream.ts:115` | passthrough 이벤트를 무조건 content_block_start{content_block: raw}+stop 쌍으로 재합성 — §6.2 'passthrough(provider==anthropic) → 원문 이벤트 복원'과 달리, 어댑터가 이벤트 원문 전체를 보존한 경우(adapters/anthropic/stream.ts:226·259·363) 이벤트 JSON이 가짜 콘텐츠 블록으로 둔갑한다 |
| 44 | CONFIRMED | low | `src/gateway/session.ts:129` | 스트림 이벤트 직렬화(push의 JSON.stringify)가 스키마 정의 순서를 강제하지 않아, finalizeDraft가 billing을 뒤에 spread한 finish는 D10 'wire 키 순서 = 스키마 필드 순서'를 위반한다 |
| 45 | CONFIRMED | low | `src/gateway/execute.ts:748` | provider-switched의 to가 skip 판정 전의 targets[i+1]을 가리켜, 다음 타깃이 skip되면 전환 대상 오표기 + 잔여 전 타깃 skip 시 실제 실패를 '모든 폴백 타깃이 skip됨' 400으로 오보고 |
| 46 | CONFIRMED | low | `src/ops/budget.ts:69` | 스펙-코드 의미론 불일치: ir-v0.md §10.4(라인 441)는 스트림 중 hard 예산 초과 시 warning(code: budget-exhausted-next-request-blocked)을 스트림에 방출하라고 명시하나, 이 코드는 PreRequest 1회 평가뿐이고 해당 코드는 402 에러의 provider.code(라인 97)로만 존재 — warning 이벤트로 방출하는 지점이 소스 전체에 없다( |
| 47 | CONFIRMED | low | `src/server/portal.ts:182` | 로그인 레이트리밋 키가 무검증·무상한 이메일 문자열(EMAIL_RE는 가입 경로만 적용) — portal:login:<email>이 그대로 저장 키가 되고, InMemoryRateLimiter(rate-limit.ts:36-38)는 창이 지나도 counters Map 항목을 영구 보존해 무인증 메모리 팽창 벡터가 된다. |
| 48 | CONFIRMED | low | `src/server/portal.ts:227` | 포털 키 발급의 maxKeys 검사가 카운트 조회와 발급 사이 원자성 없는 TOCTOU — 동시 POST /portal/keys N건이 전부 active.length < maxKeys를 관측하면 한도를 초과해 발급된다. |

## 4. 관통 패턴 (수정 설계에 반영할 것)

1. **인바운드에 warning 채널이 없다** — compat 요청 변환기 2종은 IRRequest만 반환해 D5 위반이 구조적이다. `compatChatToIR`/`compatMessagesToIR`이 `{request, warnings}`를 반환하고 응답 warnings에 병합되도록 시그니처를 바꾸는 것이 개별 패치보다 근본 수정이다.
2. **블록·툴 레벨 PO가 2급 시민** — envelope PO만 D5 검증을 받고, 블록/툴 PO는 어댑터별 임의 키 읽기(readBlockCacheControl 등)라 미지 키가 무증상이다. 레벨별 공통 파티셔너로 승격 필요.
3. **표면 간 D5 비대칭** — Responses 어댑터는 드롭을 보고하는데 CC는 조용하다. 같은 파라미터가 표면에 따라 다르게 취급된다.
4. **'문서가 진실'의 부채 축적** — ADR·인벤토리·부록이 확정한 것(fallbacks·deferred·videoMetadata·§0-2 raw 복원·§10.4 warning)이 코드에 없다. coverage-matrix 테스트가 분류 문자열 존재만 검사해 이 드리프트를 못 잡는다 — '분류→구현 실존' 교차 검증이 재발 방지 장치다.
5. **테스트가 결함을 정답으로 고정** — xGrokConvId 골든셋이 opt-in 우회를 내장. effort 반전(직전 감사)과 같은 계열 세 번째.

## 5. 문서 선행 항목 (CLAUDE.md: 코드 우회 전 문서 수정) — 전건 반영 완료 2026-08-25

- [x] ir-v0 §6 `maxOutputTokens` positive → nonnegative (max_tokens:0 프리워밍)
- [x] ir-v0 §8 usage 표 anthropic 행 (thinking_tokens)
- [x] ir-v0 §4.4 toolResult `errorContent` variant 신설 (is_error × content 직교 규칙 명문화)
- [x] ir-v0 §4.9 `rawUnit?: "block" | "event"` 판별자 신설 (§6.2 정밀화의 전제 — 계획엔 없었으나 필요)
- [x] 폴백 경합 매트릭스: stop_details 폴백 트리거 행 + 서버측 fallbacks 위임 구체화 행
- [x] 부록 (a) §3.4 anthropic-compat 적용 명시, §6.2 passthrough 복원 `rawUnit` 판별 규칙
