# ADR-0006: 상태 계층 — 처음부터 PostgreSQL + Redis, 프로바이더 서버측 상태는 게이트웨이 관리형

- 상태: **승인** (2026-08-20 사용자 결정)
- 날짜: 2026-08-20
- 관련: [ADR-0001](ADR-0001-adapter-architecture.md) D7/§5, [ADR-0005](ADR-0005-stream-contract.md)(재개 버퍼), [ADR-0007](ADR-0007-billing-envelope.md)(원장)

## 결정

### 1. 저장소 — 처음부터 운영 스택 (사용자 결정: SQLite 시작안 기각)

- **PostgreSQL (durable)**: usage/billing 원장(**append-only**), Batches 잡 상태, Files 매핑(테넌트 격리 포함), 가상 키·테넌트·예산 설정, 서버측 상태 리소스 레지스트리(아래 3), 모델 레지스트리 스냅샷, 정산 집계.
- **Redis (휘발/고속)**: 응답 캐시(grounding 제외 규칙 내장 — D7), 초 단위 토큰버킷(xAI RPS 대응), quota 카운터(일일 한도), 스트림 재개 버퍼(ADR-0005), 예산 실시간 집계.
- **스토리지 인터페이스 추상화는 유지**: 단위 테스트용 인메모리 구현체 제공 (테스트가 Postgres/Redis 없이 돌아야 함 — D9의 "import 시 외부 의존 금지" 정신).
- 로컬 개발: docker-compose(Postgres + Redis) — walking skeleton 단계부터.

### 2. 코어는 여전히 stateless

요청 처리 코어(어댑터·재타게팅·정책 평가)는 상태를 갖지 않는다. 상태 계층은 인터페이스 뒤의 별도 서비스이며, 코어는 수평 확장 가능해야 한다.

### 3. 프로바이더 서버측 상태의 게이트웨이 관리형 수명 관리 (v1)

사용자 결정: passthrough+고지가 아니라 v1부터 관리형.

- 클라이언트가 opt-in으로 서버측 상태(OpenAI `store`/`conversation`, Anthropic `container`, xAI `store`)를 생성하면 게이트웨이가 **리소스 레지스트리에 등록**: {테넌트, 프로바이더, 리소스 타입, 외부 id, TTL, 생성 시각, 생성 가상 키}.
- **테넌트 격리**: 다른 테넌트가 등록된 리소스 id를 참조하는 요청은 차단 (providerOptions에 실려 오는 외부 id를 레지스트리 대조).
- **수명**: TTL 만료 시 프로바이더 삭제 API 호출(제공되는 경우 — OpenAI responses/conversation delete, xAI responses delete), 삭제 API가 없는 리소스는 참조 차단으로 대체하고 한계를 문서화. 테넌트 데이터 삭제 요청 시 일괄 삭제 대행.
- 미등록 외부 id의 인입(게이트웨이 밖에서 만든 리소스)은 기본 거부, 테넌트 설정으로 허용 가능(그 경우 관리 대상 아님을 warning).
- **타깃 프로바이더 교체 시**: 레지스트리는 무동작(TTL 유지 — 클라이언트가 원 프로바이더로 돌아올 수 있음). 히스토리/PO의 서버 상태 참조가 타깃과 불일치하면 재타게팅 패스가 드롭 + `warning(server-state-inapplicable)` 처리한다 — 조용한 무시 금지 (ir-v0 §13.3, D5 원칙).

## 결과

- walking skeleton(로드맵 3)에 docker-compose + 스토리지 인터페이스 + Postgres/Redis 구현체가 포함된다.
- 서버 상태 레지스트리는 providerOptions 검증 경로에 훅으로 연결 (어댑터 수정 없이 정책 레이어에서).
- 재검토 트리거: 멀티리전 배포 시 Postgres 복제/파티셔닝 전략, Redis 클러스터링.
