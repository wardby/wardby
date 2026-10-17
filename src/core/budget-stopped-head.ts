/**
 * Which run last pushed to a pull request a coding run opened, and whether that push was work a
 * run stopped at its budget left unfinished. Mark-ready keeps such a draft a draft; the review
 * check skips it while its head is still that push (a person's later commit is reviewed).
 */
import type { PrismaClient } from "#prisma";
import { pullRequestOutcome } from "./host-status.js";

export type BudgetStoppedHeadDb = Pick<PrismaClient, "codingRun">;

/** The run that pushed last: its status and the commit it pushed (result.commitSha). */
export interface LastPusher {
  status: string | undefined;
  commitSha: string | undefined;
}

const commitShaOf = (result: unknown): string | undefined => {
  if (!result || typeof result !== "object") return undefined;
  const sha = (result as Record<string, unknown>).commitSha;
  return typeof sha === "string" ? sha : undefined;
};

/**
 * The newest continuation of `root` (by createdAt) whose result names pull request `prNumber`,
 * else the root itself.
 */
export async function lastPusher(
  db: BudgetStoppedHeadDb,
  root: { runId: string; result: unknown; run: { status?: string } | null },
  prNumber: number,
): Promise<LastPusher> {
  const continuations = await db.codingRun.findMany({
    where: { rootCodingRunId: root.runId },
    select: { result: true, run: { select: { status: true } } },
    orderBy: { createdAt: "desc" },
  });
  const last = continuations.find((c) => pullRequestOutcome(c.result)?.pullRequestNumber === prNumber) ?? root;
  return { status: last.run?.status, commitSha: commitShaOf(last.result) };
}

/**
 * True when the pull request's head is the push of a run that stopped at its budget: the marker
 * run resolves (through rootCodingRunId) to a root coding run recorded as this pull request, and
 * its last pusher stopped at its budget with `headSha` as its commit. Any lookup failure is
 * false, so the pull request is reviewed as usual.
 */
export async function headStoppedAtBudget(
  db: BudgetStoppedHeadDb,
  input: { markerRunId: string | null | undefined; prNumber: number; headSha: string },
): Promise<boolean> {
  try {
    if (!input.markerRunId) return false;
    const select = { runId: true, rootCodingRunId: true, result: true, run: { select: { status: true } } } as const;
    const marked = await db.codingRun.findUnique({ where: { runId: input.markerRunId }, select });
    if (!marked) return false;
    const root = marked.rootCodingRunId
      ? await db.codingRun.findUnique({ where: { runId: marked.rootCodingRunId }, select })
      : marked;
    if (!root || pullRequestOutcome(root.result)?.pullRequestNumber !== input.prNumber) return false;
    const last = await lastPusher(db, root, input.prNumber);
    return last.status === "budget_exhausted" && last.commitSha === input.headSha;
  } catch {
    return false;
  }
}
