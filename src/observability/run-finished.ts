import type { PrismaClient } from "#prisma";
import { logger } from "../core/logger.js";

const runLog = logger.child({ module: "runs" });

export type RunFinishedDb = Pick<PrismaClient, "run" | "runBudgetEvent">;

/**
 * The `run.finished` operator log line: one per run, for native and coding runs alike, so a log
 * pipeline can follow an agent's runs and spend. Ids, names, enums and amounts only: never the
 * run's task, final text or error, which can carry untrusted or secret text.
 */
export interface RunFinishedLog {
  event: "run.finished";
  runId: string;
  agentId: string;
  agentName: string;
  runKind: "native" | "coding";
  parentRunId: string | null;
  trigger: string;
  status: string;
  costUsd: number;
  /** The most the run could spend: a coding run's limit, or a native run's agent budget. */
  budgetUsd: number;
  /** The agent's budget group, when it has one. */
  budgetGroup?: string;
  /** The limit behind the run's latest budget refusal (run, run-tree, day, week, month), if any. */
  budgetLimit?: string;
  tokensIn: number;
  tokensOut: number;
  durationMs?: number;
}

/** Builds the line from the stored run. Null when the run is gone. */
export async function runFinishedLog(db: RunFinishedDb, runId: string): Promise<RunFinishedLog | null> {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: {
      id: true,
      agentId: true,
      parentRunId: true,
      trigger: true,
      status: true,
      costUsd: true,
      tokensIn: true,
      tokensOut: true,
      startedAt: true,
      finishedAt: true,
      agent: { select: { name: true, budgetUsd: true, budgetGroup: { select: { name: true } } } },
      codingRun: { select: { budgetReservedUsd: true, budgetLimitUsd: true } },
    },
  });
  if (!run) return null;
  const refusal = await db.runBudgetEvent.findFirst({
    where: { runId },
    orderBy: { at: "desc" },
    select: { limit: true },
  });
  const budgetUsd = run.codingRun
    ? Number(run.codingRun.budgetLimitUsd ?? run.codingRun.budgetReservedUsd)
    : Number(run.agent.budgetUsd);
  return {
    event: "run.finished",
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agent.name,
    runKind: run.codingRun ? "coding" : "native",
    parentRunId: run.parentRunId,
    trigger: run.trigger,
    status: run.status,
    costUsd: Number(run.costUsd),
    budgetUsd,
    ...(run.agent.budgetGroup ? { budgetGroup: run.agent.budgetGroup.name } : {}),
    ...(refusal ? { budgetLimit: refusal.limit } : {}),
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    ...(run.finishedAt ? { durationMs: run.finishedAt.getTime() - run.startedAt.getTime() } : {}),
  };
}

/**
 * Writes `run.finished` for a run its caller just made terminal. Call it only from the finalizer
 * whose write made the run terminal, so each run is logged once. Never throws: telemetry cannot
 * change a run's outcome.
 */
export async function logRunFinished(
  db: RunFinishedDb,
  runId: string,
  sink: Pick<typeof runLog, "info"> = runLog,
): Promise<void> {
  try {
    const line = await runFinishedLog(db, runId);
    if (line) sink.info(line, "run finished");
  } catch (err) {
    runLog.warn(
      { event: "run.finished_failed", runId, errorName: err instanceof Error ? err.name : typeof err },
      "could not log the finished run",
    );
  }
}
