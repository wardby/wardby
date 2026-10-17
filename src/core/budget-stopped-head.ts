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

const ROOT_SELECT = {
  runId: true,
  repository: true,
  rootCodingRunId: true,
  result: true,
  run: { select: { status: true } },
} as const;

/** The marker run's root coding run (rootCodingRunId, else itself), only when it is in `repository`. */
async function markerRoot(db: BudgetStoppedHeadDb, markerRunId: string, repository: string) {
  const marked = await db.codingRun.findUnique({ where: { runId: markerRunId }, select: ROOT_SELECT });
  if (!marked) return null;
  const root = marked.rootCodingRunId
    ? await db.codingRun.findUnique({ where: { runId: marked.rootCodingRunId }, select: ROOT_SELECT })
    : marked;
  return root && root.repository.toLowerCase() === repository.toLowerCase() ? root : null;
}

/**
 * True when the pull request's head is the push of a run that stopped at its budget: the marker
 * run resolves (through rootCodingRunId) to a root coding run in `repository` recorded as this
 * pull request, and its last pusher stopped at its budget with `headSha` as its commit. Any
 * lookup failure is false, so the pull request is reviewed as usual.
 */
export async function headStoppedAtBudget(
  db: BudgetStoppedHeadDb,
  input: { markerRunId: string | null | undefined; repository: string; prNumber: number; headSha: string },
): Promise<boolean> {
  try {
    if (!input.markerRunId) return false;
    const root = await markerRoot(db, input.markerRunId, input.repository);
    if (!root || pullRequestOutcome(root.result)?.pullRequestNumber !== input.prNumber) return false;
    const last = await lastPusher(db, root, input.prNumber);
    return last.status === "budget_exhausted" && last.commitSha === input.headSha;
  } catch {
    return false;
  }
}

/** Run statuses of a coding run that may still push (its result is not recorded yet). */
const IN_FLIGHT = ["pending", "running"] as const;

/**
 * The coding run that may be pushing to the pull request right now: the marker's root coding
 * run (in `repository`) while it is pending or running, else its newest continuation that is.
 * Its result, and so whether it stopped at its budget, is recorded only after its push lands,
 * so a review of the head waits for it. Null when none is in flight or the marker resolves to
 * nothing.
 */
export async function pushingRunInFlight(
  db: BudgetStoppedHeadDb,
  input: { markerRunId: string | null | undefined; repository: string },
): Promise<string | null> {
  if (!input.markerRunId) return null;
  const root = await markerRoot(db, input.markerRunId, input.repository);
  if (!root) return null;
  if (root.run && (IN_FLIGHT as readonly string[]).includes(root.run.status)) return root.runId;
  const continuation = await db.codingRun.findFirst({
    where: { rootCodingRunId: root.runId, run: { status: { in: [...IN_FLIGHT] } } },
    select: { runId: true },
    orderBy: { createdAt: "desc" },
  });
  return continuation?.runId ?? null;
}
