/**
 * The `wardby merge order` check: pure state computation from a related
 * pull request set's declared merge order (CodingRun.mergeOrder, see
 * related-pull-requests.ts). See
 * docs/private/2026-10-10-delegated-merge-order-design.md Part 3.
 *
 * For a member with order *k*, its dependencies are the set's members with
 * a strictly lower, non-null order; equal-order peers are not dependencies,
 * and a null-order member is never a dependency (and has none of its own).
 * The check is posted only when the set has more than one distinct non-null
 * order; otherwise (or when `self` itself has no order) there is nothing to
 * gate and the verdict is "skip".
 *
 * syncMergeOrderChecks keeps the check current on every open pull request
 * of a set: at the lead's end (syncMergeOrderChecksAfterRun), when a pull
 * request closes or gets a new head (syncMergeOrderChecksForPullRequest,
 * from host-events), and from the reconciler (sweepMergeOrderChecks) for
 * missed events. State is read fresh from the host each time; nothing is
 * stored. Best effort: none of these ever throws.
 */
import type { Run } from "#prisma";
import { CODING_CODE_PROVIDER, normalizeGitHubRepository } from "../coding/protocol.js";
import type { PullRequestOrigin, ReviewHostRegistry, UpsertNamedCheckInput } from "../providers/review-host/types.js";
import { logger, type Logger } from "./logger.js";
import { collectRelatedPullRequests, runTreeRoot, type RelatedPullRequestsDb } from "./related-pull-requests.js";

const moduleLog = logger.child({ module: "merge-order-check" });

export const MERGE_ORDER_CHECK_NAME = "wardby merge order";

export interface MergeOrderMember {
  repository: string;
  number: number;
  mergeOrder: number | null;
  state: "open" | "draft" | "merged" | "closed";
  url?: string;
}

export type MergeOrderVerdict =
  | { status: "skip" }
  | { status: "in_progress"; waitingFor: MergeOrderMember[] }
  | { status: "success"; dependencies: MergeOrderMember[] }
  | { status: "failure"; closedUnmerged: MergeOrderMember[] };

/**
 * `set` may include or omit `self`: self's own order always counts toward
 * the distinct orders, and self is never its own dependency (dependencies
 * have a strictly lower order). `self` need not be the same object instance
 * as its entry in `set`; only `mergeOrder` is read from it.
 */
export function mergeOrderVerdict(self: MergeOrderMember, set: readonly MergeOrderMember[]): MergeOrderVerdict {
  const distinctOrders = new Set<number>();
  if (self.mergeOrder !== null) distinctOrders.add(self.mergeOrder);
  for (const m of set) if (m.mergeOrder !== null) distinctOrders.add(m.mergeOrder);
  if (distinctOrders.size < 2) return { status: "skip" };
  if (self.mergeOrder === null) return { status: "skip" };

  const selfOrder = self.mergeOrder;
  const dependencies = set.filter((m) => m.mergeOrder !== null && m.mergeOrder < selfOrder);

  const closedUnmerged = dependencies.filter((m) => m.state === "closed");
  if (closedUnmerged.length > 0) return { status: "failure", closedUnmerged };

  const waitingFor = dependencies.filter((m) => m.state !== "merged");
  if (waitingFor.length > 0) return { status: "in_progress", waitingFor };

  return { status: "success", dependencies };
}

export type MergeOrderDb = RelatedPullRequestsDb;

export interface MergeOrderSyncDeps {
  db: MergeOrderDb;
  hosts: ReviewHostRegistry | undefined;
  log?: Logger;
}

export interface MergeOrderSyncOptions {
  /** A pull request this event already read: reused instead of reading it a second time. */
  origin?: { repository: string; number: number; read: () => Promise<PullRequestOrigin> };
  /** A pull request this event reports closed: its state comes from the event, and it is not read. */
  closed?: { repository: string; number: number; merged: boolean };
  /**
   * Sets already synced in this event or sweep pass, keyed by their sorted
   * members: seeds from different roots of one set (an original request
   * and a follow-up) collect the same set, which is then written once.
   */
  synced?: Set<string>;
}

interface LiveMember {
  member: MergeOrderMember;
  /** False when the host read failed: the state is unknown. */
  known: boolean;
  /** Only for a PR the App opened whose marker names a coding run recorded here for that repository. */
  headSha?: string;
}

const prUrl = (repository: string, number: number) => `https://github.com/${repository}/pull/${number}`;
/** `repository#number` as a link: never a title or any other free text from the host. */
const prLink = (m: MergeOrderMember) => `[${m.repository}#${m.number}](${prUrl(m.repository, m.number)})`;
const keyOf = (repository: string, number: number) => `${repository}#${number}`;

