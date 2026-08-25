# 라이브 probe 세션 — 전수 감사 잔여분 (2026-08-25 준비)

> 목적: [전수 감사](../research/2026-08-24-full-audit.md) 잔여 9건 중 **라이브 실측이 필요한 것**을
> 한 세션에 처리한다. probe 케이스는 [tools/capture/cases.ts](../../tools/capture/cases.ts)의
> `*-probe-*` (전건 `manual` — 기본 캡처 실행에서 제외). D9 opt-in — 실 API 키 필요.
> 상태: **14/16 실행 완료 (2026-08-25, $0.003)** — 결과는 §2 표의 판정대로 반영됨
> (problem-log 2026-08-25 + xai 인벤토리 실측 부록). **잔여: gemini 2건 + gemini-tool-call 재녹화 —
> GEMINI_API_KEY 부재.** 키 확보 시:
> `pnpm capture gemini-probe-mcp-servers gemini-probe-multimodal-fr gemini-tool-call`

## 0. 사전 조건

- `.env`에 4사 키: `ANTHROPIC_API_KEY` `OPENAI_API_KEY` `XAI_API_KEY` `GEMINI_API_KEY`
- 비용: 전 probe 합산 추정 < $0.05 (max tokens 16~100, 하네스 $1.00 하드 캡 별도)
- 새니타이저 자동 적용 — 원문은 `tools/capture/raw/`(gitignore), 픽스처는 `fixtures/<provider>/`

## 1. 실행

```bash
COREPACK_INTEGRITY_KEYS=0 corepack pnpm capture xai-probe-live-search xai-probe-metadata xai-probe-modalities xai-probe-audio-param xai-probe-prediction xai-probe-safety-identifier xai-probe-background xai-probe-top-logprobs xai-probe-context-management xai-probe-deferred xai-probe-effort-none-43 gemini-probe-mcp-servers gemini-probe-multimodal-fr anthropic-probe-format-extras openai-probe-minimal-effort gemini-tool-call
```

(`gemini-tool-call`은 기존 케이스 재녹화 — id 에코 재검증용)

## 2. 판정 규칙 → 후속 행동

| probe | 감사 항목 | 판정 | 후속 |
|---|---|---|---|
| xai-probe-live-search | xai #9 / P2 #17 | **410** → 폐기 확정 / **200** → 레퍼런스 잔존 | 410: errors.ts 문구 단정형 복원 + 인벤토리 확정. 200: search_parameters 1급/PO 표현 설계 + errors.ts 410 특례 제거 |
| xai-probe-{metadata,modalities,audio-param,prediction,safety-identifier} | xai #13 (B2-7) | 키별 **400 거부** vs **200 묵살** | 실거동 표를 인벤토리 B2-7에 기록. 묵살 키는 strip 사유를 'ADR-0004 정책'으로 정정, 거부 키는 '400 방지' 유지. warning 문구 '거부/묵살 방지'로 교정 |
| xai-probe-background | xai #7 | 400 여부 | 400이면 XAI_REJECTED_RESPONSES_KEYS에 추가 |
| xai-probe-{top-logprobs,context-management} | xai #7 | 묵살 여부 | 묵살이면 'Not Actively Used' warning 3종 추가 (index.ts postprocess) |
| xai-probe-deferred | xai #5 | `{request_id}` 단독 응답 형태 | 픽스처 → xai goldenset에 deferred 분기 케이스 추가 (P1 구현 `transformResponse` 검증) |
| xai-probe-effort-none-43 | xai #6 | none 수용 여부 | 400이면 registry grok-4.3 supportedEfforts에서 none 제거 |
| gemini-probe-mcp-servers | google #2 | 200/400 | 200: 배열형 특수 처리 승격 (PROVIDER_TOOL_KEYS 방식 아님). 400: 'MCP 단독 opt-in 해치 가능' 등급 재조정 + 인벤토리 갱신 |
| gemini-probe-multimodal-fr | google #1 (P0 #14) | 200 + 정상 응답 | 픽스처 → gemini goldenset (functionResponse.parts 요청 방향). 400이면 multimodalFunctionResponse capability 회수 + problem-log |
| gemini-tool-call (재녹화) | google #6 (id 에코) | functionCall에 id 필드 존재 여부 | id 등장 시: §13.2 재검증 좌석 절차 — 스펙 개정 선행 없이는 전환 금지 (감사 결론). 인벤토리 D-5 갱신만 |
| anthropic-probe-format-extras | anthropic #9 | 400 vs 무시 | 400: 어댑터에서 name/description/strict 드롭+warning (감사 권고 확정). 무시: 현행 방출 유지 + 인벤토리 각주 |
| openai-probe-minimal-effort | openai #11 | 400 확인 | 400: 인벤토리 §H 'minimal 없음' 근거 확정 기록. 200: registry OPENAI_GPT56_EFFORTS에 minimal 추가 |

## 3. 세션 마무리 절차

1. 픽스처 승격분은 골든셋 테스트에 연결 (`goldenset.*.test.ts` — 스냅샷 리뷰 필수)
2. 인벤토리 문서 갱신 — 감사 P2 #18 잔여분: openai(ultrafast 한계 고지·minimal 근거), gemini(MCP·id 에코), xai(B2-7 실거동 표)
3. [problem-log](../problems/problem-log.md)에 실측 결과 기록 (반증된 전제는 명시)
4. [전수 감사 보고서](../research/2026-08-24-full-audit.md) 상태줄 갱신 — P2 #17/#18 종결
5. 커밋: `fix: 감사 잔여 라이브 probe 실측 반영 — ...`

## 4. 이 세션 범위 밖 (별도 라운드)

- **P1 #18** 클라이언트 실행 빌트인 툴 output 제출 — probe가 아니라 **IR 표현 설계(ir-v0 §4.4 확장) 문서 선행**이 첫 단계. 설계 후 computer-use-preview 라이브 녹화 별도 세션
- **P1 #24** 블록 레벨 PO 파티셔너 승격 — 라이브 불요, 어댑터별 블록 인지 키 정리 코드 작업
- gemini finishReason 신값 4종 — 의도 유발 불가, 실전 등장 시 known-fields 경고로 잡힌다 (개방형이라 급하지 않음)
