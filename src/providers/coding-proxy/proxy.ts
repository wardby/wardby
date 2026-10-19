import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ModelPricing } from "../llm/pricing-core.js";
import { shippedCatalog } from "../llm/catalog.js";
import { SHIPPED_CATALOG_VERSION } from "../llm/catalog-shipped.js";
import type { ThinkingMode } from "../llm/catalog-types.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import {
  AnthropicSseUsageTracker,
  actualCostUsd,
  fingerprintRequest,
  parseAnthropicAuthoritativeUsage,
  parseAuthoritativeUsage,
  pricingSnapshot,
  safeUpstreamErrorCode,
  terminalUsageFromSseFrame,
} from "./metering.js";
import { conversationKey, estimateHold } from "./hold.js";
import { estimateInterrupted, previousInput, type InterruptedEstimate } from "./interrupted.js";
import { createPinnedProxyFetch } from "./secure-fetch.js";
import type {
  CredentialResolver,
  ProxyAuditSink,
  ProxyLedger,
  ProxyModelTerms,
  ProxyProtocol,
  ProxyRefusalRecord,
  ProxyRequest,
  ProxySession,
  ProxyUsage,
} from "./types.js";

export const PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PROXY_MAX_OUTPUT_TOKENS = 1_000_000;
export const PROXY_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
export const CLAUDE_CODE_ANTHROPIC_BETAS = [
  "claude-code-20250219",
  "context-management-2025-06-27",
  "effort-2025-11-24",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "prompt-caching-scope-2026-01-05",
  "thinking-token-count-2026-05-13",
] as const;
const MAX_UPSTREAM_JSON_BYTES = 16 * 1024 * 1024;
/** A rejected upstream's error body is read only this far, for its error code. */
const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;
const REQUEST_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
/**
 * Betas Claude Code sends only for some models. per-turn-control is sent for Claude Opus 5.5; it is
 * required only by an effort-only system message (per-turn effort), and every body field is still
 * checked against the reviewed shape, so the header alone unlocks nothing.
 */
export const OPTIONAL_ANTHROPIC_BETAS = ["per-turn-control-2026-07-01"] as const;
const APPROVED_ANTHROPIC_BETAS = new Set<string>([...CLAUDE_CODE_ANTHROPIC_BETAS, ...OPTIONAL_ANTHROPIC_BETAS]);
const WARDBY_COMMAND_TOOL = "mcp__wardby_tools__run_command";
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_TOOL_TEXT_BYTES = 256 * 1024;
/**
 * The longest run_command timeout the Claude tool runner offers the model (its MAX_TIMEOUT_MS,
 * src/claude-tool-runner/command.mjs; the proxy tests keep the two equal). A lower limit here let the
 * command run, then refused the next request, which replays that tool call, as unsupported.
 */
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

export class CodingProxyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export interface ProxyResponseSink {
  start(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array): void | Promise<void>;
  end(): void;
  destroy(): void;
}

export interface ExecuteProxyRequest {
  bearer: string;
  protocol: ProxyProtocol;
  rawBody: string;
  requestKey?: string;
  anthropicBeta?: string;
}

export interface CreateCodingProxySession {
  runId: string;
  credentialRef: string;
  protocol: ProxyProtocol;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
  /** The run's catalog entry recorded at dispatch; the session then prices and shapes requests from it. */
  terms?: ProxyModelTerms;
}

export interface CreatedCodingProxySession {
  id: string;
  runId: string;
  capability: string;
  protocol: ProxyProtocol;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
}

export interface CodingProxyOptions {
  ledger: ProxyLedger;
  credentials: CredentialResolver;
  upstreamUrl?: string;
  anthropicUpstreamUrl?: string;
  upstreamAllowedHosts?: string[];
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  audit?: ProxyAuditSink;
  pricing?: (model: string, protocol: ProxyProtocol) => ModelPricing;
  pricingVersion?: string;
  /**
   * Called with the run's id on every authenticated model request, before it is forwarded (the
   * dependency cache's seal, ModelRequestSeal). Awaited; a failure is ignored, never the request's.
   */
  onModelRequest?: (runId: string) => Promise<void>;
}

interface ParsedRequest {
  body: Record<string, unknown>;
  encoded: string;
  model: string;
  maxOutputTokens: number;
  stream: boolean;
  fingerprint: string;
  anthropicBeta?: string;
}

/** What an in-flight request's relay has seen so far, to settle it at an estimate if it breaks. */
interface RelayProgress {
  /** The output tokens the request reserved for. */
  maxOutputTokens: number;
  /** A streaming request: until its response starts, the provider has generated nothing. */
  stream: boolean;
  /** Set once the upstream response has started (its headers arrived). */
  responseStarted?: boolean;
  /** UTF-8 bytes of the request body the proxy forwarded. */
  bodyBytes: number;
  /** The request's input estimated at reserve time from its conversation's previous reply. */
  previousInput?: ProxyUsage;
  /** UTF-8 bytes of output text relayed to the client. */
  relayedOutputBytes: number;
  /** The Anthropic stream's usage tracker, once a stream is being relayed. */
  anthropic?: AnthropicSseUsageTracker;
  /** Set once the request is marked uncertain: a later failure must not mark (and audit) it again. */
  marked?: boolean;
}

export function capabilityHash(capability: string): string {
  return createHash("sha256").update(capability).digest("base64url");
}

// OpenAI Responses allowlist. Everything a request may carry is listed here;
// anything else is refused before a credential is resolved. It mirrors what the
// pinned Codex CLI (src/coding-worker/package.json) actually sends, recorded in
// fixtures/codex-<version>-responses-requests.json. Only client-side tools
// (function, custom, and namespaces of them) are allowed: a hosted tool (web
// search, remote MCP, code interpreter, image generation, file search, ...), a
// remote image or file, a stored prompt, or a previous response would make
// OpenAI fetch or run something outside the worker's egress policy and outside
// the token-metered budget. Tool names vary by model and Codex version, so they
// are checked for shape, not against a fixed list: a client-side tool the model
// calls is executed by the worker itself, which the container boundary governs.
const OPENAI_REQUEST_KEYS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "max_output_tokens",
  "background",
  "service_tier",
]);
const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const OPENAI_REASONING_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);
const OPENAI_REASONING_CONTEXTS = new Set(["all_turns", "current_turn"]);
const OPENAI_INCLUDES = new Set(["reasoning.encrypted_content"]);
// Only unset (Codex never sends one) or an explicit "default". "auto" defers to
// the OpenAI project's own tier setting, which may be priority or scale; those
// and "flex" are billed at rates the pricing table does not track.
const OPENAI_SERVICE_TIERS = new Set(["default"]);
// The client_metadata keys the pinned Codex sends (recorded fixture). Several
// are x-codex-*/x-openai-* keys whose server-side meaning is undocumented, so a
// new key fails closed like every other unknown field.
const OPENAI_CLIENT_METADATA_KEYS = new Set([
  "parent_turn_id",
  "root_turn_id",
  "session_id",
  "thread_id",
  "turn_id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
  "x-openai-subagent",
]);
const OPENAI_TOOL_CHOICES = new Set(["auto", "none", "required"]);
const OPENAI_VERBOSITIES = new Set(["low", "medium", "high"]);
const OPENAI_IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);
const OPENAI_MESSAGE_ROLES = new Set(["user", "developer", "system", "assistant"]);
const OPENAI_MESSAGE_PHASES = new Set(["commentary", "final_answer"]);
const OPENAI_GRAMMAR_SYNTAXES = new Set(["lark", "regex"]);
const OPENAI_INPUT_PARTS = new Set(["input_text", "input_image"]);
const OPENAI_ASSISTANT_PARTS = new Set(["output_text"]);
const OPENAI_AGENT_MESSAGE_PARTS = new Set(["input_text", "encrypted_content"]);
const OPENAI_TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const OPENAI_CODE_SUFFIX = /^[A-Za-z0-9_.-]{1,64}$/;
// Only an inline base64 image: Codex's view_image and code-mode image() send
// local files this way. A URL (or a file_id) would make OpenAI fetch it.
const OPENAI_INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_OPENAI_ITEMS = 10_000;
const MAX_OPENAI_TOOLS = 512;
const MAX_OPENAI_ID_LENGTH = 512;
const MAX_OPENAI_METADATA_VALUE_LENGTH = 16 * 1024;

