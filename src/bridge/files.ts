import type { JSONValue } from "../ir/json.js";
import type { Warning } from "../ir/common.js";
import type { IRRequest } from "../ir/request.js";
import type { Message } from "../ir/message.js";
import type { Block } from "../ir/blocks.js";
import type { FileMapping, FileStore } from "../state/types.js";
import { credentialHeaders, genRequestId, type ExecuteDeps } from "../gateway/execute.js";
import { GatewayError, irError } from "../gateway/errors.js";
import { getProvider } from "../gateway/registry.js";

// Files 브리지 (부록 (b) §2) — 게이트웨이 파일 id(gwf_) ↔ 프로바이더 파일 참조 매핑.
// 프로바이더별 업로드 wire 차이는 데이터 테이블 (D4 — 코어 분기문 금지).
// v1 테넌트는 "default" 고정 — 가상 키(운영 평면) 도입 시 실테넌트로 치환되는 좌석.

export const DEFAULT_TENANT = "default";

export interface FileBridgeDeps extends ExecuteDeps {
  files: FileStore;
  /** 미설정 시 "default" — 인증 미들웨어가 실테넌트 공급 (ADR-0007 §3) */
  tenant?: string;
}

export interface UploadInput {
  provider: string;
  data: Uint8Array;
  mediaType: string;
  filename?: string;
}

interface UploadResult {
  providerFileId: string;
  expiresAt?: string;
  raw: JSONValue;
}

interface FileProviderOps {
  upload(input: UploadInput, baseUrl: string, auth: Record<string, string>, fetchImpl: typeof fetch): Promise<UploadResult>;
  remove(providerFileId: string, baseUrl: string, auth: Record<string, string>, fetchImpl: typeof fetch): Promise<void>;
}

