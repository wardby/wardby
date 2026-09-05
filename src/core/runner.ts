/**
 * The single-turn runner. Uses only `ProviderRegistry.llm` — the other
 * seams (jobs, email, secrets, auth, storage) stay unimplemented until a
 * later phase actually needs them.
 *
 * Split into `createRun` (persist a pending Run for an agent) and
 * `executeRun` (drive an existing Run to a terminal state) so Phase 2's
 * scheduler can create the Run itself (inside its claim transaction) and
 * hand the id to an `Executor`, which is what actually calls `executeRun`.
 * `runAgent` is the Phase 1 convenience that does both in one call, and is
 * what the CLI's `reevo run` still uses directly (an attended, foreground
 * command doesn't need the executor's heartbeat/reconciler durability —
 * only unattended scheduled runs do).
 */

import type { PrismaClient, Run, RunTrigger } from "@prisma/client";
import type { LlmUsage, ProviderRegistry } from "../providers/index.js";
import {
  applyPreflightSafetyMargin,
  checkTokenCalibration,
  estimateInputCost,
  isOverBudget,
} from "./budget.js";
import { prisma as defaultDb } from "./db.js";

/** The subset of the Prisma client the runner touches — mockable in tests. */
export type RunnerDb = Pick<PrismaClient, "agent" | "run">;

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
  providers: Pick<ProviderRegistry, "llm">,
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

  const budgetUsd = Number(agent.budgetUsd);
  const messages = [
    { role: "system" as const, content: agent.systemPrompt },
    { role: "user" as const, content: "Begin." },
  ];

  const { tokens: inputTokens, costUsd: inputEstimateCost } =
    await estimateInputCost({ model: agent.model, budgetUsd }, messages, providers.llm);
  const guardedInputEstimateCost = applyPreflightSafetyMargin(inputEstimateCost);

  if (isOverBudget(guardedInputEstimateCost, budgetUsd)) {
    return db.run.update({
      where: { id: runId },
      data: {
        status: "refused",
        error:
          `Estimated input cost $${inputEstimateCost.toFixed(6)} (with safety margin: ` +
          `$${guardedInputEstimateCost.toFixed(6)}) meets or exceeds budget ` +
          `$${budgetUsd.toFixed(4)} before any LLM call.`,
        finishedAt: new Date(),
      },
    });
  }

  // Per-message framing overhead (role, priming, etc.) counted once up
  // front, so the mid-stream loop below can price each new delta on its
  // own — O(delta length) per event — instead of re-tokenizing the whole
  // accumulated output on every event, which is O(output length) per event
  // and O(output length²) overall for a long stream. Summing per-delta
  // counts is an approximation of the true whole-text count (BPE can merge
  // across a chunk boundary), acceptable because this is a guardrail
  // projection, not the billed total — that comes from the `done` event.
  const assistantFrameTokens = await providers.llm.countTokens(agent.model, [
    { role: "assistant", content: "" },
  ]);

  const controller = new AbortController();
  let outputTokensSoFar = 0;
  let usage: LlmUsage | undefined;
  let budgetExceeded = false;
  let projectedAtAbort = 0;
  let outputTokensAtAbort = 0;

  try {
    for await (const event of providers.llm.stream(
      { model: agent.model, messages },
      controller.signal,
    )) {
      if (event.type === "text") {
        onText?.(event.delta);

        const deltaTokens = await providers.llm.countTokens(agent.model, [
          { role: "assistant", content: event.delta },
        ]);
        outputTokensSoFar += Math.max(deltaTokens - assistantFrameTokens, 0);
        const projected = providers.llm.priceUsd(agent.model, {
          inputTokens,
          outputTokens: outputTokensSoFar,
        });
        if (isOverBudget(projected, budgetUsd)) {
          budgetExceeded = true;
          projectedAtAbort = projected;
          outputTokensAtAbort = outputTokensSoFar;
          controller.abort();
          break;
        }
      } else if (event.type === "done") {
        usage = event.usage;
      }
    }
  } catch (err) {
    return db.run.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      },
    });
  }

  if (budgetExceeded) {
    return db.run.update({
      where: { id: runId },
      data: {
        status: "failed",
        tokensIn: inputTokens,
        tokensOut: outputTokensAtAbort,
        costUsd: projectedAtAbort,
        error:
          `Budget exceeded mid-stream: projected cost $${projectedAtAbort.toFixed(6)} ` +
          `crossed budget $${budgetUsd.toFixed(4)}.`,
        finishedAt: new Date(),
      },
    });
  }

  if (!usage) {
    return db.run.update({
      where: { id: runId },
      data: {
        status: "failed",
        error: "LLM stream ended without a usage summary.",
        finishedAt: new Date(),
      },
    });
  }

  const calibration = checkTokenCalibration(inputTokens, usage.inputTokens);
  if (calibration.diverged) {
    const direction =
      calibration.deltaRatio < 0
        ? "UNDERestimated (dangerous — the pre-flight refuse gate could admit an over-budget run)"
        : "overestimated (safe direction)";
    console.warn(
      `[reevo-run] token calibration drift for model "${agent.model}": local pre-flight ` +
        `estimate was ${calibration.estimatedTokens} tokens vs. actual ${calibration.actualTokens} ` +
        `(${(calibration.deltaRatio * 100).toFixed(1)}%, ${direction}). Check the tokenizer ` +
        `encoding and per-message overhead constants for this model in src/providers/llm/openai.ts.`,
    );
  }

  return db.run.update({
    where: { id: runId },
    data: {
      status: "succeeded",
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      costUsd: usage.costUsd,
      finishedAt: new Date(),
    },
  });
}

/** Convenience: create + execute a manual run in one call (what the CLI's `reevo run` uses). */
export async function runAgent(
  agentName: string,
  providers: Pick<ProviderRegistry, "llm">,
  db: RunnerDb = defaultDb,
  onText?: (delta: string) => void,
): Promise<Run> {
  const run = await createRun(db, agentName, "manual");
  return executeRun(run.id, providers, db, onText);
}
