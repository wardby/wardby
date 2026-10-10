/**
 * The status comment for a run started by a Jira issue event: "working on
 * it" right after the webhook is answered, edited once with the outcome.
 * Same lifecycle as host-status.ts (GitHub mentions), reusing its outcome
 * text. Best effort throughout: nothing here throws.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { projectOf, type IssueTrackerProvider, type IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import { collectRunOutcome, outcomeBody, runLine, workingBody, type FinishedRun } from "./host-status.js";
import { recordPullRequests } from "./issue-bridge.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "issue-status" });
const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const ORPHAN_GRACE_MS = 2 * 60 * 1000;
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ORPHAN_BATCH = 20;

export type IssueStatusDb = Pick<
  PrismaClient,
  "runIssueStatus" | "run" | "agentIssueProject" | "issuePullRequest" | "codingRun" | "$queryRaw"
>;

export function toJiraMarkdown(text: string): string {
  return text
    .replace(/<sub>(.*?)<\/sub>/g, "_$1_")
    .replace(
      /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g,
      (_m, repo: string, n: string) => `[${repo}#${n}](https://github.com/${repo}/pull/${n})`,
    );
}

export function issueStatusRow(
  event: { issueKey: string },
  runId: string,
  visibilityRole: string | null,
): Prisma.RunIssueStatusUncheckedCreateInput {
  return { runId, provider: "jira", issueKey: event.issueKey, visibilityRole };
}

/**
 * Cents from $1 up ($12.34, $1234.50); below $1, two significant digits with at
 * least two decimals so fractions of a cent stay readable ($0.50, $0.12, $0.0035).
 * Never exponent form.
 */
const usd = (amount: number): string => {
  const abs = Math.abs(amount);
  const decimals = abs === 0 || abs >= 1 ? 2 : Math.max(2, 1 - Math.floor(Math.log10(abs)));
  // Trailing zeros past the cents are noise ($0.010, $0.100 from rounding up).
  return `$${amount.toFixed(Math.min(decimals, 20)).replace(/(\.\d\d\d*?)0+$/, "$1")}`;
};

export function formatSpendLine(input: {
  treeUsd: number;
  issueUsd: number | null;
  models: Array<{ model: string; costUsd: number }>;
}): string {
  const parts = [`Agent spend: ${usd(input.treeUsd)} this run`];
  if (input.issueUsd !== null) parts.push(`${usd(input.issueUsd)} on this issue so far`);
  if (input.models.length > 0) parts.push(input.models.map((m) => `${m.model} ${usd(m.costUsd)}`).join(", "));
  return parts.join(" · ");
}

/** The whole run tree under `runId` (every depth), the issue's total across all its runs, and the tree's models. */
export async function spendLine(db: IssueStatusDb, runId: string): Promise<string> {
  try {
    const tree = Prisma.sql`
      WITH RECURSIVE tree AS (
        SELECT "id" FROM "Run" WHERE "id" = ${runId}
        -- UNION, not UNION ALL: a parentRunId cycle (never written, but not a constraint) can't recurse forever.
        UNION
        SELECT r."id" FROM "Run" r JOIN tree t ON r."parentRunId" = t."id"
      )`;
    const [treeTotal, issueTotal, models] = await Promise.all([
      db.$queryRaw<
        { usd: string | null }[]
      >`${tree} SELECT SUM(r."costUsd")::text AS usd FROM "Run" r JOIN tree t ON r."id" = t."id"`,
      db.$queryRaw<{ usd: string | null }[]>`
        SELECT SUM(r."costUsd")::text AS usd
        FROM "RunAttribution" a
        JOIN "Run" r ON r."id" = a."runId"
        WHERE a."workItemId" = (SELECT "workItemId" FROM "RunAttribution" WHERE "runId" = ${runId})`,
      db.$queryRaw<{ model: string; usd: string }[]>`${tree}
        SELECT u."model", SUM(u."costUsd")::text AS usd
        FROM "RunModelUsage" u JOIN tree t ON u."runId" = t."id"
        GROUP BY u."model" ORDER BY SUM(u."costUsd") DESC`,
    ]);
    const treeUsd = Number(treeTotal[0]?.usd ?? 0);
    if (!Number.isFinite(treeUsd)) return "";
    return formatSpendLine({
      treeUsd,
      issueUsd: issueTotal[0]?.usd == null ? null : Number(issueTotal[0].usd),
      models: models.map((m) => ({ model: m.model, costUsd: Number(m.usd) })),
    });
  } catch (err) {
    log.warn({ err, runId }, "could not compute the agent spend for the issue comment");
    return "";
  }
}