function safeRepository(value: string): string | undefined {
  try {
    return normalizeGitHubRepository(value);
  } catch {
    return undefined;
  }
}

function originState(origin: PullRequestOrigin): MergeOrderMember["state"] {
  if (origin.merged) return "merged";
  if (origin.state !== "open") return "closed";
  return origin.draft ? "draft" : "open";
}

/**
 * The check run's text for one verdict: step label, then the pull requests
 * it depends on, as links. While the delegating run is still running
 * (`leadRunning`) it may still add or reorder steps, so a success for any
 * step above the set's lowest is posted as in_progress, waiting for it.
 */
export function mergeOrderCheckInput(
  self: MergeOrderMember,
  verdict: Exclude<MergeOrderVerdict, { status: "skip" }>,
  steps: readonly number[],
  headSha: string,
  leadRunning = false,
): UpsertNamedCheckInput {
  const step = `Step ${steps.indexOf(self.mergeOrder!) + 1} of ${steps.length} in the merge order set by the delegating agent.`;
  const base = { headSha, name: MERGE_ORDER_CHECK_NAME };
  const lines = (members: MergeOrderMember[]) => members.map(prLink).join(", ");
  if (verdict.status === "success" && leadRunning && self.mergeOrder !== steps[0]) {
    return {
      ...base,
      status: "in_progress",
      title: "Waiting for the delegating run to finish",
      summary:
        `${step}\n\nEvery earlier step has merged, but the delegating run is still running and may change ` +
        `the steps; waiting for it to finish.` +
        (verdict.dependencies.length > 0 ? `\n\nMerged: ${lines(verdict.dependencies)}` : ""),
    };
  }
  switch (verdict.status) {
    case "success":
      return {
        ...base,
        status: "completed",
        conclusion: "success",
        title: verdict.dependencies.length > 0 ? "Every earlier step has merged" : "First step: nothing to wait for",
        summary: verdict.dependencies.length > 0 ? `${step}\n\nMerged: ${lines(verdict.dependencies)}` : step,
      };
    case "failure":
      return {
        ...base,
        status: "completed",
        conclusion: "failure",
        title: "An earlier step was closed without merging",
        summary: `${step}\n\nClosed without merging: ${lines(verdict.closedUnmerged)}`,
      };
    case "in_progress":
      return {
        ...base,
        status: "in_progress",
        title: `Waiting for ${verdict.waitingFor.length} earlier pull request${verdict.waitingFor.length === 1 ? "" : "s"} to merge`,
        summary: `${step}\n\nWaiting for: ${lines(verdict.waitingFor)}`,
      };
  }
}

/**
 * Recomputes and posts the `wardby merge order` check on every open (or
 * draft) pull request of the set `seedRunId` belongs to (any run of the
 * request's tree). Nothing happens unless the set has more than one
 * distinct merge order. Each member's state is read live from the host
 * (a stored "merged" is final and not re-read); the check is posted only on
 * an open or draft pull request the App opened whose marker names a coding
 * run this deployment recorded for that repository, on its current head.
 * A member that can't be read holds back only the checks that depend on it.
 * Never throws.
 */
