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

import type { PrismaClient, Run, RunTrigger } from "@prisma/client";
import type { ProviderRegistry } from "../providers/index.js";
import type { LoadedTool } from "../providers/engine/types.js";
import { validateParams } from "../sandbox/zod-params.js";
import { runInSandbox } from "../sandbox/run-in-sandbox.js";
import { buildSecretsAccessor } from "./secrets.js";
import { prisma as defaultDb } from "./db.js";

/** The subset of the Prisma client the runner touches — mockable in tests. */
export type RunnerDb = Pick<PrismaClient, "agent" | "run" | "agentTool" | "agentSecret">;

/** Persists a new pending Run for the named agent. Throws if the agent is unknown. */
export async function createRun(
  db: RunnerDb,
  agentName: string,
  trigger: RunTrigger = "manual",
): Promise<Run> {
  const agent = await db.agent.findUnique({ where: { name: agentName } });
  if (!agent) {
    throw new Error(`Unknown agent "${agentName}".`);
  }
  return db.run.create({ data: { agentId: agent.id, trigger } });
}

/** Drives an existing Run (created by `createRun` or the scheduler) to a terminal state. */
export async function executeRun(
  runId: string,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
): Promise<Run> {
  const existingRun = await db.run.findUnique({ where: { id: runId } });
  if (!existingRun) {
    throw new Error(`Unknown run "${runId}".`);
  }
  const agent = await db.agent.findUnique({ where: { id: existingRun.agentId } });
  if (!agent) {
    throw new Error(`Run "${runId}" references missing agent "${existingRun.agentId}".`);
  }

  await db.run.update({ where: { id: runId }, data: { status: "running" } });

  try {
    const attached = await db.agentTool.findMany({
      where: { agentId: agent.id },
      include: { tool: true },
    });

    // jsonSchema was derived and validated once at `reevo tool create` time
    // (cli.ts) and cached on the row — there's no "update tool" path, so it
    // can't go stale. Re-deriving it here on every run would spin a fresh
    // QuickJS runtime and evaluate the whole vendored zod bundle per
    // attached tool, before the first LLM call, on every single run.
    const tools: LoadedTool[] = attached.map((attachment) => ({
      name: attachment.tool.name,
      description: attachment.tool.description,
      jsonSchema: attachment.tool.jsonSchema as Record<string, unknown>,
    }));
    const toolsByName = new Map(
      attached.map((attachment) => [
        attachment.tool.name,
        { code: attachment.tool.code, paramsZod: attachment.tool.paramsZod },
      ]),
    );
    const secretsAccessor = buildSecretsAccessor(agent.id, providers.secrets, db);

    const runSandboxTool = async (name: string, argsJson: string): Promise<string> => {
      const tool = toolsByName.get(name);
      if (!tool) {
        return JSON.stringify({
          error: "unknown_tool",
          message: `No tool named "${name}" is attached to this agent.`,
        });
      }

      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(argsJson);
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
        agentId: agent.id,
        datastore: providers.datastore,
        secrets: secretsAccessor,
        toolName: name,
      });
      if (!result.ok) {
        return JSON.stringify({ error: result.errorKind, message: result.errorMessage });
      }
      return JSON.stringify(result.value);
    };

    const engineResult = await providers.engine.run({
      agent: {
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        budgetUsd: Number(agent.budgetUsd),
        maxTurns: agent.maxTurns,
      },
      tools,
      providers: { llm: providers.llm },
      runSandboxTool,
      onText,
    });

    return db.run.update({
      where: { id: runId },
      data: {
        status: engineResult.status,
        tokensIn: engineResult.usage.tokensIn,
        tokensOut: engineResult.usage.tokensOut,
        costUsd: engineResult.usage.costUsd,
        error: engineResult.error ?? null,
        finalText: engineResult.finalText || null,
        turns: engineResult.turns,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    // Defensive backstop: the engine is expected to catch its own errors
    // and return a "failed" EngineResult, but an unexpected throw here
    // (a real bug, or tool-loading failing outside the per-tool try above)
    // must still never leave the run dangling in "running".
    return db.run.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
  }
}

/** Convenience: create + execute a manual run in one call (what the CLI's `reevo run` uses). */
export async function runAgent(
  agentName: string,
  providers: Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
): Promise<Run> {
  const run = await createRun(db, agentName, "manual");
  return executeRun(run.id, providers, db, onText);
}
