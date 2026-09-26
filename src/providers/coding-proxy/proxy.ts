import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getModelPricing, PRICING_VERSION, type ModelPricing } from "../llm/pricing.js";
import { getAnthropicPricing } from "../llm/pricing-anthropic.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import {
  AnthropicSseUsageTracker,
  actualCostUsd,
  estimateReservationUsd,
  fingerprintRequest,
  parseAnthropicAuthoritativeUsage,
  parseAuthoritativeUsage,
  pricingSnapshot,
  terminalUsageFromSseFrame,
} from "./metering.js";
import { createPinnedProxyFetch } from "./secure-fetch.js";
import type {
  CredentialResolver,
  ProxyAuditSink,
  ProxyLedger,
  ProxyProtocol,
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
const REQUEST_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const APPROVED_ANTHROPIC_BETAS = new Set<string>(CLAUDE_CODE_ANTHROPIC_BETAS);
const WARDBY_COMMAND_TOOL = "mcp__wardby_tools__run_command";
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_TOOL_TEXT_BYTES = 256 * 1024;

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

export function capabilityHash(capability: string): string {
  return createHash("sha256").update(capability).digest("base64url");
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
  if (body.background === true) throw new CodingProxyError(400, "background_not_allowed");
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
      input.timeout_ms > 60_000)
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

function requireAnthropicBeta(values: Set<string>, beta: (typeof CLAUDE_CODE_ANTHROPIC_BETAS)[number]): void {
  if (!values.has(beta)) throw new CodingProxyError(400, "anthropic_beta_required");
}

function parseAnthropicRequest(rawBody: string, betaHeader: string | undefined): ParsedRequest {
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
    onlyKeys(message, ["role", "content"]);
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system") {
      throw new CodingProxyError(400, "unsupported_anthropic_feature");
    }
    if (message.role === "system") {
      requireAnthropicBeta(beta.values, "mid-conversation-system-2026-04-07");
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
  if (body.thinking !== undefined) {
    requireAnthropicBeta(beta.values, "interleaved-thinking-2025-05-14");
    requireAnthropicBeta(beta.values, "thinking-token-count-2026-05-13");
    const thinking = record(body.thinking);
    onlyKeys(thinking, ["type"]);
    if (thinking.type !== "adaptive") throw new CodingProxyError(400, "unsupported_anthropic_feature");
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
  if (body.output_config !== undefined) {
    requireAnthropicBeta(beta.values, "effort-2025-11-24");
    const output = record(body.output_config);
    onlyKeys(output, ["effort"]);
    if (output.effort !== "high") throw new CodingProxyError(400, "unsupported_anthropic_feature");
  }
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

function parseRequest(protocol: ProxyProtocol, rawBody: string, anthropicBeta: string | undefined): ParsedRequest {
  if (protocol !== "anthropic-messages" && anthropicBeta !== undefined) {
    throw new CodingProxyError(400, "invalid_anthropic_beta");
  }
  return protocol === "anthropic-messages"
    ? parseAnthropicRequest(rawBody, anthropicBeta)
    : parseOpenAiRequest(rawBody);
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

  constructor(options: CodingProxyOptions) {
    this.ledger = options.ledger;
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
    this.getPricing =
      options.pricing ??
      ((model, protocol) => (protocol === "anthropic-messages" ? getAnthropicPricing(model) : getModelPricing(model)));
    this.priceVersion = options.pricingVersion ?? PRICING_VERSION;
  }

  async createSession(input: CreateCodingProxySession): Promise<CreatedCodingProxySession> {
    if (input.protocol !== "openai-responses" && input.protocol !== "anthropic-messages") {
      throw new Error("invalid_proxy_protocol");
    }
    const models = [...new Set(input.allowedModels)];
    if (models.length < 1 || models.length > 8 || models.some((model) => !model || model.length > 100)) {
      throw new Error("invalid_proxy_model_allowlist");
    }
    for (const model of models) this.getPricing(model, input.protocol);
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

  async execute(input: ExecuteProxyRequest, sink: ProxyResponseSink): Promise<void> {
    const session = await this.authenticate(input.bearer);
    if (session.protocol !== input.protocol) {
      this.audit({ type: "request.rejected", runId: session.runId, reason: "protocol_mismatch" });
      throw new CodingProxyError(403, "protocol_mismatch");
    }
    const parsed = parseRequest(input.protocol, input.rawBody, input.anthropicBeta);
    if (!session.allowedModels.includes(parsed.model)) {
      this.audit({ type: "request.rejected", runId: session.runId, model: parsed.model, reason: "model_not_allowed" });
      throw new CodingProxyError(403, "model_not_allowed");
    }
    let pricing: ModelPricing;
    try {
      pricing = this.getPricing(parsed.model, session.protocol);
    } catch {
      this.audit({ type: "request.rejected", runId: session.runId, model: parsed.model, reason: "unknown_model" });
      throw new CodingProxyError(400, "unknown_model");
    }
    const requestKey = safeRequestKey(input.requestKey, parsed.fingerprint);
    const snapshot = pricingSnapshot(this.priceVersion, pricing);
    const reservationUsd = estimateReservationUsd(Buffer.byteLength(parsed.encoded), parsed.maxOutputTokens, snapshot);
    const reservation = await this.ledger.reserve({
      id: randomUUID(),
      sessionId: session.id,
      requestKey,
      requestFingerprint: parsed.fingerprint,
      model: parsed.model,
      reservationUsd,
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
        reservationUsd,
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
      reservationUsd,
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
    } catch {
      cleanupActive();
      await this.markUncertain(
        session,
        request,
        undefined,
        controller.signal.aborted ? "upstream_aborted" : "upstream_transport",
      );
      throw new CodingProxyError(502, controller.signal.aborted ? "upstream_aborted" : "upstream_transport_error");
    }

    if (!upstream.ok) {
      cleanupActive();
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
      if (parsed.stream) await this.forwardStream(session, request, upstream, sink);
      else await this.forwardJson(session, request, upstream, sink);
    } catch (error) {
      await this.markUncertain(session, request, upstream.status, "invalid_or_incomplete_upstream_response");
      sink.destroy();
      throw error instanceof CodingProxyError ? error : new CodingProxyError(502, "invalid_upstream_response");
    } finally {
      cleanupActive();
    }
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
    this.audit({
      type: "response.completed",
      runId: session.runId,
      requestId: request.id,
      model: request.model,
      status: upstreamStatus,
      costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
    });
    if (costUsd > request.reservationUsd + Number.EPSILON) {
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
  ): Promise<void> {
    if (!upstream.body) throw new Error("missing_upstream_body");
    sink.start(upstream.status, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const connected = { value: true };
    const decoder = new TextDecoder();
    let buffer = "";
    let receivedBytes = 0;
    let completed = false;
    const anthropicUsage = session.protocol === "anthropic-messages" ? new AnthropicSseUsageTracker() : undefined;
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
          await safeWrite(sink, Buffer.from(`${frame}\n\n`), connected);
          continue;
        }
        if (!terminal.usage) throw new Error("terminal_usage_missing");
        await this.complete(session, request, terminal.usage, upstream.status);
        completed = true;
        await safeWrite(sink, Buffer.from(`${frame}\n\n`), connected);
      }
    }
    buffer = (buffer + decoder.decode()).replaceAll("\r\n", "\n");
    if (!completed) throw new Error("terminal_usage_missing");
    if (buffer) await safeWrite(sink, Buffer.from(buffer), connected);
    if (connected.value) sink.end();
  }

  private async markUncertain(
    session: ProxySession,
    request: ProxyRequest,
    status: number | undefined,
    reason: string,
  ): Promise<void> {
    await this.ledger.markUncertain(request.id, status);
    this.audit({ type: "request.uncertain", runId: session.runId, requestId: request.id, status, reason });
  }
}
