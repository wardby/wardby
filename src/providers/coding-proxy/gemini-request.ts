/**
 * A Gemini generateContent body, checked against what the Gemini CLI sends
 * (fixtures/gemini-cli-0.70.0-requests.json). Function declarations are client tools and pass on their shape,
 * as Codex's do (the MCP gateway enforces pins). Of Google's server-side tools only googleSearch and urlContext
 * may pass, and only under the session's web-tool policy; parts Google would fetch itself (fileData) never do.
 * The validated object is what is forwarded (re-encoded): its content is never changed and nothing is added.
 */
import { fingerprintRequest } from "./metering.js";
import { MAX_TOOL_TEXT_BYTES } from "./types.js";
import { vertexLocation } from "../llm/vertex-gemini.js";
import { GOOGLE_AI_STUDIO_PREFIX } from "../llm/google-ai-studio.js";
import type { WebTools } from "../../coding/google-web-tools.js";
import type { GeminiBackend } from "./gemini-upstream.js";
import type { GeminiRoute } from "./gemini-route.js";

/**
 * The hold's output cap for a request without generationConfig.maxOutputTokens: Gemini 4 Neon's published default
 * synchronous maximum output (65,536; aistudio.google.com/docs/models/gemini-4-neon). The page's 1,048,576 needs
 * long decode, which no allowed request field turns on.
 */
export const GEMINI_UNSET_MAX_OUTPUT_TOKENS = 65_536;
const MAX_CONTENTS = 10_000;
const MAX_PARTS = 4_096;
const MAX_TOOLS = 64;
const MAX_DECLARATIONS = 512;
const MAX_SIGNATURE_CHARS = 65_536;
const DECLARATION_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const INLINE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const FUNCTION_CALLING_MODES = new Set(["AUTO", "ANY", "NONE", "VALIDATED", "MODE_UNSPECIFIED"]);
const RESPONSE_MIME = new Set(["text/plain", "application/json"]);
const TOP_KEYS = ["contents", "systemInstruction", "tools", "toolConfig", "generationConfig", "safetySettings"];
const GENERATION_KEYS = [
  "maxOutputTokens",
  "temperature",
  "topP",
  "topK",
  "candidateCount",
  "stopSequences",
  "responseMimeType",
  "responseJsonSchema",
  "responseSchema",
  "thinkingConfig",
  "seed",
  "presencePenalty",
  "frequencyPenalty",
];

export class GeminiRequestRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface GeminiParseContext {
  route: GeminiRoute;
  backend: GeminiBackend;
  allowedModels: readonly string[];
  /** The run's catalog entry's efforts: the thinkingLevel values it takes. */
  efforts: readonly string[];
  webTools: WebTools;
  maxBodyBytes: number;
  maxOutputTokens: number;
}

export function googleModelId(modelId: string, backend: GeminiBackend): string {
  if (backend === "vertex-gemini") return vertexLocation(modelId).googleModel;
  return modelId.startsWith(GOOGLE_AI_STUDIO_PREFIX) ? modelId.slice(GOOGLE_AI_STUDIO_PREFIX.length) : modelId;
}

