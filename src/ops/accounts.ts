import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

// 포털 계정 인증 프리미티브 (2026-08-24).
// 시크릿 취급은 저장소 전반의 기존 원칙과 동일선상: 비밀번호는 scrypt 해시만,
// 세션 토큰은 sha256 해시만 저장 (가상 키 keyHash와 같은 규칙 — 유출 시 원문 미노출).

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** 형식: s1:<salt hex>:<hash hex> — 버전 접두로 파라미터 교체 여지를 남긴다 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `s1:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, saltHex, hashHex] = stored.split(":");
  if (version !== "s1" || !saltHex || !hashHex) return false;
  const key = await scrypt(password, Buffer.from(saltHex, "hex"));
  const expected = Buffer.from(hashHex, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/**
 * 계정 부재 시에도 로그인 경로가 같은 비용을 치르게 하는 더미 검증 —
 * "이메일 존재 여부"가 응답 시간으로 새는 것을 줄인다 (메시지도 동일하게: 자격증명 불일치).
 */
let dummyHash: Promise<string> | undefined;
export async function burnVerifyTiming(): Promise<void> {
  dummyHash ??= hashPassword("timing-equalizer");
  await verifyPassword("definitely-not-it", await dummyHash);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = `pses_${randomBytes(24).toString("hex")}`;
  return { token, tokenHash: hashSessionToken(token) };
}

export function newAccountId(): string {
  return `acc_${randomBytes(9).toString("hex")}`;
}
