/**
 * The runner. Split into `createRun` (persist a pending Run for an agent)
 * and `executeRun` (drive an existing Run to a terminal state) so Phase 2's
 * scheduler can create the Run itself (inside its claim transaction) and
 * hand the id to an `Executor`, which is what actually calls `executeRun`.
 * `runAgent` is the convenience that does both in one call, and is what the
 * CLI's `reevo run` uses directly (an attended, foreground command doesn't
 * need the executor's heartbeat/reconciler durability — only unattended
 * scheduled runs do).
 *
 * Phase 3: `executeRun` is now a thin wrapper. It loads the agent and its
 * attached tools, builds the `EngineRunContext` (wiring `runSandboxTool` to
 * the Zod-in-sandbox validation + WASM sandbox), calls the configured
 * `Engine`, and persists the `EngineResult`. Every budget decision
 * (pre-flight refuse, cumulative pre-turn gate, mid-stream cutoff, wind-
 * down) lives inside the engine now — there is exactly one place that
 * reasons about cost, not one here plus one in the engine.
 */

import type { Prisma, PrismaClient, Run, RunTrigger } from "@prisma/client";
import type { ProviderRegistry } from "../providers/index.js";
import type { LoadedTool } from "../providers/engine/types.js";
import { runStepInline, type StepRunner } from "../providers/engine/types.js";
import { validateParams } from "../sandbox/zod-params.js";
import { runInSandbox } from "../sandbox/run-in-sandbox.js";
import { asStringArray, asPrefixMap } from "../sandbox/tool-capabilities.js";
import { scopeDatastore } from "../providers/datastore/scoped.js";
import { buildSecretsAccessor, scopeSecretsAccessor } from "./secrets.js";
import { buildSharedDatastoreAccessor, scopeSharedDatastoreAccessor } from "./datastores.js";
import { effectiveBudgetForRun } from "./budget-groups.js";
import { MEMORY_TOOL_DEFS, MEMORY_TOOL_NAMES, handleMemoryTool } from "./memory-tools.js";
import { prisma as defaultDb } from "./db.js";
import { logger } from "./logger.js";

const runnerLog = logger.child({ module: "runner" });

/** The subset of the Prisma client the runner touches — mockable in tests. */
export type RunnerDb = Pick<PrismaClient, "agent" | "run" | "agentTool" | "agentSecret" | "agentDatastore" | "budgetGroup">;

/**
 * The two states a Run can still be driven out of. Every write `executeRun`
 * makes is filtered on these: a durable executor can have two attempts of the
 * same run in flight at once (a still-live original parked in a slow LLM step
 * and an adopted attempt the reconciler resumed elsewhere), and whichever
 * reaches a terminal state first must win. A conditional `updateMany` makes
 * that a database-level CAS rather than a race — the loser's WHERE matches
 * zero rows. It also stops a *later* attempt resurrecting a run the
 * reconciler already reaped: a `lost` row stays `lost`.
 */
const DRIVABLE = ["pending", "running"] as const;

/**
 * Raised when a run's step boundary observed a cancellation (DbosExecutor's
 * `stop`). `executeRun`'s backstop persists these as `cancelled` with the
 * operator's reason, rather than `failed` with an executor-internal message.
 */
export class RunCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancelledError";
  }
}

/**
 * Terminal write + read-back. The write is conditional (see DRIVABLE), so
 * the returned row is the run's real state — this attempt's result if it won
 * the race, the winner's if it did not.
 */
async function finishRun(db: RunnerDb, runId: string, data: Prisma.RunUpdateManyMutationInput): Promise<Run> {
  await db.run.updateMany({ where: { id: runId, status: { in: [...DRIVABLE] } }, data });
  return db.run.findUniqueOrThrow({ where: { id: runId } });
}

/** Persists a new pending Run for the named agent. Throws if the agent is unknown. */
export async function createRun(db: RunnerDb, agentName: string, trigger: RunTrigger = "manual"): Promise<Run> {
  const agent = await db.agent.findUnique({ where: { name: agentName } });
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}".`);
  }
  if (agent.kind === "coding") {
    throw new Error("Coding agent execution requires the Phase 5 container executor.");
  }
  return db.run.create({ data: { agentId: agent.id, trigger } });
}