function openAiCode(prefix: string, value: unknown): string {
  return `${prefix}:${typeof value === "string" && OPENAI_CODE_SUFFIX.test(value) ? value : "other"}`;
}

function openAiRecord(value: unknown, code = "invalid_openai_request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodingProxyError(400, code);
  return value as Record<string, unknown>;
}

function openAiOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code = "invalid_openai_request",
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new CodingProxyError(400, code);
}

function openAiString(value: unknown, maxLength: number, code = "invalid_openai_request"): void {
  if (typeof value !== "string" || value.length > maxLength) throw new CodingProxyError(400, code);
}

function openAiOptional(value: unknown, check: (value: unknown) => void): void {
  if (value !== undefined) check(value);
}

function openAiId(value: unknown): void {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_OPENAI_ID_LENGTH) {
    throw new CodingProxyError(400, "invalid_openai_request");
  }
}

function openAiToolName(value: unknown, code = "invalid_openai_request"): void {
  if (typeof value !== "string" || !OPENAI_TOOL_NAME.test(value)) throw new CodingProxyError(400, code);
}

function validateOpenAiFunctionTool(tool: Record<string, unknown>): void {
  openAiOnlyKeys(tool, ["type", "name", "description", "strict", "parameters"], "invalid_openai_tool");
  openAiToolName(tool.name, "invalid_openai_tool");
  openAiOptional(tool.description, (value) => openAiString(value, MAX_TOOL_TEXT_BYTES, "invalid_openai_tool"));
  if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
    throw new CodingProxyError(400, "invalid_openai_tool");
  }
  openAiOptional(tool.parameters, (value) => openAiRecord(value, "invalid_openai_tool"));
}

function validateOpenAiCustomTool(tool: Record<string, unknown>): void {
  openAiOnlyKeys(tool, ["type", "name", "description", "format"], "invalid_openai_tool");
  openAiToolName(tool.name, "invalid_openai_tool");
  openAiOptional(tool.description, (value) => openAiString(value, MAX_TOOL_TEXT_BYTES, "invalid_openai_tool"));
  if (tool.format === undefined) return;
  const format = openAiRecord(tool.format, "invalid_openai_tool");
  if (format.type === "text") return openAiOnlyKeys(format, ["type"], "invalid_openai_tool");
  openAiOnlyKeys(format, ["type", "syntax", "definition"], "invalid_openai_tool");
  if (format.type !== "grammar" || typeof format.syntax !== "string" || !OPENAI_GRAMMAR_SYNTAXES.has(format.syntax)) {
    throw new CodingProxyError(400, "invalid_openai_tool");
  }
  openAiString(format.definition, MAX_TOOL_TEXT_BYTES, "invalid_openai_tool");
}

function validateOpenAiTools(value: unknown, count: { value: number }, nested = false): void {
  if (!Array.isArray(value)) throw new CodingProxyError(400, "invalid_openai_tool");
  for (const candidate of value) {
    if (++count.value > MAX_OPENAI_TOOLS) throw new CodingProxyError(400, "invalid_openai_tool");
    const tool = openAiRecord(candidate, "invalid_openai_tool");
    if (tool.type === "function") {
      validateOpenAiFunctionTool(tool);
    } else if (tool.type === "custom") {
      validateOpenAiCustomTool(tool);
    } else if (tool.type === "namespace" && !nested) {
      openAiOnlyKeys(tool, ["type", "name", "description", "tools"], "invalid_openai_tool");
      openAiToolName(tool.name, "invalid_openai_tool");
      openAiOptional(tool.description, (value) => openAiString(value, MAX_TOOL_TEXT_BYTES, "invalid_openai_tool"));
      validateOpenAiTools(tool.tools, count, true);
    } else {
      throw new CodingProxyError(400, openAiCode("openai_tool_not_allowed", tool.type));
    }
  }
}

function validateOpenAiContentPart(value: unknown, allowed: ReadonlySet<string>): void {
  const part = openAiRecord(value);
  if (typeof part.type !== "string" || !allowed.has(part.type)) {
    throw new CodingProxyError(400, openAiCode("openai_input_not_allowed", part.type));
  }
  if (part.type === "input_image") {
    if (part.file_id !== undefined || typeof part.image_url !== "string" || !OPENAI_INLINE_IMAGE.test(part.image_url)) {
      throw new CodingProxyError(400, "openai_remote_input_not_allowed");
    }
    openAiOnlyKeys(part, ["type", "image_url", "detail"]);
    if (part.detail !== undefined && (typeof part.detail !== "string" || !OPENAI_IMAGE_DETAILS.has(part.detail))) {
      throw new CodingProxyError(400, "invalid_openai_request");
    }
  } else if (part.type === "encrypted_content") {
    openAiOnlyKeys(part, ["type", "encrypted_content"]);
    openAiString(part.encrypted_content, PROXY_MAX_BODY_BYTES);
  } else {
    openAiOnlyKeys(part, ["type", "text"]);
    openAiString(part.text, PROXY_MAX_BODY_BYTES);
  }
}

function validateOpenAiContent(value: unknown, allowed: ReadonlySet<string>, allowString = true): void {
  if (typeof value === "string" && allowString) return;
  if (!Array.isArray(value) || value.length > MAX_OPENAI_ITEMS)
    throw new CodingProxyError(400, "invalid_openai_request");
  for (const part of value) validateOpenAiContentPart(part, allowed);
}

function validateOpenAiTextParts(value: unknown, type: string): void {
  if (!Array.isArray(value) || value.length > MAX_OPENAI_ITEMS)
    throw new CodingProxyError(400, "invalid_openai_request");
  for (const candidate of value) {
    const part = openAiRecord(candidate);
    openAiOnlyKeys(part, ["type", "text"]);
    if (part.type !== type) throw new CodingProxyError(400, openAiCode("openai_input_not_allowed", part.type));
    openAiString(part.text, PROXY_MAX_BODY_BYTES);
  }
}