/** Insert the spend line above the trailing footer, which must stay the last line. */
function withSpend(body: string, spend: string): string {
  if (!spend) return body;
  const trimmed = body.trimEnd();
  const at = trimmed.lastIndexOf("\n");
  if (at < 0) return `${spend}\n\n${trimmed}`;
  return `${trimmed.slice(0, at).trimEnd()}\n\n${spend}\n\n${trimmed.slice(at + 1)}`;
}

export async function postIssueWorkingStatus(
  db: IssueStatusDb,
  trackers: IssueTrackerRegistry,
  runId: string,
): Promise<void> {
  try {
    const status = await db.runIssueStatus.findUnique({ where: { runId } });
    if (!status || status.commentId || status.completedAt) return;
    const tracker = trackers[status.provider as IssueTrackerProvider];
    if (!tracker) return;
    const posted = await tracker.comment(status.issueKey, {
      markdown: toJiraMarkdown(workingBody(runId)),
      ...(status.visibilityRole ? { visibilityRole: status.visibilityRole } : {}),
    });
    const claimed = await db.runIssueStatus.updateMany({
      where: { runId, commentId: null, completedAt: null },
      data: { commentId: posted.id },
    });
    if (claimed.count === 0) {
      log.warn({ runId }, "status comment posted after the outcome; leaving both");
      return;
    }
    const run = await db.run.findUnique({ where: { id: runId }, select: { id: true, status: true, finalText: true } });
    if (run && TERMINAL.has(run.status)) await completeIssueStatus(db, run, trackers);
  } catch (err) {
    log.warn({ err, runId }, "could not post the issue status comment");
  }
}

/** The run's agent's live link to the issue's project, or null (also when it cannot be determined: fail closed). */
async function currentLink(
  db: IssueStatusDb,
  runId: string,
  issueKey: string,
  provider: string,
): Promise<{
  agentId: string;
  access: string;
  commentVisibilityRole: string | null;
  onPullRequestOpened: string | null;
} | null> {
  const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true } });
  if (!run?.agentId) return null;
  const link = await db.agentIssueProject.findUnique({
    where: { agentId_provider_projectKey: { agentId: run.agentId, provider, projectKey: projectOf(issueKey) } },
    select: { access: true, commentVisibilityRole: true, onPullRequestOpened: true },
  });
  return link ? { agentId: run.agentId, ...link } : null;
}

/**
 * The coding runs (of `runIds`) that continued a pull request opened for a
 * different issue: their PR belongs to that issue, not this one. A continued
 * PR with no issue, or this same issue, is fine.
 */
async function continuedForAnotherIssue(
  db: IssueStatusDb,
  runIds: string[],
  issue: { provider: string; issueKey: string },
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db.codingRun.findMany({
    where: { runId: { in: runIds } },
    select: { runId: true, rootCodingRun: { select: { issueProvider: true, issueKey: true } } },
  });
  return new Set(
    rows
      .filter(({ rootCodingRun: root }) => {
        if (!root?.issueKey) return false;
        return root.issueKey !== issue.issueKey || root.issueProvider !== issue.provider;
      })
      .map((row) => row.runId),
  );
}

