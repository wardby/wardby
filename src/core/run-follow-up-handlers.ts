import type { Prisma, PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import type { IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import { stopChildrenOfLostRun } from "./lost-run-children.js";
import { DRIVABLE } from "./run-status.js";
import { enqueueRunFollowUp, type RunFollowUpHandlers } from "./run-follow-ups.js";
import { fileSelfDefect } from "./self-defects.js";
import { emitRunFinishedEvents } from "./workflow-run-events.js";

/** The chores the control plane does after a run's terminal status. A kind names one handler. */
export const FOLLOW_UP_KINDS = {
  /** Stops the still-drivable children of a run that ended lost. */
  stopChildren: "stop_children",
  /** Files (or re-sights) the run's self-defect. */
  selfDefect: "self_defect",
  /** Emits the run's outcome and review-verdict workflow events. */
  runFinishedEvents: "run_finished_events",
} as const;

/** The chores that follow a lost run, in the order they used to run. */
export const LOST_RUN_FOLLOW_UP_KINDS = [
  FOLLOW_UP_KINDS.stopChildren,
  FOLLOW_UP_KINDS.selfDefect,
  FOLLOW_UP_KINDS.runFinishedEvents,
] as const;

/** Queues the chores of a run that just became `lost`; call it in the transaction of the status write. */
export async function enqueueLostRunFollowUps(
  tx: Pick<Prisma.TransactionClient, "runFollowUp">,
  runId: string,
): Promise<void> {
  for (const kind of LOST_RUN_FOLLOW_UP_KINDS) await enqueueRunFollowUp(tx, { runId, kind });
}

/** How long one self-defect filing may take; under HANDLER_TIMEOUT_MS so the handler, not the race, ends it. */
const SELF_DEFECT_FILING_WAIT_MS = 90_000;

class ChildrenStillDrivable extends Error {
  override readonly name = "ChildrenStillDrivable";
}

export interface RunFollowUpHandlerDeps {
  db: Pick<
    PrismaClient,
    | "run"
    | "agent"
    | "agentIssueProject"
    | "principal"
    | "resourceGrant"
    | "runHook"
    | "planSet"
    | "codingRun"
    | "runHostCheck"
    | "runBudgetEvent"
    | "registryFetch"
    | "registryAuditRecord"
    | "$transaction"
  >;
  /** Stops children of a lost run; absent: the chore is a no-op. */
  executor?: Pick<Executor, "stop">;
  issueTrackers?: IssueTrackerRegistry;
}

/**
 * The handlers every run type shares, by kind. Each loads what it needs from the database by run id (a
 * payload holds ids, never content) and is safe to run again. The container executor adds its own
 * (`Executor.followUpHandlers`); `serve` and the scheduler merge the two.
 */
export function buildRunFollowUpHandlers(deps: RunFollowUpHandlerDeps): RunFollowUpHandlers {
  const { db, executor, issueTrackers } = deps;
  return {
    [FOLLOW_UP_KINDS.stopChildren]: async ({ runId }) => {
      if (!executor) return;
      await stopChildrenOfLostRun(db, executor, runId);
      // The helper logs a child it could not stop and moves on; the row is retried while one is left.
      const remaining = await db.run.count({ where: { parentRunId: runId, status: { in: [...DRIVABLE] } } });
      if (remaining > 0) throw new ChildrenStillDrivable();
    },
    [FOLLOW_UP_KINDS.selfDefect]: async ({ runId }) => {
      const run = await db.run.findUnique({
        where: { id: runId },
        select: { id: true, agentId: true, status: true, error: true, finishedAt: true },
      });
      if (!run) return;
      await fileSelfDefect(db, issueTrackers, run, { waitMs: SELF_DEFECT_FILING_WAIT_MS });
    },
    [FOLLOW_UP_KINDS.runFinishedEvents]: async ({ runId }) => {
      const run = await db.run.findUnique({
        where: { id: runId },
        select: { id: true, agentId: true, status: true, error: true, parentRunId: true },
      });
      if (run) await emitRunFinishedEvents(db, run);
    },
  };
}

/** The drain's handlers: the shared ones plus the executor's own. */
export function runFollowUpHandlersFor(deps: RunFollowUpHandlerDeps & { executor?: Executor }): RunFollowUpHandlers {
  return { ...buildRunFollowUpHandlers(deps), ...deps.executor?.followUpHandlers?.() };
}
