import type { Usage } from "../ir/usage.js";

// 상태 계층 인터페이스 (ADR-0006 §1) — 코어는 stateless, 상태는 인터페이스 뒤.
// 인메모리 구현으로 테스트가 Postgres/Redis 없이 돈다 (D9).

/** usage/billing 원장 행 — append-only, 시도별 1행 (ADR-0005 다중 시도 회계 / ADR-0007) */
export interface LedgerRow {
  requestId: string;
  attempt: number; // 1부터 — 리트라이 시 증가
  provider: string;
  model: string;
  surface: string;
  stream: boolean;
  outcome: "success" | "error" | "canceled";
  httpStatus?: number;
  finishReason?: string;
  errorCategory?: string;
  usage?: Usage;
  billed: boolean;
  /** 리트라이 행은 해당 시도 소요, 최종(성공/터미널) 행은 요청 총 소요 */
  durationMs: number;
  createdAt: string; // ISO
  // ── 운영 평면 (ADR-0007 — 2026-08-21) ──
  tenant?: string;
  keyId?: string; // 가상 키 (gwk_)
  keySource?: "byo" | "pool"; // 정산 분리 기준 (ADR-0007 결과 절)
  costUsd?: number; // 가격표 근사 (raw usage 보존으로 재계산 가능)
}

export interface UsageLedger {
  /** append-only. 실패해도 요청 처리를 막지 않는다 — 호출측이 로그로 강등 */
  record(row: LedgerRow): Promise<void>;
}

