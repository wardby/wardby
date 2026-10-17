/**
 * Links a run's pull requests to the issue that started it: records each
 * issue/PR pair (recordIssuePullRequests, the same for a Jira issue and a
 * GitHub issue), and for a tracker issue puts a web link on the issue and
 * applies the link's configured status move. Provider-neutral: a code host is
 * only ever { provider, repository, number }. The issue key comes from the run
 * tree (RunIssueStatus, or a GitHub mention's RunHostStatus), never from model
 * output. The status move is a control-plane
 * action (not gated by allowedTransitions). Nothing here throws, except
 * handlePullRequestClosed's lookup before it has claimed anything (so the
 * webhook delivery is rolled back and redelivered).
 */
import { Prisma, type PrismaClient } from "#prisma";
import {
  projectOf,
  type IssueTracker,
  type IssueTrackerProvider,
  type IssueTrackerRegistry,
} from "../providers/issue-tracker/types.js";
import { normalizeGitHubRepository } from "../coding/protocol.js";
import { logger } from "./logger.js";
import { dedupeKeys, emitWorkflowEvent } from "./workflow-events.js";

const log = logger.child({ module: "issue-bridge" });

export type IssueBridgeDb = Pick<PrismaClient, "issuePullRequest">;
export type PullRequestClosedDb = Pick<PrismaClient, "issuePullRequest" | "agentIssueProject">;

export interface BridgedPullRequest {
  codeProvider: string;
  repository: string;
  number: number;
  url: string;
  openedByRunId: string;
  outcome: "pull_request_opened" | "pull_request_updated";
}

export interface RecordPullRequestsInput {
  issueKey: string;
  issueProvider: string;
  agentId: string;
  /** The status the link moves the issue to when a pull request is opened, if configured. */
  onPullRequestOpened?: string | null;
  pullRequests: BridgedPullRequest[];
}

export const pullRequestGlobalId = (pr: Pick<BridgedPullRequest, "codeProvider" | "repository" | "number">): string =>
  `wardby:pr:${pr.codeProvider}:${pr.repository}#${pr.number}`;

type PairState = "created" | "open" | "settled" | "unknown";

/** The issue side of an IssuePullRequest row: { provider: "jira", key: "PROJ-7" } or githubIssueKey's. */
export interface RecordedIssue {
  provider: string;
  key: string;
}

/** One pull request to record against an issue. */
export interface IssuePullRequestRecord {
  codeProvider: string;
  repository: string;
  number: number;
  url: string;
  /** The issue-linked agent whose run tree opened it. */
  agentId: string;
  /** The coding run that opened it (the continuePriorRun target for follow-ups). */
  openedByRunId: string;
  /** What the run did to it: only a newly recorded opened pull request notifies (pr_opened). */
  outcome: "pull_request_opened" | "pull_request_updated";
}

/** A GitHub issue's IssuePullRequest key: "<owner>/<repo>#<number>", the repository normalised. */
export function githubIssueKey(repository: string, number: number): string {
  return `${normalizeGitHubRepository(repository)}#${number}`;
}

/**
 * Makes sure the issue/PR pair has a row, without ever overwriting one: a new
 * row is "created"; an existing open one gets its url refreshed ("open"); a
 * merged or closed one is left alone ("settled"). A lost create race (P2002)
 * reads back the winner's row. "unknown" when the store could not be read.
 */