export async function completeIssueStatus(
  db: IssueStatusDb,
  run: FinishedRun,
  trackers: IssueTrackerRegistry | undefined,
  opts: { postIfMissing?: boolean } = {},
): Promise<void> {
  if (!trackers) return;
  try {
    const status = await db.runIssueStatus.findUnique({ where: { runId: run.id } });
    if (!status || status.completedAt) return;
    if (!status.commentId && !opts.postIfMissing) return;
    const tracker = trackers[status.provider as IssueTrackerProvider];
    if (!tracker) return;
    // The link may have been removed or downgraded to read since the run
    // started: then report status only (no reply, no spend), never the agent's reply.
    const link = await currentLink(db, run.id, status.issueKey, status.provider);
    const writable = link?.access === "write";
    const project = projectOf(status.issueKey);
    let body: string;
    if (writable) {
      const { pullRequests, failedChildren, budgetSentence } = await collectRunOutcome(db, run);
      const foreign = await continuedForAnotherIssue(
        db,
        pullRequests.flatMap((pr) => (pr.pullRequestUrl && pr.runId ? [pr.runId] : [])),
        status,
      );
      for (const runId of foreign) {
        log.info(
          { runId: run.id, codingRunId: runId, issueKey: status.issueKey },
          "not linking a pull request continued from another issue's run",
        );
      }
      const bridged = pullRequests.flatMap((pr) =>
        pr.pullRequestUrl && pr.runId && !foreign.has(pr.runId)
          ? [
              {
                codeProvider: pr.codeProvider,
                repository: pr.repository,
                number: pr.pullRequestNumber,
                url: pr.pullRequestUrl,
                openedByRunId: pr.runId,
                outcome: pr.outcome,
              },
            ]
          : [],
      );
      const { notes } =
        bridged.length > 0
          ? await recordPullRequests(db, tracker, {
              issueKey: status.issueKey,
              issueProvider: status.provider,
              agentId: link.agentId,
              onPullRequestOpened: link.onPullRequestOpened,
              pullRequests: bridged,
            })
          : { notes: [] };
      const outcome = outcomeBody(run, "", pullRequests, failedChildren, {
        budgetSentence,
        noPullRequestText: "Done.",
        // One comment per request: this status comment carries the agent's answer.
        replyAsAnswer: true,
      });
      // Notes and spend go above the footer, which must stay the last line.
      body = withSpend(withSpend(outcome, notes.join("\n")), await spendLine(db, run.id));
    } else {
      const why = link
        ? `this agent's link to ${project} is now read-only`
        : `this agent is no longer linked to ${project}`;
      body = `Stopped reporting: ${why}.\n\n${runLine(run.id)}`;
    }
    const markdown = toJiraMarkdown(body);
    let commentId = status.commentId;
    // Keys in the issue's own project (e.g. a related issue the reply names) become smart links.
    const issueKeyProjects = writable ? [project] : [];
    if (commentId) await tracker.editComment(status.issueKey, commentId, { markdown, issueKeyProjects });
    else if (writable) {
      commentId = (
        await tracker.comment(status.issueKey, {
          markdown,
          issueKeyProjects,
          ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
        })
      ).id;
    }
    // Unlinked or read-only with no status comment yet: complete the row
    // without posting; never create content where the agent may not write.
    await db.runIssueStatus.update({ where: { runId: run.id }, data: { commentId, completedAt: new Date() } });
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the issue status comment");
  }
}

export async function closeOrphanedIssueStatuses(
  db: IssueStatusDb,
  trackers: IssueTrackerRegistry | undefined,
  now: Date = new Date(),
): Promise<void> {
  const providers = Object.keys(trackers ?? {});
  if (!trackers || providers.length === 0) return;
  const orphans = await db.runIssueStatus.findMany({
    where: {
      completedAt: null,
      provider: { in: providers },
      run: {
        status: { notIn: ["pending", "running"] },
        finishedAt: {
          lte: new Date(now.getTime() - ORPHAN_GRACE_MS),
          gte: new Date(now.getTime() - ORPHAN_MAX_AGE_MS),
        },
      },
    },
    select: { run: { select: { id: true, status: true, finalText: true } } },
    orderBy: { run: { finishedAt: "desc" } },
    take: ORPHAN_BATCH,
  });
  for (const { run } of orphans) await completeIssueStatus(db, run, trackers, { postIfMissing: true });
}
