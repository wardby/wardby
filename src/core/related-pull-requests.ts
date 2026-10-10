/**
 * The pull requests that came from the same request as a run: every pull
 * request opened by a coding run in the same top-level run tree (a lead that
 * fanned out to several repositories), plus any recorded for the same tracker
 * issue (IssuePullRequest). Control-plane rows only.
 * Ordered by the delegating agent's declared merge order when any entry has
 * one (CodingRun.mergeOrder; nulls last), then by when each pull request's
 * coding run was dispatched: the lead's delegation order (for a lead with
 * parallelDelegations, the order its concurrent delegations were admitted,
 * ties broken by repository#number). A pull request's mergeOrder is the
 * newest non-null value set by its opener run or any later continuation
 * that acted on it, so a lead that re-delegates with a different order
 * after the fact is reflected here. When mergeOrder is set on any entry,
 * every truncation cap below this collector (MAX_RELATED_GROUP here,
 * MAX_SIBLING_HINTS on openSiblingsOf, MAX_RELATED_PULL_REQUESTS on
 * renderRelatedSection) drops entries with no order first, since they sort
 * last.
 * A PR opened while siblings were still running lists only the PRs opened
 * before it; updateRelatedPullRequests rewrites every open PR of the set
 * with the full list when the lead run ends. Continuations join
 * the set in both directions: a follow-up that continued one of the set's
 * pull requests brings the original request's tree, and the original request
 * brings every later follow-up tree that continued one of its pull requests.
 */
