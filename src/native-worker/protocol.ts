/**
 * The native sandbox worker contract, version 1 (docs/private native sandbox
 * plan, phase 2). The worker runs the unchanged NativeEngine; everything it
 * needs from outside — model calls, built-in tools, privileged sandbox
 * bridges, progress, streamed text, and the terminal result — is a call to the
 * trusted gateway. The worker is untrusted: the gateway validates every
 * request against these schemas, and nothing in WorkerInput can carry a
 * secret value or a credential.
 *
 * Transport-neutral: the same messages travel in-process (loopback), over a
 * child process's stdio, and (phase 3) over HTTP.
 */

import { z } from "zod";
import { LLM_EFFORT_LEVELS } from "../providers/llm/types.js";

export const NATIVE_WORKER_PROTOCOL_VERSION = 1;
/** Above the sandbox's 12 MiB bridge-result cap, plus envelope. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type ProtocolErrorCode =
  "unsupported_protocol_version" | "message_too_large" | "message_not_json" | "message_invalid";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ProtocolError";
  }
}

/** Errors the gateway returns for a call; the worker treats them as final for that call. */
export type GatewayErrorCode =
  /** The run is no longer pending/running, or its task was cancelled: stop. */
  | "run_not_drivable"
  /** This callId was already used for a call that is still in flight or not replayable. */
  | "duplicate_call"
  /** A name the run is not allowed to use (unknown tool, bridge, or built-in). */
  | "not_allowed"
  | "invalid_request"
  /** A privileged bridge failed; `message` is what the tool sees, as in-process. */
  | "bridge_error"
  /** The run's budget cannot cover another model call (the gateway's reservation was refused). */
  | "budget_exhausted"
  /** The worker's network isolation is not proven yet: retry shortly. */
  | "not_ready"
  | "internal";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

const runId = z.string().min(1).max(64);
const callId = z.string().min(1).max(128);

const LlmMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), argsJson: z.string() }).strict()).optional(),
  })
  .strict();

const LlmToolDefSchema = z
  .object({ name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })
  .strict();

export const LlmRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(LlmMessageSchema),
    tools: z.array(LlmToolDefSchema).optional(),
    maxTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    stopSequences: z.array(z.string()).optional(),
    effort: z.enum(LLM_EFFORT_LEVELS).optional(),
  })
  .strict();

export const LlmStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }).strict(),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: z.string(), argsJson: z.string() }).strict(),
  z
    .object({
      type: z.literal("done"),
      stopReason: z.string(),
      usage: z
        .object({
          inputTokens: z.number(),
          outputTokens: z.number(),
          cachedInputTokens: z.number().optional(),
          cacheWriteTokens: z.number().optional(),
          costUsd: z.number(),
        })
        .strict(),
    })
    .strict(),
]);

const LoadedToolSchema = z
  .object({ name: z.string(), description: z.string(), jsonSchema: z.record(z.string(), z.unknown()) })
  .strict();

/** A user tool as the worker runs it: code and schema only. Capabilities stay on the gateway. */
const WorkerUserToolSchema = z.object({ code: z.string(), paramsZod: z.string() }).strict();

const PricingSchema = z
  .object({
    provider: z.string(),
    modelId: z.string(),
    encoding: z.enum(["cl100k_base", "o200k_base"]),
    inputPerMTok: z.number(),
    outputPerMTok: z.number(),
    cachedInputPerMTok: z.number(),
    cacheWritePerMTok: z.number(),
    efforts: z.array(z.enum(LLM_EFFORT_LEVELS)),
    thinkingMode: z.string(),
  })
  .strict();