async function readJsonOrThrow(provider: string, res: Response, action: string): Promise<Record<string, unknown>> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GatewayError({
      category: res.status === 401 ? "auth" : res.status === 404 ? "not_found" : "provider_error",
      httpStatus: res.status,
      message: `${provider} 파일 ${action} 실패 (HTTP ${res.status})`,
      fallbackEligible: false,
      billed: false,
      provider: { key: provider, status: res.status, raw: body.slice(0, 2000) },
    });
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** 프로바이더 구성 데이터 테이블 — xai는 참조 wire 세부 미확보로 v1 제외 (부록 (b) §2) */
const FILE_PROVIDERS: Record<string, FileProviderOps> = {
  anthropic: {
    async upload(input, baseUrl, auth, fetchImpl) {
      const form = new FormData();
      form.append("file", new Blob([input.data], { type: input.mediaType }), input.filename ?? "upload.bin");
      const res = await fetchImpl(`${baseUrl}/v1/files`, {
        method: "POST",
        headers: { ...auth, "anthropic-version": "2023-06-01", "anthropic-beta": "files-api-2025-04-14" },
        body: form,
      });
      const body = await readJsonOrThrow("anthropic", res, "업로드");
      return { providerFileId: String(body["id"] ?? ""), raw: body as JSONValue };
    },
    async remove(providerFileId, baseUrl, auth, fetchImpl) {
      const res = await fetchImpl(`${baseUrl}/v1/files/${providerFileId}`, {
        method: "DELETE",
        headers: { ...auth, "anthropic-version": "2023-06-01", "anthropic-beta": "files-api-2025-04-14" },
      });
      await readJsonOrThrow("anthropic", res, "삭제");
    },
  },
  openai: {
    async upload(input, baseUrl, auth, fetchImpl) {
      const form = new FormData();
      form.append("purpose", "user_data");
      form.append("file", new Blob([input.data], { type: input.mediaType }), input.filename ?? "upload.bin");
      const res = await fetchImpl(`${baseUrl}/v1/files`, { method: "POST", headers: auth, body: form });
      const body = await readJsonOrThrow("openai", res, "업로드");
      const expires = body["expires_at"];
      return {
        providerFileId: String(body["id"] ?? ""),
        ...(typeof expires === "number" ? { expiresAt: new Date(expires * 1000).toISOString() } : {}),
        raw: body as JSONValue,
      };
    },
    async remove(providerFileId, baseUrl, auth, fetchImpl) {
      const res = await fetchImpl(`${baseUrl}/v1/files/${providerFileId}`, { method: "DELETE", headers: auth });
      await readJsonOrThrow("openai", res, "삭제");
    },
  },
  google: {
    // resumable 프로토콜 2단계 (인벤토리 A-2) — start로 업로드 URL 수령 → bytes 업로드+finalize
    async upload(input, baseUrl, auth, fetchImpl) {
      const start = await fetchImpl(`${baseUrl}/upload/v1beta/files`, {
        method: "POST",
        headers: {
          ...auth,
          "content-type": "application/json",
          "x-goog-upload-protocol": "resumable",
          "x-goog-upload-command": "start",
          "x-goog-upload-header-content-length": String(input.data.byteLength),
          "x-goog-upload-header-content-type": input.mediaType,
        },
        body: JSON.stringify({ file: { displayName: input.filename ?? "upload.bin" } }),
      });
      if (!start.ok) await readJsonOrThrow("google", start, "업로드 시작");
      const uploadUrl = start.headers.get("x-goog-upload-url");
      if (!uploadUrl) {
        throw new GatewayError(irError("provider_error", 502, "google resumable 업로드 URL 미수신"));
      }
      const fin = await fetchImpl(uploadUrl, {
        method: "POST",
        headers: {
          ...auth,
          "x-goog-upload-command": "upload, finalize",
          "x-goog-upload-offset": "0",
        },
        body: input.data,
      });
      const body = await readJsonOrThrow("google", fin, "업로드 완료");
      const file = (body["file"] ?? {}) as Record<string, unknown>;
      return {
        providerFileId: String(file["uri"] ?? file["name"] ?? ""),
        ...(typeof file["expirationTime"] === "string" ? { expiresAt: file["expirationTime"] } : {}),
        raw: body as JSONValue,
      };
    },
    async remove(providerFileId, baseUrl, auth, fetchImpl) {
      // providerFileId는 fileUri(https://.../v1beta/files/{id}) 또는 files/{id} — name 세그먼트 추출
      const name = providerFileId.includes("/files/")
        ? `files/${providerFileId.split("/files/")[1]}`
        : providerFileId;
      const res = await fetchImpl(`${baseUrl}/v1beta/${name}`, { method: "DELETE", headers: auth });
      await readJsonOrThrow("google", res, "삭제");
    },
  },
};

function providerOps(provider: string): FileProviderOps {
  const ops = FILE_PROVIDERS[provider];
  if (!ops) {
    throw new GatewayError({
      category: "invalid_request",
      httpStatus: 501,
      message: `${provider}는 Files 브리지 미지원 — 지원: ${Object.keys(FILE_PROVIDERS).join("·")} (부록 (b) §2)`,
      fallbackEligible: false,
      billed: false,
      provider: { key: provider, code: "files-unsupported" },
    });
  }
  return ops;
}

export interface GatewayFileEnvelope {
  id: string;
  provider: string;
  providerFileId: string;
  mediaType: string;
  sizeBytes: number;
  filename?: string;
  createdAt: string;
  expiresAt?: string;
}

function toEnvelope(m: FileMapping): GatewayFileEnvelope {
  return {
    id: m.gatewayFileId,
    provider: m.provider,
    providerFileId: m.providerFileId,
    mediaType: m.mediaType,
    sizeBytes: m.sizeBytes,
    ...(m.filename ? { filename: m.filename } : {}),
    createdAt: m.createdAt,
    ...(m.expiresAt ? { expiresAt: m.expiresAt } : {}),
  };
}