import { Prisma, type PrismaClient, type Run } from "#prisma";
import { CODING_CODE_PROVIDER, normalizeGitHubRepository } from "../coding/protocol.js";
import {
  ISSUE_KEY,
  ISSUE_TRACKER_NAMES,
  type IssueTrackerProvider,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import type { ReviewHostRegistry } from "../providers/review-host/types.js";
import { renderRelatedSection, type RelatedPullRequestState } from "../providers/vcs/github.js";
import { pullRequestOutcome } from "./host-status.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "related-pull-requests" });

/** Most pull requests a group holds; the description shows fewer (MAX_RELATED_PULL_REQUESTS). */
export const MAX_RELATED_GROUP = 50;
/** Most coding runs read per tree walk (and per continuation lookup). */
const MAX_TREE_CODING_RUNS = 200;
/** Most forward/reverse expansion passes after the seed's own tree walk. */
const MAX_EXPANSION_PASSES = 4;

export type RelatedPullRequestsDb = Pick<PrismaClient, "run" | "codingRun" | "issuePullRequest" | "$queryRaw">;

export type StoredPullRequestState = "open" | "merged" | "closed";
const STORED_STATES = new Set<string>(["open", "merged", "closed"]);

export interface RelatedPullRequest {
  repository: string;
  number: number;
  openedAt: Date;
  /** The coding run that opened it: the continuePriorRun target for a follow-up. */
  openedByRunId: string;
  /** Only when stored (IssuePullRequest.state, kept current by pr_closed); otherwise unknown. */
  state?: StoredPullRequestState;
  /**
   * Step in the delegating agent's merge order (CodingRun.mergeOrder, 1-99),
   * from the coding run that opened it. Absent when that run set none, or
   * when the entry only came from IssuePullRequest (no CodingRun to read it
   * from).
   */
  mergeOrder?: number;
}

export interface RelatedPullRequestGroup {
  pullRequests: RelatedPullRequest[];
  /** The first well-formed issue seen on the group's coding runs. */
  issue?: { provider: string; key: string };
}

interface TreeCodingRun {
  runId: string;
  result: unknown;
  rootCodingRunId: string | null;
  issueProvider: string | null;
  issueKey: string | null;
  startedAt: Date;
  mergeOrder: number | null;
}

/** Every coding run in the top-level trees containing `seeds` (walks up parentRunId, then down). */
async function treeCodingRuns(db: RelatedPullRequestsDb, seeds: string[]): Promise<TreeCodingRun[]> {
  return db.$queryRaw<TreeCodingRun[]>`
    WITH RECURSIVE up AS (
      SELECT r."id", r."parentRunId" FROM "Run" r WHERE r."id" IN (${Prisma.join(seeds)})
      -- UNION, not UNION ALL: a parentRunId cycle (never written, but not a constraint) can't recurse forever.
      UNION
      SELECT p."id", p."parentRunId" FROM "Run" p JOIN up u ON p."id" = u."parentRunId"
    ), down AS (
      SELECT u."id" FROM up u WHERE u."parentRunId" IS NULL
      UNION
      SELECT c."id" FROM "Run" c JOIN down d ON c."parentRunId" = d."id"
    )
    SELECT cr."runId", cr."result", cr."rootCodingRunId", cr."issueProvider", cr."issueKey", cr."mergeOrder", r."startedAt"
    FROM "CodingRun" cr
    JOIN down d ON cr."runId" = d."id"
    JOIN "Run" r ON r."id" = cr."runId"
    ORDER BY r."startedAt" ASC, cr."runId" ASC
    LIMIT ${MAX_TREE_CODING_RUNS}`;
}

function safeRepository(value: string): string | undefined {
  try {
    return normalizeGitHubRepository(value);
  } catch {
    return undefined;
  }
}

export async function collectRelatedPullRequests(
  db: RelatedPullRequestsDb,
  runId: string,
  /**
   * Scopes the issue join (and any tree row explicitly tagged for a
   * different issue) to exactly this issue, instead of every issue key the
   * tree's coding runs happen to carry. Used by openSiblingsForIssue so a
   * tree that touches two cards never leaks the other card's pull requests
   * into this one's continuation hints; omitted by every other caller, which
   * keeps today's "every issue the tree touched" behavior (Decision 2).
   */
  onlyIssueKey?: { provider: string; key: string },
): Promise<RelatedPullRequestGroup> {
  const rows = await treeCodingRuns(db, [runId]);
  const seen = new Set(rows.map((r) => r.runId));
  // A continuation's pull request belongs to the request that opened it, so
  // the set is closed in both directions: forward (a continuation row walks
  // to its root's tree) and reverse (an opener's later continuations, found
  // through the indexed rootCodingRunId, walk their own trees, which may
  // have opened new pull requests). Repeated until nothing new turns up, at
  // most MAX_EXPANSION_PASSES times, and never past a full group.
  const expandedOpeners = new Set<string>();
  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
    const roots: string[] = [];
    const openers: string[] = [];
    let opened = 0;
    for (const r of rows) {
      const outcome = pullRequestOutcome(r.result)?.outcome;
      if (outcome === "pull_request_updated" && r.rootCodingRunId && !seen.has(r.rootCodingRunId)) {
        roots.push(r.rootCodingRunId);
      } else if (outcome === "pull_request_opened") {
        opened++;
        if (!expandedOpeners.has(r.runId)) openers.push(r.runId);
      }
    }
    if (opened >= MAX_RELATED_GROUP) break;
    for (const opener of openers) expandedOpeners.add(opener);
    const continuations =
      openers.length > 0
        ? await db.codingRun.findMany({
            where: { rootCodingRunId: { in: openers } },
            select: { runId: true },
            orderBy: { runId: "asc" },
            take: MAX_TREE_CODING_RUNS,
          })
        : [];
    const seeds = [...new Set([...roots, ...continuations.map((c) => c.runId)])].filter((id) => !seen.has(id));
    if (seeds.length === 0) break;
    let added = 0;
    for (const extra of await treeCodingRuns(db, seeds)) {
      if (!seen.has(extra.runId)) {
        seen.add(extra.runId);
        rows.push(extra);
        added++;
      }
    }
    if (added === 0) break;
  }

  const byKey = new Map<string, RelatedPullRequest>();
  const keyOf = (repository: string, number: number) => `${repository}#${number}`;
  let issue: RelatedPullRequestGroup["issue"];
  const issues = new Map<string, { provider: string; key: string }>();
  for (const r of rows) {
    if (r.issueProvider && r.issueKey && ISSUE_KEY.test(r.issueKey)) {
      const found = { provider: r.issueProvider, key: r.issueKey };
      issue ??= found;
      issues.set(`${found.provider}\0${found.key}`, found);
    }
    const pr = pullRequestOutcome(r.result);
    if (pr?.outcome !== "pull_request_opened") continue;
    // A tree row explicitly tagged for a different card never joins this one's set.
    if (onlyIssueKey && r.issueKey && (r.issueProvider !== onlyIssueKey.provider || r.issueKey !== onlyIssueKey.key)) {
      continue;
    }
    const repository = safeRepository(pr.repository);
    if (repository && !byKey.has(keyOf(repository, pr.pullRequestNumber))) {
      byKey.set(keyOf(repository, pr.pullRequestNumber), {
        repository,
        number: pr.pullRequestNumber,
        openedAt: new Date(r.startedAt),
        openedByRunId: r.runId,
        ...(r.mergeOrder != null ? { mergeOrder: r.mergeOrder } : {}),
      });
    }
  }
  // A continuation's own mergeOrder (which can override the root's, Task 1)
  // is set after the opener's; the entry's mergeOrder is the newest non-null
  // value among the opener row and every continuation row (same PR key,
  // "pull_request_opened" or "pull_request_updated") found in the tree walk.
  const newestMergeOrder = new Map<string, { startedAt: Date; mergeOrder: number }>();
  for (const r of rows) {
    if (r.mergeOrder == null) continue;
    const pr = pullRequestOutcome(r.result);
    if (pr?.outcome !== "pull_request_opened" && pr?.outcome !== "pull_request_updated") continue;
    if (onlyIssueKey && r.issueKey && (r.issueProvider !== onlyIssueKey.provider || r.issueKey !== onlyIssueKey.key)) {
      continue;
    }
    const repository = safeRepository(pr.repository);
    if (!repository) continue;
    const key = keyOf(repository, pr.pullRequestNumber);
    const startedAt = new Date(r.startedAt);
    const current = newestMergeOrder.get(key);
    if (!current || startedAt.getTime() >= current.startedAt.getTime()) {
      newestMergeOrder.set(key, { startedAt, mergeOrder: r.mergeOrder });
    }
  }
  for (const [key, entry] of byKey) {
    const newest = newestMergeOrder.get(key);
    if (newest) entry.mergeOrder = newest.mergeOrder;
  }
  const issueFilter = onlyIssueKey
    ? new Map([[`${onlyIssueKey.provider}\0${onlyIssueKey.key}`, onlyIssueKey]])
    : issues;
  if (issueFilter.size > 0) {
    const recorded = await db.issuePullRequest.findMany({
      where: {
        codeProvider: CODING_CODE_PROVIDER,
        OR: [...issueFilter.values()].map((i) => ({ issueProvider: i.provider, issueKey: i.key })),
      },
      select: { repository: true, number: true, createdAt: true, openedByRunId: true, state: true },
      orderBy: { createdAt: "asc" },
      take: MAX_RELATED_GROUP,
    });
    // Every pull request recorded for the issue, merged and closed included (Decision 2).
    for (const r of recorded) {
      const repository = safeRepository(r.repository);
      if (!repository || !Number.isSafeInteger(r.number) || r.number <= 0) continue;
      const state = STORED_STATES.has(r.state) ? (r.state as StoredPullRequestState) : undefined;
      const existing = byKey.get(keyOf(repository, r.number));
      if (existing) {
        // The tree's own opener and dispatch time stay; the stored state is added.
        if (state) existing.state = state;
        continue;
      }
      byKey.set(keyOf(repository, r.number), {
        repository,
        number: r.number,
        openedAt: r.createdAt,
        openedByRunId: r.openedByRunId,
        ...(state ? { state } : {}),
      });
    }
  }
  const order = (e: { mergeOrder?: number | null }) => e.mergeOrder ?? Number.POSITIVE_INFINITY;
  const pullRequests = [...byKey.values()]
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        a.openedAt.getTime() - b.openedAt.getTime() ||
        `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`),
    )
    .slice(0, MAX_RELATED_GROUP);
  return { pullRequests, ...(issue ? { issue } : {}) };
}