async function ensurePair(db: IssueBridgeDb, issue: RecordedIssue, pr: IssuePullRequestRecord): Promise<PairState> {
  const where = {
    codeProvider_repository_number_issueProvider_issueKey: {
      codeProvider: pr.codeProvider,
      repository: pr.repository,
      number: pr.number,
      issueProvider: issue.provider,
      issueKey: issue.key,
    },
  };
  try {
    let existing = await db.issuePullRequest.findUnique({ where, select: { state: true } });
    if (!existing) {
      try {
        await db.issuePullRequest.create({
          data: {
            issueProvider: issue.provider,
            issueKey: issue.key,
            codeProvider: pr.codeProvider,
            repository: pr.repository,
            number: pr.number,
            url: pr.url,
            agentId: pr.agentId,
            openedByRunId: pr.openedByRunId,
          },
        });
        return "created";
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        existing = await db.issuePullRequest.findUnique({ where, select: { state: true } });
        if (!existing) return "unknown";
      }
    }
    if (existing.state !== "open") return "settled";
    await db.issuePullRequest.update({ where, data: { url: pr.url } });
    return "open";
  } catch (err) {
    log.warn(
      { err, issueKey: issue.key, repository: pr.repository, number: pr.number },
      "could not record the issue/PR pair",
    );
    return "unknown";
  }
}

/** Records each pair (ensurePair), in order; each state lines up with its pull request. Never throws. */
async function recordPairs(
  db: IssueBridgeDb,
  issue: RecordedIssue,
  prs: readonly IssuePullRequestRecord[],
): Promise<PairState[]> {
  const states: PairState[] = [];
  for (const pr of prs) states.push(await ensurePair(db, issue, pr));
  return states;
}

/**
 * Notifies pr_opened for each pull request this call newly recorded as opened
 * (`states` lines up with `prs`), so a retried completion does not notify
 * twice. One message and dedupe key for every issue provider. Never throws.
 */
async function emitNewlyOpened(
  issue: RecordedIssue,
  prs: readonly IssuePullRequestRecord[],
  states: readonly PairState[],
  movedTo: string | null,
): Promise<void> {
  for (const [i, pr] of prs.entries()) {
    if (states[i] !== "created" || pr.outcome !== "pull_request_opened") continue;
    await emitWorkflowEvent({
      dedupeKey: dedupeKeys.prOpened(pr.codeProvider, pr.repository, pr.number),
      runId: pr.openedByRunId,
      agentId: pr.agentId,
      workItem: { provider: issue.provider, key: issue.key },
      pullRequest: { codeProvider: pr.codeProvider, repository: pr.repository, number: pr.number },
      payload: { kind: "pr_opened", prLabel: `${pr.repository}#${pr.number}`, prUrl: pr.url, movedTo },
    });
  }
}

/**
 * Records the pull requests a run opened or continued for an issue, the same
 * for every issue provider (a Jira issue, a GitHub issue): one IssuePullRequest
 * row per issue/PR pair, state "open", never duplicated or overwritten (a
 * merged or closed pair stays so; an open one gets its url refreshed), and a
 * pr_opened notification for each newly recorded opened pull request.
 * handlePullRequestClosed settles the rows. A GitHub issue's key is always
 * githubIssueKey's, so any lookup of its rows must build the key the same way.
 * Safe to repeat; never throws.
 */
export async function recordIssuePullRequests(
  db: IssueBridgeDb,
  issue: RecordedIssue,
  prs: readonly IssuePullRequestRecord[],
): Promise<void> {
  try {
    await emitNewlyOpened(issue, prs, await recordPairs(db, issue, prs), null);
  } catch (err) {
    log.warn({ err, issueKey: issue.key }, "could not record the issue's pull requests");
  }
}

/**
 * The coding runs (of `runIds`) that continued a pull request opened for a
 * different issue: their PR belongs to that issue, not this one. A
 * continuation is foreign when its root coding run was dispatched for another
 * tracked issue (CodingRun.issueKey), or when that root opened a pull request
 * recorded for a different issue of any provider (IssuePullRequest, which a
 * GitHub issue's runs also write). A continued PR with no issue, or this same
 * issue, is fine.
 */
