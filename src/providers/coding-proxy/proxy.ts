import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getModelPricing, PRICING_VERSION, type ModelPricing } from "../llm/pricing.js";
import {
  actualCostUsd,
  estimateReservationUsd,
  fingerprintRequest,
  parseAuthoritativeUsage,
  pricingSnapshot,
  terminalUsageFromSseFrame,
} from "./metering.js";
import type { CredentialResolver, ProxyAuditSink, ProxyLedger, ProxyRequest, ProxySession } from "./types.js";

export const PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PROXY_MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_UPSTREAM_JSON_BYTES = 16 * 1024 * 1024;
const REQUEST_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

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
  rawBody: string;
  requestKey?: string;
}

export interface CreateCodingProxySession {
  runId: string;
  credentialRef: string;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
}

export interface CreatedCodingProxySession {
  id: string;
  runId: string;
  capability: string;
  allowedModels: string[];
  deadlineAt: Date;
  budgetUsd: number;
}

export interface CodingProxyOptions {
  ledger: ProxyLedger;
  credentials: CredentialResolver;
  upstreamUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  audit?: ProxyAuditSink;
  pricing?: (model: string) => ModelPricing;
  pricingVersion?: string;
}

interface ParsedRequest {
  body: Record<string, unknown>;
  encoded: string;
  model: string;
  maxOutputTokens: number;
  stream: boolean;
  fingerprint: string;
}

function capabilityHash(capability: string): string {
  return createHash("sha256").update(capability).digest("base64url");
}

function parseRequest(rawBody: string): ParsedRequest {
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
  if (
    !Number.isSafeInteger(body.max_output_tokens) ||
    (body.max_output_tokens as number) < 1 ||
    (body.max_output_tokens as number) > PROXY_MAX_OUTPUT_TOKENS
  ) {
    throw new CodingProxyError(400, "invalid_max_output_tokens");
  }
  if (body.stream !== true && body.stream !== false) throw new CodingProxyError(400, "stream_required");
  if (body.background === true) throw new CodingProxyError(400, "background_not_allowed");
  const normalized = { ...body, store: false, background: false };
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > PROXY_MAX_BODY_BYTES) throw new CodingProxyError(413, "payload_too_large");
  return {
    body: normalized,
    encoded,
    model: body.model,
    maxOutputTokens: body.max_output_tokens as number,
    stream: body.stream,
    fingerprint: fingerprintRequest(encoded),
  };
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
  private readonly upstreamUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly audit: ProxyAuditSink;
  private readonly getPricing: (model: string) => ModelPricing;
  private readonly priceVersion: string;
  private readonly activeRequests = new Map<string, Set<AbortController>>();

  constructor(options: CodingProxyOptions) {
    this.ledger = options.ledger;
    this.credentials = options.credentials;
    this.upstreamUrl = options.upstreamUrl ?? "https://api.openai.com/v1/responses";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.audit = options.audit ?? (() => undefined);
    this.getPricing = options.pricing ?? getModelPricing;
    this.priceVersion = options.pricingVersion ?? PRICING_VERSION;
  }

  async createSession(input: CreateCodingProxySession): Promise<CreatedCodingProxySession> {
    const models = [...new Set(input.allowedModels)];
    if (models.length < 1 || models.length > 8 || models.some((model) => !model || model.length > 100)) {
      throw new Error("invalid_proxy_model_allowlist");
    }
    for (const model of models) this.getPricing(model);
    if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) throw new Error("invalid_proxy_budget");
    if (input.deadlineAt.getTime() <= this.now().getTime()) throw new Error("invalid_proxy_deadline");
    if (!input.credentialRef || input.credentialRef.length > 200) throw new Error("invalid_proxy_credential_reference");
    const capability = `rrp_${randomBytes(32).toString("base64url")}`;
    const id = randomUUID();
    await this.ledger.createSession({
      id,
      runId: input.runId,
      capabilityHash: capabilityHash(capability),
      credentialRef: input.credentialRef,
      allowedModels: models,
      deadlineAt: input.deadlineAt,
      budgetUsd: input.budgetUsd,
    });
    this.audit({ type: "session.created", runId: input.runId });
    return {
      id,
      runId: input.runId,
      capability,
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
    const parsed = parseRequest(input.rawBody);
    if (!session.allowedModels.includes(parsed.model)) {
      this.audit({ type: "request.rejected", runId: session.runId, model: parsed.model, reason: "model_not_allowed" });
      throw new CodingProxyError(403, "model_not_allowed");
    }
    let pricing: ModelPricing;
    try {
      pricing = this.getPricing(parsed.model);
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
      throw new CodingProxyError(429, "reevo_budget_exhausted");
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
      upstream = await this.fetchImpl(this.upstreamUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: parsed.stream ? "text/event-stream" : "application/json",
          "idempotency-key": `${session.id}:${request.id}`,
        },
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
    usage: ReturnType<typeof parseAuthoritativeUsage>,
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
    const usage = parseAuthoritativeUsage((value as Record<string, unknown>)?.usage);
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
        const terminal = terminalUsageFromSseFrame(frame);
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