interface LivePullRequest {
  repository: string;
  number: number;
  state?: RelatedPullRequestState;
  /** Set only when the PR is the App's own and its marker run is one this deployment recorded here. */
  markerRunId?: string;
  /** Carried through from RelatedPullRequest.mergeOrder for rendering. */
  mergeOrder?: number;
}

function issueFor(
  group: RelatedPullRequestGroup,
  trackers: IssueTrackerRegistry | undefined,
): { key: string; url?: string; trackerName?: string } | undefined {
  if (!group.issue) return undefined;
  const provider = group.issue.provider as IssueTrackerProvider;
  let url: string | undefined;
  try {
    url = trackers?.[provider]?.issueUrl(group.issue.key);
  } catch {
    url = undefined;
  }
  const trackerName = Object.hasOwn(ISSUE_TRACKER_NAMES, provider) ? ISSUE_TRACKER_NAMES[provider] : undefined;
  return { key: group.issue.key, ...(url ? { url } : {}), ...(trackerName ? { trackerName } : {}) };
}

/**
 * After a native run ends, rewrites the Related pull requests section on
 * every open pull request of its request (control-plane rows only). Best
 * effort: never throws, and never removes a section (a set of one writes
 * nothing). Only PRs the App authored, whose marker names a coding run this
 * deployment recorded in that repository, are edited.
 */
