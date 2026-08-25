import type {
  AccountStore,
  BatchJob,
  BatchStore,
  BodyLogEntry,
  BodyLogSink,
  FileMapping,
  FileStore,
  KeyStore,
  LedgerRow,
  PortalAccount,
  PortalSessionRecord,
  PortalSessionStore,
  ProviderKeyStore,
  QueryableLedger,
  ResourceStore,
  ServerResource,
  SessionPersistence,
  TenantProviderKey,
  UsageAggregate,
  VirtualKey,
} from "./types.js";

// 인메모리 구현체 — 단위 테스트·상태 계층 미설정 시 폴백 (ADR-0006 §1)

export class InMemoryLedger implements QueryableLedger {
  readonly rows: LedgerRow[] = [];
  async record(row: LedgerRow): Promise<void> {
    this.rows.push(row);
  }
  async aggregate(opts: {
    from: string;
    to: string;
    groupBy: "model" | "provider" | "keyId" | "tenant";
    tenant?: string;
  }): Promise<UsageAggregate[]> {
    const groups = new Map<string, UsageAggregate>();
    for (const r of this.rows) {
      if (r.createdAt < opts.from || r.createdAt > opts.to) continue;
      if (opts.tenant !== undefined && r.tenant !== opts.tenant) continue;
      const group = String(r[opts.groupBy] ?? "(none)");
      const agg = groups.get(group) ?? { group, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
      agg.requests += 1;
      agg.inputTokens += r.usage?.input.total ?? 0;
      agg.outputTokens += r.usage?.output.total ?? 0;
      agg.totalTokens += r.usage?.totalTokens ?? 0;
      agg.costUsd += r.costUsd ?? 0;
      groups.set(group, agg);
    }
    return [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
  }
}

export class InMemoryKeyStore implements KeyStore {
  private readonly keys = new Map<string, VirtualKey>();
  async put(key: VirtualKey): Promise<void> {
    this.keys.set(key.keyId, key);
  }
  async getByHash(keyHash: string): Promise<VirtualKey | null> {
    return [...this.keys.values()].find((k) => k.keyHash === keyHash) ?? null;
  }
  async get(keyId: string): Promise<VirtualKey | null> {
    return this.keys.get(keyId) ?? null;
  }
  async list(): Promise<VirtualKey[]> {
    return [...this.keys.values()];
  }
}

export class InMemoryProviderKeyStore implements ProviderKeyStore {
  private readonly keys = new Map<string, TenantProviderKey>();
  async put(key: TenantProviderKey): Promise<void> {
    this.keys.set(`${key.tenant}/${key.provider}`, key);
  }
  async get(tenant: string, provider: string): Promise<TenantProviderKey | null> {
    return this.keys.get(`${tenant}/${provider}`) ?? null;
  }
  async delete(tenant: string, provider: string): Promise<void> {
    this.keys.delete(`${tenant}/${provider}`);
  }
}

export class InMemoryResourceStore implements ResourceStore {
  private readonly resources = new Map<string, ServerResource>();
  private key(provider: string, type: string, id: string): string {
    return `${provider}/${type}/${id}`;
  }
  async register(r: ServerResource): Promise<void> {
    this.resources.set(this.key(r.provider, r.resourceType, r.externalId), r);
  }
  async ownerOf(provider: string, resourceType: string, externalId: string): Promise<string | null> {
    return this.resources.get(this.key(provider, resourceType, externalId))?.tenant ?? null;
  }
  async listExpired(nowIso: string): Promise<ServerResource[]> {
    return [...this.resources.values()].filter((r) => r.expiresAt !== undefined && r.expiresAt <= nowIso);
  }
  async delete(provider: string, resourceType: string, externalId: string): Promise<void> {
    this.resources.delete(this.key(provider, resourceType, externalId));
  }
}

export class InMemoryBodyLog implements BodyLogSink {
  readonly entries: BodyLogEntry[] = [];
  async record(entry: BodyLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class InMemorySessionPersistence implements SessionPersistence {
  private readonly events = new Map<string, string[]>();

  async appendEvent(sessionId: string, _seq: number, json: string): Promise<void> {
    const list = this.events.get(sessionId) ?? [];
    list.push(json);
    this.events.set(sessionId, list);
  }

  async loadEvents(sessionId: string, afterSeq: number): Promise<string[] | null> {
    const list = this.events.get(sessionId);
    if (!list) return null;
    return list.slice(Math.max(0, afterSeq + 1)); // seq == index (세션 단일 스탬퍼 불변식)
  }

  async markEnded(sessionId: string, ttlSeconds: number): Promise<void> {
    const timer = setTimeout(() => this.events.delete(sessionId), ttlSeconds * 1000);
    timer.unref?.();
  }

  async invalidate(sessionId: string): Promise<void> {
    this.events.delete(sessionId);
  }
}

export class InMemoryAccountStore implements AccountStore {
  private readonly byEmail = new Map<string, PortalAccount>();
  private readonly byId = new Map<string, PortalAccount>();
  async create(account: PortalAccount): Promise<boolean> {
    if (this.byEmail.has(account.email)) return false;
    this.byEmail.set(account.email, account);
    this.byId.set(account.accountId, account);
    return true;
  }
  async getByEmail(email: string): Promise<PortalAccount | null> {
    return this.byEmail.get(email) ?? null;
  }
  async get(accountId: string): Promise<PortalAccount | null> {
    return this.byId.get(accountId) ?? null;
  }
}

export class InMemoryPortalSessionStore implements PortalSessionStore {
  private readonly sessions = new Map<string, PortalSessionRecord>();
  async put(session: PortalSessionRecord): Promise<void> {
    this.sessions.set(session.tokenHash, session);
  }
  async get(tokenHash: string): Promise<PortalSessionRecord | null> {
    return this.sessions.get(tokenHash) ?? null;
  }
  async delete(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
  async deleteExpired(nowIso: string): Promise<number> {
    let purged = 0;
    for (const [hash, s] of this.sessions) if (s.expiresAt <= nowIso) { this.sessions.delete(hash); purged += 1; }
    return purged;
  }
}

export class InMemoryFileStore implements FileStore {
  private readonly files = new Map<string, FileMapping>(); // key: tenant/gwf

  async put(mapping: FileMapping): Promise<void> {
    this.files.set(`${mapping.tenant}/${mapping.gatewayFileId}`, mapping);
  }
  async get(tenant: string, gatewayFileId: string): Promise<FileMapping | null> {
    return this.files.get(`${tenant}/${gatewayFileId}`) ?? null;
  }
  async delete(tenant: string, gatewayFileId: string): Promise<void> {
    this.files.delete(`${tenant}/${gatewayFileId}`);
  }
  async list(tenant: string): Promise<FileMapping[]> {
    return [...this.files.values()].filter((f) => f.tenant === tenant);
  }
}

export class InMemoryBatchStore implements BatchStore {
  private readonly jobs = new Map<string, BatchJob>();

  async put(job: BatchJob): Promise<void> {
    this.jobs.set(`${job.tenant}/${job.gatewayBatchId}`, job);
  }
  async get(tenant: string, gatewayBatchId: string): Promise<BatchJob | null> {
    return this.jobs.get(`${tenant}/${gatewayBatchId}`) ?? null;
  }
  async list(tenant: string): Promise<BatchJob[]> {
    return [...this.jobs.values()].filter((j) => j.tenant === tenant);
  }
  async claimBridgeFlag(tenant: string, gatewayBatchId: string, flag: string): Promise<boolean> {
    // 단일 프로세스 — Map 동기 접근이라 check-and-set이 원자적
    const key = `${tenant}/${gatewayBatchId}`;
    const job = this.jobs.get(key);
    if (!job || job.bridgeState?.[flag] === "true") return false;
    this.jobs.set(key, { ...job, bridgeState: { ...(job.bridgeState ?? {}), [flag]: "true" } });
    return true;
  }
}