export async function continuedForAnotherIssue(
  db: Pick<PrismaClient, "codingRun" | "issuePullRequest">,
  runIds: string[],
  issue: RecordedIssue,
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db.codingRun.findMany({
    where: { runId: { in: runIds } },
    select: {
      runId: true,
      rootCodingRunId: true,
      rootCodingRun: { select: { issueProvider: true, issueKey: true } },
    },
  });
  const foreign = new Set<string>();
  const byRoot = new Map<string, string[]>();
  for (const { runId, rootCodingRunId, rootCodingRun: root } of rows) {
    if (root?.issueKey && (root.issueKey !== issue.key || root.issueProvider !== issue.provider)) {
      foreign.add(runId);
    } else if (rootCodingRunId) {
      byRoot.set(rootCodingRunId, [...(byRoot.get(rootCodingRunId) ?? []), runId]);
    }
  }
  if (byRoot.size > 0) {
    const recorded = await db.issuePullRequest.findMany({
      where: { openedByRunId: { in: [...byRoot.keys()] } },
      select: { openedByRunId: true, issueProvider: true, issueKey: true },
    });
    for (const r of recorded) {
      if (r.issueProvider === issue.provider && r.issueKey === issue.key) continue;
      for (const runId of byRoot.get(r.openedByRunId) ?? []) foreign.add(runId);
    }
  }
  return foreign;
}

/**
 * Returns sentences for the outcome comment (a refused status move); empty
 * when there is nothing to say. Safe to repeat (a retried completion): each
 * pair's side effects happen once — the status move only when this call newly
 * recorded an opened pull request, and a merged/closed pair is never re-linked
 * (re-posting its web link would un-resolve it). An unreadable store skips
 * both rather than risk repeating them.
 */
export async function recordPullRequests(
  db: IssueBridgeDb,
  tracker: IssueTracker,
  input: RecordPullRequestsInput,
): Promise<{ notes: string[] }> {
  const notes: string[] = [];
  try {
    let newlyOpened = false;
    const issue = { provider: input.issueProvider, key: input.issueKey };
    const records = input.pullRequests.map((pr) => ({ ...pr, agentId: input.agentId }));
    const states = await recordPairs(db, issue, records);
    for (const [i, pr] of input.pullRequests.entries()) {
      const state = states[i];
      if (state === "created" && pr.outcome === "pull_request_opened") newlyOpened = true;
      if (state !== "created" && state !== "open") continue;
      try {
        await tracker.addRemoteLink(input.issueKey, {
          globalId: pullRequestGlobalId(pr),
          url: pr.url,
          title: `${pr.repository}#${pr.number}`,
        });
      } catch (err) {
        log.warn(
          { err, issueKey: input.issueKey, repository: pr.repository, number: pr.number },
          "could not link the pull request on the issue",
        );
      }
    }
    const target = input.onPullRequestOpened;
    let movedTo: string | null = null;
    if (target && newlyOpened) {
      try {
        const moved = await tracker.transitionTo(input.issueKey, target);
        movedTo = moved.toStatus || target;
      } catch (err) {
        log.warn({ err, issueKey: input.issueKey, target }, "could not move the issue after a pull request opened");
        notes.push(`Could not move ${input.issueKey} to "${target}"; it may need a manual move.`);
      }
    }
    // Only pairs this call newly recorded, so a retried completion does not notify twice. Never throws.
    await emitNewlyOpened(issue, records, states, movedTo);
  } catch (err) {
    log.warn({ err, issueKey: input.issueKey }, "could not bridge the pull requests to the issue");
  }
  return { notes };
}

export interface ClosedPullRequest {
  codeProvider: string;
  repository: string;
  number: number;
  merged: boolean;
}

/**
 * A pull request wardby recorded against an issue was merged or closed: marks
 * each still-open pair (every issue provider, configured tracker or not),
 * and, for an issue in a configured tracker where the agent's link to the
 * issue's project is still write, comments on the issue (and on merge resolves the web link and
 * applies the link's onPullRequestMerged move). Only rows wardby wrote are
 * touched, matched by the host's own identity for the PR — nothing from the
 * PR's text. The row is claimed first (open → merged/closed), so a duplicate
 * or concurrent delivery finds nothing to do. Throws only when the lookup of
 * linked rows fails — before anything is claimed — so the caller's webhook
 * delivery is rolled back and redelivered; never throws after that.
 */
