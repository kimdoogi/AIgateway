import type { JSONObject, JSONValue } from "../../ir/json.js";
import type { Block, FileBlock, ToolResultBlock } from "../../ir/blocks.js";
import type { Warning } from "../../ir/common.js";
import type { IRRequest } from "../../ir/request.js";
import type { RequestContext, TransformedRequest } from "../types.js";
import { z } from "zod";
import { AdapterInvalidRequestError, gateBlockLevelOptions, gateEffort, makeWarning, partitionProviderOptions } from "../shared.js";
import { parseGoogleRequestOptions, readPartExtras } from "./options.js";
import { GeminiWireRequestSchema } from "./wire.js";

// 툴 레벨 providerOptions.google — functionDeclaration 신좌석 (인벤토리 §K, 감사 google #8)
const GeminiToolLevelSchema = z.object({
  response: z.record(z.string(), z.unknown()).optional(),
  responseJsonSchema: z.record(z.string(), z.unknown()).optional(),
  behavior: z.string().optional(), // Live 비동기 NON_BLOCKING (인벤토리 §K)
});

// 블록 레벨 인지 키 (감사 #17 — partExtras: withPartExtras, videoMetadata: §4.5)
const GEMINI_BLOCK_PO_KEYS: ReadonlySet<string> = new Set(["partExtras", "videoMetadata"]);
const GEMINI_MESSAGE_PO_KEYS: ReadonlySet<string> = new Set([]);

// IR → Gemini generateContent wire (ADR-0003, ir-v0 §13, docs/research/2026-08-20-gemini-api.md)
// 순수 함수. 스트리밍은 body가 아니라 경로로 갈린다 (:streamGenerateContent?alt=sse 강제 — ADR-0003 §2).

// Gemini 3 thoughtSignature 검증 우회용 공식 더미 (인벤토리 C-2 — 합성/타사 이력 주입 시.
// 2.5 세대는 검증 없음이라 무해). 첫 functionCall part에만 필수 (병렬 규칙).
const DUMMY_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const DEFAULT_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high"]; // thinkingLevel 집합 (3세대)

// 어댑터가 조립하는 핵심 필드 — passthrough/extra가 이미 설정된 값을 덮어쓰면 명시적 에러
const RESERVED_BODY_KEYS = new Set([
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "safetySettings",
  "generationConfig",
  "cachedContent",
  "serviceTier",
  "store",
]);

// provider 툴 id 접미(snake_case — ir-v0 §6.2 예: "google.google_search") → wire Tool 멤버 키
const PROVIDER_TOOL_KEYS: Record<string, string> = {
  google_search: "googleSearch",
  google_search_retrieval: "googleSearchRetrieval",
  code_execution: "codeExecution",
  url_context: "urlContext",
  google_maps: "googleMaps",
  file_search: "fileSearch",
  computer_use: "computerUse",
};

type RetargetReasoning = "drop" | "demote-to-text" | "strip-and-annotate";

interface ConvertCtx {
  warnings: Warning[];
  retargetReasoning: RetargetReasoning;
  /** 멀티모달 functionResponse.parts 지원 (Gemini 3 세대 게이트 — 감사 google #1) */
  multimodalFunctionResponse?: boolean;
}

/** 파라미터 드롭의 D5 처리 — strict면 4xx, 아니면 드롭 + warning (shared.dropUnsupportedParams와 동일 규약) */
type DropParam = (message: string, path: string) => void;

function makeDropParam(strict: boolean | undefined, warnings: Warning[]): DropParam {
  return (message, path) => {
    if (strict) throw new AdapterInvalidRequestError(`${message} (strictParameters)`);
    warnings.push(makeWarning("unsupported", "parameter-dropped", message, path));
  };
}

function withPartExtras(part: JSONObject, block: { providerOptions?: Record<string, JSONObject> }): JSONObject {
  const extras = readPartExtras(block.providerOptions);
  return extras ? { ...part, ...extras } : part;
}