const refuse = (code: string, status = 400): never => {
  throw new GeminiRequestRefused(status, code);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function rec(value: unknown, code: string): Record<string, unknown> {
  return isRecord(value) ? value : refuse(code);
}
function only(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(code);
}
function str(value: unknown, max: number, code: string): string {
  return typeof value === "string" && Buffer.byteLength(value) <= max ? value : refuse(code);
}
const num = (value: unknown, code: string) =>
  typeof value === "number" && Number.isFinite(value) ? value : refuse(code);

/** One part of a content: exactly one data field, and only the kinds a coding agent's client produces. */
function validatePart(value: unknown): void {
  const part = rec(value, "invalid_gemini_content");
  for (const key of ["fileData", "executableCode", "codeExecutionResult", "videoMetadata"]) {
    if (key in part) refuse("gemini_part_not_allowed");
  }
  only(
    part,
    ["text", "thought", "thoughtSignature", "functionCall", "functionResponse", "inlineData"],
    "invalid_gemini_content",
  );
  const data = ["text", "functionCall", "functionResponse", "inlineData"].filter((key) => key in part);
  if (data.length !== 1) refuse("invalid_gemini_content");
  if (part.thought !== undefined && typeof part.thought !== "boolean") refuse("invalid_gemini_content");
  if (part.thoughtSignature !== undefined) str(part.thoughtSignature, MAX_SIGNATURE_CHARS, "invalid_gemini_content");
  if ("text" in part && typeof part.text !== "string") refuse("invalid_gemini_content");
  if ("functionCall" in part) {
    const call = rec(part.functionCall, "invalid_gemini_content");
    only(call, ["id", "name", "args"], "invalid_gemini_content");
    if (typeof call.name !== "string" || !DECLARATION_NAME.test(call.name)) refuse("invalid_gemini_content");
    if (call.id !== undefined) str(call.id, 512, "invalid_gemini_content");
    if (call.args !== undefined) rec(call.args, "invalid_gemini_content");
  }
  if ("functionResponse" in part) {
    const response = rec(part.functionResponse, "invalid_gemini_content");
    only(response, ["id", "name", "response"], "invalid_gemini_content");
    if (typeof response.name !== "string" || !DECLARATION_NAME.test(response.name)) refuse("invalid_gemini_content");
    if (response.id !== undefined) str(response.id, 512, "invalid_gemini_content");
    rec(response.response, "invalid_gemini_content");
  }
  if ("inlineData" in part) {
    const inline = rec(part.inlineData, "invalid_gemini_content");
    only(inline, ["mimeType", "data"], "invalid_gemini_content");
    if (typeof inline.mimeType !== "string" || !INLINE_MIME.has(inline.mimeType)) refuse("gemini_part_not_allowed");
    if (typeof inline.data !== "string" || !BASE64.test(inline.data)) refuse("invalid_gemini_content");
  }
}

function validateContent(value: unknown, system = false): void {
  const content = rec(value, "invalid_gemini_content");
  only(content, ["role", "parts"], "invalid_gemini_content");
  if (
    system
      ? content.role !== undefined && content.role !== "user" && content.role !== "system"
      : content.role !== "user" && content.role !== "model"
  ) {
    refuse("invalid_gemini_content");
  }
  if (!Array.isArray(content.parts) || content.parts.length > MAX_PARTS) refuse("invalid_gemini_content");
  for (const part of content.parts as unknown[]) validatePart(part);
}

function validateTools(value: unknown, policy: WebTools): void {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) refuse("invalid_gemini_tool");
  let declarations = 0;
  for (const candidate of value as unknown[]) {
    const tool = rec(candidate, "invalid_gemini_tool");
    const keys = Object.keys(tool);
    if (keys.length !== 1) refuse("invalid_gemini_tool");
    const [kind] = keys;
    if (kind === "functionDeclarations") {
      if (!Array.isArray(tool.functionDeclarations)) refuse("invalid_gemini_tool");
      for (const entry of tool.functionDeclarations as unknown[]) {
        if (++declarations > MAX_DECLARATIONS) refuse("invalid_gemini_tool");
        const declaration = rec(entry, "invalid_gemini_tool");
        only(
          declaration,
          ["name", "description", "parameters", "parametersJsonSchema", "response", "responseJsonSchema"],
          "invalid_gemini_tool",
        );
        if (typeof declaration.name !== "string" || !DECLARATION_NAME.test(declaration.name))
          refuse("invalid_gemini_tool");
        if (declaration.description !== undefined)
          str(declaration.description, MAX_TOOL_TEXT_BYTES, "invalid_gemini_tool");
        for (const key of ["parameters", "parametersJsonSchema", "response", "responseJsonSchema"]) {
          if (declaration[key] !== undefined) rec(declaration[key], "invalid_gemini_tool");
        }
      }
    } else if (kind === "googleSearch" || kind === "urlContext") {
      if (!isRecord(tool[kind]) || Object.keys(tool[kind]).length > 0) refuse("invalid_gemini_tool");
      const allowed = kind === "googleSearch" ? policy !== "off" : policy === "search-and-fetch";
      if (!allowed) refuse("web_tools_not_allowed");
    } else refuse("tools_not_allowed");
  }
}

function validateToolConfig(value: unknown): void {
  const config = rec(value, "invalid_gemini_request");
  only(config, ["functionCallingConfig"], "invalid_gemini_request");
  if (config.functionCallingConfig === undefined) return;
  const calling = rec(config.functionCallingConfig, "invalid_gemini_request");
  only(calling, ["mode", "allowedFunctionNames"], "invalid_gemini_request");
  if (calling.mode !== undefined && (typeof calling.mode !== "string" || !FUNCTION_CALLING_MODES.has(calling.mode))) {
    refuse("invalid_gemini_request");
  }
  if (calling.allowedFunctionNames !== undefined) {
    if (!Array.isArray(calling.allowedFunctionNames)) refuse("invalid_gemini_request");
    for (const name of calling.allowedFunctionNames as unknown[]) {
      if (typeof name !== "string" || !DECLARATION_NAME.test(name)) refuse("invalid_gemini_request");
    }
  }
}

