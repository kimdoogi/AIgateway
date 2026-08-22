import { beforeAll, describe, expect, it } from "vitest";
import { IRRequestSchema, type IRRequest } from "../ir/index.js";
import { bootstrapProviders } from "../gateway/bootstrap.js";
import { GatewayError } from "../gateway/errors.js";
import { InMemoryFileStore } from "../state/memory.js";
import { deleteFile, resolveGatewayFileRefs, uploadFile } from "./files.js";

// Files 브리지 (부록 (b) §2) — mock fetch + 인메모리 스토어 (D9).

process.env["ANTHROPIC_API_KEY"] = "test-key";
process.env["GEMINI_API_KEY"] = "test-key";
beforeAll(() => bootstrapProviders());

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
}

function mockFetch(responder: (url: string, init?: RequestInit) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> });
    return responder(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const data = new Uint8Array([1, 2, 3]);

describe("Files 브리지", () => {
  it("anthropic 업로드 — 베타 헤더 + 매핑 저장, 삭제는 프로바이더 대행", async () => {
    const files = new InMemoryFileStore();
    const { fetchImpl, calls } = mockFetch(() =>
      new Response(JSON.stringify({ id: "file_abc123", type: "file" }), { status: 200 }),
    );
    const env = await uploadFile(
      { provider: "anthropic", data, mediaType: "application/pdf", filename: "doc.pdf" },
      { files, fetchImpl, genId: () => "req_f1" },
    );
    expect(env.id).toBe("gwf_f1");
    expect(env.providerFileId).toBe("file_abc123");
    expect(calls[0]!.url).toContain("/v1/files");
    expect(calls[0]!.headers["anthropic-beta"]).toContain("files-api");
    expect(await files.get("default", "gwf_f1")).not.toBeNull();

    await deleteFile("gwf_f1", { files, fetchImpl });
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(await files.get("default", "gwf_f1")).toBeNull();
  });

  it("google 업로드 — resumable 2단계 (start 헤더 → finalize)", async () => {
    const files = new InMemoryFileStore();
    const { fetchImpl, calls } = mockFetch((url) => {
      if (url.includes("/upload/v1beta/files")) {
        return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/u1" } });
      }
      return new Response(JSON.stringify({ file: { name: "files/xyz", uri: "https://generativelanguage.googleapis.com/v1beta/files/xyz" } }), { status: 200 });
    });
    const env = await uploadFile(
      { provider: "google", data, mediaType: "video/mp4" },
      { files, fetchImpl, genId: () => "req_f2" },
    );
    expect(env.providerFileId).toContain("/files/xyz");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("https://upload.example/u1");
  });

  it("xai — Files 브리지 미지원 501 (부록 (b) §2)", async () => {
    const files = new InMemoryFileStore();
    await expect(uploadFile({ provider: "xai", data, mediaType: "text/plain" }, { files })).rejects.toSatisfy(
      (err: unknown) => {
        expect((err as GatewayError).irError.httpStatus).toBe(501);
        expect((err as GatewayError).irError.provider?.code).toBe("files-unsupported");
        return true;
      },
    );
  });

  it("refs.gateway 치환 — 타깃 일치 시 프로바이더 id로, 불일치는 D6-8 명시적 400", async () => {
    const files = new InMemoryFileStore();
    await files.put({
      gatewayFileId: "gwf_x",
      tenant: "default",
      provider: "anthropic",
      providerFileId: "file_real",
      mediaType: "application/pdf",
      sizeBytes: 3,
      createdAt: "2026-08-21T00:00:00Z",
    });
    const req: IRRequest = IRRequestSchema.parse({
      version: "0",
      model: "claude-haiku-4-5",
      messages: [
        {
          role: "user",
          blocks: [
            { type: "text", text: "read this" },
            { type: "file", mediaType: "application/pdf", data: { type: "reference", refs: { gateway: "gwf_x" } } },
          ],
        },
      ],
    });
    const { request } = await resolveGatewayFileRefs(req, "anthropic", files);
    const fileBlock = request.messages[0]!.blocks[1]! as { data: { refs: Record<string, string> } };
    expect(fileBlock.data.refs).toEqual({ anthropic: "file_real" });
    // 원본 비변조 (순수성)
    expect((req.messages[0]!.blocks[1]! as { data: { refs: Record<string, string> } }).data.refs).toEqual({ gateway: "gwf_x" });

    await expect(resolveGatewayFileRefs(req, "openai", files)).rejects.toSatisfy((err: unknown) => {
      expect((err as GatewayError).irError.httpStatus).toBe(400);
      expect((err as GatewayError).irError.message).toContain("재업로드");
      return true;
    });
  });

  it("미지 gwf id는 404, 스토어 미설정 + gateway 참조는 400", async () => {
    const files = new InMemoryFileStore();
    const req: IRRequest = IRRequestSchema.parse({
      version: "0",
      model: "claude-haiku-4-5",
      messages: [
        {
          role: "user",
          blocks: [{ type: "file", mediaType: "application/pdf", data: { type: "reference", refs: { gateway: "gwf_none" } } }],
        },
      ],
    });
    await expect(resolveGatewayFileRefs(req, "anthropic", files)).rejects.toSatisfy((err: unknown) => {
      expect((err as GatewayError).irError.httpStatus).toBe(404);
      return true;
    });
    await expect(resolveGatewayFileRefs(req, "anthropic", undefined)).rejects.toSatisfy((err: unknown) => {
      expect((err as GatewayError).irError.httpStatus).toBe(400);
      return true;
    });
  });
});