function fileToWire(block: FileBlock, cctx: ConvertCtx, path: string): JSONObject {
  let part: JSONObject;
  switch (block.data.type) {
    case "base64":
      part = { inlineData: { mimeType: block.mediaType, data: block.data.data } };
      break;
    case "url":
      // YouTube 등 URL 직접 입력 (인벤토리 E-5) — fileData.fileUri에 그대로
      part = { fileData: { mimeType: block.mediaType, fileUri: block.data.url } };
      break;
    case "reference": {
      const fileUri = block.data.refs["google"];
      if (!fileUri) {
        // D6-8: 타깃 불일치 reference는 재타게팅이 해결했어야 함 — 조용한 드롭 대신 명시적 에러
        throw new AdapterInvalidRequestError(
          `file reference에 google fileUri가 없습니다 (${path}) — 재타게팅 필요 (D6-8)`,
        );
      }
      part = { fileData: { mimeType: block.mediaType, fileUri } };
      break;
    }
    case "text":
      // Gemini에는 텍스트 소스 part가 없음 — text part로 등가 변환 (손실 없음)
      part = { text: block.data.text };
      break;
  }
  // 미디어 part에 실려온 서명 왕복 (C-2 — 모든 part에 부착 가능)
  if (block.opaqueState?.provider === "google") part["thoughtSignature"] = block.opaqueState.data;
  // §4.5 계약: videoMetadata({startOffset,endOffset,fps})는 providerOptions.google — 미소비 시
  // 클리핑 무시로 전체 비디오 과금 (감사 google #4 / P0 #14 짝)
  const vm = block.providerOptions?.["google"]?.["videoMetadata"];
  if (vm && typeof vm === "object") part["videoMetadata"] = vm as JSONValue;
  // gemini wire에 대응 좌석이 없는 문서 메타 — 조용한 유실 금지 (D5)
  for (const key of ["title", "context", "citationsEnabled", "filename"] as const) {
    if (block[key] !== undefined) {
      cctx.warnings.push(
        makeWarning("unsupported", "parameter-dropped", `gemini file part는 ${key} 미지원 — 드롭`, `${path}.${key}`),
      );
    }
  }
  // partExtras(mediaResolution 등) — 미디어 part에도 배선 (감사 google #4: 무경고 무시였다)
  return withPartExtras(part, block);
}

/** functionResponse.response는 Struct(객체) 필수 — 비객체는 output/error 래핑 (SDK 관례) */
function toolResultToWire(block: ToolResultBlock, cctx: ConvertCtx, path: string): JSONObject | null {
  if (block.providerExecuted) {
    // 타 프로바이더 산 서버 툴 결과 → D6-6: 텍스트 강등 + warning
    // (google 산 서버 툴 아티팩트는 custom 블록(google.code_execution_result 등)으로 왕복 — §15)
    cctx.warnings.push(
      makeWarning(
        "compatibility",
        "block-dropped",
        `복원 불가한 서버 툴 결과(${block.toolName}) — 텍스트 강등 (D6-6)`,
        path,
      ),
    );
    return {
      text: `[서버 툴 ${block.toolName} 결과]\n${JSON.stringify(
        block.output.type === "json" ? block.output.value : block.output,
      )}`,
    };
  }

  const out = block.output;
  let response: JSONObject;
  switch (out.type) {
    case "text":
      response = { output: out.text };
      break;
    case "json":
      response =
        typeof out.value === "object" && out.value !== null && !Array.isArray(out.value)
          ? (out.value as JSONObject)
          : { output: out.value };
      break;
    case "content":
    case "errorContent": {
      // 3세대는 멀티모달 functionResponse.parts 지원 (감사 google #1 실증 — 2.5 이하 드롭 유지).
      // file 블록 → parts(inlineData/fileData), 텍스트는 response.output/error로.
      const texts: string[] = [];
      const frParts: JSONObject[] = [];
      out.blocks.forEach((b, i) => {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "file" && cctx.multimodalFunctionResponse) {
          frParts.push(fileToWire(b, cctx, `${path}.content[${i}]`));
        } else {
          cctx.warnings.push(
            makeWarning(
              "unsupported",
              "block-dropped",
              `generateContent functionResponse는 ${b.type} 블록 미지원 — 드롭${
                b.type === "file" ? " (멀티모달 함수응답은 Gemini 3 세대 한정)" : ""
              }`,
              `${path}.content[${i}]`,
            ),
          );
        }
      });
      // §4.4 직교 — errorContent는 error 슬롯으로 (is_error 등가)
      response = out.type === "errorContent" ? { error: texts.join("\n") } : { output: texts.join("\n") };
      if (frParts.length > 0) {
        return { functionResponse: { name: block.toolName, response, parts: frParts } };
      }
      break;
    }
    case "errorText":
      response = { error: out.text };
      break;
    case "errorJson":
      response = { error: out.value };
      break;
    case "executionDenied":
      response = { error: `execution denied${out.reason ? `: ${out.reason}` : ""}` };
      break;
  }
  // id 미포함 — generateContent 매칭 키는 name+순서 (인벤토리 D-5, §13.2)
  return { functionResponse: { name: block.toolName, response } };
}

