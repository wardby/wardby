import type { Prisma } from "#prisma";
import { FOLLOW_UP_KINDS } from "../../core/run-follow-up-handlers.js";
import { enqueueRunFollowUp } from "../../core/run-follow-ups.js";

/** The chores that follow a coding run's terminal status, by kind (container.ts holds their handlers). */
export const CODING_FOLLOW_UP_KINDS = {
  /** Captures the session transcript, then removes the job. In that order: capture needs the pod. */
  releaseJob: "coding_run_release_job",
  /** Posts the final status on the run's pull request (a continuation). */
  hostNotify: "coding_run_host_notify",
  /** Runs `onCodingRunTerminal` (the no-change re-review, releasing reviews that waited for the run). */
  terminalHook: "coding_run_terminal_hook",
} as const;

/**
 * How long the drain leaves a coding run's chores to the process that ended the run. That process does
 * them right after the status write and marks them done; past this the process is presumed dead.
 */
export const CODING_FOLLOW_UP_GRACE_MS = 60_000;

/**
 * Queues the chores of a coding run that just became terminal (and its self-defect when `selfDefect`);
 * call it in the transaction of the status write.
 */
export async function enqueueCodingRunFollowUps(
  tx: Pick<Prisma.TransactionClient, "runFollowUp">,
  runId: string,
  options: { selfDefect: boolean; now?: Date },
): Promise<void> {
  const notBefore = new Date((options.now ?? new Date()).getTime() + CODING_FOLLOW_UP_GRACE_MS);
  for (const kind of Object.values(CODING_FOLLOW_UP_KINDS)) await enqueueRunFollowUp(tx, { runId, kind, notBefore });
  // Nothing else files it for a coding run, so no grace: the drain does it.
  if (options.selfDefect) await enqueueRunFollowUp(tx, { runId, kind: FOLLOW_UP_KINDS.selfDefect });
}
