/**
 * The status comment for a run started by an @-mention. Where to comment is
 * recorded with the run itself (mentionStatusRow, written in the dispatch
 * transaction); the "working on it" comment is posted right after the webhook
 * is answered, and edited once with the outcome — the pull requests its coding
 * sub-runs opened or updated, the agent's reply when none came out, or why it
 * did not succeed. A run that ends before its comment was posted (the instance
 * died first, say) still gets one: the reconciler posts the outcome as a new
 * comment. Best effort throughout: nothing here throws.
 */
import type { Prisma, PrismaClient, Run } from "#prisma";
import type { CodeReviewHost, ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "host-status" });

/** Keeps the edited comment readable; the full reply stays on the run. */
const MAX_REPLY_CHARS = 2000;
const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);

export type HostStatusDb = Pick<PrismaClient, "runHostStatus" | "run">;

type FinishedRun = Pick<Run, "id" | "status" | "finalText">;

/** The parts of a CodingRun result this comment uses. */
export interface PullRequestOutcome {
  outcome: "pull_request_opened" | "pull_request_updated";
  repository: string;
  pullRequestNumber: number;
}

/** A sub-run that ended without succeeding. */
export interface FailedChild {
  id: string;
  status: string;
}

const runLine = (runId: string): string => `<sub>wardby run \`${runId}\`</sub>`;

export function workingBody(runId: string): string {
  return `👀 Working on it.\n\n${runLine(runId)}`;
}

/** The status row for a mention run, created in the same transaction as the run. */
export function mentionStatusRow(
  provider: ReviewHostProvider,
  event: { repository: string; number: number; replyToReviewCommentId?: string },
  runId: string,
): Prisma.RunHostStatusUncheckedCreateInput {
  return {
    runId,
    provider,
    repository: event.repository,
    number: event.number,
    commentKind: event.replyToReviewCommentId ? "inline" : "conversation",
    replyToReviewCommentId: event.replyToReviewCommentId ?? null,
  };
}

function pullRequestOutcome(result: unknown): PullRequestOutcome | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.outcome !== "pull_request_opened" && r.outcome !== "pull_request_updated") return null;
  if (typeof r.repository !== "string" || typeof r.pullRequestNumber !== "number") return null;
  if (!Number.isInteger(r.pullRequestNumber) || r.pullRequestNumber <= 0) return null;
  return { outcome: r.outcome, repository: r.repository, pullRequestNumber: r.pullRequestNumber };
}