function validateOpenAiInputItem(value: unknown, toolCount: { value: number }): void {
  const item = openAiRecord(value);
  switch (item.type) {
    case undefined:
    case "message": {
      openAiOnlyKeys(item, ["type", "id", "role", "content", "phase"]);
      openAiOptional(item.id, openAiId);
      if (typeof item.role !== "string" || !OPENAI_MESSAGE_ROLES.has(item.role)) {
        throw new CodingProxyError(400, "invalid_openai_request");
      }
      if (item.phase !== undefined && (typeof item.phase !== "string" || !OPENAI_MESSAGE_PHASES.has(item.phase))) {
        throw new CodingProxyError(400, "invalid_openai_request");
      }
      validateOpenAiContent(item.content, item.role === "assistant" ? OPENAI_ASSISTANT_PARTS : OPENAI_INPUT_PARTS);
      return;
    }
    case "reasoning":
      openAiOnlyKeys(item, ["type", "id", "summary", "content", "encrypted_content"]);
      openAiOptional(item.id, openAiId);
      validateOpenAiTextParts(item.summary, "summary_text");
      if (item.content !== undefined && item.content !== null) validateOpenAiTextParts(item.content, "reasoning_text");
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        openAiString(item.encrypted_content, PROXY_MAX_BODY_BYTES);
      }
      return;
    case "function_call":
      openAiOnlyKeys(item, ["type", "id", "call_id", "name", "namespace", "arguments"]);
      openAiOptional(item.id, openAiId);
      openAiId(item.call_id);
      openAiToolName(item.name);
      openAiOptional(item.namespace, (value) => openAiToolName(value));
      openAiString(item.arguments, PROXY_MAX_BODY_BYTES);
      return;
    case "custom_tool_call":
      openAiOnlyKeys(item, ["type", "id", "status", "call_id", "name", "input"]);
      openAiOptional(item.id, openAiId);
      openAiOptional(item.status, (value) => openAiString(value, 64));
      openAiId(item.call_id);
      openAiToolName(item.name);
      openAiString(item.input, PROXY_MAX_BODY_BYTES);
      return;
    case "function_call_output":
    case "custom_tool_call_output":
      openAiOnlyKeys(
        item,
        item.type === "function_call_output"
          ? ["type", "id", "call_id", "output"]
          : ["type", "id", "call_id", "name", "output"],
      );
      openAiOptional(item.id, openAiId);
      openAiId(item.call_id);
      openAiOptional(item.name, (value) => openAiToolName(value));
      validateOpenAiContent(item.output, OPENAI_INPUT_PARTS);
      return;
    case "agent_message":
      openAiOnlyKeys(item, ["type", "id", "author", "recipient", "content"]);
      openAiOptional(item.id, openAiId);
      openAiOptional(item.author, (value) => openAiString(value, MAX_OPENAI_ID_LENGTH));
      openAiOptional(item.recipient, (value) => openAiString(value, MAX_OPENAI_ID_LENGTH));
      validateOpenAiContent(item.content, OPENAI_AGENT_MESSAGE_PARTS, false);
      return;
    case "additional_tools":
      openAiOnlyKeys(item, ["type", "id", "role", "tools"]);
      openAiOptional(item.id, openAiId);
      if (item.role !== undefined && item.role !== "developer")
        throw new CodingProxyError(400, "invalid_openai_request");
      validateOpenAiTools(item.tools, toolCount);
      return;
    default:
      throw new CodingProxyError(400, openAiCode("openai_input_not_allowed", item.type));
  }
}

function validateOpenAiReasoning(value: unknown): void {
  const reasoning = openAiRecord(value, "openai_reasoning_not_allowed");
  openAiOnlyKeys(reasoning, ["effort", "summary", "context"], "openai_reasoning_not_allowed");
  for (const [key, allowed] of [
    ["effort", OPENAI_REASONING_EFFORTS],
    ["summary", OPENAI_REASONING_SUMMARIES],
    ["context", OPENAI_REASONING_CONTEXTS],
  ] as const) {
    const setting = reasoning[key];
    if (setting !== undefined && (typeof setting !== "string" || !allowed.has(setting))) {
      throw new CodingProxyError(400, "openai_reasoning_not_allowed");
    }
  }
}

function validateOpenAiText(value: unknown): void {
  const text = openAiRecord(value, "openai_text_not_allowed");
  openAiOnlyKeys(text, ["verbosity", "format"], "openai_text_not_allowed");
  if (text.verbosity !== undefined && (typeof text.verbosity !== "string" || !OPENAI_VERBOSITIES.has(text.verbosity))) {
    throw new CodingProxyError(400, "openai_text_not_allowed");
  }
  if (text.format === undefined) return;
  const format = openAiRecord(text.format, "openai_text_not_allowed");
  if (format.type === "text") return openAiOnlyKeys(format, ["type"], "openai_text_not_allowed");
  openAiOnlyKeys(format, ["type", "name", "schema", "strict", "description"], "openai_text_not_allowed");
  if (format.type !== "json_schema" || typeof format.name !== "string" || !OPENAI_TOOL_NAME.test(format.name)) {
    throw new CodingProxyError(400, "openai_text_not_allowed");
  }
  openAiRecord(format.schema, "openai_text_not_allowed");
  if (format.strict !== undefined && typeof format.strict !== "boolean") {
    throw new CodingProxyError(400, "openai_text_not_allowed");
  }
  openAiOptional(format.description, (value) => openAiString(value, MAX_TOOL_TEXT_BYTES, "openai_text_not_allowed"));
}

function validateOpenAiClientMetadata(value: unknown): void {
  const metadata = openAiRecord(value);
  for (const [key, entry] of Object.entries(metadata)) {
    if (!OPENAI_CLIENT_METADATA_KEYS.has(key)) {
      throw new CodingProxyError(400, openAiCode("openai_client_metadata_key_not_allowed", key));
    }
    openAiString(entry, MAX_OPENAI_METADATA_VALUE_LENGTH);
  }
}

function validateOpenAiBody(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (!OPENAI_REQUEST_KEYS.has(key))
      throw new CodingProxyError(400, openAiCode("openai_request_key_not_allowed", key));
  }
  if (body.background !== undefined && body.background !== false) {
    throw new CodingProxyError(400, body.background === true ? "background_not_allowed" : "invalid_openai_request");
  }
  if (body.service_tier !== undefined) {
    if (typeof body.service_tier !== "string" || !OPENAI_SERVICE_TIERS.has(body.service_tier)) {
      throw new CodingProxyError(400, "service_tier_not_allowed");
    }
  }
  if (body.store !== undefined && typeof body.store !== "boolean") {
    throw new CodingProxyError(400, "invalid_openai_request");
  }
  openAiOptional(body.instructions, (value) => openAiString(value, PROXY_MAX_BODY_BYTES));
  const toolCount = { value: 0 };
  if (body.tools !== undefined) validateOpenAiTools(body.tools, toolCount);
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice !== "string" || !OPENAI_TOOL_CHOICES.has(body.tool_choice)) {
      throw new CodingProxyError(400, "openai_tool_choice_not_allowed");
    }
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") {
    throw new CodingProxyError(400, "invalid_openai_request");
  }
  openAiOptional(body.reasoning, validateOpenAiReasoning);
  if (body.include !== undefined) {
    const include = body.include;
    if (
      !Array.isArray(include) ||
      new Set(include).size !== include.length ||
      include.some((entry) => typeof entry !== "string" || !OPENAI_INCLUDES.has(entry))
    ) {
      throw new CodingProxyError(400, "openai_include_not_allowed");
    }
  }
  openAiOptional(body.prompt_cache_key, (value) => openAiString(value, MAX_OPENAI_ID_LENGTH));
  openAiOptional(body.text, validateOpenAiText);
  openAiOptional(body.client_metadata, validateOpenAiClientMetadata);
  if (typeof body.input === "string") return;
  if (!Array.isArray(body.input) || body.input.length > MAX_OPENAI_ITEMS) {
    throw new CodingProxyError(400, "invalid_openai_request");
  }
  for (const item of body.input) validateOpenAiInputItem(item, toolCount);
}