function reasoningToWire(
  block: Extract<Block, { type: "reasoning" }>,
  cctx: ConvertCtx,
  path: string,
): JSONObject | null {
  if (block.opaqueState?.provider === "google") {
    // thought part 원문 복원 — signature는 받은 그대로 (인벤토리 C-2). 빈 text라도 보존 (§10.2)
    return { text: block.text, thought: true, thoughtSignature: block.opaqueState.data };
  }
  // 서명 없어도 google 산(origin==타깃)이면 원문 복원 (§13.3 — 이식성 판단은 origin 상이/부재만.
  // thought part는 서명 없이 유효 — 실측: 서명은 별도 part에 실려오는 경우가 흔하다)
  if (block.origin?.provider === "google") {
    return { text: block.text, thought: true };
  }
  // 외래(서명 없는) reasoning — retarget 정책 적용 (D6-2)
  switch (cctx.retargetReasoning) {
    case "demote-to-text":
      if (block.text.length > 0) {
        cctx.warnings.push(
          makeWarning("compatibility", "reasoning-demoted", "외래 reasoning을 텍스트로 강등", path),
        );
        return { text: block.text };
      }
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning에 강등할 텍스트 없음 — 드롭", path),
      );
      return null;
    case "strip-and-annotate":
      cctx.warnings.push(
        makeWarning("compatibility", "reasoning-annotated", "외래 reasoning 제거 사실을 주석으로 대체", path),
      );
      return { text: "[이전 턴의 추론 내용은 프로바이더 전환으로 제거되었습니다]" };
    case "drop":
      cctx.warnings.push(
        makeWarning("unsupported", "reasoning-dropped", "외래 reasoning 블록 드롭 (retarget: drop)", path),
      );
      return null;
  }
}

