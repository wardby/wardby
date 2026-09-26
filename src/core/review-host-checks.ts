import type { PrismaClient, Run } from "#prisma";
import type { ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "review-host-checks" });

/**
 * A check the control plane started for a run must never stay "in progress":
 * when the run reaches any terminal state without the review tool having
 * completed it, complete it neutral. Best effort — a failure is logged, not
 * retried; the check's Re-run button still works. Never throws.
 */
export async function closeOpenHostCheck(
  db: Pick<PrismaClient, "runHostCheck">,
  run: Pick<Run, "id" | "status">,
  hosts: ReviewHostRegistry | undefined,
): Promise<void> {
  if (!hosts) return;
  try {
    const check = await db.runHostCheck.findUnique({ where: { runId: run.id } });
    if (!check || check.completedAt) return;
    const host = hosts[check.provider as ReviewHostProvider];
    if (!host) return;
    await host.completeCheck(check.repository, {
      checkId: check.checkId,
      conclusion: "neutral",
      title: "Review did not complete",
      summary: `wardby run ${run.id} ended with status "${run.status}" before publishing a review. Use Re-run to try again.`,
    });
    await db.runHostCheck.update({ where: { runId: run.id }, data: { completedAt: new Date() } });
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the run's host check");
  }
}