function parseOpenAiRequest(rawBody: string): ParsedRequest {
  if (Buffer.byteLength(rawBody) > PROXY_MAX_BODY_BYTES) throw new CodingProxyError(413, "payload_too_large");
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new CodingProxyError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodingProxyError(400, "expected_json_object");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.model !== "string" || !body.model) throw new CodingProxyError(400, "model_required");
  const maxOutputTokens = body.max_output_tokens ?? PROXY_DEFAULT_MAX_OUTPUT_TOKENS;
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > PROXY_MAX_OUTPUT_TOKENS
  ) {
    throw new CodingProxyError(400, "invalid_max_output_tokens");
  }
  if (body.stream !== true && body.stream !== false) throw new CodingProxyError(400, "stream_required");
  validateOpenAiBody(body);
  const normalized = { ...body, max_output_tokens: maxOutputTokens, store: false, background: false };
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > PROXY_MAX_BODY_BYTES) throw new CodingProxyError(413, "payload_too_large");
  return {
    body: normalized,
    encoded,
    model: body.model,
    maxOutputTokens,
    stream: body.stream,
    fingerprint: fingerprintRequest(encoded),
  };
}

function record(value: unknown, code = "invalid_anthropic_request"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodingProxyError(400, code);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
}

function validateCacheControl(value: unknown): void {
  const cache = record(value);
  onlyKeys(cache, ["type"]);
  if (cache.type !== "ephemeral") throw new CodingProxyError(400, "unsupported_anthropic_feature");
}

function validateTextBlock(value: unknown): void {
  const block = record(value);
  onlyKeys(block, ["type", "text", "cache_control"]);
  if (block.type !== "text" || typeof block.text !== "string") {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
  if (block.cache_control !== undefined) validateCacheControl(block.cache_control);
}

function validateTextBlocks(value: unknown): void {
  if (!Array.isArray(value) || value.length > 10_000) throw new CodingProxyError(400, "invalid_anthropic_request");
  for (const block of value) validateTextBlock(block);
}

function validateCommandInput(value: unknown): void {
  const input = record(value, "unsupported_anthropic_feature");
  onlyKeys(input, ["command", "timeout_ms"]);
  if (
    typeof input.command !== "string" ||
    input.command.length < 1 ||
    Buffer.byteLength(input.command) > MAX_COMMAND_BYTES
  ) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
  if (
    input.timeout_ms !== undefined &&
    (typeof input.timeout_ms !== "number" ||
      !Number.isSafeInteger(input.timeout_ms) ||
      input.timeout_ms < 1_000 ||
      input.timeout_ms > MAX_COMMAND_TIMEOUT_MS)
  ) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
}

function validateCommandTool(value: unknown): void {
  const tool = record(value, "tools_not_allowed");
  onlyKeys(tool, ["name", "description", "input_schema", "cache_control", "type"]);
  if (
    tool.name !== WARDBY_COMMAND_TOOL ||
    typeof tool.description !== "string" ||
    tool.description.length > MAX_TOOL_TEXT_BYTES ||
    (tool.type !== undefined && tool.type !== "custom")
  ) {
    throw new CodingProxyError(400, "tools_not_allowed");
  }
  record(tool.input_schema, "tools_not_allowed");
  if (tool.cache_control !== undefined) validateCacheControl(tool.cache_control);
}

function validateStructuredOutputTool(value: unknown): void {
  const tool = record(value, "tools_not_allowed");
  onlyKeys(tool, ["name", "description", "input_schema", "cache_control", "type"]);
  if (
    tool.name !== STRUCTURED_OUTPUT_TOOL ||
    typeof tool.description !== "string" ||
    tool.description.length > MAX_TOOL_TEXT_BYTES ||
    (tool.type !== undefined && tool.type !== "custom")
  ) {
    throw new CodingProxyError(400, "tools_not_allowed");
  }
  record(tool.input_schema, "tools_not_allowed");
  if (tool.cache_control !== undefined) validateCacheControl(tool.cache_control);
}

function validateApprovedTool(value: unknown): void {
  const tool = record(value, "tools_not_allowed");
  if (tool.name === WARDBY_COMMAND_TOOL) return validateCommandTool(tool);
  if (tool.name === STRUCTURED_OUTPUT_TOOL) return validateStructuredOutputTool(tool);
  throw new CodingProxyError(400, "tools_not_allowed");
}

function validateToolUseBlock(value: Record<string, unknown>): void {
  onlyKeys(value, ["type", "id", "name", "input"]);
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 512) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
  if (value.name === WARDBY_COMMAND_TOOL) return validateCommandInput(value.input);
  if (value.name === STRUCTURED_OUTPUT_TOOL) return void record(value.input, "unsupported_anthropic_feature");
  throw new CodingProxyError(400, "unsupported_anthropic_feature");
}

