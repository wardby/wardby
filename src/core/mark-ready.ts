/**
 * Marks a draft pull request Wardby's own App opened ready for review once it passes (#287):
 * every Wardby review check on the head succeeded, CI is green, and the `wardby merge order`
 * check is success or absent. Opt-in per write link (AgentRepository.markReadyWhenPassing) of
 * the agent the repository event triggers: the builder that opened the pull request, or a lead
 * that delegated to it (coding agents cannot link repositories, so a lead's link carries it).
 * At most once per pull request (CodingRun.markedReadyAt on the opener's root coding run for its
 * default repository's, CodingRunRepository.markedReadyAt on the root's row for an extra's, #537),
 * so a person moving it back to draft is final. Cheap DB checks first; no host reads unless some
 * link on the repository opted in.
 *
 * The host only confirms the pull request was authored by this App. The trust boundary is
 * here: the pull request's marker must resolve (resolveRunPullRequest) to a root coding run
 * whose default repository or writable extra is this repository, recorded as this pull request
 * (provider included), whose agent, or an ancestor agent in its
 * run tree (Run.parentRunId, at most MAX_ANCESTOR_HOPS up), has an authorized, opted-in write
 * link on this repository. An opted-in agent outside that run tree never counts. Only
 * authorized links (authorizedVia set) count, for opting in and for review checks.
 *
 * Work a run stopped at its budget pushed (a draft to continue) is never marked ready.
 *
 * Never approves, merges, or converts back to draft. Never throws.
 */
import type { PrismaClient } from "#prisma";
import type { ReviewHostRegistry } from "../providers/review-host/types.js";
import { lastPushStoppedAtBudget } from "./budget-stopped-head.js";
import type { Logger } from "./logger.js";
import { MERGE_ORDER_CHECK_NAME } from "./merge-order-check.js";
import { resolveRunPullRequest } from "./run-pull-request.js";

export type MarkReadyOutcome = "marked" | "off" | "not_ready" | "skipped" | "failed";
export type MarkReadyDb = Pick<
  PrismaClient,
  "agentRepository" | "codingRun" | "codingRunRepository" | "run" | "runHostCheck"
>;
export interface MarkReadyDeps {
  db: MarkReadyDb;
  hosts: ReviewHostRegistry | undefined;
  log?: Logger;
}

const CI_GREEN = new Set(["passing", "none"]);
/** How far up the run tree (Run.parentRunId) the opt-in may come from. */
const MAX_ANCESTOR_HOPS = 10;

const CODING_RUN_SELECT = {
  runId: true,
  repository: true,
  rootCodingRunId: true,
  markedReadyAt: true,
  result: true,
  run: { select: { agentId: true, parentRunId: true, status: true } },
} as const;

const passed = (c: { status: string; conclusion: string | null } | undefined): boolean =>
  c !== undefined && c.status === "completed" && c.conclusion === "success";

