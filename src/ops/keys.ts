import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { KeyStore, ProviderKeyStore, VirtualKey } from "../state/types.js";
import { GatewayError, irError } from "../gateway/errors.js";
import type { ProviderRuntime } from "../gateway/registry.js";
import { credentialHeaders } from "../gateway/execute.js";

// 가상 키·BYO 프로바이더 키 (운영 평면 — ADR-0007 §3, 사용자 결정 D1/D2 2026-08-21).
// 가상 키 시크릿은 발급 응답에 1회만 노출, 저장은 sha256 해시만.
// BYO 키는 AES-256-GCM 암호화 저장 — 마스터 키는 env GATEWAY_KEY_ENCRYPTION_KEY (KMS는 2차).

export function hashKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export interface IssuedKey {
  key: VirtualKey;
  /** 1회 노출 시크릿 — 응답 후 게이트웨이는 해시만 보유 */
  secret: string;
}

export async function issueVirtualKey(
  store: KeyStore,
  input: { tenant: string; name?: string; budget?: VirtualKey["budget"]; bodyLogOptOut?: boolean },
  now: () => Date = () => new Date(),
): Promise<IssuedKey> {
  const secret = `gwk_${randomBytes(24).toString("hex")}`;
  const key: VirtualKey = {
    keyId: `gwkid_${randomBytes(8).toString("hex")}`,
    tenant: input.tenant,
    ...(input.name ? { name: input.name } : {}),
    keyHash: hashKey(secret),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.bodyLogOptOut ? { bodyLogOptOut: true } : {}),
    createdAt: now().toISOString(),
  };
  await store.put(key);
  return { key, secret };
}

export async function verifyVirtualKey(store: KeyStore, secret: string): Promise<VirtualKey> {
  const key = await store.getByHash(hashKey(secret));
  if (!key || key.disabled) {
    throw new GatewayError(irError("auth", 401, "유효하지 않은 가상 키"));
  }
  return key;
}

// ── BYO 키 암호화 (AES-256-GCM) ─────────────────────────────

function masterKey(): Buffer {
  const raw = process.env["GATEWAY_KEY_ENCRYPTION_KEY"];
  if (!raw) {
    throw new GatewayError(
      irError("invalid_request", 501, "GATEWAY_KEY_ENCRYPTION_KEY 미설정 — BYO 키 저장 불가 (32바이트 hex/base64)", {
        gatewayException: false,
      }),
    );
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new GatewayError(irError("invalid_request", 500, "GATEWAY_KEY_ENCRYPTION_KEY는 32바이트여야 합니다", { gatewayException: true }));
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(encrypted: string): string {
  const [ivB64, tagB64, ctB64] = encrypted.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new GatewayError(irError("gateway_error", 500, "BYO 키 암호문 형식 오류", { gatewayException: true }));
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/**
 * 자격증명 결정자 (ADR-0001 하이브리드): 테넌트 BYO 키 우선, 없으면 env 풀 키.
 * 반환 resolver는 execute deps.credentials 슬롯에 주입된다. keySource는 원장 정산 분리 기준.
 */
export function tenantCredentialResolver(
  tenant: string,
  providerKeys: ProviderKeyStore | undefined,
): {
  credentials: (rt: ProviderRuntime) => Promise<Record<string, string>>;
  sourceFor: (provider: string) => Promise<"byo" | "pool">;
} {
  const cache = new Map<string, string | null>(); // provider → 복호화 키 (요청 스코프)
  async function byoKey(provider: string): Promise<string | null> {
    if (!providerKeys) return null;
    if (!cache.has(provider)) {
      const rec = await providerKeys.get(tenant, provider);
      cache.set(provider, rec ? decryptSecret(rec.encryptedKey) : null);
    }
    return cache.get(provider) ?? null;
  }
  return {
    credentials: async (rt) => {
      const byo = await byoKey(rt.provider);
      if (byo !== null) return { [rt.auth.header]: `${rt.auth.prefix ?? ""}${byo}` };
      return credentialHeaders(rt);
    },
    sourceFor: async (provider) => ((await byoKey(provider)) !== null ? "byo" : "pool"),
  };
}
