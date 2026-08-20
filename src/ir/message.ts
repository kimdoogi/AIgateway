import { z } from "zod";
import { BlockSchema, type BlockType } from "./blocks.js";
import { NSSchema, OriginSchema } from "./common.js";

// ir-v0 §3 — system은 별도 필드가 아니라 메시지 배열 안에 위치 보존으로 존재(G6).
export const RoleSchema = z.enum(["system", "user", "assistant", "tool"]);
export type Role = z.infer<typeof RoleSchema>;

// §3 role별 허용 블록. 역할 배치 제약(연속 role 병합 등)은 IR이 강제하지 않는다 — 어댑터/재타게팅 소관.
const ALLOWED_BLOCKS: Record<Role, readonly BlockType[]> = {
  system: ["text", "passthrough"],
  user: ["text", "file", "toolResult", "custom", "passthrough"],
  assistant: [
    "text",
    "reasoning",
    "toolCall",
    "toolResult",
    "file",
    "source",
    "custom",
    "passthrough",
  ],
  tool: ["toolResult", "passthrough"],
};

export const MessageSchema = z
  .strictObject({
    role: RoleSchema,
    blocks: z.array(BlockSchema).min(1),
    origin: OriginSchema.optional(),
    providerOptions: NSSchema.optional(),
  })
  .superRefine((msg, ctx) => {
    const allowed = ALLOWED_BLOCKS[msg.role];
    msg.blocks.forEach((block, i) => {
      if (!allowed.includes(block.type)) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i, "type"],
          message: `role '${msg.role}'에 허용되지 않는 블록 타입 '${block.type}' (ir-v0 §3)`,
        });
      }
      // assistant의 toolResult는 providerExecuted 전용 (§3)
      if (msg.role === "assistant" && block.type === "toolResult" && !block.providerExecuted) {
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i],
          message: "assistant 메시지의 toolResult는 providerExecuted 전용 (ir-v0 §3)",
        });
      }
    });
  });
export type Message = z.infer<typeof MessageSchema>;