/** The agent's reply as a quote, cut to MAX_REPLY_CHARS, with @-mentions defused so nobody is pinged. */
function quoteReply(text: string): string {
  const cut = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
  return cut
    .replace(/@(?=[\w-])/g, "@​")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function outcomeBody(
  run: FinishedRun,
  repository: string,
  pullRequests: PullRequestOutcome[],
  failedChildren: FailedChild[] = [],
): string {
  const links = pullRequests.map((pr) => {
    const ref =
      pr.repository.toLowerCase() === repository.toLowerCase()
        ? `#${pr.pullRequestNumber}`
        : `${pr.repository}#${pr.pullRequestNumber}`;
    return pr.outcome === "pull_request_opened" ? `Opened ${ref}` : `Pushed changes to ${ref}`;
  });
  const partial = links.length > 0 ? `\n\n${links.join(", ")}.` : "";
  const footer = runLine(run.id);
  if (run.status === "lost") {
    return `❌ Interrupted before it finished (for example, wardby restarted). Repeat your request to retry.${partial}\n\n${footer}`;
  }
  if (run.status !== "succeeded") {
    // Only the status: a run's error text can carry internal detail that does not belong on the host.
    return `❌ Stopped: the run ended with status \`${run.status}\`.${partial}\n\n${footer}`;
  }
  const reply = run.finalText?.trim();
  const quoted = reply ? `\n\n${quoteReply(reply)}` : "";
  if (failedChildren.length > 0) {
    // The agent itself finished, but the work it handed off did not.
    const which = failedChildren.map((c) => `\`${c.id}\` (\`${c.status}\`)`).join(", ");
    return `❌ A sub-run did not succeed: ${which}.${partial}${quoted}\n\n${footer}`;
  }
  if (links.length > 0) return `✅ ${links.join(", ")}.\n\n${footer}`;
  return `✅ Finished without opening a pull request.${quoted}\n\n${footer}`;
}

/**
 * Writes a finished run's outcome to its status comment and marks it
 * complete: edits the comment when it exists; when it does not yet, posts the
 * outcome as a new comment only if `postIfMissing` (the reconciler, well after
 * the run ended), and otherwise leaves the row for postMentionStatus, which
 * is about to post it. A failed host call leaves the row open for the
 * reconciler to retry.
 */
export async function completeHostStatus(
  db: HostStatusDb,
  run: FinishedRun,
  hosts: ReviewHostRegistry | undefined,
  opts: { postIfMissing?: boolean } = {},
): Promise<void> {
  if (!hosts) return;
  try {
    const status = await db.runHostStatus.findUnique({ where: { runId: run.id } });
    if (!status || status.completedAt) return;
    if (!status.commentId && !opts.postIfMissing) return;
    const host = hosts[status.provider as ReviewHostProvider];
    if (!host) return;
    const children = await db.run.findMany({
      where: { parentRunId: run.id },
      select: { id: true, status: true, codingRun: { select: { result: true } } },
      orderBy: { startedAt: "asc" },
    });
    const pullRequests = children
      .map((c) => pullRequestOutcome(c.codingRun?.result))
      .filter((pr): pr is PullRequestOutcome => pr !== null);
    const failedChildren = children
      .filter((c) => TERMINAL.has(c.status) && c.status !== "succeeded")
      .map((c) => ({ id: c.id, status: c.status }));
    const body = outcomeBody(run, status.repository, pullRequests, failedChildren);
    let commentId = status.commentId;
    if (commentId) {
      await host.editComment(status.repository, {
        kind: status.commentKind === "inline" ? "inline" : "conversation",
        id: commentId,
        body,
      });
    } else {
      commentId = (
        await host.comment(status.repository, {
          number: status.number,
          body,
          ...(status.replyToReviewCommentId ? { replyToReviewCommentId: status.replyToReviewCommentId } : {}),
        })
      ).id;
    }
    await db.runHostStatus.update({ where: { runId: run.id }, data: { commentId, completedAt: new Date() } });
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the run's status comment");
  }
}

/**
 * Posts the "working on it" comment for a mention run whose status row was
 * written at dispatch, and records the comment on the row. When the run
 * already ended (a fast failure can beat this follow-up), completes it at
 * once. Does nothing when the row is gone, already has a comment, or is
 * already complete. Never throws.
 */
export async function postMentionStatus(
  db: HostStatusDb,
  host: CodeReviewHost,
  runId: string,
  hosts: ReviewHostRegistry | undefined,
): Promise<void> {
  try {
    const status = await db.runHostStatus.findUnique({ where: { runId } });
    if (!status || status.commentId || status.completedAt) return;
    const posted = await host.comment(status.repository, {
      number: status.number,
      body: workingBody(runId),
      ...(status.replyToReviewCommentId ? { replyToReviewCommentId: status.replyToReviewCommentId } : {}),
    });
    const claimed = await db.runHostStatus.updateMany({
      where: { runId, commentId: null, completedAt: null },
      data: { commentId: posted.id },
    });
    if (claimed.count === 0) {
      // The reconciler posted the outcome meanwhile; this comment is surplus.
      log.warn({ runId }, "status comment posted after the outcome; leaving both");
      return;
    }
    const run = await db.run.findUnique({ where: { id: runId }, select: { id: true, status: true, finalText: true } });
    if (run && TERMINAL.has(run.status)) await completeHostStatus(db, run, hosts);
  } catch (err) {
    log.warn({ err, runId }, "could not post the status comment");
  }
}