export async function handlePullRequestClosed(
  db: PullRequestClosedDb,
  trackers: IssueTrackerRegistry | undefined,
  pr: ClosedPullRequest,
): Promise<void> {
  const where = { codeProvider: pr.codeProvider, repository: pr.repository, number: pr.number };
  // Not caught: nothing is claimed yet, and a throw rolls back the delivery so it is redelivered.
  // Oldest pair first: pr_closed's dedupe key is per pull request, so the first-recorded issue's event is
  // the one kept, every delivery alike.
  const rows = await db.issuePullRequest.findMany({
    where: { ...where, state: "open" },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    // Exactly once per claimed row, from the finally below, even when a later step throws: the row is no
    // longer open, so nothing would retry it. Never throws.
    const emitClosed = (movedTo: string | null) =>
      emitWorkflowEvent({
        dedupeKey: dedupeKeys.prClosed(pr.codeProvider, pr.repository, pr.number),
        agentId: row.agentId,
        workItem: { provider: row.issueProvider, key: row.issueKey },
        pullRequest: { codeProvider: pr.codeProvider, repository: pr.repository, number: pr.number },
        payload: {
          kind: "pr_closed",
          prLabel: `${row.repository}#${row.number}`,
          prUrl: row.url,
          merged: pr.merged,
          movedTo,
        },
      });
    let claimedRow = false;
    let movedTo: string | null = null;
    try {
      const claimed = await db.issuePullRequest.updateMany({
        where: { id: row.id, state: "open" },
        data: { state: pr.merged ? "merged" : "closed" },
      });
      if (claimed.count === 0) continue;
      claimedRow = true;
      // A pair with no configured tracker (a GitHub issue's, say) is only marked.
      const tracker = trackers?.[row.issueProvider as IssueTrackerProvider];
      if (!tracker) continue;
      const link = await db.agentIssueProject.findUnique({
        where: {
          agentId_provider_projectKey: {
            agentId: row.agentId,
            provider: row.issueProvider,
            projectKey: projectOf(row.issueKey),
          },
        },
        select: { access: true, commentVisibilityRole: true, onPullRequestMerged: true },
      });
      if (link?.access !== "write") continue;
      const ref = `[${row.repository}#${row.number}](${row.url})`;
      let markdown: string;
      if (pr.merged) {
        await tracker
          .addRemoteLink(row.issueKey, {
            globalId: pullRequestGlobalId(row),
            url: row.url,
            title: `${row.repository}#${row.number}`,
            status: { resolved: true },
          })
          .catch((err: unknown) =>
            log.warn({ err, issueKey: row.issueKey, ...where }, "could not resolve the pull request's web link"),
          );
        markdown = `✅ Pull request ${ref} was merged.`;
        const target = link.onPullRequestMerged;
        if (target) {
          try {
            const moved = await tracker.transitionTo(row.issueKey, target);
            movedTo = moved.toStatus;
            markdown += ` Moved to ${moved.toStatus}.`;
          } catch (err) {
            log.warn({ err, issueKey: row.issueKey, target }, "could not move the issue after its pull request merged");
            markdown += ` Could not move ${row.issueKey} to "${target}"; it may need a manual move.`;
          }
        }
      } else {
        markdown = `Pull request ${ref} was closed without merging.`;
      }
      await tracker.comment(row.issueKey, {
        markdown,
        ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
      });
    } catch (err) {
      log.warn({ err, issueKey: row.issueKey, ...where }, "could not bridge the closed pull request to the issue");
    } finally {
      if (claimedRow) await emitClosed(movedTo);
    }
  }
}