/** Returns the output cap the hold uses. */
function validateGenerationConfig(value: unknown, ctx: GeminiParseContext): number {
  if (value === undefined) return GEMINI_UNSET_MAX_OUTPUT_TOKENS;
  const config = rec(value, "invalid_gemini_generation_config");
  only(config, GENERATION_KEYS, "invalid_gemini_generation_config");
  if (config.candidateCount !== undefined && config.candidateCount !== 1) refuse("invalid_gemini_generation_config");
  for (const key of ["temperature", "topP", "topK", "seed", "presencePenalty", "frequencyPenalty"]) {
    if (config[key] !== undefined) num(config[key], "invalid_gemini_generation_config");
  }
  if (config.stopSequences !== undefined) {
    if (!Array.isArray(config.stopSequences) || config.stopSequences.length > 16)
      refuse("invalid_gemini_generation_config");
    for (const stop of config.stopSequences as unknown[]) str(stop, 1024, "invalid_gemini_generation_config");
  }
  if (
    config.responseMimeType !== undefined &&
    (typeof config.responseMimeType !== "string" || !RESPONSE_MIME.has(config.responseMimeType))
  ) {
    refuse("invalid_gemini_generation_config");
  }
  for (const key of ["responseJsonSchema", "responseSchema"]) {
    if (config[key] !== undefined) rec(config[key], "invalid_gemini_generation_config");
  }
  if (config.thinkingConfig !== undefined) {
    const thinking = rec(config.thinkingConfig, "invalid_gemini_generation_config");
    only(thinking, ["thinkingLevel", "thinkingBudget", "includeThoughts"], "invalid_gemini_generation_config");
    if (thinking.thinkingLevel !== undefined) {
      if (typeof thinking.thinkingLevel !== "string" || !ctx.efforts.includes(thinking.thinkingLevel.toLowerCase())) {
        refuse("unsupported_effort");
      }
    }
    if (thinking.thinkingBudget !== undefined) {
      const budget = num(thinking.thinkingBudget, "invalid_gemini_generation_config");
      if (!Number.isSafeInteger(budget) || budget < -1 || budget > ctx.maxOutputTokens)
        refuse("invalid_gemini_generation_config");
    }
    if (thinking.includeThoughts !== undefined && typeof thinking.includeThoughts !== "boolean") {
      refuse("invalid_gemini_generation_config");
    }
  }
  if (config.maxOutputTokens === undefined) return GEMINI_UNSET_MAX_OUTPUT_TOKENS;
  const cap = config.maxOutputTokens;
  if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > ctx.maxOutputTokens) {
    refuse("invalid_max_output_tokens");
  }
  return cap as number;
}

function validateSafetySettings(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16) refuse("invalid_gemini_request");
  for (const entry of value as unknown[]) {
    const setting = rec(entry, "invalid_gemini_request");
    only(setting, ["category", "threshold", "method"], "invalid_gemini_request");
    for (const key of ["category", "threshold"]) str(setting[key], 64, "invalid_gemini_request");
    if (setting.method !== undefined) str(setting.method, 64, "invalid_gemini_request");
  }
}

export function parseGeminiRequest(
  rawBody: string,
  ctx: GeminiParseContext,
): {
  body: Record<string, unknown>;
  encoded: string;
  model: string;
  maxOutputTokens: number;
  stream: boolean;
  fingerprint: string;
} {
  if (Buffer.byteLength(rawBody) > ctx.maxBodyBytes) refuse("payload_too_large", 413);
  const expected = ctx.backend === "vertex-gemini" ? "vertex-express" : "ai-studio";
  if (ctx.route.surface !== expected) refuse("gemini_backend_mismatch", 403);
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    refuse("invalid_json");
  }
  const body = isRecord(value) ? value : refuse("expected_json_object");
  only(body, TOP_KEYS, "invalid_gemini_request");
  if (!Array.isArray(body.contents) || body.contents.length === 0 || body.contents.length > MAX_CONTENTS) {
    refuse("invalid_gemini_request");
  }
  for (const content of body.contents as unknown[]) validateContent(content);
  if (body.systemInstruction !== undefined) validateContent(body.systemInstruction, true);
  if (body.tools !== undefined) validateTools(body.tools, ctx.webTools);
  if (body.toolConfig !== undefined) validateToolConfig(body.toolConfig);
  if (body.safetySettings !== undefined) validateSafetySettings(body.safetySettings);
  const maxOutputTokens = validateGenerationConfig(body.generationConfig, ctx);
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > ctx.maxBodyBytes) refuse("payload_too_large", 413);
  const model = ctx.allowedModels.find((id) => googleModelId(id, ctx.backend) === ctx.route.model) ?? ctx.route.model;
  return {
    body,
    encoded,
    model,
    maxOutputTokens,
    stream: ctx.route.method === "streamGenerateContent",
    fingerprint: fingerprintRequest(`${ctx.route.surface}\n${ctx.route.method}\n${ctx.route.model}\n${encoded}`),
  };
}