export async function syncMergeOrderChecks(
  deps: MergeOrderSyncDeps,
  seedRunId: string,
  opts: MergeOrderSyncOptions = {},
): Promise<void> {
  const log = deps.log ?? moduleLog;
  const host = deps.hosts?.[CODING_CODE_PROVIDER as keyof ReviewHostRegistry];
  if (!host?.upsertNamedCheck || !host.pullRequestOrigin) return;
  try {
    const group = await collectRelatedPullRequests(deps.db, seedRunId);
    if (opts.synced) {
      const setKey = group.pullRequests
        .map((pr) => keyOf(pr.repository, pr.number))
        .sort()
        .join("\n");
      if (opts.synced.has(setKey)) return;
      opts.synced.add(setKey);
    }
    const steps = [
      ...new Set(group.pullRequests.flatMap((pr) => (pr.mergeOrder !== undefined ? [pr.mergeOrder] : []))),
    ].sort((a, b) => a - b);
    if (steps.length < 2) return;
    // A property of the set, whichever root it was seeded from: any of its run trees' roots (the
    // original request, or a follow-up that continued one of its PRs) still running may change steps.
    const leadRunning = (group.roots ?? []).some((r) => r.status === "pending" || r.status === "running");

    const reused = opts.origin ? safeRepository(opts.origin.repository) : undefined;
    const closed = opts.closed ? safeRepository(opts.closed.repository) : undefined;
    const members: LiveMember[] = [];
    // Bounded by the collector's MAX_RELATED_GROUP: at most one read per member.
    for (const pr of group.pullRequests) {
      const base = { repository: pr.repository, number: pr.number, mergeOrder: pr.mergeOrder ?? null };
      const key = keyOf(pr.repository, pr.number);
      if (closed && key === keyOf(closed, opts.closed!.number)) {
        members.push({ member: { ...base, state: opts.closed!.merged ? "merged" : "closed" }, known: true });
        continue;
      }
      if (pr.state === "merged") {
        members.push({ member: { ...base, state: "merged" }, known: true });
        continue;
      }
      // No order: never a dependency and never checked, so its state is never needed: no read.
      if (base.mergeOrder === null) {
        members.push({ member: { ...base, state: "open" }, known: true });
        continue;
      }
      try {
        const origin =
          reused && key === keyOf(reused, opts.origin!.number)
            ? await opts.origin!.read()
            : await host.pullRequestOrigin(pr.repository, pr.number);
        let headSha: string | undefined;
        if (origin.markerRunId) {
          const opener = await deps.db.codingRun.findUnique({
            where: { runId: origin.markerRunId },
            select: { repository: true },
          });
          if (opener && opener.repository.toLowerCase() === pr.repository) headSha = origin.headSha;
        }
        members.push({ member: { ...base, state: originState(origin) }, known: true, ...(headSha ? { headSha } : {}) });
      } catch (err) {
        log.warn(
          { err, seedRunId, repository: pr.repository, number: pr.number },
          "could not read a pull request of a merge-ordered set",
        );
        members.push({ member: { ...base, state: "open" }, known: false });
      }
    }

    const set = members.map((m) => m.member);
    for (const target of members) {
      const self = target.member;
      if (!target.headSha || self.mergeOrder === null || (self.state !== "open" && self.state !== "draft")) continue;
      const order = self.mergeOrder;
      if (members.some((m) => !m.known && m.member.mergeOrder !== null && m.member.mergeOrder < order)) {
        log.info(
          { seedRunId, repository: self.repository, number: self.number },
          "merge order check left as is: an earlier step could not be read",
        );
        continue;
      }
      const verdict = mergeOrderVerdict(self, set);
      if (verdict.status === "skip") continue;
      try {
        await host.upsertNamedCheck(
          self.repository,
          mergeOrderCheckInput(self, verdict, steps, target.headSha, leadRunning),
        );
        log.info(
          { seedRunId, repository: self.repository, number: self.number, status: verdict.status },
          "merge order check posted",
        );
      } catch (err) {
        log.warn(
          { err, seedRunId, repository: self.repository, number: self.number },
          "could not post the merge order check",
        );
      }
    }
  } catch (err) {
    log.warn({ err, seedRunId }, "could not sync the merge order checks");
  }
}

/**
 * At a run's end: a tree root (the lead) that delegated anything syncs its
 * set. A run that delegated nothing costs one indexed lookup. Never throws.
 */
export async function syncMergeOrderChecksAfterRun(
  deps: MergeOrderSyncDeps,
  run: Pick<Run, "id" | "parentRunId">,
): Promise<void> {
  if (run.parentRunId !== null) return;
  const host = deps.hosts?.[CODING_CODE_PROVIDER as keyof ReviewHostRegistry];
  if (!host?.upsertNamedCheck || !host.pullRequestOrigin) return;
  try {
    if (!(await deps.db.run.findFirst({ where: { parentRunId: run.id }, select: { id: true } }))) return;
  } catch (err) {
    (deps.log ?? moduleLog).warn({ err, runId: run.id }, "could not sync the merge order checks");
    return;
  }
  await syncMergeOrderChecks(deps, run.id);
}

/** Most coding runs (seeds) looked up per pull request event or sweep pass. */
const MAX_SEEDS = 20;

/** Coding runs with a merge order whose outcome is pull request `repository#number`. */
async function orderedSeeds(db: MergeOrderDb, repository: string, number: number): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ runId: string }>>`
    SELECT cr."runId"
    FROM "CodingRun" cr
    WHERE cr."mergeOrder" IS NOT NULL
      AND lower(cr."repository") = lower(${repository})
      AND cr."result"->>'outcome' IN ('pull_request_opened', 'pull_request_updated')
      AND lower(cr."result"->>'repository') = lower(${repository})
      AND cr."result"->>'pullRequestNumber' = ${String(number)}
    ORDER BY cr."updatedAt" DESC
    LIMIT ${MAX_SEEDS}`;
  return rows.map((r) => r.runId);
}

/**
 * A pull request closed or got a new head: syncs every set it is an
 * ordered member of. Only a pull request a coding run with a merge order
 * opened or continued can change any verdict (a member without an order is
 * no one's dependency and gets no check), so anything else costs one query
 * and no host call. Never throws.
 */
