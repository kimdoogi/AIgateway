# ADR-0007: 과금/테넌시 envelope — 라인아이템 + 예산 집행 + 정산까지 v1

- 상태: **승인** (2026-08-20 사용자 결정)
- 날짜: 2026-08-20
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D7, [ADR-0006](ADR-0006-state-layer.md)(원장·집계 저장), [IR 게이트](ir-design-gate.md) G4(usage 정규화)

## 결정

### 1. usage와 billing의 분리

- **usage** = 토큰·호출 사실 (IR 정규화 필드 + raw 보존, G4 공식)
- **billing** = 금액 환산 — 응답 envelope의 별도 블록:

```
billing: {
  lineItems: [{ kind: 'tokens' | 'server_tool' | 'iterations' | 'cache_storage' | 'search',
                sku,            // 예: 'anthropic:claude-opus-5:input:cache_read:1h'
                quantity, unitCost, cost, currency }],
  total, currency
}
```

### 2. 단가 산정

- 레지스트리 가격표 기반 — 다단계 구간(long context 프리미엄: OpenAI 272K 초과, xAI 200k 초과), 캐시 TTL별 단가(Anthropic 5m/1h), fast mode 별도 단가, 서버 툴 호출당 과금(xAI server_tool_usage_details, Anthropic web_search_requests, Gemini 쿼리당 grounding), **Anthropic `iterations`류 top-level 미합산 항목**을 라인아이템으로 흡수.
- raw usage를 원장에 함께 보존 → 가격표 갱신 시 재계산 가능.

### 3. 가상 키 예산 집행 (v1)

- 가상 키에 기간별 예산 한도: soft(경고 헤더/이벤트) → hard(요청 차단, 명시적 4xx).
- 실시간 집계는 Redis, 확정 원장은 Postgres append-only (ADR-0006). 스트림은 `usage-interim`(ADR-0005)으로 진행 중 집계 반영.

### 4. 정산 v1 (사용자 결정: "정산까지")

- 테넌트별 기간 정산 리포트: 모델·기능(kind)·가상 키별 집계, CSV/JSON 익스포트 API.
- 확정 원장 기준(append-only), 리포트 재생성 가능(멱등).
- 범위 밖: 세금계산서 발행, PG/결제 연동 — 2차.

### 5. 리셀 대비

라인아이템에 마진/마크업 필드를 예약 (국내 기업 대상 리셀/차지백 시나리오) — v1은 필드만, 정책 엔진은 2차.

## 결과

- IR 응답 envelope 스키마(로드맵 2)에 billing 블록 포함.
- 예산 집행은 정책 레이어의 PreRequest 단계(캐시 뒤, 프로바이더 호출 전). 스트림 중 hard 초과 처리는 확정 완료 — ir-v0 §10.4: 현재 스트림 완료 + 다음 요청부터 차단. **집행 단위는 게이트웨이 요청(`req_`)당 1회 평가** — 같은 요청 내 폴백 시도는 현재 스트림의 연속으로 간주해 차단하지 않고, 초과분은 원장에 기록 (E2E 검증 F3 해소).
- 원장에 **키 소스 구분**(테넌트 BYO / 게이트웨이 풀)을 기록한다 — BYO 트래픽(프로바이더가 테넌트에 직접 청구)과 풀 키 트래픽(게이트웨이 리셀)의 정산이 다르기 때문 (E2E 검증 F4 파생).
- 골든셋에 billing 계산 스냅샷 추가 (usage 픽스처 → 라인아이템 결과).
