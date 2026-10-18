/**
 * The trusted side of the native sandbox worker contract. `runSandboxedEngine`
 * is an Engine in all but name: the runner hands it the same context it would
 * hand NativeEngine, and it returns an EngineResult — but the turn loop runs
 * in a worker, and this module serves the worker's calls from that context.
 *
 * Authority stays here (invariant 8 of the plan): model usage and cost are
 * metered from what the provider streamed through this gateway, never taken
 * from the worker; every call is validated against the protocol schemas and
 * refused once the run is no longer drivable; built-in tools and privileged
 * sandbox bridges are served only by name from the run's own surface.
 */

import type { EngineProgress, EngineResult, EngineRunContext } from "../providers/engine/types.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import pino from "pino";
import { isPrivilegedBridgeName, redactExactSecretValues, type PrivilegedHost } from "../sandbox/host-functions.js";
import { logger } from "../core/logger.js";
import {
  GatewayError,
  GatewayRequestSchema,
  NATIVE_WORKER_PROTOCOL_VERSION,
  parseParams,
  ProtocolError,
  type GatewayMethod,
  type GatewayParams,
  type GatewayRequest,
  type WorkerInput,
  workerGatewayError,
} from "./protocol.js";

/**
 * The gateways' log. Both (in-process and HTTP) log an unexpected error here, as `native gateway
 * request failed` (or `native gateway model stream failed`). Exported so tests can watch it.
 */
export const gatewayLog = logger.child({ module: "native-gateway" });

/** `err` for the log with every exact secret value removed from its (cause-folded) message and stack. */
function redactedError(err: unknown, values: readonly string[]): unknown {
  if (values.length === 0 || !(err instanceof Error)) return err;
  // pino's own serializer folds the cause chain into message and stack, so a cause is covered too.
  const serialized = pino.stdSerializers.err(err);
  const safe = new Error(redactExactSecretValues(serialized.message, values));
  safe.name = err.name;
  safe.stack = redactExactSecretValues(serialized.stack ?? "", values);
  return safe;
}

/**
 * The one way either gateway turns a failure into what the worker sees: an unexpected error is
 * logged for the operator (redacted by the run's secret values) and becomes the checked
 * GatewayError (workerGatewayError); the values are read once and serve both.
 */
export async function forWorker(
  err: unknown,
  secretValues: (() => Promise<Iterable<string>>) | undefined,
  logMessage: string,
): Promise<GatewayError> {
  if (err instanceof GatewayError) return workerGatewayError(err, secretValues);
  const values = await secretValues?.().then(
    (v) => [...v],
    () => undefined,
  );
  gatewayLog.error({ err: redactedError(err, values ?? []) }, logMessage);
  return workerGatewayError(err, values ? async () => values : undefined);
}

/** The trusted gateway as a transport sees it: untrusted requests in, results or GatewayErrors out. */
export interface NativeGateway {
  call(request: unknown): Promise<unknown>;
  stream(request: unknown): AsyncIterable<LlmStreamEvent>;
}

/** Starts a worker for `input`, lets it call `gateway`, and resolves when it exits. */
export interface WorkerLauncher {
  run(input: WorkerInput, gateway: NativeGateway, signal: AbortSignal): Promise<{ exitCode: number | null }>;
}

/** Where a run stands, read live on every call. */
export type RunDrivability = "drivable" | "cancelled" | "ended";

/** Thrown when the worker stopped because the run was cancelled; the runner records `cancelled`. */
export class SandboxRunCancelledError extends Error {}

export interface SandboxedEngineOptions {
  runId: string;
  input: WorkerInput;
  /** The context the runner would hand NativeEngine: the run-bound LLM, onText, and onProgress. */
  ctx: Pick<EngineRunContext, "providers" | "onText" | "onProgress">;
  builtinHandler: (name: string) => ((argsJson: string) => Promise<string>) | undefined;
  privilegedHostFor: (tool: string, signal: AbortSignal) => PrivilegedHost | undefined;
  /**
   * Every secret value the user tool `tool` may read. A failure's cause code that overlaps any of
   * the run's values is not sent to the worker; without this, no cause code is sent.
   */
  readableSecretValues?: (tool: string) => Promise<string[]>;
  drivability: () => Promise<RunDrivability>;
  launcher: WorkerLauncher;
}

