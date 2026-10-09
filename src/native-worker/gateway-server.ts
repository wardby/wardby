/**
 * The native sandbox gateway over HTTP (native sandbox phase 3): stateless per
 * request. Each request is authenticated by the hash of its bearer capability,
 * rebuilt from its run's gateway session (the snapshot pinned at launch), the
 * run row, and the call ledger, and served by the same trusted code the
 * in-process path uses — so any control-plane replica can serve any call, and a
 * replica restart is only a retry for the worker.
 *
 * Authority stays here: a model call reserves its worst case against the
 * session budget before the provider is called and settles at the provider's
 * reported usage; the worker's own usage numbers are never read.
 */

import { logger } from "../core/logger.js";
import {
  createNativeRunTools,
  durableDelegate,
  failNativeRun,
  finishNativeRun,
  nativeRunIntegrations,
  recordNativeRunProgress,
  runDrivability,
  sandboxCapabilityHash,
  type NativeRunFinishContext,
  type NativeRunProviders,
  type RunnerDb,
  type SandboxSessionSnapshot,
} from "../core/runner.js";
import { DELEGATE_TOOL_PREFIX } from "../core/tool-names.js";
import { RoutingLlmProvider } from "../providers/llm/routing.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { isPrivilegedBridgeName } from "../sandbox/host-functions.js";
import { PrismaGatewayLedger, type GatewaySessionRecord } from "./ledger.js";
import {
  GatewayError,
  GatewayRequestSchema,
  parseParams,
  type GatewayErrorCode,
  type GatewayMethod,
  type GatewayParams,
} from "./protocol.js";

const serverLog = logger.child({ module: "native-gateway-server" });

/** Output tokens reserved for a model call that names no maxTokens (as the coding proxy does). */
export const GATEWAY_DEFAULT_RESERVE_OUTPUT_TOKENS = 4_096;
/** The most output tokens one call may reserve for. */
export const GATEWAY_MAX_RESERVE_OUTPUT_TOKENS = 128_000;
/** A replayable result is kept only up to this size; a larger one cannot be replayed on retry. */
export const GATEWAY_MAX_REPLAY_BYTES = 256 * 1024;

export interface GatewayServerDeps {
  db: RunnerDb & ConstructorParameters<typeof PrismaGatewayLedger>[0];
  providers: NativeRunProviders;
  /** Delegation long-poll window; tests shorten it. */
  pollWindowMs?: number;
}

/** What a request gets back: one JSON value, or a stream of model events. */
export type GatewayResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "stream"; status: 200; events: AsyncIterable<LlmStreamEvent> };

const ok = (result: unknown): GatewayResponse => ({
  kind: "json",
  status: 200,
  body: { ok: true, result: result ?? null },
});
const fail = (status: number, code: GatewayErrorCode | "unauthorized", message: string): GatewayResponse => ({
  kind: "json",
  status,
  body: { ok: false, error: { code, message } },
});

const STATUS_FOR: Record<string, number> = {
  invalid_request: 400,
  not_allowed: 403,
  run_not_drivable: 409,
  duplicate_call: 409,
  budget_exhausted: 402,
  not_ready: 503,
  bridge_error: 200,
  internal: 500,
};

/** Serves one gateway request. Never throws: every failure is a response. */
export async function serveGatewayRequest(
  deps: GatewayServerDeps,
  authorization: string | undefined,
  body: unknown,
): Promise<GatewayResponse> {
  try {
    return await handle(deps, authorization, body);
  } catch (err) {
    if (err instanceof GatewayError) return fail(STATUS_FOR[err.code] ?? 500, err.code, err.message);
    serverLog.error({ err }, "native gateway request failed");
    return fail(500, "internal", "The gateway could not serve this call.");
  }
}

