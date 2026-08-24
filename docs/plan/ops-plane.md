# 운영 평면 실행 계획 — 가상 키·예산·정산 + 서버 상태 레지스트리 + 본문 로그

- 상태: **구현 완료 (2026-08-21 — 6단계 전부, 테스트 421개)**. 결정 확정: D1 마스터 키 env ✓ / D2 **DB 암호화 저장**(권고와 달리 — AES-256-GCM + `GATEWAY_KEY_ENCRYPTION_KEY`, KMS 2차) ✓ / D3 기본 on ✓
- **2026-08-22 전면 리뷰 반영**: compat 인바운드 인증 좌석 **클로즈** — `/compat/*`도 동일 미들웨어 통과 + 인바운드 전처리(파일 ref·BYO·리소스 검증) 공용화. 브리지(Files/Batches)·count_tokens가 풀 키를 고정 사용하던 것도 리졸버 경유로 교정. 스트림 세션에 소유 테넌트 기록 → 재개·취소 격리(영속 버퍼 키도 테넌트 스코프)
- **2026-08-22 프로덕션 배포 P0/P1/P2 반영**: 예산 집계·요청 빈도 제한·취소 전파가 Redis 뒤로 이관돼 **다중 레플리카에서 성립**(실 Redis 검증). 본문 로그는 비블로킹 + `BODY_LOG_RETENTION_DAYS` 보관 정책(관리 스윕이 집행). OTel은 `OTEL_EXPORTER_OTLP_ENDPOINT` 설정 시 실제 등록(이전에는 SDK 미등록으로 전 span no-op)
- 잔여 좌석: 스트림 응답 본문 로그(요청만 v1), 스트림 finish PM 리소스 등록, TTL 스윕 자동화(현재 관리 API 트리거), 가격표 실단가 확충(현재 미등재 모델은 `billing-price-estimated` warning + 폴백 단가)
- 근거: [ADR-0006 §3](../decisions/ADR-0006-state-layer.md)(리소스 레지스트리) · [ADR-0007](../decisions/ADR-0007-billing-envelope.md)(라인아이템·예산·정산) · [ADR-0008](../decisions/ADR-0008-observability.md)(본문 로그)
- 선행 완료: 원장(usage_ledger)·가격표(gateway/pricing.ts)·FileStore/BatchStore의 tenant 좌석

## 작업 분해 (구현 순서)

1. **가상 키·테넌트** — `gwk_` 키 발급/폐기(관리 API), 키→테넌트 매핑 스토어(Postgres), `/v0/*` 인증 미들웨어(Authorization: Bearer gwk_...), 원장 행에 tenant·keyId·키 소스(BYO/풀) 컬럼 추가. Files/Batches의 `DEFAULT_TENANT`를 실테넌트로 치환.
2. **billing 라인아이템** — 가격표 기반 usage→lineItems 변환(§8 usage + `:batch`/캐시 TTL/서버 툴 SKU), 응답 envelope `billing` 블록 채움(ir-v0 §7 — 스키마는 이미 예약), 원장에 cost 컬럼.
3. **예산 집행** — 키별 기간 예산(soft/hard), PreRequest 평가(§10.4 — 현재 스트림 완료 + 다음 요청 차단, 요청당 1회 평가), Redis 실시간 집계 + 원장 확정치 보정. `budget-soft-warning`/`budget-exhausted-next-request-blocked` warning 발화.
4. **정산 리포트** — `GET /v0/admin/usage-report?from&to&groupBy=model|kind|key` (JSON/CSV), 확정 원장 기준 멱등 재생성.
5. **서버 상태 리소스 레지스트리** (ADR-0006 §3) — PO 검증 경로 훅: opt-in 서버 상태 생성 시 등록{테넌트·프로바이더·타입·외부 id·TTL}, 타 테넌트 참조 차단, 미등록 외부 id 기본 거부(+테넌트 설정 허용), TTL 만료 시 삭제 API 대행.
6. **본문 로그 파이프라인** (ADR-0008) — 3층(메타[완료]/본문/OTel), 본문 로그 sink 인터페이스(Postgres/파일), groundingMetadata 제외 규칙(TOS), 테넌트 opt-out 플래그.

## 사용자 결정 (착수 전)

| # | 질문 | 권고 |
|---|---|---|
| D1 | **관리 API 인증** — 가상 키 발급/정산 리포트 등 `/v0/admin/*`의 인증 방식 | v1: `GATEWAY_ADMIN_KEY` env 단일 마스터 키 (콘솔·RBAC는 2차) |
| D2 | **BYO 프로바이더 키 저장** — 하이브리드(ADR-0001 확정)의 BYO 쪽 키를 어디에 | v1: 풀 키(env)만 실구현, BYO는 **요청 헤더 패스스루**(`x-provider-key` — 게이트웨이 저장 없음). DB 저장(암호화·KMS)은 2차 |
| D3 | **본문 로깅 기본값** — ADR-0008은 기본 on(opt-out)인데 v1 로컬/단일 테넌트 배포에서도 유지? | ADR대로 기본 on 유지 (데이터 주권·리전 제약은 배포 설정으로) |

## 비범위 (2차)

세금계산서·PG 연동(ADR-0007), admin 콘솔 UI, 멀티리전, BYO 키 DB 저장, 마진/마크업 정책 엔진(필드만 예약).