export async function uploadFile(input: UploadInput, deps: FileBridgeDeps): Promise<GatewayFileEnvelope> {
  const ops = providerOps(input.provider);
  const rt = getProvider(input.provider);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const result = await ops.upload(input, rt.baseUrl, credentialHeaders(rt), fetchImpl);
  if (!result.providerFileId) {
    throw new GatewayError(irError("provider_error", 502, `${input.provider} 업로드 응답에 파일 id 없음`));
  }
  const mapping: FileMapping = {
    gatewayFileId: `gwf_${genRequestId(deps).slice(4)}`,
    tenant: deps.tenant ?? DEFAULT_TENANT,
    provider: input.provider,
    providerFileId: result.providerFileId,
    mediaType: input.mediaType,
    sizeBytes: input.data.byteLength,
    ...(input.filename ? { filename: input.filename } : {}),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
  };
  await deps.files.put(mapping);
  return toEnvelope(mapping);
}

export async function getFile(gatewayFileId: string, deps: FileBridgeDeps): Promise<GatewayFileEnvelope> {
  const m = await deps.files.get(deps.tenant ?? DEFAULT_TENANT, gatewayFileId);
  if (!m) throw new GatewayError(irError("not_found", 404, `파일 없음: ${gatewayFileId}`));
  return toEnvelope(m);
}

export async function listFiles(deps: FileBridgeDeps): Promise<GatewayFileEnvelope[]> {
  return (await deps.files.list(deps.tenant ?? DEFAULT_TENANT)).map(toEnvelope);
}

export async function deleteFile(gatewayFileId: string, deps: FileBridgeDeps): Promise<void> {
  const m = await deps.files.get(deps.tenant ?? DEFAULT_TENANT, gatewayFileId);
  if (!m) throw new GatewayError(irError("not_found", 404, `파일 없음: ${gatewayFileId}`));
  const ops = providerOps(m.provider);
  const rt = getProvider(m.provider);
  await ops.remove(m.providerFileId, rt.baseUrl, credentialHeaders(rt), deps.fetchImpl ?? fetch);
  await deps.files.delete(deps.tenant ?? DEFAULT_TENANT, gatewayFileId);
}

/**
 * IR file 블록의 `refs.gateway`(gwf id)를 타깃 프로바이더 파일 id로 치환 (부록 (b) §2).
 * 타깃 프로바이더 매핑이 없으면 D6-8 규칙 — 명시적 4xx. 비변조(깊은 경로 복사).
 */
export async function resolveGatewayFileRefs(
  req: IRRequest,
  targetProvider: string,
  store: FileStore | undefined,
  tenant: string = DEFAULT_TENANT,
): Promise<{ request: IRRequest; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  let changed = false;

  async function resolveBlock(block: Block, path: string): Promise<Block> {
    if (block.type !== "file" || block.data.type !== "reference") return block;
    const gwfId = block.data.refs["gateway"];
    if (typeof gwfId !== "string" || gwfId.length === 0) return block;
    if (!store) {
      throw new GatewayError(
        irError("invalid_request", 400, `refs.gateway 참조가 있으나 파일 스토어 미설정 (${path})`),
      );
    }
    const m = await store.get(tenant, gwfId);
    if (!m) throw new GatewayError(irError("not_found", 404, `파일 없음: ${gwfId} (${path})`));
    if (m.provider !== targetProvider) {
      // D6-8 — 타깃 불일치 reference는 조용한 드롭 대신 명시적 실패 (재업로드 안내)
      throw new GatewayError(
        irError(
          "invalid_request",
          400,
          `${gwfId}는 ${m.provider}에 업로드된 파일 — 타깃 ${targetProvider}에서 사용 불가. 해당 프로바이더로 재업로드 필요 (D6-8)`,
        ),
      );
    }
    changed = true;
    const { gateway: _gw, ...rest } = block.data.refs;
    return { ...block, data: { type: "reference", refs: { ...rest, [targetProvider]: m.providerFileId } } };
  }

  const messages: Message[] = [];
  for (const [mi, msg] of req.messages.entries()) {
    const blocks: Block[] = [];
    for (const [bi, b] of msg.blocks.entries()) {
      blocks.push(await resolveBlock(b, `messages[${mi}].blocks[${bi}]`));
    }
    messages.push({ ...msg, blocks });
  }
  if (!changed) return { request: req, warnings };
  return { request: { ...req, messages }, warnings };
}