/** Drives an existing Run (created by `createRun` or the scheduler) to a terminal state. */
export async function executeRun(
  runId: string,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets" | "memory">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
  step: StepRunner = runStepInline,
): Promise<Run> {
  const existingRun = await db.run.findUnique({ where: { id: runId } });
  if (!existingRun) {
    throw new Error(`Unknown run "${runId}".`);
  }

  // Pre-flight guard. A run that already reached a terminal state must never
  // be re-driven: a durable workflow re-dispatched after the reconciler
  // reaped its row (rollback to EXECUTOR=in-process, then roll forward) would
  // otherwise re-spend the whole run against a `lost` row, and a duplicate
  // attempt of a finished run would spend a second time for a result no write
  // can land. Cheaper and clearer than letting it run and discarding the
  // result at the conditional write.
  if (!DRIVABLE.includes(existingRun.status as (typeof DRIVABLE)[number])) {
    runnerLog.info({ runId, status: existingRun.status }, "skipping execution of an already-terminal run");
    return existingRun;
  }

  // Pinned in one checkpointed step: on replay after a crash, the agent row
  // or its budget group may have changed since first execution. The
  // engine's control flow depends on budgetUsd and maxTurns, so they must
  // be pinned to the values seen on first execution or the replay's step
  // order diverges from the record.
  const loaded = await step("load", async () => {
    const agent = await db.agent.findUnique({ where: { id: existingRun.agentId } });
    if (!agent) {
      throw new Error(`Run "${runId}" references missing agent "${existingRun.agentId}".`);
    }
    const attached = await db.agentTool.findMany({
      where: { agentId: agent.id },
      include: { tool: true },
    });
    const { effectiveBudgetUsd } = await effectiveBudgetForRun(db, agent);
    return {
      agentId: agent.id,
      kind: agent.kind,
      memoryEnabled: agent.memoryEnabled,
      agent: {
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        budgetUsd: effectiveBudgetUsd,
        maxTurns: agent.maxTurns,
      },
      // jsonSchema was derived and validated once at `reevo tool create`
      // time (cli.ts) and cached on the row — there's no "update tool"
      // path, so it can't go stale. Re-deriving it here on every run would
      // spin a fresh QuickJS runtime and evaluate the whole vendored zod
      // bundle per attached tool, before the first LLM call, on every run.
      // The memory built-ins (recognized by name in runSandboxTool below,
      // never sandboxed) are appended the same way when enabled.
      tools: [
        ...attached.map((attachment): LoadedTool => ({
          name: attachment.tool.name,
          description: attachment.tool.description,
          jsonSchema: attachment.tool.jsonSchema as Record<string, unknown>,
        })),
        ...(agent.memoryEnabled ? MEMORY_TOOL_DEFS : []),
      ],
      toolsByName: Object.fromEntries(
        attached.map((attachment) => [
          attachment.tool.name,
          {
            code: attachment.tool.code,
            paramsZod: attachment.tool.paramsZod,
            allowedSecrets: asStringArray(attachment.allowedSecrets),
            allowedDatastorePrefixes: asStringArray(attachment.allowedDatastorePrefixes),
            allowedHosts: asStringArray(attachment.allowedHosts),
            allowedSharedDatastorePrefixes: asPrefixMap(attachment.allowedSharedDatastorePrefixes),
          },
        ]),
      ),
    };
  });

  if (loaded.kind === "coding") {
    return finishRun(db, runId, {
      status: "failed",
      error: "Coding agent execution requires the Phase 5 container executor.",
      finishedAt: new Date(),
    });
  }

  // Conditional on DRIVABLE rather than on `pending`: an adopted attempt
  // legitimately finds the row already `running`, but a terminal row must
  // never be flipped back to `running`.
  await db.run.updateMany({ where: { id: runId, status: { in: [...DRIVABLE] } }, data: { status: "running" } });

  try {
    const toolsByName = new Map(Object.entries(loaded.toolsByName));
    const secretsAccessor = buildSecretsAccessor(loaded.agentId, providers.secrets, db);
    const sharedDatastoreAccessor = buildSharedDatastoreAccessor(loaded.agentId, providers.datastore, db);

    const runSandboxTool = async (name: string, argsJson: string): Promise<string> => {
      if (loaded.memoryEnabled && MEMORY_TOOL_NAMES.has(name)) {
        return handleMemoryTool(name, argsJson, loaded.agentId, providers.memory);
      }

      const tool = toolsByName.get(name);
      if (!tool) {
        return JSON.stringify({
          error: "unknown_tool",
          message: `No tool named "${name}" is attached to this agent.`,
        });
      }

      let parsedArgs: unknown;
      try {
        // Some providers stream no JSON delta at all for a zero-parameter
        // tool call, yielding an empty argsJson rather than "{}".
        parsedArgs = JSON.parse(argsJson || "{}");
      } catch (err) {
        return JSON.stringify({
          error: "invalid_arguments_json",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      const validation = await validateParams(tool.paramsZod, parsedArgs);
      if (!validation.ok) {
        return JSON.stringify({ error: "validation_failed", message: validation.errorMessage });
      }

      const result = await runInSandbox({
        code: tool.code,
        params: validation.value,
        agentId: loaded.agentId,
        datastore: scopeDatastore(providers.datastore, tool.allowedDatastorePrefixes),
        sharedDatastore: scopeSharedDatastoreAccessor(sharedDatastoreAccessor, tool.allowedSharedDatastorePrefixes),
        secrets: scopeSecretsAccessor(secretsAccessor, tool.allowedSecrets),
        allowedFetchHosts: tool.allowedHosts,
        toolName: name,
      });
      if (!result.ok) {
        return JSON.stringify({ error: result.errorKind, message: result.errorMessage });
      }
      return JSON.stringify(result.value);
    };

    const engineResult = await providers.engine.run({
      agent: loaded.agent,
      tools: loaded.tools,
      providers: { llm: providers.llm },
      runSandboxTool,
      onText,
      step,
    });

    return finishRun(db, runId, {
      status: engineResult.status,
      tokensIn: engineResult.usage.tokensIn,
      tokensOut: engineResult.usage.tokensOut,
      costUsd: engineResult.usage.costUsd,
      error: engineResult.error ?? null,
      finalText: engineResult.finalText || null,
      turns: engineResult.turns,
      finishedAt: new Date(),
    });
  } catch (err) {
    // Defensive backstop: the engine is expected to catch its own errors
    // and return a "failed" EngineResult, but an unexpected throw here
    // (a real bug, or tool-loading failing outside the per-tool try above)
    // must still never leave the run dangling in "running". A cancellation
    // is not a failure: it carries the operator's own reason.
    return finishRun(db, runId, {
      status: err instanceof RunCancelledError ? "cancelled" : "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    });
  }
}

/** Convenience: create + execute a manual run in one call (what the CLI's `reevo run` uses). */
export async function runAgent(
  agentName: string,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets" | "memory">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
): Promise<Run> {
  const run = await createRun(db, agentName, "manual");
  return executeRun(run.id, providers, db, onText);
}