function validateToolResultBlock(value: Record<string, unknown>): void {
  onlyKeys(value, ["type", "tool_use_id", "content", "is_error", "cache_control"]);
  if (typeof value.tool_use_id !== "string" || value.tool_use_id.length < 1 || value.tool_use_id.length > 512) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
  if (typeof value.content === "string") {
    if (value.content.length > MAX_TOOL_TEXT_BYTES) throw new CodingProxyError(400, "unsupported_anthropic_feature");
  } else {
    validateTextBlocks(value.content);
  }
  if (value.is_error !== undefined && typeof value.is_error !== "boolean") {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
  if (value.cache_control !== undefined) validateCacheControl(value.cache_control);
}

function validateThinkingBlock(value: Record<string, unknown>): void {
  onlyKeys(value, ["type", "thinking", "signature"]);
  if (typeof value.thinking !== "string" || typeof value.signature !== "string") {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
}

function validateMessageBlocks(value: unknown, role: unknown): void {
  if (!Array.isArray(value) || value.length > 10_000) throw new CodingProxyError(400, "invalid_anthropic_request");
  for (const candidate of value) {
    const block = record(candidate);
    if (block.type === "text") {
      validateTextBlock(block);
    } else if (block.type === "tool_use" && role === "assistant") {
      validateToolUseBlock(block);
    } else if (block.type === "tool_result" && role === "user") {
      validateToolResultBlock(block);
    } else if (block.type === "thinking" && role === "assistant") {
      validateThinkingBlock(block);
    } else {
      throw new CodingProxyError(400, "unsupported_anthropic_feature");
    }
  }
}

function parseAnthropicBeta(value: string | undefined): { header?: string; values: Set<string> } {
  if (value === undefined) return { values: new Set() };
  if (value.length < 1 || value.length > 2_048) throw new CodingProxyError(400, "invalid_anthropic_beta");
  const values = value.split(",").map((candidate) => candidate.trim());
  const unique = new Set(values);
  if (
    values.some((candidate) => !candidate || !APPROVED_ANTHROPIC_BETAS.has(candidate)) ||
    unique.size !== values.length
  ) {
    throw new CodingProxyError(400, "invalid_anthropic_beta");
  }
  const normalized = [...unique].sort();
  return { header: normalized.join(","), values: new Set(normalized) };
}

/**
 * Models whose catalog entry says `thinkingMode: "manual"` take manual extended thinking
 * (`{type: "enabled", budget_tokens}`) instead of adaptive thinking, and no effort level (Claude
 * Haiku 4.5 in the shipped catalog, which returns a 400 for adaptive thinking). The pinned Claude
 * Agent SDK sends it `budget_tokens` = max_tokens - 1 and no `output_config`
 * (fixtures/anthropic-sdk-request-haiku-4-5.json). Every other model stays adaptive-only.
 */
/** Anthropic's minimum manual thinking budget. */
const MIN_THINKING_BUDGET_TOKENS = 1024;

function requireAnthropicBeta(
  values: Set<string>,
  beta: (typeof CLAUDE_CODE_ANTHROPIC_BETAS)[number] | (typeof OPTIONAL_ANTHROPIC_BETAS)[number],
): void {
  if (!values.has(beta)) throw new CodingProxyError(400, "anthropic_beta_required");
}

/** What the session's catalog entry allows a request for its model to ask for. */
interface AnthropicModelShape {
  thinkingMode: ThinkingMode;
  /** Effort levels the model accepts; a request may send any of them, and none when empty. */
  efforts: readonly string[];
}

/**
 * An `output_config` (top-level, or on an effort-only system message): only an effort level, and
 * only one the run's catalog entry lists. Budget is still reserved from max_tokens per request, so
 * effort only changes how much of it the model uses. Effort doesn't exist on a manual-thinking
 * model; the SDK never sends it there.
 */
function validateEffortConfig(
  value: unknown,
  { thinkingMode, efforts }: AnthropicModelShape,
  betas: Set<string>,
): void {
  if (thinkingMode === "manual") throw new CodingProxyError(400, "unsupported_anthropic_feature");
  requireAnthropicBeta(betas, "effort-2025-11-24");
  const output = record(value);
  onlyKeys(output, ["effort"]);
  if (typeof output.effort !== "string" || !efforts.includes(output.effort)) {
    throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
}

function parseAnthropicRequest(
  rawBody: string,
  betaHeader: string | undefined,
  shape: AnthropicModelShape,
): ParsedRequest {
  const beta = parseAnthropicBeta(betaHeader);
  if (Buffer.byteLength(rawBody) > PROXY_MAX_BODY_BYTES) throw new CodingProxyError(413, "payload_too_large");
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new CodingProxyError(400, "invalid_json");
  }
  const body = record(value, "expected_json_object");
  onlyKeys(body, [
    "model",
    "messages",
    "system",
    "tools",
    "metadata",
    "max_tokens",
    "thinking",
    "context_management",
    "output_config",
    "stream",
  ]);
  if (typeof body.model !== "string" || !body.model) throw new CodingProxyError(400, "model_required");
  if (
    typeof body.max_tokens !== "number" ||
    !Number.isSafeInteger(body.max_tokens) ||
    body.max_tokens < 1 ||
    body.max_tokens > PROXY_MAX_OUTPUT_TOKENS
  ) {
    throw new CodingProxyError(400, "invalid_max_output_tokens");
  }
  if (body.stream !== true && body.stream !== false) throw new CodingProxyError(400, "stream_required");
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 10_000) {
    throw new CodingProxyError(400, "invalid_anthropic_request");
  }
  if (body.system !== undefined) validateTextBlocks(body.system);
  for (const value of body.messages) {
    const message = record(value);
    onlyKeys(message, message.role === "system" ? ["role", "content", "output_config"] : ["role", "content"]);
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      throw new CodingProxyError(400, "unsupported_anthropic_feature");
    }
    if (message.role === "system") {
      requireAnthropicBeta(beta.values, "mid-conversation-system-2026-04-07");
      if (message.output_config !== undefined) {
        // An effort-only system message (Claude Opus 5.5's per-turn effort): no content at all, and
        // the same effort rule as the top-level output_config.
        requireAnthropicBeta(beta.values, "per-turn-control-2026-07-01");
        if (!Array.isArray(message.content) || message.content.length !== 0) {
          throw new CodingProxyError(400, "unsupported_anthropic_feature");
        }
        validateEffortConfig(message.output_config, shape, beta.values);
        continue;
      }
      if (typeof message.content === "string") {
        if (Buffer.byteLength(message.content) > MAX_TOOL_TEXT_BYTES) {
          throw new CodingProxyError(400, "unsupported_anthropic_feature");
        }
        continue;
      }
    }
    validateMessageBlocks(message.content, message.role);
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 2) throw new CodingProxyError(400, "tools_not_allowed");
    const names = new Set<string>();
    for (const tool of body.tools) {
      const definition = record(tool, "tools_not_allowed");
      if (typeof definition.name !== "string" || names.has(definition.name))
        throw new CodingProxyError(400, "tools_not_allowed");
      names.add(definition.name);
      validateApprovedTool(definition);
    }
  }
  if (body.metadata !== undefined) {
    const metadata = record(body.metadata);
    onlyKeys(metadata, ["user_id"]);
    if (typeof metadata.user_id !== "string") throw new CodingProxyError(400, "invalid_anthropic_request");
  }
  const manualThinking = shape.thinkingMode === "manual";
  if (body.thinking !== undefined) {
    requireAnthropicBeta(beta.values, "interleaved-thinking-2025-05-14");
    requireAnthropicBeta(beta.values, "thinking-token-count-2026-05-13");
    const thinking = record(body.thinking);
    if (manualThinking) {
      onlyKeys(thinking, ["type", "budget_tokens"]);
      const budget = thinking.budget_tokens;
      if (
        thinking.type !== "enabled" ||
        typeof budget !== "number" ||
        !Number.isSafeInteger(budget) ||
        budget < MIN_THINKING_BUDGET_TOKENS ||
        budget >= body.max_tokens
      ) {
        throw new CodingProxyError(400, "unsupported_anthropic_feature");
      }
    } else {
      onlyKeys(thinking, ["type"]);
      if (thinking.type !== "adaptive") throw new CodingProxyError(400, "unsupported_anthropic_feature");
    }
  }
  if (body.context_management !== undefined) {
    requireAnthropicBeta(beta.values, "context-management-2025-06-27");
    const context = record(body.context_management);
    onlyKeys(context, ["edits"]);
    const edits = context.edits;
    if (!Array.isArray(edits) || edits.length !== 1) throw new CodingProxyError(400, "unsupported_anthropic_feature");
    const edit = record(edits[0]);
    onlyKeys(edit, ["type", "keep"]);
    if (edit.type !== "clear_thinking_20251015" || edit.keep !== "all") {
      throw new CodingProxyError(400, "unsupported_anthropic_feature");
    }
  }
  if (body.output_config !== undefined) validateEffortConfig(body.output_config, shape, beta.values);
  const normalized: Record<string, unknown> = { ...body };
  delete normalized.metadata;
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > PROXY_MAX_BODY_BYTES) throw new CodingProxyError(413, "payload_too_large");
  return {
    body: normalized,
    encoded,
    model: body.model,
    maxOutputTokens: body.max_tokens,
    stream: body.stream,
    fingerprint: fingerprintRequest(`${beta.header ?? ""}\n${encoded}`),
    anthropicBeta: beta.header,
  };
}

function parseRequest(
  protocol: ProxyProtocol,
  rawBody: string,
  anthropicBeta: string | undefined,
  shape: AnthropicModelShape,
): ParsedRequest {
  if (protocol !== "anthropic-messages" && anthropicBeta !== undefined) {
    throw new CodingProxyError(400, "invalid_anthropic_beta");
  }
  try {
    return protocol === "anthropic-messages"
      ? parseAnthropicRequest(rawBody, anthropicBeta, shape)
      : parseOpenAiRequest(rawBody);
  } catch (error) {
    // JSON nested deeply enough (inside a free-form tool schema, say) overflows
    // the stack when re-encoded. It is the client's request, not a proxy fault.
    if (error instanceof RangeError) throw new CodingProxyError(400, "request_nesting_too_deep");
    throw error;
  }
}

function safeRequestKey(value: string | undefined, fingerprint: string): string {
  if (value === undefined) return `body:${fingerprint}`;
  if (!REQUEST_KEY_PATTERN.test(value)) throw new CodingProxyError(400, "invalid_idempotency_key");
  return value;
}

function errorBody(code: string): Uint8Array {
  return Buffer.from(JSON.stringify({ error: { type: code, message: code } }));
}

