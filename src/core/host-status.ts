/**
 * The status comment for a run started by an @-mention: posted as soon as the
 * run is dispatched ("working on it"), then edited once with the outcome — the
 * pull requests its coding sub-runs opened or updated, the agent's reply when
 * none came out, or the status of a run that did not succeed. Best effort
 * throughout: nothing here throws, and a comment the edit could not reach is
 * retried by the reconciler (closeOrphanedHostStatuses).
 */
import type { PrismaClient, Run } from "#prisma";
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

const runLine = (runId: string): string => `<sub>wardby run \`${runId}\`</sub>`;

export function workingBody(runId: string): string {
  return `👀 Working on it.\n\n${runLine(runId)}`;
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

export function outcomeBody(run: FinishedRun, repository: string, pullRequests: PullRequestOutcome[]): string {
  const links = pullRequests.map((pr) => {
    const ref =
      pr.repository.toLowerCase() === repository.toLowerCase()
        ? `#${pr.pullRequestNumber}`
        : `${pr.repository}#${pr.pullRequestNumber}`;
    return pr.outcome === "pull_request_opened" ? `Opened ${ref}` : `Pushed changes to ${ref}`;
  });
  const footer = runLine(run.id);
  if (run.status !== "succeeded") {
    // Only the status: a run's error text can carry internal detail that does not belong on the host.
    const partial = links.length > 0 ? `\n\n${links.join(", ")}.` : "";
    return `❌ Stopped: the run ended with status \`${run.status}\`.${partial}\n\n${footer}`;
  }
  if (links.length > 0) return `✅ ${links.join(", ")}.\n\n${footer}`;
  const reply = run.finalText?.trim();
  return `✅ Finished without opening a pull request.${reply ? `\n\n${quoteReply(reply)}` : ""}\n\n${footer}`;
}

/**
 * Edits a run's status comment with its outcome and marks it complete. Does
 * nothing when the run has no status comment or it is already complete. A
 * failed edit leaves the row open so the reconciler retries it.
 */
export async function completeHostStatus(
  db: HostStatusDb,
  run: FinishedRun,
  hosts: ReviewHostRegistry | undefined,
): Promise<void> {
  if (!hosts) return;
  try {
    const status = await db.runHostStatus.findUnique({ where: { runId: run.id } });
    if (!status || status.completedAt) return;
    const host = hosts[status.provider as ReviewHostProvider];
    if (!host) return;
    const children = await db.run.findMany({
      where: { parentRunId: run.id },
      select: { codingRun: { select: { result: true } } },
      orderBy: { startedAt: "asc" },
    });
    const pullRequests = children
      .map((c) => pullRequestOutcome(c.codingRun?.result))
      .filter((pr): pr is PullRequestOutcome => pr !== null);
    await host.editComment(status.repository, {
      kind: status.commentKind === "inline" ? "inline" : "conversation",
      id: status.commentId,
      body: outcomeBody(run, status.repository, pullRequests),
    });
    await db.runHostStatus.update({ where: { runId: run.id }, data: { completedAt: new Date() } });
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the run's status comment");
  }
}

/**
 * Posts the "working on it" comment for a mention run and records it. When
 * the run already ended (a fast failure can beat this follow-up), completes it
 * at once instead of waiting for the reconciler. Never throws.
 */
export async function postMentionStatus(
  db: HostStatusDb,
  host: CodeReviewHost,
  event: { repository: string; number: number; replyToReviewCommentId?: string },
  runId: string,
  hosts: ReviewHostRegistry | undefined,
): Promise<void> {
  try {
    const posted = await host.comment(event.repository, {
      number: event.number,
      body: workingBody(runId),
      ...(event.replyToReviewCommentId ? { replyToReviewCommentId: event.replyToReviewCommentId } : {}),
    });
    await db.runHostStatus.create({
      data: {
        runId,
        provider: host.provider,
        repository: event.repository,
        number: event.number,
        commentKind: event.replyToReviewCommentId ? "inline" : "conversation",
        commentId: posted.id,
      },
    });
    const run = await db.run.findUnique({ where: { id: runId }, select: { id: true, status: true, finalText: true } });
    if (run && TERMINAL.has(run.status)) await completeHostStatus(db, run, hosts);
  } catch (err) {
    log.warn({ err, repository: event.repository, number: event.number, runId }, "could not post the status comment");
  }
}