interface MeteredUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

/** Runs one native run's engine in a worker and returns its result with gateway-metered usage. */
export async function runSandboxedEngine(options: SandboxedEngineOptions): Promise<EngineResult> {
  const { runId, input, ctx } = options;
  const llm = ctx.providers.llm;
  const controller = new AbortController();
  const usage: MeteredUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0, cachedInputTokens: 0, cacheWriteTokens: 0 };
  const usedCallIds = new Set<string>();
  const builtinResults = new Map<string, Promise<string>>();
  const hosts = new Map<string, PrivilegedHost>();
  let lastTextSeq = -1;
  let finished: GatewayParams<"finish"> | undefined;
  let cancelled = false;

  const meter = (event: Extract<LlmStreamEvent, { type: "done" }>["usage"]) => {
    usage.tokensIn += event.inputTokens;
    usage.tokensOut += event.outputTokens;
    usage.costUsd += event.costUsd;
    usage.cachedInputTokens += event.cachedInputTokens ?? 0;
    usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
  };

  /** Validates the envelope and the run, and claims the callId; returns the method's params. */
  const admit = async <M extends GatewayMethod>(raw: unknown, expected?: M) => {
    const parsed = GatewayRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const v = (raw as { v?: unknown } | null)?.v;
      if (v !== undefined && v !== NATIVE_WORKER_PROTOCOL_VERSION) {
        throw new GatewayError("invalid_request", new ProtocolError("unsupported_protocol_version").message);
      }
      throw new GatewayError("invalid_request", parsed.error.issues[0]?.message ?? "invalid request");
    }
    const request: GatewayRequest = parsed.data;
    if (request.runId !== runId) throw new GatewayError("not_allowed", "request for another run");
    if (expected && request.method !== expected) throw new GatewayError("invalid_request", "wrong method");
    let params: GatewayParams<M>;
    try {
      params = parseParams(request.method as M, request.params);
    } catch (err) {
      throw new GatewayError("invalid_request", err instanceof Error ? err.message : String(err));
    }
    const state = await options.drivability();
    if (state !== "drivable") {
      if (state === "cancelled") cancelled = true;
      controller.abort();
      throw new GatewayError("run_not_drivable", "This run is no longer running.");
    }
    return { request, params };
  };

  const claim = (callId: string) => {
    if (usedCallIds.has(callId)) throw new GatewayError("duplicate_call", `callId "${callId}" was already used.`);
    usedCallIds.add(callId);
  };

  /** The run's readable secret values, for checking a failure's cause code before the worker sees it. */
  const readable = options.readableSecretValues;
  const runSecretValues = readable
    ? async () => (await Promise.all(Object.keys(input.userTools).map((tool) => readable(tool)))).flat()
    : undefined;

  const served: NativeGateway = {
    async *stream(raw) {
      const { request, params } = await admit(raw, "llm.stream");
      claim(request.callId);
      // The worker may only call the run's own pinned model.
      if (params.request.model !== input.agent.model) {
        throw new GatewayError("not_allowed", "A run may only call its own model.");
      }
      const req = params.request;
      let sawDone = false;
      let streamedText = "";
      try {
        for await (const event of llm.stream(req, controller.signal)) {
          if (event.type === "done") {
            sawDone = true;
            meter(event.usage);
          } else if (event.type === "text") {
            streamedText += event.delta;
          }
          yield event;
        }
      } finally {
        // The worker stopped reading (its own mid-stream budget cutoff, or it went away) before the
        // provider reported usage: bill this gateway's own estimate of what was streamed, so an
        // aborted call is never free.
        if (!sawDone) {
          const inputTokens = await llm.countTokens(req.model, req.messages, req.tools).catch(() => 0);
          const outputTokens = streamedText
            ? await llm.countTokens(req.model, [{ role: "assistant", content: streamedText }]).catch(() => 0)
            : 0;
          meter({ inputTokens, outputTokens, costUsd: llm.priceUsd(req.model, { inputTokens, outputTokens }) });
        }
      }
    },

    async call(raw) {
      const { request, params } = await admit(raw);
      switch (request.method) {
        case "llm.countTokens": {
          const p = params as GatewayParams<"llm.countTokens">;
          return llm.countTokens(p.model, p.messages, p.tools);
        }
        case "builtin.call": {
          const p = params as GatewayParams<"builtin.call">;
          // A repeated callId for a finished built-in returns the same result instead of acting twice.
          const prior = builtinResults.get(request.callId);
          if (prior) return prior;
          const handler = input.builtinTools.includes(p.name) ? options.builtinHandler(p.name) : undefined;
          if (!handler) throw new GatewayError("not_allowed", `"${p.name}" is not a built-in tool of this run.`);
          const result = handler(p.argsJson);
          builtinResults.set(request.callId, result);
          return result;
        }
        case "host.call": {
          const p = params as GatewayParams<"host.call">;
          claim(request.callId);
          if (!isPrivilegedBridgeName(p.bridge)) throw new GatewayError("not_allowed", "unknown bridge");
          const key = `${p.tool}\u0000${p.invocation}`;
          let host = hosts.get(key);
          if (!host) {
            host = options.privilegedHostFor(p.tool, controller.signal);
            if (!host) throw new GatewayError("not_allowed", `"${p.tool}" is not a user tool of this run.`);
            hosts.set(key, host);
          }
          try {
            return await host[p.bridge](p.argsJson);
          } catch (err) {
            // What the tool sees, exactly as in-process (bridge.ts truncates the same way).
            const message = err instanceof Error ? err.message.slice(0, 1024) : "Host function failed.";
            throw new GatewayError("bridge_error", message);
          }
        }
        case "progress": {
          const p = params as GatewayParams<"progress">;
          // Turns from the worker, usage from this gateway's own metering.
          const progress: EngineProgress = {
            turns: p.turns,
            usage: { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd },
          };
          await ctx.onProgress?.(progress);
          return null;
        }
        case "text": {
          const p = params as GatewayParams<"text">;
          if (p.seq > lastTextSeq) {
            lastTextSeq = p.seq;
            ctx.onText?.(p.delta);
          }
          return null;
        }
        case "finish": {
          claim(request.callId);
          finished ??= params as GatewayParams<"finish">;
          return null;
        }
        default:
          throw new GatewayError("invalid_request", `"${request.method}" is a streaming method.`);
      }
    },
  };

  // What crosses to the worker on every transport: a GatewayError, never an unexpected error's text.
  const gateway: NativeGateway = {
    async call(raw) {
      try {
        return await served.call(raw);
      } catch (err) {
        throw await forWorker(err, runSecretValues, "native gateway request failed");
      }
    },
    async *stream(raw) {
      try {
        yield* served.stream(raw);
      } catch (err) {
        throw await forWorker(err, runSecretValues, "native gateway model stream failed");
      }
    },
  };

  const { exitCode } = await options.launcher.run(input, gateway, controller.signal);
  controller.abort();
  if (cancelled || (!finished && (await options.drivability()) === "cancelled")) {
    throw new SandboxRunCancelledError("The run was cancelled while its sandbox worker was running.");
  }
  if (!finished) {
    gatewayLog.warn({ runId, exitCode }, "native sandbox worker exited without a result");
    throw new Error(`native_sandbox_worker_exited: the sandbox worker exited (code ${exitCode}) without a result.`);
  }
  return {
    status: finished.status,
    finalText: finished.finalText,
    turns: finished.turns,
    ...(finished.error !== undefined ? { error: finished.error } : {}),
    usage,
  };
}
