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
import { causeCodeOf, GATEWAY_CAUSE_CODES } from "../core/error-code.js";
import { LLM_EFFORT_LEVELS } from "../providers/llm/types.js";
import { overlapsSecretValue } from "../sandbox/host-functions.js";

// The allow-list and its checked helper live in core/error-code.ts (shared with the runner); re-exported here.
export { causeCodeOf, GATEWAY_CAUSE_CODES };

export const NATIVE_WORKER_PROTOCOL_VERSION = 1;

/** Set to "1" in a Substrate native actor's env: the worker runs in substrate mode (substrate-mode.ts). */
export const NATIVE_SUBSTRATE_ENV = "WARDBY_NATIVE_SUBSTRATE";
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
  /** No capability, or one that names no active session (HTTP 401; never sent over stdio). */
  | "unauthorized"
  | "internal";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    /**
     * For `internal` only: the code the underlying error's message led with (causeCodeOf), so the
     * run can name the cause without the rest of that message.
     */
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** What the worker is told about an unexpected gateway failure: never the error's own text. */
export const GATEWAY_INTERNAL_MESSAGE = "The gateway could not serve this call.";

/**
 * `err` as the worker may see it, on every transport (HTTP, stdio, loopback). An unexpected error
 * becomes `internal` with the generic message; a GatewayError keeps its code and message. A cause
 * code is carried only when it is declared (GATEWAY_CAUSE_CODES) and checked: not when it equals, contains, or is contained in a secret
 * value the run can read (`secretValues`, read only when there is a code to check), and not at
 * all when there is nothing to check it against or reading the values fails.
 */
export async function workerGatewayError(
  err: unknown,
  secretValues?: () => Promise<Iterable<string>>,
): Promise<GatewayError> {
  const leading = err instanceof GatewayError ? err.causeCode : causeCodeOf(err);
  // Declared codes only; the exact-value check below is a second guard.
  const candidate = leading && GATEWAY_CAUSE_CODES.has(leading) ? leading : undefined;
  let causeCode: string | undefined;
  if (candidate && secretValues) {
    const values = await secretValues().catch(() => undefined);
    if (values && !overlapsSecretValue(candidate, values)) causeCode = candidate;
  }
  if (err instanceof GatewayError) return new GatewayError(err.code, err.message, causeCode);
  return new GatewayError(
    "internal",
    causeCode ? `The gateway could not serve this call (${causeCode}).` : GATEWAY_INTERNAL_MESSAGE,
    causeCode,
  );
}

/**
 * `err` as a transport carries it to the worker: a GatewayError (already checked by the gateway
 * that threw it) as is, with a declared cause code only; anything else `internal` with the generic message and no cause code, since
 * a transport has no secret values to check one against.
 */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) {
    const causeCode = err.causeCode && GATEWAY_CAUSE_CODES.has(err.causeCode) ? err.causeCode : undefined;
    return new GatewayError(err.code, err.message, causeCode);
  }
  return new GatewayError("internal", GATEWAY_INTERNAL_MESSAGE);
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
/** `timeoutMs`: the tool's time limit for this run, already capped by the server; absent = the default. */
const WorkerUserToolSchema = z
  .object({ code: z.string(), paramsZod: z.string(), timeoutMs: z.number().int().positive().optional() })
  .strict();

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

/** Where a worker that starts without its input fetches it (POST, same bearer auth as a call). */
export const NATIVE_GATEWAY_INPUT_PATH = "/native-gateway/v1/input";
/**
 * Where a Substrate worker's supervisor reports the worker's exit (POST { code }, the same bearer auth
 * as the input route): Substrate's actor state never shows a process exit, so the gateway records it.
 */
export const NATIVE_GATEWAY_EXIT_PATH = "/native-gateway/v1/exit";
/** The exit route's body: the worker's exit code (a signal is 128 + its number). */
export const NativeWorkerExitSchema = z.object({ code: z.number().int().min(0).max(255) }).strict();
/**
 * Set by the Substrate supervisor (substrate-supervisor.ts, PID 1) on the worker it starts, so the
 * same entry runs the worker rather than another supervisor. Never a secret.
 */