async function handle(
  deps: GatewayServerDeps,
  authorization: string | undefined,
  body: unknown,
): Promise<GatewayResponse> {
  const { db } = deps;
  const ledger = new PrismaGatewayLedger(db);
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!token) return fail(401, "unauthorized", "A gateway capability is required.");
  const session = await ledger.findSessionByCapabilityHash(sandboxCapabilityHash(token));
  if (!session) return fail(401, "unauthorized", "Unknown gateway capability.");

  const parsed = GatewayRequestSchema.safeParse(body);
  if (!parsed.success) throw new GatewayError("invalid_request", parsed.error.issues[0]?.message ?? "invalid request");
  const request = parsed.data;
  if (request.runId !== session.runId) throw new GatewayError("not_allowed", "request for another run");
  let params: GatewayParams<GatewayMethod>;
  try {
    params = parseParams(request.method, request.params);
  } catch (err) {
    throw new GatewayError("invalid_request", err instanceof Error ? err.message : String(err));
  }
  if (session.status !== "active" || Date.now() >= session.deadlineAt.getTime()) {
    throw new GatewayError("run_not_drivable", "This run's gateway session has ended.");
  }
  // Nothing is served before the worker's network isolation is proven: until then its egress may
  // not yet be limited to this gateway, so it must not receive tool code results, secrets, or data.
  if (!session.networkReadyAt) {
    throw new GatewayError("not_ready", "This run's network isolation is not proven yet; retry shortly.");
  }
  if ((await runDrivability(db, session.runId)) !== "drivable") {
    throw new GatewayError("run_not_drivable", "This run is no longer running.");
  }

  const ctx = await rebuild(deps, session);
  switch (request.method) {
    case "llm.stream":
      return {
        kind: "stream",
        status: 200,
        events: streamModel(ctx, ledger, request.callId, params as GatewayParams<"llm.stream">),
      };
    case "llm.countTokens": {
      const p = params as GatewayParams<"llm.countTokens">;
      return ok(await ctx.llm.countTokens(p.model, p.messages, p.tools));
    }
    case "builtin.call":
      return ok(await builtin(ctx, ledger, request.callId, params as GatewayParams<"builtin.call">, deps.pollWindowMs));
    case "host.call":
      return ok(await hostCall(ctx, ledger, request.callId, params as GatewayParams<"host.call">));
    case "progress": {
      const p = params as GatewayParams<"progress">;
      const totals = await ledger.totals(session.id);
      await recordNativeRunProgress(db, session.runId, {
        turns: p.turns,
        usage: { tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, costUsd: totals.costUsd },
      });
      return ok(null);
    }
    case "text":
      // Live text is for an attached observer; a background sandbox run has none.
      return ok(null);
    case "finish":
      return ok(await finish(ctx, ledger, request.callId, params as GatewayParams<"finish">));
  }
}

interface RebuiltRun {
  session: GatewaySessionRecord;
  snapshot: SandboxSessionSnapshot;
  llm: LlmProvider;
  tools: ReturnType<typeof createNativeRunTools>;
  finishContext: NativeRunFinishContext;
  delegation: Omit<Parameters<typeof durableDelegate>[0], "ledger" | "sessionId">;
}

async function rebuild(deps: GatewayServerDeps, session: GatewaySessionRecord): Promise<RebuiltRun> {
  const { db, providers } = deps;
  const snapshot = session.snapshot as SandboxSessionSnapshot;
  const existingRun = await db.run.findUniqueOrThrow({ where: { id: session.runId } });
  const { reviewHosts, repoAccess, issueTrackers } = nativeRunIntegrations(providers, db);
  const loaded = snapshot.loaded;
  const llm =
    loaded.pricing && providers.llm instanceof RoutingLlmProvider
      ? providers.llm.forRun(loaded.pricing.entry)
      : providers.llm;
  return {
    session,
    snapshot,
    llm,
    tools: createNativeRunTools({
      runId: session.runId,
      existingRun,
      loaded,
      providers,
      db,
      reviewHosts,
      repoAccess,
      issueTrackers,
    }),
    finishContext: { runId: session.runId, db, providers, reviewHosts, repoAccess, issueTrackers },
    delegation: {
      runId: session.runId,
      existingRun,
      loaded,
      providers,
      db,
      issueTrackers,
      pollWindowMs: deps.pollWindowMs,
    },
  };
}

async function* streamModel(
  ctx: RebuiltRun,
  ledger: PrismaGatewayLedger,
  callId: string,
  params: GatewayParams<"llm.stream">,
): AsyncIterable<LlmStreamEvent> {
  const req = params.request;
  if (req.model !== ctx.snapshot.input.agent.model)
    throw new GatewayError("not_allowed", "A run may only call its own model.");
  const inputTokens = await ctx.llm.countTokens(req.model, req.messages, req.tools);
  const outputTokens = Math.min(
    req.maxTokens ?? GATEWAY_DEFAULT_RESERVE_OUTPUT_TOKENS,
    GATEWAY_MAX_RESERVE_OUTPUT_TOKENS,
  );
  const reservationUsd = ctx.llm.priceUsd(req.model, { inputTokens, outputTokens });
  const reserved = await ledger.reserve({ sessionId: ctx.session.id, callId, reservationUsd, now: new Date() });
  if (reserved.outcome === "duplicate")
    throw new GatewayError("duplicate_call", `callId "${callId}" was already used.`);
  if (reserved.outcome === "inactive")
    throw new GatewayError("run_not_drivable", "This run's gateway session has ended.");
  if (reserved.outcome === "budget_exhausted") {
    throw new GatewayError("budget_exhausted", "This run's budget cannot cover another model call.");
  }

  let settled = false;
  let sawEvent = false;
  let streamedText = "";
  try {
    for await (const event of ctx.llm.stream(req)) {
      sawEvent = true;
      if (event.type === "text") streamedText += event.delta;
      if (event.type === "done") {
        settled = true;
        await ledger.complete(ctx.session.id, callId, {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens ?? 0,
          cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
          costUsd: event.usage.costUsd,
        });
      }
      yield event;
    }
  } catch (err) {
    if (!settled) {
      // Refused before anything streamed: the provider billed nothing. Mid-stream: unknown, keep the hold.
      if (sawEvent) await ledger.markUncertain(ctx.session.id, callId);
      else await ledger.release(ctx.session.id, callId);
      settled = true;
    }
    throw err;
  } finally {
    if (!settled) {
      // The worker stopped reading (its own budget cutoff) before usage arrived: bill an estimate.
      const output = streamedText
        ? await ctx.llm.countTokens(req.model, [{ role: "assistant", content: streamedText }]).catch(() => 0)
        : 0;
      await ledger.complete(ctx.session.id, callId, {
        inputTokens,
        outputTokens: output,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: ctx.llm.priceUsd(req.model, { inputTokens, outputTokens: output }),
      });
    }
  }
}