export async function syncMergeOrderChecksForPullRequest(
  deps: MergeOrderSyncDeps,
  pr: { repository: string; number: number },
  opts: MergeOrderSyncOptions = {},
): Promise<void> {
  const log = deps.log ?? moduleLog;
  const host = deps.hosts?.[CODING_CODE_PROVIDER as keyof ReviewHostRegistry];
  if (!host?.upsertNamedCheck || !host.pullRequestOrigin) return;
  const repository = safeRepository(pr.repository);
  if (!repository || !Number.isSafeInteger(pr.number) || pr.number <= 0) return;
  let roots: Array<{ id: string }>;
  try {
    roots = [];
    for (const seed of await orderedSeeds(deps.db, repository, pr.number)) {
      const root = await runTreeRoot(deps.db, seed, repository);
      if (root && !roots.some((r) => r.id === root.id)) roots.push(root);
    }
  } catch (err) {
    log.warn({ err, repository, number: pr.number }, "could not find the merge-ordered sets of a pull request");
    return;
  }
  const synced = new Set<string>();
  for (const root of roots) await syncMergeOrderChecks(deps, root.id, { ...opts, synced });
}

/** The sweep runs at most this often per process (the reconciler ticks every 15 s). */
export const MERGE_ORDER_SWEEP_INTERVAL_MS = 10 * 60_000;
/** Coding runs with a merge order updated within this long are swept. */
export const MERGE_ORDER_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Most coding runs read per sweep pass. */
const MERGE_ORDER_SWEEP_SEEDS = 50;
/** Most sets synced per sweep pass; the least recently synced go first. */
export const MERGE_ORDER_SWEEP_BATCH = 10;

let lastSweepAt = Number.NEGATIVE_INFINITY;
/** Root run id -> when this process last swept it: rotates the batch across passes. */
const lastSyncedAt = new Map<string, number>();

export function resetMergeOrderSweepForTests(): void {
  lastSweepAt = Number.NEGATIVE_INFINITY;
  lastSyncedAt.clear();
}

/**
 * The reconciler's half, for missed pr_closed/pr_updated events: syncs the
 * sets of pull requests that coding runs with a merge order opened or
 * continued in the last 7 days, a bounded batch per pass, at most once per
 * MERGE_ORDER_SWEEP_INTERVAL_MS per process. Returns the number of sets
 * synced. Never throws.
 */
export async function sweepMergeOrderChecks(deps: MergeOrderSyncDeps, now: Date = new Date()): Promise<number> {
  const log = deps.log ?? moduleLog;
  const host = deps.hosts?.[CODING_CODE_PROVIDER as keyof ReviewHostRegistry];
  if (!host?.upsertNamedCheck || !host.pullRequestOrigin) return 0;
  if (now.getTime() - lastSweepAt < MERGE_ORDER_SWEEP_INTERVAL_MS) return 0;
  lastSweepAt = now.getTime();
  const since = new Date(now.getTime() - MERGE_ORDER_SWEEP_MAX_AGE_MS);
  for (const [root, at] of lastSyncedAt) if (at < since.getTime()) lastSyncedAt.delete(root);
  let roots: Array<{ id: string }>;
  try {
    // Covers the MERGE_ORDER_SWEEP_SEEDS most recently updated coding runs with a merge order
    // within the last 7 days; older sets rely on their pr_closed/pr_updated events alone.
    const rows = await deps.db.$queryRaw<Array<{ runId: string; repository: string }>>`
      SELECT cr."runId", cr."repository"
      FROM "CodingRun" cr
      WHERE cr."mergeOrder" IS NOT NULL
        AND cr."updatedAt" >= ${since}
        AND cr."result"->>'outcome' IN ('pull_request_opened', 'pull_request_updated')
      ORDER BY cr."updatedAt" DESC
      LIMIT ${MERGE_ORDER_SWEEP_SEEDS}`;
    roots = [];
    for (const row of rows) {
      const root = await runTreeRoot(deps.db, row.runId, row.repository);
      if (root && !roots.some((r) => r.id === root.id)) roots.push(root);
    }
  } catch (err) {
    log.warn({ err }, "merge order check sweep failed");
    return 0;
  }
  const batch = roots
    .map((root, index) => ({ root, index, at: lastSyncedAt.get(root.id) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .slice(0, MERGE_ORDER_SWEEP_BATCH);
  const synced = new Set<string>();
  for (const { root } of batch) {
    lastSyncedAt.set(root.id, now.getTime());
    await syncMergeOrderChecks(deps, root.id, { synced });
  }
  return batch.length;
}