export async function updateRelatedPullRequests(
  db: RelatedPullRequestsDb,
  run: Pick<Run, "id">,
  hosts: ReviewHostRegistry | undefined,
  trackers: IssueTrackerRegistry | undefined,
): Promise<void> {
  const host = hosts?.[CODING_CODE_PROVIDER as keyof ReviewHostRegistry];
  if (!host?.replaceRelatedSection || !host.pullRequestOrigin) return;
  try {
    // A run that delegated nothing has no request set of its own.
    if (!(await db.run.findFirst({ where: { parentRunId: run.id }, select: { id: true } }))) return;
    const group = await collectRelatedPullRequests(db, run.id);
    if (group.pullRequests.length < 2) return;

    const live: LivePullRequest[] = [];
    for (const pr of group.pullRequests) {
      // A stored merged/closed state is final and such a PR is never edited: no host read.
      if (pr.state === "merged" || pr.state === "closed") {
        live.push({
          repository: pr.repository,
          number: pr.number,
          state: pr.state,
          ...(pr.mergeOrder !== undefined ? { mergeOrder: pr.mergeOrder } : {}),
        });
        continue;
      }
      try {
        const origin = await host.pullRequestOrigin(pr.repository, pr.number);
        const state: RelatedPullRequestState = origin.merged
          ? "merged"
          : origin.state !== "open"
            ? "closed"
            : origin.draft
              ? "draft"
              : "open";
        let markerRunId: string | undefined;
        if (origin.markerRunId) {
          const opener = await db.codingRun.findUnique({
            where: { runId: origin.markerRunId },
            select: { repository: true },
          });
          if (opener && opener.repository.toLowerCase() === pr.repository) markerRunId = origin.markerRunId;
        }
        live.push({
          repository: pr.repository,
          number: pr.number,
          state,
          ...(markerRunId ? { markerRunId } : {}),
          ...(pr.mergeOrder !== undefined ? { mergeOrder: pr.mergeOrder } : {}),
        });
      } catch (err) {
        log.warn(
          { err, runId: run.id, repository: pr.repository, number: pr.number },
          "could not read a related pull request",
        );
        // The stored state (issue-recorded PRs) is better than none; never edited without a live read.
        live.push({
          repository: pr.repository,
          number: pr.number,
          ...(pr.state ? { state: pr.state } : {}),
          ...(pr.mergeOrder !== undefined ? { mergeOrder: pr.mergeOrder } : {}),
        });
      }
    }

    const issue = issueFor(group, trackers);
    for (const target of live) {
      if (!target.markerRunId || (target.state !== "open" && target.state !== "draft")) continue;
      const block = renderRelatedSection({
        entries: live.map((pr) => ({
          repository: pr.repository,
          number: pr.number,
          ...(pr.state ? { state: pr.state } : {}),
          ...(pr === target ? { self: true } : {}),
          ...(pr.mergeOrder !== undefined ? { mergeOrder: pr.mergeOrder } : {}),
        })),
        ...(issue ? { issue } : {}),
      });
      if (!block) continue;
      try {
        const outcome = await host.replaceRelatedSection(target.repository, target.number, {
          expectedMarkerRunId: target.markerRunId,
          block,
        });
        log.info(
          { runId: run.id, repository: target.repository, number: target.number, outcome },
          "related pull requests section",
        );
      } catch (err) {
        log.warn(
          { err, runId: run.id, repository: target.repository, number: target.number },
          "could not update a related pull requests section",
        );
      }
    }
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not update related pull requests");
  }
}