export const NATIVE_SUPERVISED_ENV = "WARDBY_NATIVE_SUPERVISED";
/** The gateway's call route (http-server.ts NATIVE_GATEWAY_PATH): NATIVE_GATEWAY_URL ends with it. */
export const NATIVE_GATEWAY_CALL_PATH = "/native-gateway/v1/call";

/**
 * The bearer a Substrate worker sends (substrate mode): public, fixed, and replaced by the egress
 * gateway with the run's capability. Reaching the gateway as-is, it hashes to no session: 401.
 */
export const NATIVE_PLACEHOLDER_CAPABILITY = "wardby_native_placeholder_injected_by_egress_gateway";

/**
 * Where a Substrate startup canary posts its verdict (POST). The canary actor sends the public
 * placeholder as its bearer, and the egress gateway replaces it with the canary's own short-lived
 * capability (its Secret), as for a run. The gateway accepts that capability once, for that actor,
 * within its report window (substrate-canary-store.ts); every valid body gets the same answer,
 * whether or not it was taken, so the route is no oracle for capabilities.
 */
export const NATIVE_GATEWAY_CANARY_PATH = "/native-gateway/v1/canary";
/** A canary's verdicts: pass, or the first probe that failed, in the Kubernetes probe's order. */
export const NATIVE_CANARY_RESULTS = [
  "pass",
  "gateway_unreachable",
  "deny_port_reachable",
  "outside_reachable",
] as const;
export type NativeCanaryResult = (typeof NATIVE_CANARY_RESULTS)[number];
/** The canary route's body. */
export const NativeCanaryReportSchema = z
  .object({ actor: z.string().regex(/^wr-[0-9a-f]{20}-canary$/), result: z.enum(NATIVE_CANARY_RESULTS) })
  .strict();
export type NativeCanaryReport = z.infer<typeof NativeCanaryReportSchema>;
/** The gateway's default witness port (docker-isolation.ts NATIVE_GATEWAY_DENY_PORT, re-declared for the worker image). */
export const NATIVE_CANARY_DENY_PORT = 8791;
/**
 * The Substrate worker template's env var naming the gateway's deny port (the operator's
 * NATIVE_GATEWAY_DENY_PORT), which the startup canary probes.
 */
export const NATIVE_DENY_PORT_ENV = "NATIVE_GATEWAY_DENY_PORT";
/**
 * kubernetes-isolation.ts NATIVE_PROBE_OUTSIDE, re-declared for the worker image, which cannot load
 * providers/jobs/ (kubernetes-isolation.test.ts keeps them equal): the internet, and the cloud
 * metadata endpoints.
 */
export const NATIVE_PROBE_OUTSIDE_TARGETS: readonly { host: string; port: number }[] = Object.freeze([
  Object.freeze({ host: "1.1.1.1", port: 443 }),
  Object.freeze({ host: "169.254.169.254", port: 80 }),
  Object.freeze({ host: "169.254.170.23", port: 80 }),
  Object.freeze({ host: "fd00:ec2::254", port: 80 }),
  Object.freeze({ host: "fd00:ec2::23", port: 80 }),
]);

/**
 * A gateway route's URL from NATIVE_GATEWAY_URL (the call route's URL): the same origin and any path
 * prefix in front of the call route, then `path`.
 */
export function nativeGatewayRouteUrl(gatewayUrl: string, path: string): string {
  const url = new URL(gatewayUrl);
  const current = url.pathname.replace(/\/+$/, "");
  const prefix = current.endsWith(NATIVE_GATEWAY_CALL_PATH)
    ? current.slice(0, -NATIVE_GATEWAY_CALL_PATH.length)
    : current;
  url.pathname = `${prefix}${path}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** The input route's result: the session's snapshot input, which never holds a gateway or a secret. */
export const GatewayInputResponseSchema = z.object({ input: WorkerInputSchema.omit({ gateway: true }) }).strict();

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
  return parsed.data as GatewayParams<M>;
}