function blockToWire(block: Block, cctx: ConvertCtx, path: string): JSONObject | null {
  switch (block.type) {
    case "text": {
      const part: JSONObject = { text: block.text };
      // 응답의 text part에 실려온 signature 왕복 (스트리밍 빈 text part 포함 — 프루닝 금지 §10.2)
      if (block.opaqueState?.provider === "google") part["thoughtSignature"] = block.opaqueState.data;
      return withPartExtras(part, block);
    }
    case "reasoning":
      return reasoningToWire(block, cctx, path);
    case "toolCall": {
      if (block.providerExecuted) {
        // google 산 서버 툴 호출 아티팩트는 custom 블록으로 왕복(§15) — 여기 도달은 타 프로바이더 산
        cctx.warnings.push(
          makeWarning("unsupported", "block-dropped", `타 프로바이더 서버 툴 호출(${block.toolName}) — 드롭`, path),
        );
        return null;
      }
      if (block.input.type === "text") {
        throw new AdapterInvalidRequestError(
          `Gemini functionCall args는 JSON object 필수 — 비JSON 입력 불가 (${path}), 재타게팅 필요`,
        );
      }
      const args = block.input.value;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new AdapterInvalidRequestError(
          `Gemini functionCall args는 JSON object 필수 (${path}) — 재타게팅 필요`,
        );
      }
      // id 드롭 — generateContent는 name+순서 매칭 (§13.2: 합성·비합성 불문 전부 드롭)
      const part: JSONObject = { functionCall: { name: block.toolName, args: args as JSONObject } };
      if (block.opaqueState?.provider === "google") part["thoughtSignature"] = block.opaqueState.data;
      return withPartExtras(part, block);
    }
    case "toolResult":
      return toolResultToWire(block, cctx, path);
    case "file":
      return fileToWire(block, cctx, path);
    case "source":
      return null; // §4.6 — 히스토리 재전송 대상 아님 (스펙 명시라 warning 없음)
    case "custom": {
      // google.executable_code / google.code_execution_result — payload가 wire part 원문 (§15 무변경 라운드트립)
      if (block.kind.startsWith("google.")) return block.payload as JSONObject;
      cctx.warnings.push(
        makeWarning("unsupported", "block-dropped", `타 프로바이더 custom 블록(${block.kind}) — 드롭`, path),
      );
      return null;
    }
    case "passthrough": {
      if (block.provider === "google") return block.raw as JSONObject;
      cctx.warnings.push(
        makeWarning("unsupported", "passthrough-dropped", "타 프로바이더 passthrough 블록 — 드롭", path),
      );
      return null;
    }
  }
}

/**
 * model 턴의 첫 functionCall part에 signature 보장 (D6-9): Gemini 3는 현재 턴 FC의
 * signature 누락 = 400 (MISSING_THOUGHT_SIGNATURE). 없으면 공식 더미 삽입 + warning.
 * 병렬 규칙(첫 FC에만 필수)에 맞춰 첫 FC만 검사한다 (인벤토리 C-2).
 */
function ensureFirstFunctionCallSignature(parts: JSONObject[], warnings: Warning[], path: string): void {
  const idx = parts.findIndex((p) => p["functionCall"] !== undefined);
  if (idx < 0 || parts[idx]!["thoughtSignature"] !== undefined) return;
  // 교체(비변조) — passthrough/custom 원문 객체를 직접 mutate하면 입력 IR이 오염된다 (D4 순수성)
  parts[idx] = { ...parts[idx]!, thoughtSignature: DUMMY_THOUGHT_SIGNATURE };
  warnings.push(
    makeWarning(
      "compatibility",
      "signature-synthesized",
      "functionCall에 thoughtSignature 부재 — 공식 더미 삽입 (Gemini 3 검증 우회, D6-9)",
      path,
    ),
  );
}

type WireContent = { role: "user" | "model"; parts: JSONObject[] };

/** body에 외부 키(opt-in extra / passthroughParams)를 병합 — 예약 키 충돌은 명시적 에러 */
function mergeExternal(body: JSONObject, entries: JSONObject, label: string): void {
  for (const [k, v] of Object.entries(entries)) {
    if (RESERVED_BODY_KEYS.has(k) && body[k] !== undefined) {
      throw new AdapterInvalidRequestError(`${label}의 '${k}'가 어댑터가 조립한 핵심 필드와 충돌합니다`);
    }
    body[k] = v;
  }
}

/**
 * effort 게이트 — shared.gateEffort 위임 (§6.3 최근접 클램프 + on/off 경계 보존).
 * 드롭 사유 문구만 gemini 세대 사정(2.5는 thinkingBudget)을 반영해 주입한다.
 */
function clampEffort(
  effort: string,
  supported: readonly string[],
  strict: boolean | undefined,
  warnings: Warning[],
): string | undefined {
  return gateEffort(
    effort,
    supported,
    {
      strict,
      label: "google",
      emptyMessage:
        "모델이 thinkingLevel 미지원 (2.5 세대는 providerOptions.google.thinkingConfig.thinkingBudget 사용) — effort 드롭",
      noneMessage: "모델이 추론 비활성(effort 'none')을 표현할 수 없음 — thinking 설정 미방출 (모델 기본 동작)",
    },
    warnings,
  );
}