/** Everything the worker is given, once, at start. No secret values and no credentials. */
export const WorkerInputSchema = z
  .object({
    v: z.literal(NATIVE_WORKER_PROTOCOL_VERSION),
    runId,
    agent: z
      .object({
        systemPrompt: z.string(),
        model: z.string(),
        budgetUsd: z.number().nonnegative(),
        maxTurns: z.number().int().positive(),
        effort: z.enum(LLM_EFFORT_LEVELS).optional(),
        untrustedContext: z.string().optional(),
      })
      .strict(),
    tools: z.array(LoadedToolSchema),
    /** Names the gateway serves (memory, repo_*, jira_*, sub-agent memory, delegate_to_*). */
    builtinTools: z.array(z.string()),
    /** User tools the worker runs itself, by name. */
    userTools: z.record(z.string(), WorkerUserToolSchema),
    /** Tool names whose calls in one turn may run at the same time (delegations, when opted in). */
    runsConcurrently: z.array(z.string()),
    /** The run's pinned catalog entry, so the engine's local budget checks price without a network call. */
    pricing: PricingSchema,
    /**
     * Where and how to reach the HTTP gateway. Absent: the gateway is on this process's stdio.
     * The capability is given once, here, on the worker's stdin; it is never in its environment,
     * argv, or the server's stored snapshot (only its hash is stored).
     */
    gateway: z
      .object({ url: z.string().url(), capability: z.string().min(32).max(256) })
      .strict()
      .optional(),
  })
  .strict();
export type WorkerInput = z.infer<typeof WorkerInputSchema>;

const UsageTotalsSchema = z.object({ tokensIn: z.number(), tokensOut: z.number(), costUsd: z.number() }).strict();

/** Each gateway method and its params. */
export const GatewayParamsSchemas = {
  "llm.stream": z.object({ request: LlmRequestSchema }).strict(),
  "llm.countTokens": z
    .object({ model: z.string(), messages: z.array(LlmMessageSchema), tools: z.array(LlmToolDefSchema).optional() })
    .strict(),
  "builtin.call": z.object({ name: z.string().max(200), argsJson: z.string() }).strict(),
  /** `invocation` names one tool call, so its bridges share one privileged host (secret redaction is per call). */
  "host.call": z
    .object({
      tool: z.string().max(200),
      invocation: z.string().min(1).max(128),
      bridge: z.string().max(64),
      argsJson: z.string(),
    })
    .strict(),
  progress: z.object({ turns: z.number().int().nonnegative(), usage: UsageTotalsSchema }).strict(),
  text: z.object({ seq: z.number().int().nonnegative(), delta: z.string() }).strict(),
  finish: z
    .object({
      status: z.enum(["succeeded", "budget_exhausted", "refused", "failed"]),
      finalText: z.string(),
      turns: z.number().int().nonnegative(),
      error: z.string().optional(),
    })
    .strict(),
} as const;
export type GatewayMethod = keyof typeof GatewayParamsSchemas;
export type GatewayParams<M extends GatewayMethod> = z.infer<(typeof GatewayParamsSchemas)[M]>;

export const GatewayRequestSchema = z
  .object({
    v: z.literal(NATIVE_WORKER_PROTOCOL_VERSION),
    runId,
    callId,
    method: z.enum(Object.keys(GatewayParamsSchemas) as [GatewayMethod, ...GatewayMethod[]]),
    params: z.unknown(),
  })
  .strict();
export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

/** Rejects before parsing a message too large to accept. */
export function assertMessageSize(text: string): void {
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new ProtocolError("message_too_large");
}

function checkVersion(raw: unknown): void {
  if (raw && typeof raw === "object" && "v" in raw && raw.v !== NATIVE_WORKER_PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_protocol_version");
  }
}

/** Parses a JSON message text with the size cap, version check, and schema. */
export function parseMessage<T>(text: string, schema: z.ZodType<T>): T {
  assertMessageSize(text);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError("message_not_json");
  }
  checkVersion(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProtocolError("message_invalid", parsed.error.issues[0]?.message);
  return parsed.data;
}

/** A gateway request's params, validated for its method. */
export function parseParams<M extends GatewayMethod>(method: M, params: unknown): GatewayParams<M> {
  const parsed = GatewayParamsSchemas[method].safeParse(params);
  if (!parsed.success) throw new ProtocolError("message_invalid", parsed.error.issues[0]?.message);
  return parsed.data;
}