async function builtin(
  ctx: RebuiltRun,
  ledger: PrismaGatewayLedger,
  callId: string,
  params: GatewayParams<"builtin.call">,
  pollWindowMs: number | undefined,
): Promise<unknown> {
  if (!ctx.snapshot.input.builtinTools.includes(params.name)) {
    throw new GatewayError("not_allowed", `"${params.name}" is not a built-in tool of this run.`);
  }
  if (params.name.startsWith(DELEGATE_TOOL_PREFIX)) {
    const outcome = await durableDelegate(
      { ...ctx.delegation, pollWindowMs, ledger, sessionId: ctx.session.id },
      callId,
      params.name,
      params.argsJson,
    );
    return "pending" in outcome ? { pending: true } : outcome.result;
  }
  const handler = ctx.tools.builtinHandler(params.name);
  if (!handler) throw new GatewayError("not_allowed", `"${params.name}" is not a built-in tool of this run.`);
  return replayable(ledger, ctx.session.id, callId, "builtin.call", () => handler(params.argsJson));
}

async function hostCall(
  ctx: RebuiltRun,
  ledger: PrismaGatewayLedger,
  callId: string,
  params: GatewayParams<"host.call">,
): Promise<unknown> {
  if (!isPrivilegedBridgeName(params.bridge)) throw new GatewayError("not_allowed", "unknown bridge");
  if (!ctx.snapshot.input.userTools[params.tool]) {
    throw new GatewayError("not_allowed", `"${params.tool}" is not a user tool of this run.`);
  }
  const redact = params.bridge === "__bridge_console" ? await ctx.tools.readableSecretValues(params.tool) : undefined;
  const host = ctx.tools.privilegedHostFor(params.tool, AbortSignal.timeout(30_000), redact);
  if (!host) throw new GatewayError("not_allowed", `"${params.tool}" is not a user tool of this run.`);
  const bridge = host[params.bridge];
  const run = async () => {
    try {
      return await bridge(params.argsJson);
    } catch (err) {
      // What the tool sees, exactly as in-process (bridge.ts truncates the same way).
      throw new GatewayError(
        "bridge_error",
        err instanceof Error ? err.message.slice(0, 1024) : "Host function failed.",
      );
    }
  };
  // Console lines are not worth a ledger row; everything else replays its result on a retried callId.
  if (params.bridge === "__bridge_console") return run();
  return replayable(ledger, ctx.session.id, callId, "host.call", run);
}

/** Runs a one-shot call once per callId; a retry replays its recorded result. */
async function replayable(
  ledger: PrismaGatewayLedger,
  sessionId: string,
  callId: string,
  method: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  const claimed = await ledger.claim(sessionId, callId, method);
  if (claimed.outcome === "done") {
    const stored = claimed.result as {
      value?: unknown;
      error?: { code: GatewayErrorCode; message: string };
      tooLarge?: true;
    };
    if (stored.tooLarge) throw new GatewayError("internal", "This call's result was too large to replay.");
    if (stored.error) throw new GatewayError(stored.error.code, stored.error.message);
    return stored.value;
  }
  if (claimed.outcome === "in_flight")
    throw new GatewayError("duplicate_call", `callId "${callId}" is still in flight.`);
  try {
    const value = await run();
    const record = { value: value ?? null };
    await ledger.recordResult(
      sessionId,
      callId,
      JSON.stringify(record).length <= GATEWAY_MAX_REPLAY_BYTES ? record : { tooLarge: true },
    );
    return value;
  } catch (err) {
    if (err instanceof GatewayError && err.code === "bridge_error") {
      await ledger.recordResult(sessionId, callId, { error: { code: err.code, message: err.message } });
    }
    throw err;
  }
}

async function finish(
  ctx: RebuiltRun,
  ledger: PrismaGatewayLedger,
  callId: string,
  params: GatewayParams<"finish">,
): Promise<null> {
  const claimed = await ledger.claim(ctx.session.id, callId, "finish");
  if (claimed.outcome !== "claimed") return null;
  const totals = await ledger.totals(ctx.session.id);
  try {
    await finishNativeRun(ctx.finishContext, ctx.snapshot.input.agent.model, {
      status: params.status,
      finalText: params.finalText,
      turns: params.turns,
      ...(params.error !== undefined ? { error: params.error } : {}),
      usage: {
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        costUsd: totals.costUsd,
        cachedInputTokens: totals.cachedInputTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
      },
    });
  } catch (err) {
    await failNativeRun(ctx.finishContext, err);
  } finally {
    await ledger.recordResult(ctx.session.id, callId, { value: null });
    await ledger.endSession(ctx.session.id, "finished");
  }
  return null;
}