async function safeWrite(sink: ProxyResponseSink, chunk: Uint8Array, connected: { value: boolean }): Promise<void> {
  if (!connected.value) return;
  try {
    await sink.write(chunk);
  } catch {
    connected.value = false;
  }
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) throw new Error("missing_upstream_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error("upstream_response_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export class CodingProxy {
  private readonly ledger: ProxyLedger;
  private readonly credentials: CredentialResolver;
  private readonly upstreamUrls: Record<ProxyProtocol, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly audit: ProxyAuditSink;
  private readonly getPricing: (model: string, protocol: ProxyProtocol) => ModelPricing;
  private readonly priceVersion: string;
  private readonly activeRequests = new Map<string, Set<AbortController>>();
  private readonly onModelRequest?: (runId: string) => Promise<void>;

  constructor(options: CodingProxyOptions) {
    this.ledger = options.ledger;
    this.onModelRequest = options.onModelRequest;
    this.credentials = options.credentials;
    this.upstreamUrls = {
      "openai-responses": options.upstreamUrl ?? "https://api.openai.com/v1/responses",
      "anthropic-messages": options.anthropicUpstreamUrl ?? "https://api.anthropic.com/v1/messages?beta=true",
    };
    const upstreamHosts = Object.values(this.upstreamUrls).map((url) => new URL(url).hostname);
    this.fetchImpl =
      options.fetch ??
      createPinnedProxyFetch({
        allowedHosts: options.upstreamAllowedHosts ?? upstreamHosts,
      });
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit ?? (() => undefined);
    // The fallback for sessions created before the catalog (no stored terms): the
    // proxy has no catalog store, only the shipped catalog compiled into it.
    this.getPricing =
      options.pricing ??
      ((model, protocol) => {
        const entry = shippedCatalog().require(model);
        const expected = protocol === "anthropic-messages" ? "anthropic" : "openai";
        if (entry.provider !== expected) throw new Error("unknown_model");
        return entry;
      });
    this.priceVersion = options.pricingVersion ?? `shipped:${SHIPPED_CATALOG_VERSION}`;
  }

  async createSession(input: CreateCodingProxySession): Promise<CreatedCodingProxySession> {
    if (input.protocol !== "openai-responses" && input.protocol !== "anthropic-messages") {
      throw new Error("invalid_proxy_protocol");
    }
    const models = [...new Set(input.allowedModels)];
    if (models.length < 1 || models.length > 8 || models.some((model) => !model || model.length > 100)) {
      throw new Error("invalid_proxy_model_allowlist");
    }
    if (input.terms) {
      const expected = input.protocol === "anthropic-messages" ? "anthropic" : "openai";
      if (models.length !== 1 || input.terms.entry.modelId !== models[0] || input.terms.entry.provider !== expected) {
        throw new Error("invalid_proxy_model_terms");
      }
    } else {
      for (const model of models) this.getPricing(model, input.protocol);
    }
    if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) throw new Error("invalid_proxy_budget");
    if (input.deadlineAt.getTime() <= this.now().getTime()) throw new Error("invalid_proxy_deadline");
    if (!input.credentialRef || input.credentialRef.length > 200) throw new Error("invalid_proxy_credential_reference");
    const capability = `rrp_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    const registryTokenHash = capabilityHash(deriveRegistryToken(capability));
    await this.ledger.createSession({
      id,
      runId: input.runId,
      capabilityHash: capabilityHash(capability),
      credentialRef: input.credentialRef,
      protocol: input.protocol,
      allowedModels: models,
      deadlineAt: input.deadlineAt,
      budgetUsd: input.budgetUsd,
      registryTokenHash,
      terms: input.terms,
    });
    this.audit({ type: "session.created", runId: input.runId });
    return {
      id,
      runId: input.runId,
      capability,
      protocol: input.protocol,
      allowedModels: models,
      deadlineAt: input.deadlineAt,
      budgetUsd: input.budgetUsd,
    };
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.ledger.cancelSession(sessionId);
    for (const controller of this.activeRequests.get(sessionId) ?? []) controller.abort();
  }

  /** Whether this session's run was refused a model request for budget. */
  budgetExhausted(sessionId: string): Promise<boolean> {
    return this.ledger.budgetExhausted(sessionId);
  }

  /** The numbers behind this session's first budget refusal, if any. */
  budgetRefusal(sessionId: string): Promise<ProxyRefusalRecord | null> {
    return this.ledger.budgetRefusal(sessionId);
  }

  /** The code of the first upstream failure relayed for this session's run, if any. */
  upstreamFailure(sessionId: string): Promise<string | null> {
    return this.ledger.upstreamFailure(sessionId);
  }

  async execute(input: ExecuteProxyRequest, sink: ProxyResponseSink): Promise<void> {
    const session = await this.authenticate(input.bearer);
    // The run's agent exists from its first model request on (both protocols arrive here).
    if (this.onModelRequest) await this.onModelRequest(session.runId).catch(() => undefined);
    if (session.protocol !== input.protocol) {
      this.audit({ type: "request.rejected", runId: session.runId, reason: "protocol_mismatch" });
      throw new CodingProxyError(403, "protocol_mismatch");
    }
    // A session from before the model catalog has no stored entry: take the shape from the shipped one.
    const entry = session.terms?.entry ?? shippedCatalog().get(session.allowedModels[0]);
    const shape: AnthropicModelShape = {
      thinkingMode: entry?.thinkingMode ?? "adaptive",
      efforts: entry?.efforts ?? [],
    };
    let parsed: ParsedRequest;
    try {
      parsed = parseRequest(input.protocol, input.rawBody, input.anthropicBeta, shape);
    } catch (error) {
      // The session is already authenticated and no credential has been
      // resolved; record the refusal against the run so a smuggling attempt
      // is attributable, then refuse.
      if (error instanceof CodingProxyError) {
        this.audit({ type: "request.rejected", runId: session.runId, status: error.status, reason: error.code });
      }
      throw error;
    }
    if (!session.allowedModels.includes(parsed.model)) {
      this.audit({ type: "request.rejected", runId: session.runId, model: parsed.model, reason: "model_not_allowed" });
      throw new CodingProxyError(403, "model_not_allowed");
    }
    let terms: { pricing: ModelPricing; version: string };
    try {
      terms = this.termsFor(session, parsed.model);
    } catch {
      this.audit({ type: "request.rejected", runId: session.runId, model: parsed.model, reason: "unknown_model" });
      throw new CodingProxyError(400, "unknown_model");
    }
    const requestKey = safeRequestKey(input.requestKey, parsed.fingerprint);
    const snapshot = pricingSnapshot(terms.version, terms.pricing);
    const bodyBytes = Buffer.byteLength(parsed.encoded);
    const conversation = conversationKey(session.protocol, parsed.body);
    // A failed lookup holds the ceiling: never a reason to fail the request.
    const previous = conversation ? await this.ledger.previousReply(session.id, conversation).catch(() => null) : null;
    const holdNow = this.now();
    const hold = estimateHold({
      protocol: session.protocol,
      model: parsed.model,
      bodyBytes,
      maxOutputTokens: parsed.maxOutputTokens,
      pricing: snapshot,
      previous,
      now: holdNow,
    });
    // An interrupted reply's input, from the same previous reply and clock as the hold.
    const previousPrompt = previousInput({ model: parsed.model, bodyBytes, previous, pricing: snapshot, now: holdNow });
    const reservationUsd = hold.holdUsd;
    const holdAudit = {
      reservationUsd,
      ceilingUsd: hold.ceilingUsd,
      reservationBasis: hold.basis,
      ...(hold.fallback ? { holdFallback: hold.fallback } : {}),
      ...(hold.cachedTokens !== undefined
        ? { holdCachedTokens: hold.cachedTokens, holdUncachedTokens: hold.uncachedTokens }
        : {}),
    };
    const reservation = await this.ledger.reserve({
      id: randomUUID(),
      sessionId: session.id,
      requestKey,
      requestFingerprint: parsed.fingerprint,
      model: parsed.model,
      reservationUsd,
      requestBytes: bodyBytes,
      ceilingUsd: hold.ceilingUsd,
      reservationBasis: hold.basis,
      conversationKey: conversation,
      pricing: snapshot,
      now: this.now(),
    });
    if (reservation.outcome === "inactive") {
      this.audit({ type: "request.rejected", runId: session.runId, reason: reservation.reason });
      throw new CodingProxyError(403, `session_${reservation.reason}`);
    }
    if (reservation.outcome === "budget_exhausted") {
      this.audit({
        type: "request.rejected",
        runId: session.runId,
        model: parsed.model,
        reason: "budget_exhausted",
        ...holdAudit,
        budgetUsd: reservation.details.budgetUsd,
        spentUsd: reservation.details.spentUsd,
        heldReservedUsd: reservation.details.heldReservedUsd,
        heldUncertainUsd: reservation.details.heldUncertainUsd,
        turn: reservation.details.turn,
      });
      throw new CodingProxyError(429, "wardby_budget_exhausted");
    }
    if (reservation.outcome === "duplicate") {
      this.handleDuplicate(session, reservation.request, parsed.fingerprint);
    }
    const request = reservation.request;
    this.audit({
      type: "request.reserved",
      runId: session.runId,
      requestId: request.id,
      model: request.model,
      ...holdAudit,
    });

    let key: string;
    try {
      key = await this.credentials.resolve(session.credentialRef);
      if (!key) throw new Error();
    } catch {
      await this.ledger.release(request.id, 503);
      this.audit({
        type: "request.released",
        runId: session.runId,
        requestId: request.id,
        status: 503,
        reason: "credential_unavailable",
      });
      throw new CodingProxyError(503, "upstream_unavailable");
    }

    const remainingMs = session.deadlineAt.getTime() - this.now().getTime();
    if (remainingMs <= 0) {
      await this.ledger.release(request.id, 403);
      throw new CodingProxyError(403, "session_expired");
    }
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), remainingMs);
    deadlineTimer.unref();
    this.trackActive(session.id, controller);
    const progress: RelayProgress = {
      maxOutputTokens: parsed.maxOutputTokens,
      stream: parsed.stream,
      bodyBytes,
      ...(previousPrompt ? { previousInput: previousPrompt } : {}),
      relayedOutputBytes: 0,
    };
    const cleanupActive = () => {
      clearTimeout(deadlineTimer);
      const active = this.activeRequests.get(session.id);
      active?.delete(controller);
      if (active?.size === 0) this.activeRequests.delete(session.id);
    };

    let upstream: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: parsed.stream ? "text/event-stream" : "application/json",
        // The pinned fetch never decompresses, and the response is relayed as-is.
        "accept-encoding": "identity",
      };
      if (session.protocol === "anthropic-messages") {
        headers["x-api-key"] = key;
        headers["anthropic-version"] = "2023-06-01";
        if (parsed.anthropicBeta) headers["anthropic-beta"] = parsed.anthropicBeta;
      } else {
        headers.authorization = `Bearer ${key}`;
        headers["idempotency-key"] = `${session.id}:${request.id}`;
      }
      upstream = await this.fetchImpl(this.upstreamUrls[session.protocol], {
        method: "POST",
        headers,
        body: parsed.encoded,
        redirect: "error",
        signal: controller.signal,
      });
      progress.responseStarted = true;
    } catch {
      cleanupActive();
      await this.markUncertain(
        session,
        request,
        undefined,
        controller.signal.aborted ? "upstream_aborted" : "upstream_transport",
        {},
        progress,
      );
      throw new CodingProxyError(502, controller.signal.aborted ? "upstream_aborted" : "upstream_transport_error");
    }

    if (!upstream.ok) {
      // Read while the deadline still bounds the body; the body itself is never relayed.
      const code = (await rejectedUpstreamErrorCode(upstream)) ?? `http_${upstream.status}`;
      cleanupActive();
      await this.recordUpstreamFailure(session, code);
      await this.ledger.release(request.id, upstream.status);
      this.audit({
        type: "request.released",
        runId: session.runId,
        requestId: request.id,
        status: upstream.status,
        reason: "upstream_rejected",
      });
      sink.start(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
      await safeWrite(sink, errorBody("upstream_rejected"), { value: true });
      sink.end();
      return;
    }

    try {
      if (parsed.stream) await this.forwardStream(session, request, upstream, sink, progress);
      else await this.forwardJson(session, request, upstream, sink);
    } catch (error) {
      await this.markUncertain(
        session,
        request,
        upstream.status,
        failureReason(error),
        responseHeadersOf(upstream),
        progress,
      );
      sink.destroy();
      throw error instanceof CodingProxyError ? error : new CodingProxyError(502, "invalid_upstream_response");
    } finally {
      cleanupActive();
    }
  }

  /** A session's model terms: its stored catalog entry, or the fallback for sessions from before the catalog. */
  private termsFor(
    session: ProxySession,
    model: string,
  ): { pricing: ModelPricing; version: string; thinkingMode: ThinkingMode } {
    if (session.terms) {
      return {
        pricing: session.terms.entry,
        version: session.terms.version,
        thinkingMode: session.terms.entry.thinkingMode,
      };
    }
    return {
      pricing: this.getPricing(model, session.protocol),
      version: this.priceVersion,
      thinkingMode: shippedCatalog().get(model)?.thinkingMode ?? "adaptive",
    };
  }

  private async authenticate(bearer: string): Promise<ProxySession> {
    if (!bearer || bearer.length > 100) throw new CodingProxyError(401, "invalid_capability");
    const session = await this.ledger.findSessionByCapabilityHash(capabilityHash(bearer));
    if (!session) throw new CodingProxyError(401, "invalid_capability");
    return session;
  }

  private trackActive(sessionId: string, controller: AbortController): void {
    const active = this.activeRequests.get(sessionId) ?? new Set<AbortController>();
    active.add(controller);
    this.activeRequests.set(sessionId, active);
  }

  private handleDuplicate(session: ProxySession, request: ProxyRequest, fingerprint: string): never {
    const reason = request.requestFingerprint === fingerprint ? `duplicate_${request.status}` : "idempotency_conflict";
    this.audit({ type: "request.rejected", runId: session.runId, requestId: request.id, reason });
    throw new CodingProxyError(409, reason);
  }

  private async complete(
    session: ProxySession,
    request: ProxyRequest,
    usage: ProxyUsage,
    upstreamStatus: number,
  ): Promise<void> {
    const costUsd = actualCostUsd(usage, request.pricing);
    await this.ledger.complete(request.id, usage, costUsd, upstreamStatus);
    const overshootUsd = costUsd - request.reservationUsd;
    this.audit({
      type: "response.completed",
      runId: session.runId,
      requestId: request.id,
      model: request.model,
      status: upstreamStatus,
      costUsd,
      reservationUsd: request.reservationUsd,
      ...(overshootUsd > Number.EPSILON ? { reason: "reservation_exceeded", overshootUsd } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    });
    // A cached hold may be exceeded when the cache misses (settled, audited above); the ceiling may not.
    const ceilingUsd = request.ceilingUsd ?? request.reservationUsd;
    if (costUsd > ceilingUsd + Number.EPSILON) {
      await this.ledger.cancelSession(session.id);
      throw new CodingProxyError(502, "reservation_invariant_violated");
    }
  }

  private async forwardJson(
    session: ProxySession,
    request: ProxyRequest,
    upstream: Response,
    sink: ProxyResponseSink,
  ): Promise<void> {
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_JSON_BYTES) {
      throw new Error("upstream_response_too_large");
    }
    const bytes = await readBoundedBody(upstream.body, MAX_UPSTREAM_JSON_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new Error("invalid_upstream_json");
    }
    const usage =
      session.protocol === "anthropic-messages"
        ? parseAnthropicAuthoritativeUsage((value as Record<string, unknown>)?.usage)
        : parseAuthoritativeUsage((value as Record<string, unknown>)?.usage);
    await this.complete(session, request, usage, upstream.status);
    sink.start(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
    await safeWrite(sink, bytes, { value: true });
    sink.end();
  }

  private async forwardStream(
    session: ProxySession,
    request: ProxyRequest,
    upstream: Response,
    sink: ProxyResponseSink,
    progress: RelayProgress,
  ): Promise<void> {
    if (!upstream.body) throw new Error("missing_upstream_body");
    sink.start(upstream.status, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const connected = { value: true };
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedBytes = 0;
    let completed = false;
    let failedWithoutUsage = false;
    const anthropicUsage =
      session.protocol === "anthropic-messages" ? (progress.anthropic = new AnthropicSseUsageTracker()) : undefined;
    const body = upstream.body as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of body) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_UPSTREAM_JSON_BYTES) throw new Error("upstream_response_too_large");
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll("\r\n", "\n");
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const terminal = anthropicUsage ? anthropicUsage.consume(frame) : terminalUsageFromSseFrame(frame);
        if (!terminal.terminal) {
          progress.relayedOutputBytes += relayedTextBytes(frame, session.protocol);
          await safeWrite(sink, Buffer.from(`${frame}\n\n`), connected);
          continue;
        }
        if (!terminal.usage) {
          if (!terminal.failure) throw new Error("terminal_usage_missing");
          // The upstream failed the response and reported no usage. Pass its failure on so the
          // client sees the real error instead of a cut connection; the reservation stays held.
          await this.recordUpstreamFailure(session, terminal.failure);
          if (!completed) {
            await this.markUncertain(
              session,
              request,
              upstream.status,
              `upstream_failed:${terminal.failure}`,
              responseHeadersOf(upstream),
              progress,
            );
          }
          failedWithoutUsage = true;
          await safeWrite(sink, Buffer.from(`${frame}\n\n`), connected);
          continue;
        }
        await this.complete(session, request, terminal.usage, upstream.status);
        completed = true;
        await safeWrite(sink, Buffer.from(`${frame}\n\n`), connected);
      }
    }
    buffer = (buffer + decoder.decode()).replaceAll("\r\n", "\n");
    if (!completed && !failedWithoutUsage) throw new Error("terminal_usage_missing");
    if (buffer) await safeWrite(sink, Buffer.from(buffer), connected);
    if (connected.value) sink.end();
  }

  /** Best effort: the executor reads it to name the failure; it must never break the relay. */
  private async recordUpstreamFailure(session: ProxySession, code: string): Promise<void> {
    await this.ledger.recordUpstreamFailure(session.id, code).catch(() => undefined);
  }

  private async markUncertain(
    session: ProxySession,
    request: ProxyRequest,
    status: number | undefined,
    reason: string,
    headers: { contentType?: string; contentEncoding?: string },
    progress: RelayProgress,
  ): Promise<void> {
    if (progress.marked) return;
    progress.marked = true;
    let estimate = await this.estimateInterrupted(session, request, progress);
    if (estimate) {
      try {
        await this.ledger.markUncertain(request.id, status, estimate);
      } catch {
        // Settling at the estimate failed: mark it uncertain without one, so it keeps its full hold.
        estimate = undefined;
      }
    }
    if (!estimate) await this.ledger.markUncertain(request.id, status);
    this.audit({
      type: "request.uncertain",
      runId: session.runId,
      requestId: request.id,
      status,
      reason,
      ...(estimate ? { estimatedCostUsd: estimate.costUsd } : {}),
      ...headers,
    });
  }

  /**
   * The best known cost of a request that broke before its final usage (interrupted.ts), or
   * undefined when none can be made: the request then keeps its full hold. Never throws.
   */
  private async estimateInterrupted(
    session: ProxySession,
    request: ProxyRequest,
    progress: RelayProgress,
  ): Promise<InterruptedEstimate | undefined> {
    try {
      const hints = await this.ledger.settlementHints(session.id, request.model);
      const estimate = estimateInterrupted(
        {
          ...progress.anthropic?.partial(),
          beforeResponse: progress.stream && !progress.responseStarted,
          relayedOutputBytes: progress.relayedOutputBytes,
          ...hints,
          ...(progress.previousInput ? { previous: progress.previousInput } : {}),
          bodyBytes: progress.bodyBytes,
          reservationUsd: request.reservationUsd,
          maxOutputTokens: progress.maxOutputTokens,
          ceilingUsd: request.ceilingUsd ?? request.reservationUsd,
        },
        request.pricing,
      );
      return Number.isFinite(estimate.costUsd) ? estimate : undefined;
    } catch {
      return undefined;
    }
  }
}

/** OpenAI Responses events whose string `delta` is generated output: text, tool input, reasoning. */
const OPENAI_OUTPUT_DELTAS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
]);

/** The generated-output field of each Anthropic content_block_delta type (signatures are not output). */
const ANTHROPIC_OUTPUT_DELTAS: Record<string, string> = {
  text_delta: "text",
  input_json_delta: "partial_json",
  thinking_delta: "thinking",
};

/**
 * UTF-8 bytes of generated output in a relayed SSE frame: text, tool-call input and thinking or
 * reasoning deltas, which are most of a coding agent's output.
 */
function relayedTextBytes(frame: string, protocol: ProxyProtocol): number {
  if (!frame.includes(protocol === "anthropic-messages" ? "content_block_delta" : ".delta")) return 0;
  try {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const value = JSON.parse(data) as Record<string, unknown> | null;
    if (!value || typeof value.type !== "string") return 0;
    if (protocol === "openai-responses") {
      return OPENAI_OUTPUT_DELTAS.has(value.type) && typeof value.delta === "string"
        ? Buffer.byteLength(value.delta)
        : 0;
    }
    if (value.type !== "content_block_delta") return 0;
    const delta = value.delta as Record<string, unknown> | undefined;
    const field = typeof delta?.type === "string" ? ANTHROPIC_OUTPUT_DELTAS[delta.type] : undefined;
    const text = field ? delta?.[field] : undefined;
    return typeof text === "string" ? Buffer.byteLength(text) : 0;
  } catch {
    return 0;
  }
}

/** The safe error code in a rejected upstream's JSON body, or undefined when it names none or cannot be read. */
async function rejectedUpstreamErrorCode(upstream: Response): Promise<string | undefined> {
  try {
    const bytes = await readBoundedBody(upstream.body, MAX_UPSTREAM_ERROR_BYTES);
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return value && typeof value === "object" ? safeUpstreamErrorCode(value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The fixed code a relay failed with, or a generic one: error messages are not recorded. */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z_]{1,64}$/.test(message) ? message : "stream_read_failed";
}

/** The upstream's content type and encoding, trimmed to a short printable value, for the audit record. */
function responseHeadersOf(upstream: Response): { contentType?: string; contentEncoding?: string } {
  const clean = (value: string | null) =>
    value ? value.replace(/[^\x20-\x7e]/g, "").slice(0, 100) || undefined : undefined;
  const contentType = clean(upstream.headers.get("content-type"));
  const contentEncoding = clean(upstream.headers.get("content-encoding"));
  return { ...(contentType ? { contentType } : {}), ...(contentEncoding ? { contentEncoding } : {}) };
}