export function transformRequest(req: IRRequest, ctx: RequestContext): TransformedRequest {
  const warnings: Warning[] = [];
  const dropParam = makeDropParam(req.strictParameters, warnings); // D5 strict 모드 배선
  const cctx: ConvertCtx = {
    warnings,
    retargetReasoning: req.retarget?.reasoning ?? "drop",
    ...(ctx.capabilities?.multimodalFunctionResponse ? { multimodalFunctionResponse: true } : {}),
  };
  // 블록·메시지 레벨 PO D5 게이트 (감사 #17)
  gateBlockLevelOptions(req.messages, "google", GEMINI_BLOCK_PO_KEYS, GEMINI_MESSAGE_PO_KEYS, req.allowUnknownProviderOptions, warnings);
  const body: JSONObject = {};
  const headers: Record<string, string> = { "content-type": "application/json" };

  // ── system: 선두 연속 system → systemInstruction (text part만 — 인벤토리 B-1).
  //    중간 system은 user 변환 + warning (§13.3 D6-4 — systemInstruction 병합은 캐시를 깨므로 비기본)
  const systemParts: JSONObject[] = [];
  let leading = true;
  const contents: WireContent[] = [];

  req.messages.forEach((msg, mi) => {
    if (leading && msg.role === "system") {
      msg.blocks.forEach((b, bi) => {
        if (b.type === "text") {
          systemParts.push({ text: b.text });
        } else if (b.type === "passthrough" && b.provider === "google") {
          systemParts.push(b.raw as JSONObject);
        } else {
          warnings.push(
            makeWarning(
              "unsupported",
              "block-dropped",
              `systemInstruction은 text part만 지원 — ${b.type} 블록 드롭`,
              `messages[${mi}].blocks[${bi}]`,
            ),
          );
        }
      });
      return;
    }
    leading = false;

    let role: WireContent["role"];
    if (msg.role === "system") {
      role = "user";
      warnings.push(
        makeWarning(
          "compatibility",
          "system-repositioned",
          "중간 system 메시지를 user 턴으로 변환 (Gemini는 system role 없음 — D6-4)",
          `messages[${mi}]`,
        ),
      );
    } else {
      role = msg.role === "assistant" ? "model" : "user";
    }

    const parts: JSONObject[] = [];
    msg.blocks.forEach((b, bi) => {
      const part = blockToWire(b, cctx, `messages[${mi}].blocks[${bi}]`);
      if (part) parts.push(part);
    });
    if (parts.length === 0) return;
    if (role === "model") ensureFirstFunctionCallSignature(parts, warnings, `messages[${mi}]`);
    const prev = contents[contents.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  });
  if (contents.length === 0) {
    // 빈 contents는 Google이 불투명한 400으로 거부 — 전송 전 명시적 실패 (system 전용/전량 드롭 케이스)
    throw new AdapterInvalidRequestError(
      "gemini contents가 비었습니다 — user/assistant 메시지가 최소 1개 필요 (system 전용 요청 불가)",
    );
  }
  body["contents"] = contents;
  if (systemParts.length > 0) body["systemInstruction"] = { parts: systemParts };

  // ── providerOptions.google (D5 — shared 공통 정책). PO는 표준 필드와 충돌 시 우선 (§2 규범) ──
  const opts = parseGoogleRequestOptions(req.providerOptions, req.allowUnknownProviderOptions ?? false, warnings);

  // ── tools ──
  if (req.tools && req.tools.length > 0) {
    const functionDeclarations: JSONObject[] = [];
    const wireTools: JSONObject[] = [];
    req.tools.forEach((t, ti) => {
      if (t.type === "function") {
        // parametersJsonSchema = raw JSON Schema 통과 (변환 손실 최소 경로 — 인벤토리 K)
        const def: JSONObject = { name: t.name };
        if (t.description) def["description"] = t.description;
        def["parametersJsonSchema"] = t.inputSchema;
        if (t.strict !== undefined) {
          dropParam("gemini 함수 툴은 strict 미지원 — 드롭 (스키마 강제는 toolConfig VALIDATED 모드)", `tools[${ti}].strict`);
        }
        if (t.inputExamples) {
          dropParam("gemini 함수 툴은 inputExamples 미지원 — 드롭", `tools[${ti}].inputExamples`);
        }
        // 툴 레벨 PO — response/responseJsonSchema 등 (감사 google #8: 좌석 미독취) + D5 미지 키 정책
        const toolPO = partitionProviderOptions(
          t.providerOptions,
          "google",
          GeminiToolLevelSchema,
          req.allowUnknownProviderOptions ?? false,
          warnings,
        );
        if (toolPO.known.response) def["response"] = toolPO.known.response as JSONValue;
        if (toolPO.known.responseJsonSchema) def["responseJsonSchema"] = toolPO.known.responseJsonSchema as JSONValue;
        if (toolPO.known.behavior) def["behavior"] = toolPO.known.behavior;
        for (const [k, v] of Object.entries(toolPO.extra)) def[k] = v; // opt-in 통과분 (warning 동반)
        functionDeclarations.push(def);
        return;
      }
      // provider 툴: id = "google.google_search" 등 (§6.2) — 접미를 wire Tool 멤버 키로
      if (!t.id.startsWith("google.")) {
        throw new AdapterInvalidRequestError(`타 프로바이더 툴 ${t.id}은 google 타깃에서 사용 불가`);
      }
      const suffix = t.id.slice("google.".length);
      const wireKey = PROVIDER_TOOL_KEYS[suffix];
      if (!wireKey) {
        throw new AdapterInvalidRequestError(
          `알 수 없는 google provider 툴 ${t.id} (지원: ${Object.keys(PROVIDER_TOOL_KEYS).join(", ")})`,
        );
      }
      wireTools.push({ [wireKey]: t.args ?? {} });
    });
    if (functionDeclarations.length > 0) wireTools.unshift({ functionDeclarations });
    body["tools"] = wireTools;
  }

  // ── toolChoice → toolConfig.functionCallingConfig (PO toolConfig가 있으면 PO 우선 — §2) ──
  if (opts.toolConfig) {
    if (req.toolChoice !== undefined || req.parallelToolCalls !== undefined) {
      warnings.push(
        makeWarning(
          "compatibility",
          "provider-option-override",
          "providerOptions.google.toolConfig가 toolChoice/parallelToolCalls와 같은 wire 슬롯을 차지 — PO 우선 (§2)",
          "toolChoice",
        ),
      );
    }
    body["toolConfig"] = opts.toolConfig;
  } else {
    if (req.toolChoice !== undefined) {
      const fcc: JSONObject =
        req.toolChoice === "auto"
          ? { mode: "AUTO" }
          : req.toolChoice === "required"
            ? { mode: "ANY" }
            : req.toolChoice === "none"
              ? { mode: "NONE" }
              : { mode: "ANY", allowedFunctionNames: [req.toolChoice.toolName] };
      body["toolConfig"] = { functionCallingConfig: fcc };
    }
    if (req.parallelToolCalls === false) {
      dropParam("gemini는 병렬 툴콜 비활성 knob 미지원 — parallelToolCalls:false 드롭", "parallelToolCalls");
    }
  }

  if (opts.safetySettings) body["safetySettings"] = opts.safetySettings;

  // ── generationConfig (sampling — 전 표준 파라미터 지원, 인벤토리 B-2) ──
  const gen: JSONObject = {};
  if (req.maxOutputTokens === 0) {
    // 0(캐시 프리워밍)은 anthropic 전용 의미론 — gemini는 미지원, 드롭 + warning (ir-v0 §6)
    warnings.push(makeWarning("unsupported", "parameter-dropped", "maxOutputTokens 0(프리워밍)은 gemini 미지원 — 드롭", "maxOutputTokens"));
  } else if (req.maxOutputTokens !== undefined) gen["maxOutputTokens"] = req.maxOutputTokens;
  if (req.temperature !== undefined) gen["temperature"] = req.temperature;
  if (req.topP !== undefined) gen["topP"] = req.topP;
  if (req.topK !== undefined) gen["topK"] = req.topK;
  if (req.stopSequences) gen["stopSequences"] = req.stopSequences;
  if (req.seed !== undefined) gen["seed"] = req.seed;
  if (req.presencePenalty !== undefined) gen["presencePenalty"] = req.presencePenalty;
  if (req.frequencyPenalty !== undefined) gen["frequencyPenalty"] = req.frequencyPenalty;

  if (req.responseFormat && req.responseFormat.type === "json") {
    gen["responseMimeType"] = "application/json";
    if (req.responseFormat.schema) gen["responseJsonSchema"] = req.responseFormat.schema;
    for (const key of ["name", "description", "strict"] as const) {
      if (req.responseFormat[key] !== undefined) {
        dropParam(`gemini responseJsonSchema는 ${key} 미지원 — 드롭`, `responseFormat.${key}`);
      }
    }
  }

  // ── reasoning effort → thinkingConfig.thinkingLevel (PO thinkingConfig가 있으면 PO 우선 — §2) ──
  if (opts.thinkingConfig) {
    if (req.reasoning?.effort) {
      warnings.push(
        makeWarning(
          "compatibility",
          "provider-option-override",
          "providerOptions.google.thinkingConfig가 reasoning.effort와 같은 wire 슬롯을 차지 — PO 우선 (§2)",
          "reasoning.effort",
        ),
      );
    }
    gen["thinkingConfig"] = opts.thinkingConfig;
  } else if (req.reasoning?.effort) {
    const supported = ctx.capabilities?.supportedEfforts ?? DEFAULT_EFFORTS;
    const level = clampEffort(req.reasoning.effort, supported, req.strictParameters, warnings);
    // includeThoughts: reasoning 요청 = thought summary 수신 의도 (타 프로바이더의 reasoning 노출과 대칭)
    if (level !== undefined) gen["thinkingConfig"] = { includeThoughts: true, thinkingLevel: level };
  }
  if (opts.responseModalities) gen["responseModalities"] = opts.responseModalities;
  if (opts.speechConfig) gen["speechConfig"] = opts.speechConfig;
  if (opts.mediaResolution) gen["mediaResolution"] = opts.mediaResolution;
  if (Object.keys(gen).length > 0) body["generationConfig"] = gen;

  if (opts.cachedContent) body["cachedContent"] = opts.cachedContent;
  if (opts.serviceTier) body["serviceTier"] = opts.serviceTier;
  if (opts.store !== undefined) body["store"] = opts.store;

  // ── metadata: gemini 대응 필드 없음 — 전부 드롭 + 보고 (strict면 4xx) ──
  if (req.metadata) {
    for (const k of Object.keys(req.metadata)) {
      dropParam(`gemini 미지원 metadata.${k} 드롭`, `metadata.${k}`);
    }
  }

  mergeExternal(body, opts.extra, "providerOptions.google(opt-in)");

  // ── passthroughParams (D10-1). 타깃 불일치는 정책 레이어가 걸렀어야 함 ──
  if (req.passthroughParams) {
    if (req.passthroughParams.provider !== "google") {
      throw new AdapterInvalidRequestError(
        "타 프로바이더 passthroughParams가 gemini 어댑터에 도달 — 정책 레이어 필터 누락",
        { gatewayException: true },
      );
    }
    mergeExternal(body, req.passthroughParams.params, "passthroughParams");
    for (const [k, v] of Object.entries(req.passthroughParams.headers ?? {})) headers[k] = v;
  }

  // ── D4 요청 방향 wire 검증. parse 부수 효과: 알려진 키 canonical 재배열 ──
  const validated = GeminiWireRequestSchema.parse(body) as unknown as JSONObject;

  // 스트리밍 프레이밍 이중성 (인벤토리 F-1): 기본 JSON 배열 — ?alt=sse 강제 (ADR-0003 §2)
  const action = req.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const path = `/v1beta/models/${ctx.modelId}:${action}`;

  return { request: { method: "POST", path, headers, body: validated }, warnings };
}