/** Most open siblings hinted in one task. */
export const MAX_SIBLING_HINTS = 10;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Closes every sibling-hint block (mention and Jira alike). */
export const SIBLING_GUIDANCE =
  "Continue the pull request you were asked about, and a listed open one only when the change requires it. " +
  "Never open a new pull request in a repository that already has an open pull request listed here. Merged or " +
  "closed pull requests are not listed: a change there needs a new pull request.";

export interface OpenSibling {
  repository: string;
  number: number;
  openedByRunId: string;
}

/**
 * The group's pull requests a follow-up may continue: stored state "open", or
 * no stored state yet (a same-tree sibling not recorded for an issue), minus
 * `exclude` and malformed run ids. Stored state only: no host call. A hint for
 * a PR that has closed since is refused by the continuation itself (git.ts).
 */
export function openSiblingsOf(
  group: RelatedPullRequestGroup,
  exclude?: { repository: string; number: number },
): OpenSibling[] {
  const excluded = exclude ? `${safeRepository(exclude.repository) ?? ""}#${exclude.number}` : "";
  return group.pullRequests
    .filter(
      (pr) =>
        (pr.state === undefined || pr.state === "open") &&
        `${pr.repository}#${pr.number}` !== excluded &&
        SAFE_RUN_ID.test(pr.openedByRunId),
    )
    .slice(0, MAX_SIBLING_HINTS)
    .map((pr) => ({ repository: pr.repository, number: pr.number, openedByRunId: pr.openedByRunId }));
}

/** Open siblings of the request `seedRunId` belongs to. Never throws. */
export async function openSiblings(
  db: RelatedPullRequestsDb,
  seedRunId: string,
  exclude: { repository: string; number: number },
): Promise<OpenSibling[]> {
  try {
    return openSiblingsOf(await collectRelatedPullRequests(db, seedRunId), exclude);
  } catch (err) {
    log.warn({ err, seedRunId }, "could not list open sibling pull requests; continuing without hints");
    return [];
  }
}

/**
 * Open pull requests of a whole card: seeded from the newest pull request
 * recorded for the issue (any agent), then the collector is scoped to this
 * issue alone (never "every issue the tree touched") so a tree that happens
 * to also carry another card's coding runs can't leak that card's pull
 * requests into this one's hints. Never throws.
 */
export async function openSiblingsForIssue(
  db: RelatedPullRequestsDb,
  issue: { provider: string; key: string },
): Promise<OpenSibling[]> {
  try {
    const newest = await db.issuePullRequest.findMany({
      where: { issueProvider: issue.provider, issueKey: issue.key, codeProvider: CODING_CODE_PROVIDER },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { openedByRunId: true },
    });
    const seed = newest[0]?.openedByRunId;
    if (!seed || !SAFE_RUN_ID.test(seed)) return [];
    return openSiblingsOf(await collectRelatedPullRequests(db, seed, issue));
  } catch (err) {
    log.warn({ err, issueKey: issue.key }, "could not list the issue's open pull requests; continuing without hints");
    return [];
  }
}