export async function maybeMarkReady(
  deps: MarkReadyDeps,
  repository: string,
  prNumber: number,
  provider: string,
): Promise<MarkReadyOutcome> {
  try {
    const host = deps.hosts?.[provider];
    if (!host?.pullRequestOrigin || !host.readOwnChecks || !host.readCi || !host.markReadyForReview) return "off";
    const links = await deps.db.agentRepository.findMany({
      where: { provider, repository },
      select: {
        agentId: true,
        access: true,
        triggers: true,
        checkName: true,
        markReadyWhenPassing: true,
        authorizedVia: true,
      },
    });
    const optedIn = new Set(
      links
        .filter((l) => l.access === "write" && l.authorizedVia !== null && l.markReadyWhenPassing)
        .map((l) => l.agentId),
    );
    if (optedIn.size === 0) return "off";
    const reviewChecks = links
      .filter(
        (l) => l.access === "write" && l.authorizedVia !== null && l.triggers.includes("pull_request") && l.checkName,
      )
      .map((l) => l.checkName as string);
    if (reviewChecks.length === 0) return "not_ready";
    // readOwnChecks reads at most 10 names; MERGE_ORDER_CHECK_NAME plus the reviewer
    // check names must fit, or the merge-order check would silently be read as absent.
    if (reviewChecks.length > 9) return "not_ready";

    const origin = await host.pullRequestOrigin(repository, prNumber);
    if (origin.state !== "open" || origin.draft !== true || origin.isFork || !origin.markerRunId) return "not_ready";

    const target = await resolveRunPullRequest(deps.db, {
      markerRunId: origin.markerRunId,
      provider,
      repository,
      pullRequestNumber: prNumber,
    });
    if (!target.ok) return "not_ready";
    const root = await deps.db.codingRun.findUnique({ where: { runId: target.root.runId }, select: CODING_RUN_SELECT });
    if (!root) return "not_ready";
    const extra = target.repo.kind === "extra" ? target.repo.name : undefined;
    if (!(await optedInInRunTree(deps.db, root.run, optedIn))) return "not_ready";
    if (await markedReady(deps.db, root, extra)) return "skipped";
    if (await lastPushStoppedAtBudget(deps.db, root, prNumber, extra)) return "not_ready";

    const checks = await host.readOwnChecks(repository, origin.headSha, [MERGE_ORDER_CHECK_NAME, ...reviewChecks]);
    if (!reviewChecks.every((name) => passed(checks.get(name)))) return "not_ready";
    const order = checks.get(MERGE_ORDER_CHECK_NAME);
    if (order !== undefined && !passed(order)) return "not_ready";

    const ci = await host.readCi(repository, origin.headSha);
    if (!CI_GREEN.has(ci.state) || ci.truncated) return "not_ready";

    const claimedAt = new Date();
    // CodingRun.updatedAt is @updatedAt, so this claim (and a release below) bumps it, which
    // feeds the merge-order sweep's ordering. Harmless: the sweep re-derives state from the
    // host each time, it doesn't rely on updatedAt being untouched by mark-ready.
    // The default repository's claim is on the root CodingRun; an extra's on the root's row of that
    // name (#537), so each pull request of the set is marked once.
    const claimRow = (from: Date | null, to: Date | null) =>
      extra === undefined
        ? deps.db.codingRun.updateMany({
            where: { runId: root.runId, markedReadyAt: from },
            data: { markedReadyAt: to },
          })
        : deps.db.codingRunRepository.updateMany({
            where: { runId: root.runId, name: extra, markedReadyAt: from },
            data: { markedReadyAt: to },
          });
    const claim = await claimRow(null, claimedAt);
    if (claim.count === 0) return "skipped";
    const release = () =>
      claimRow(claimedAt, null).catch((err: unknown) =>
        deps.log?.warn({ err, repository, prNumber }, "could not release the mark-ready claim"),
      );
    try {
      const result = await host.markReadyForReview(repository, prNumber, origin.headSha, origin.markerRunId);
      if (result === "marked") {
        deps.log?.info({ repository, prNumber }, "marked the pull request ready for review");
        return "marked";
      }
      await release();
      return "skipped";
    } catch (err) {
      await release();
      throw err;
    }
  } catch (err) {
    deps.log?.warn({ err, repository, prNumber }, "could not mark the pull request ready for review");
    return "failed";
  }
}

/** Whether the pull request was marked already: the root's own claim, or its row named `extra`'s. */
async function markedReady(
  db: MarkReadyDb,
  root: { runId: string; markedReadyAt: Date | null },
  extra: string | undefined,
): Promise<boolean> {
  if (extra === undefined) return root.markedReadyAt !== null;
  const row = await db.codingRunRepository.findUnique({
    where: { runId_name: { runId: root.runId, name: extra } },
    select: { markedReadyAt: true },
  });
  return row?.markedReadyAt != null;
}

/**
 * True when the opener's agent, or an agent up its run tree (bounded, cycle-safe), is opted in.
 * A coding run's parentRunId is set when a lead delegated to it.
 */
async function optedInInRunTree(
  db: MarkReadyDb,
  opener: { agentId: string; parentRunId?: string | null },
  optedIn: ReadonlySet<string>,
): Promise<boolean> {
  if (optedIn.has(opener.agentId)) return true;
  const seen = new Set<string>();
  let next = opener.parentRunId ?? null;
  for (let hop = 0; next && hop < MAX_ANCESTOR_HOPS && !seen.has(next); hop++) {
    seen.add(next);
    const run = await db.run.findUnique({ where: { id: next }, select: { agentId: true, parentRunId: true } });
    if (!run) return false;
    if (optedIn.has(run.agentId)) return true;
    next = run.parentRunId;
  }
  return false;
}

/** After a reviewer run ends: evaluate the pull request it reviewed. Null when it reviewed none. */
export async function markReadyAfterRun(deps: MarkReadyDeps, runId: string): Promise<MarkReadyOutcome | null> {
  try {
    const row = await deps.db.runHostCheck.findUnique({
      where: { runId },
      select: { provider: true, repository: true, prNumber: true, verdict: true },
    });
    if (!row || row.prNumber === null || !row.verdict) return null;
    return await maybeMarkReady(deps, row.repository, row.prNumber, row.provider);
  } catch (err) {
    deps.log?.warn({ err, runId }, "could not evaluate mark-ready after the run");
    return "failed";
  }
}
