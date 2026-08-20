# AI Gateway — 작업 규칙

## 문서가 진실이다

- 설계의 단일 진실: [docs/README.md](docs/README.md)(로드맵) → [docs/decisions/](docs/decisions/)(ADR) → [docs/specs/ir-v0.md](docs/specs/ir-v0.md)(IR 스펙 — zod 구현의 원본, 불일치 시 문서 우선).
- 구현 중 스펙 결함 발견 시: 코드를 우회하지 말고 **문서 수정 + [docs/problems/problem-log.md](docs/problems/problem-log.md) 기록**을 먼저.
- 새 규칙/기능 추가 시 [폴백 경합 매트릭스](docs/decisions/fallback-interaction-matrix.md)와 교차 발화 여부를 확인.

## 코드 규칙 (ADR에서 파생)

- **코어에 프로바이더 분기문 금지** — `if (provider === ...)`가 코어에 생기면 어댑터 인터페이스에 속성이 빠진 것 (D4).
- 조용한 변조 금지 — 드롭/클램프/강등은 반드시 warning (코드명은 ir-v0 §5의 표준 코드만 사용) (D5).
- 어댑터는 순수 변환 함수 + 타입드 스트림 상태 머신. 요청/응답 양방향 zod 검증 (D4).
- 직렬화는 결정론적 — 같은 IR → 바이트 동일 JSON (D10). 스키마 필드 정의 순서 = wire 키 순서.
- import 시 네트워크/외부 의존 금지. 테스트는 픽스처만 사용, 라이브 API는 opt-in (D9).
- 골든셋이 어댑터의 완성 정의: 요청 방향·응답(SSE 재생)·인바운드 재합성·크로스 왕복 4종 (D9).

## 환경

- pnpm 사용 (로컬: `~/.local/bin/pnpm`). Node 로컬 v20.17 (프로덕션 타깃 22).
- 시크릿은 `.env` (gitignore됨) — 코드·커밋·픽스처에 키 절대 금지. 픽스처는 새니타이저 통과 후 저장.
- 상태 계층: docker-compose (Postgres+Redis). 커밋/푸시는 사용자가 요청할 때만.