/** 정산 리포트용 집계 (ADR-0007 §4) — 확정 원장 기준 멱등 */
export interface UsageAggregate {
  group: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface QueryableLedger extends UsageLedger {
  aggregate(opts: {
    from: string;
    to: string;
    groupBy: "model" | "provider" | "keyId" | "tenant";
    tenant?: string;
  }): Promise<UsageAggregate[]>;
}

// ── 가상 키·테넌트 (ADR-0007 §3, ADR-0001 하이브리드) ──

export interface VirtualKey {
  keyId: string; // gwk_...
  tenant: string;
  name?: string;
  /** 시크릿의 sha256 hex — 시크릿 원문은 발급 응답에 1회만 노출, 저장 금지 */
  keyHash: string;
  disabled?: boolean;
  /** 기간 예산 (USD) — soft: 경고, hard: 다음 요청 차단 (§10.4) */
  budget?: { periodDays: number; softUsd?: number; hardUsd?: number };
  /** 요청 빈도 한도 — 예산이 못 막는 순간 폭주 방어 (리뷰 2026-08-22 #14). 미설정 = 무제한 */
  rateLimit?: { requestsPerMinute: number };
  /** 본문 로그 opt-out (ADR-0008 — 기본 on) */
  bodyLogOptOut?: boolean;
  createdAt: string;
}

export interface KeyStore {
  put(key: VirtualKey): Promise<void>;
  getByHash(keyHash: string): Promise<VirtualKey | null>;
  get(keyId: string): Promise<VirtualKey | null>;
  list(): Promise<VirtualKey[]>;
}

/** 테넌트 BYO 프로바이더 키 (사용자 결정 D2 — DB 암호화 저장. AES-256-GCM, 마스터 키는 env) */
export interface TenantProviderKey {
  tenant: string;
  provider: string;
  /** AES-256-GCM 암호문 (iv:tag:data base64) — 평문 저장 금지 */
  encryptedKey: string;
  createdAt: string;
}

export interface ProviderKeyStore {
  put(key: TenantProviderKey): Promise<void>;
  get(tenant: string, provider: string): Promise<TenantProviderKey | null>;
  delete(tenant: string, provider: string): Promise<void>;
}

// ── 서버 상태 리소스 레지스트리 (ADR-0006 §3) ──

export interface ServerResource {
  tenant: string;
  provider: string;
  resourceType: string; // container | previousResponseId | conversation | cachedContent ...
  externalId: string;
  createdAt: string;
  expiresAt?: string;
  createdByKeyId?: string;
}

export interface ResourceStore {
  register(r: ServerResource): Promise<void>;
  /** 소유 테넌트 반환 — 미등록은 null */
  ownerOf(provider: string, resourceType: string, externalId: string): Promise<string | null>;
  listExpired(nowIso: string): Promise<ServerResource[]>;
  delete(provider: string, resourceType: string, externalId: string): Promise<void>;
}

// ── 본문 로그 (ADR-0008 — 기본 on, 테넌트 opt-out) ──

export interface BodyLogEntry {
  requestId: string;
  tenant?: string;
  direction: "request" | "response";
  body: unknown; // groundingMetadata 제외 처리 후 (TOS)
  createdAt: string;
}

export interface BodyLogSink {
  record(entry: BodyLogEntry): Promise<void>;
  /**
   * 보관 기간 초과분 삭제 — 삭제 행 수 반환 (리뷰 2026-08-22 #11).
   * 본문 로그는 기본 on이라 정리 수단이 없으면 디스크가 선형 증가하고, 개인정보 삭제
   * 요청에 대응할 방법도 없다. 구현 없는 sink(인메모리 등)는 생략 가능.
   */
  deleteOlderThan?(iso: string): Promise<number>;
}

/**
 * 스트림 재개 버퍼의 프로세스 외 영속화 (ADR-0005/0006 — Redis).
 * v0 계약: write-through(인메모리가 fast path), 프로세스 재시작 후 재개는 **재생 전용**
 * (라이브 테일 없음 — grace 초과 후와 동일 의미론). 크로스노드 cancel은 problem log 예고 참조.
 */
export interface SessionPersistence {
  appendEvent(sessionId: string, seq: number, json: string): Promise<void>;
  /** afterSeq 이후 이벤트 json 배열. 미지/만료 세션은 null */
  loadEvents(sessionId: string, afterSeq: number): Promise<string[] | null>;
  /** 종료 시점 — TTL 시작 */
  markEnded(sessionId: string, ttlSeconds: number): Promise<void>;
  /** 버퍼 무효화 — append 실패로 seq↔index 정렬이 깨졌을 때 (틀린 재생 대신 410, 리뷰 F9-r4) */
  invalidate(sessionId: string): Promise<void>;
}

/**
 * 스트림 취소의 크로스노드 전파 (ADR-0001 D7 "취소 전파 1급 요구사항").
 * 세션 객체는 소유 레플리카의 메모리에만 있으므로, 다른 파드로 들어온 취소 요청은
 * 브로드캐스트해야 도달한다 (리뷰 2026-08-22 #12: 없으면 업스트림이 계속 과금된다).
 * 수신 측은 **반드시 로컬 세션의 소유 테넌트를 대조**한 뒤 취소해야 한다 — 메시지의
 * tenant는 발신자 주장일 뿐이고, 권한 판정은 세션을 가진 쪽만 할 수 있다.
 */
export interface StreamControl {
  /** 취소 요청 전파 — 소유 레플리카가 없으면 아무 일도 일어나지 않는다 (at-most-once) */
  requestCancel(sessionId: string, tenant: string | undefined): Promise<void>;
  /** 구독 시작. handler는 자기가 소유한 세션만 처리한다 */
  subscribe(handler: (sessionId: string, tenant: string | undefined) => void): Promise<void>;
  close(): Promise<void>;
}

// ── 셀프 가입 포털 (2026-08-24) — 계정 = 테넌트 1:1 ─────────────

export interface PortalAccount {
  accountId: string; // acc_...
  email: string; // 소문자 정규화 저장
  /** scrypt (s1:salt:hash) — 평문·복호 가능 형태 저장 금지 */
  passwordHash: string;
  /** 이 계정의 리소스 스코프 — 가상 키·BYO·원장 귀속이 전부 이 값으로 격리된다 */
  tenant: string;
  disabled?: boolean;
  createdAt: string;
}

export interface AccountStore {
  /** 생성. 이메일 중복이면 false (경합 안전 — 유니크 제약이 진실) */
  create(account: PortalAccount): Promise<boolean>;
  getByEmail(email: string): Promise<PortalAccount | null>;
  get(accountId: string): Promise<PortalAccount | null>;
}

/** 포털 세션 — 토큰 원문은 쿠키에만, 저장은 sha256 해시 (가상 키와 동일 원칙) */
export interface PortalSessionRecord {
  tokenHash: string;
  accountId: string;
  expiresAt: string;
  createdAt: string;
}

export interface PortalSessionStore {
  put(session: PortalSessionRecord): Promise<void>;
  get(tokenHash: string): Promise<PortalSessionRecord | null>;
  delete(tokenHash: string): Promise<void>;
  /** 만료분 정리 (관리 스윕이 호출) — 삭제 행 수 반환 */
  deleteExpired?(nowIso: string): Promise<number>;
}

/** 게이트웨이 파일 매핑 (부록 (b) §2, ADR-0006 §1 — 테넌트 격리 포함) */
export interface FileMapping {
  gatewayFileId: string; // gwf_...
  tenant: string; // v1: "default" — 가상 키 도입(운영 평면) 시 실테넌트로
  provider: string;
  providerFileId: string; // anthropic/openai file id, google fileUri
  mediaType: string;
  sizeBytes: number;
  filename?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface FileStore {
  put(mapping: FileMapping): Promise<void>;
  /** 타 테넌트 id는 null (존재 노출 금지 — 부록 (b) §2) */
  get(tenant: string, gatewayFileId: string): Promise<FileMapping | null>;
  delete(tenant: string, gatewayFileId: string): Promise<void>;
  list(tenant: string): Promise<FileMapping[]>;
}

/** 배치 잡 레코드 (부록 (b) §3.3) */
export interface BatchJob {
  gatewayBatchId: string; // gwb_...
  tenant: string;
  provider: string;
  providerBatchId: string;
  /** openai: 입력/출력 파일 id 등 브리지 부속 상태 */
  bridgeState?: Record<string, string>;
  status: string; // 정규화 상태 (부록 (b) §3.3)
  rawStatus?: string;
  counts: { total: number; succeeded: number; errored: number; canceled: number; expired: number };
  /** customId → 요청 모델 (결과 정규화 시 어댑터 ctx 공급용) */
  itemModels: Record<string, string>;
  createdAt: string;
  expiresAt?: string;
}

export interface BatchStore {
  put(job: BatchJob): Promise<void>;
  get(tenant: string, gatewayBatchId: string): Promise<BatchJob | null>;
  list(tenant: string): Promise<BatchJob[]>;
  /**
   * bridgeState[flag]="true" 원자적 test-and-set — 이미 true면 false 반환.
   * 배치 원장 적재의 1회 보장 (감사 2026-08-24 #36: 동시 결과 조회 2건이 원장 2배 적재)
   */
  claimBridgeFlag(tenant: string, gatewayBatchId: string, flag: string): Promise<boolean>;
}
