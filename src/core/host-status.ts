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
import type { Prisma, PrismaClient, Run, RunStatus } from "#prisma";
import { summarizeRegistryFetches, warningRefusals, type RegistryRefusalSummary } from "../coding/registry/report.js";
import { packageRefusalWording } from "../coding/registry/refusal-wording.js";
import {
  isPackageAuditMode,
  packageAuditWording,
  summarizePackageAudit,
  type PackageAuditMode,
  type PackageAuditSummary,
} from "../coding/registry/audit-mode.js";
import { CODING_CODE_PROVIDER } from "../coding/protocol.js";
import { storedServiceNames } from "../coding/services/catalog.js";
import {
  SERVICE_UNREADY_CATEGORY,
  serviceRefusalSentence,
  serviceUnreadySentence,
} from "../coding/services/wording.js";
import { PROTECTED_PATH_CATEGORY, PROTECTED_PATH_HOST_LINE } from "../coding/protected-path-wording.js";
import {
  budgetStoppedChangesSentence,
  CONTINUATION_CLOSED_CATEGORY,
  CONTINUATION_CLOSED_HOST_LINE,
} from "../coding/continuation-wording.js";
import type { CodeReviewHost, ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import { loadBudgetSentence } from "./budget-wording.js";
import { continuedForAnotherIssue, githubIssueKey, recordIssuePullRequests } from "./issue-bridge.js";
import { logger } from "./logger.js";
import { providerClassOfCategory, providerSentence, type ProviderFailureClass } from "./provider-wording.js";
import { defuseMentions, splitReply } from "./reply-parts.js";
import { splitTaskOverride } from "./untrusted-content.js";

const log = logger.child({ module: "host-status" });

/** Keeps the edited comment readable; a longer reply goes out in full as follow-up comments (fullReplyOf). */
const MAX_REPLY_CHARS = 2000;
/** The most a GitHub follow-up comment holds, header and cut note included (GitHub's limit is 65,536). */
export const GITHUB_REPLY_MAX_CHARS = 60_000;
/** The most follow-up comments a full reply is posted as; the rest is cut, and stays on the run. */
export const REPLY_MAX_PARTS = 4;
/**
 * The most a Jira follow-up comment holds, header and cut note included. Jira Cloud's limit is 32,767
 * characters, but it may apply to the serialized ADF body markdownToAdf produces rather than to this
 * Markdown (unverified), and ADF's JSON is longer than the text; so keep a wide margin.
 */
export const JIRA_REPLY_MAX_CHARS = 15_000;
/** The status comment's line when the full reply follows. */
const FULL_REPLY_FOLLOWS = "The full reply follows in the next comment(s).";
/** The same, for a status in a review thread: the follow-ups go to the pull request's conversation. */
const FULL_REPLY_FOLLOWS_IN_CONVERSATION = "The full reply follows in this pull request's conversation.";
/** Ends the last follow-up when the reply did not fit in REPLY_MAX_PARTS comments. */
const REPLY_CUT_NOTE =
  "\n\n---\n\n*The rest of the reply was cut: it was too long to post in full. The full text is on the run (`get_run` → `finalText`).*";
/** The run statuses a run never leaves. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "refused",
  "lost",
  "budget_exhausted",
  "cancelled",
];
const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);

export type HostStatusDb = Pick<
  PrismaClient,
  | "runHostStatus"
  | "run"
  | "runBudgetEvent"
  | "registryFetch"
  | "registryAuditRecord"
  | "issuePullRequest"
  | "codingRun"
>;

export type FinishedRun = Pick<Run, "id" | "status" | "finalText">;

/** The parts of a CodingRun result this comment uses. */
export interface PullRequestOutcome {
  outcome: "pull_request_opened" | "pull_request_updated";
  repository: string;
  pullRequestNumber: number;
  /** The result's own pull request URL; absent from a malformed result. */
  pullRequestUrl?: string;
  /** The code host the repository is on. */
  codeProvider: string;
  /** The coding sub-run that produced it; set by collectRunOutcome. */
  runId?: string;
  /** How many of the run's own checks (result.tests) failed; the commands stay in the PR body. */
  failedChecks?: number;
}

/** A sub-run that ended without succeeding. */
export interface FailedChild {
  id: string;
  status: string;
  /** The coding sub-run's failure category; `provider_<class>` names a model-provider refusal. */
  failureCategory?: string | null;
  /** The sub-run's Run.error; read only for a service refusal's host sentence (coding/services/wording.ts). */
  error?: string | null;
  /** The service names on the coding sub-run (CodingRun.services), for one that never became ready. */
  services?: string[];
}

export const runLine = (runId: string): string => `<sub>wardby run \`${runId}\`</sub>`;

export function workingBody(runId: string, heading = "👀 Working on it."): string {
  return `${heading}\n\n${runLine(runId)}`;
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

export function pullRequestOutcome(result: unknown): PullRequestOutcome | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (r.outcome !== "pull_request_opened" && r.outcome !== "pull_request_updated") return null;
  if (typeof r.repository !== "string" || typeof r.pullRequestNumber !== "number") return null;
  if (!Number.isInteger(r.pullRequestNumber) || r.pullRequestNumber <= 0) return null;
  return {
    outcome: r.outcome,
    repository: r.repository,
    pullRequestNumber: r.pullRequestNumber,
    codeProvider: CODING_CODE_PROVIDER,
    ...(typeof r.pullRequestUrl === "string" ? { pullRequestUrl: r.pullRequestUrl } : {}),
    ...failedCheckCount(r.tests),
  };
}

/** Only a count reaches the comment: test commands are agent-authored and belong in the PR body. */
function failedCheckCount(tests: unknown): { failedChecks?: number } {
  if (!Array.isArray(tests)) return {};
  const failed = tests.filter(
    (t) => t && typeof t === "object" && (t as Record<string, unknown>).outcome === "failed",
  ).length;
  return failed > 0 ? { failedChecks: failed } : {};
}

/** The agent's reply as a quote, cut to MAX_REPLY_CHARS, with @-mentions defused so nobody is pinged. */
const cutReply = (text: string): string =>
  text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;

function quoteReply(text: string): string {
  return defuseMentions(cutReply(text))
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The reply to post in full as follow-up comments, or null when the ordinary quote applies: only for a
 * run that succeeded with no pull request and no failed sub-run, whose trimmed reply is longer than the
 * status comment's quote holds.
 */
export function fullReplyOf(
  run: FinishedRun,
  pullRequests: PullRequestOutcome[],
  failedChildren: FailedChild[],
): string | null {
  if (run.status !== "succeeded" || pullRequests.length > 0 || failedChildren.length > 0) return null;
  const reply = run.finalText?.trim();
  return reply && reply.length > MAX_REPLY_CHARS ? reply : null;
}

const partHeader = (i: number, n: number): string => `**Reply, part ${i} of ${n}**\n\n`;

/**
 * Numbered comment bodies for a full reply: "**Reply, part i of n**" then the part, the last ending with
 * the cut note when the reply did not fit in `maxParts`. Each body, header and note included, is at most
 * `maxChars`. @-mentions are defused (splitReply).
 */
export function fullReplyComments(reply: string, opts: { maxChars: number; maxParts: number }): string[] {
  const maxParts = Math.max(1, Math.floor(opts.maxParts));
  const reserve = partHeader(maxParts, maxParts).length + REPLY_CUT_NOTE.length;
  const { parts, truncated } = splitReply(reply, { maxChars: opts.maxChars - reserve, maxParts });
  return parts.map(
    (part, i) =>
      `${partHeader(i + 1, parts.length)}${part}${truncated && i === parts.length - 1 ? REPLY_CUT_NOTE : ""}`,
  );
}

type RefusalOutcome = {
  pullRequests: readonly PullRequestOutcome[];
  failedChildren: readonly FailedChild[];
  packageRefusals?: readonly RegistryRefusalSummary[];
  noChanges?: boolean;
};

/**
 * The refusals that can block the run: all of them when a coding sub-run failed, otherwise all but
 * listing-only ones, which the installer may only have looked at (see LISTING_REFUSAL_FILENAME).
 */
export function blockingRefusals(outcome: Omit<RefusalOutcome, "noChanges">): RegistryRefusalSummary[] {
  const refusals = outcome.packageRefusals ?? [];
  return outcome.failedChildren.length > 0 ? [...refusals] : warningRefusals(refusals);
}

/**
 * Whether package refusals blocked the run: it succeeded, but nothing reached a pull request, a coding
 * sub-run made no changes or failed, and packages were refused (blockingRefusals). The GitHub and Jira
 * status comments and the Slack `run_blocked` event all use it, so they always agree.
 */
export function isBlockedByRefusals(run: Pick<FinishedRun, "status">, outcome: RefusalOutcome): boolean {
  return (
    run.status === "succeeded" &&
    outcome.pullRequests.length === 0 &&
    (outcome.noChanges === true || outcome.failedChildren.length > 0) &&
    blockingRefusals(outcome).length > 0
  );
}

export function outcomeBody(
  run: FinishedRun,
  repository: string,
  pullRequests: PullRequestOutcome[],
  failedChildren: FailedChild[] = [],
  opts: {
    packageRefusals?: RegistryRefusalSummary[];
    noChanges?: boolean;
    budgetSentence?: string;
    /** The run came from an issue (GitHub or Jira): a budget-stopped draft can be continued from the issue too. */
    fromIssue?: boolean;
    noPullRequestText?: string;
    /** The agent's reply IS the answer (no separate reply comment): shown as written, not quoted. */
    replyAsAnswer?: boolean;
    /**
     * The caller posts the full reply as follow-up comments when fullReplyOf is not null (see
     * completeHostStatus): the ✅ no-pull-request body then points to them instead of quoting the reply.
     */
    fullReplyFollows?: boolean;
    /** The status comment is in a review thread, so the follow-ups land in the conversation instead. */
    statusInThread?: boolean;
    /** Package audit mode on any coding sub-run: a short block above the run line, whatever the outcome. */
    packageAudit?: { mode: PackageAuditMode; summary: PackageAuditSummary };
  } = {},
): string {
  const refOf = (pr: PullRequestOutcome): string =>
    pr.repository.toLowerCase() === repository.toLowerCase()
      ? `#${pr.pullRequestNumber}`
      : `${pr.repository}#${pr.pullRequestNumber}`;
  const links = pullRequests.map((pr) =>
    pr.outcome === "pull_request_opened" ? `Opened ${refOf(pr)}` : `Pushed changes to ${refOf(pr)}`,
  );
  const partial = links.length > 0 ? `\n\n${links.join(", ")}.` : "";
  const refusals = opts.packageRefusals ?? [];
  const blocked = isBlockedByRefusals(run, {
    pullRequests,
    failedChildren,
    packageRefusals: refusals,
    noChanges: opts.noChanges,
  });
  const blockedBy = blocked ? blockingRefusals({ pullRequests, failedChildren, packageRefusals: refusals }) : [];
  // The ⚠️ line: on a no-changes run it keeps listing-only refusals (see LISTING_REFUSAL_FILENAME), and
  // when blocked it holds only those the ⛔ list leaves out.
  const noChangesRun = opts.noChanges === true && pullRequests.length === 0;
  const warned = blocked
    ? refusals.filter((refusal) => !blockedBy.includes(refusal))
    : noChangesRun
      ? refusals
      : warningRefusals(refusals);
  const warning =
    (links.length > 0 || run.status === "succeeded") && warned.length > 0
      ? packageRefusalWording(warned, { blocked: false })
      : "";
  const audit = opts.packageAudit ? packageAuditWording(opts.packageAudit.mode, opts.packageAudit.summary) : "";
  const footer = warning + (warning ? "\n\n" : "") + audit + (audit ? "\n\n" : "") + runLine(run.id);
  if (blocked) return packageRefusalWording(blockedBy) + "\n\n" + footer;
  if (run.status === "lost") {
    return `❌ Interrupted before it finished (for example, wardby restarted). Repeat your request to retry.${partial}\n\n${footer}`;
  }
  if (run.status === "budget_exhausted" || run.status === "refused") {
    // A refused run could not start for lack of budget; see budgetSentence.
    return `❌ ${opts.budgetSentence ?? "Out of budget."}${partial}\n\n${footer}`;
  }
  if (run.status !== "succeeded") {
    // Only the status: a run's error text can carry internal detail that does not belong on the host.
    return `❌ Stopped: the run ended with status \`${run.status}\`.${partial}\n\n${footer}`;
  }
  const reply = run.finalText?.trim();
  const quoted = reply ? `\n\n${quoteReply(reply)}` : "";
  if (failedChildren.length > 0) {
    // The agent itself finished, but the work it handed off did not.
    // A sub-run stopped at its budget may still have pushed its changes so far (a draft to continue).
    const keptBy = new Map(
      pullRequests.filter((pr) => pr.runId !== undefined).map((pr) => [pr.runId as string, pr] as const),
    );
    const keptOf = (c: FailedChild): PullRequestOutcome | undefined =>
      c.status === "budget_exhausted" ? keptBy.get(c.id) : undefined;
    const kept = failedChildren.map(keptOf).filter((pr): pr is PullRequestOutcome => pr !== undefined);
    const outOfBudget = failedChildren.filter((c) => c.status === "budget_exhausted" && !keptOf(c));
    const providerClassOf = (c: FailedChild) =>
      c.status === "failed" ? providerClassOfCategory(c.failureCategory) : null;
    // A coding sub-run its services stopped: refused at dispatch, or a sidecar never became ready.
    const serviceSentenceOf = (c: FailedChild): string | null =>
      c.status === "refused"
        ? serviceRefusalSentence(c.error)
        : c.status === "failed" && c.failureCategory === SERVICE_UNREADY_CATEGORY
          ? serviceUnreadySentence(c.services ?? [])
          : null;
    // No path reaches this comment (see coding/protected-path-wording.ts), only the category.
    const protectedPathOf = (c: FailedChild): boolean =>
      c.status === "failed" && c.failureCategory === PROTECTED_PATH_CATEGORY;
    // A continuation whose PR closed before the sub-run ever spent anything
    // is stored as "refused" (a preflight refusal), not "failed" -- the
    // category is the same either way, so both statuses are recognised here.
    const continuationClosedOf = (c: FailedChild): boolean =>
      (c.status === "failed" || c.status === "refused") && c.failureCategory === CONTINUATION_CLOSED_CATEGORY;
    const providerClasses = new Set(
      failedChildren.map(providerClassOf).filter((c): c is ProviderFailureClass => c !== null),
    );
    const serviceSentences = new Set(failedChildren.map(serviceSentenceOf).filter((s): s is string => s !== null));
    const protectedPathFailed = failedChildren.some(protectedPathOf);
    const continuationClosedFailed = failedChildren.some(continuationClosedOf);
    const other = failedChildren.filter(
      (c) =>
        c.status !== "budget_exhausted" &&
        providerClassOf(c) === null &&
        serviceSentenceOf(c) === null &&
        !protectedPathOf(c) &&
        !continuationClosedOf(c),
    );
    const lines: string[] = kept.map(
      (pr) =>
        `A sub-run ran out of budget before finishing. ${budgetStoppedChangesSentence(
          refOf(pr),
          pr.outcome === "pull_request_opened",
          opts.fromIssue === true,
        )}`,
    );
    if (outOfBudget.length > 0) {
      lines.push(`A sub-run ran out of budget: ${outOfBudget.map((c) => `\`${c.id}\``).join(", ")}.`);
    }
    // The class only, never the provider's code: the sentence says who has to act.
    for (const providerClass of providerClasses) {
      lines.push(`A sub-run could not reach the model: ${providerSentence(providerClass)}`);
    }
    // The fixed sentence only, never the Run.error code in front of it.
    for (const sentence of serviceSentences) {
      lines.push(`A sub-run could not start: ${sentence}`);
    }
    if (protectedPathFailed) lines.push(PROTECTED_PATH_HOST_LINE);
    if (continuationClosedFailed) lines.push(CONTINUATION_CLOSED_HOST_LINE);
    if (other.length > 0) {
      lines.push(`A sub-run did not succeed: ${other.map((c) => `\`${c.id}\` (\`${c.status}\`)`).join(", ")}.`);
    }
    // The kept pull requests are named in their own lines.
    const others = links.filter((_, i) => !kept.includes(pullRequests[i]));
    const otherLinks = others.length > 0 ? `\n\n${others.join(", ")}.` : "";
    const icon = kept.length === failedChildren.length ? "⚠️" : "❌";
    return `${icon} ${lines.join(" ")}${otherLinks}${quoted}\n\n${footer}`;
  }
  const failedChecks = pullRequests.reduce((sum, pr) => sum + (pr.failedChecks ?? 0), 0);
  if (links.length > 0 && failedChecks > 0) {
    const checks = failedChecks === 1 ? "1 check" : `${failedChecks} checks`;
    return `⚠️ ${links.join(", ")}, but ${checks} failed in the run: see the pull request's description before merging.\n\n${footer}`;
  }
  if (links.length > 0) return `✅ ${links.join(", ")}.\n\n${footer}`;
  if (opts.fullReplyFollows && fullReplyOf(run, pullRequests, failedChildren) !== null) {
    const follows = opts.statusInThread ? FULL_REPLY_FOLLOWS_IN_CONVERSATION : FULL_REPLY_FOLLOWS;
    return opts.replyAsAnswer
      ? `✅ ${follows}\n\n${footer}`
      : `✅ Finished without opening a pull request. ${follows}\n\n${footer}`;
  }
  if (opts.replyAsAnswer && reply) return `✅ ${cutReply(reply)}\n\n${footer}`;
  return `✅ ${opts.noPullRequestText ?? "Finished without opening a pull request."}${quoted}\n\n${footer}`;
}

/** Package audit mode on a run's coding sub-runs: the strongest mode, and what it recorded across them. */
export type PackageAuditOutcome = { mode: PackageAuditMode; summary: PackageAuditSummary };

/** The package audit of these children (best effort, like the refusals: a read failure reports none). */
async function loadPackageAudit(
  db: Pick<PrismaClient, "registryAuditRecord">,
  children: readonly { id: string; codingRun: { packageAuditMode: string | null } | null }[],
): Promise<PackageAuditOutcome | undefined> {
  const audited = children.filter((c) => isPackageAuditMode(c.codingRun?.packageAuditMode));
  if (audited.length === 0) return undefined;
  try {
    const rows = await db.registryAuditRecord.findMany({
      where: { runId: { in: audited.map((c) => c.id) } },
      orderBy: { createdAt: "asc" },
    });
    const mode = audited.some((c) => c.codingRun?.packageAuditMode === "full") ? "full" : "audit";
    return { mode, summary: summarizePackageAudit(rows) };
  } catch {
    return undefined;
  }
}

/** A run's package audit alone, for a run whose other outcome is not read (one that did not succeed). */
export async function collectPackageAudit(
  db: Pick<PrismaClient, "run" | "registryAuditRecord">,
  runId: string,
): Promise<PackageAuditOutcome | undefined> {
  const children = await db.run.findMany({
    where: { parentRunId: runId },
    select: { id: true, codingRun: { select: { packageAuditMode: true } } },
  });
  return loadPackageAudit(db, children);
}

/** What collectRunOutcome reads: a run's children and, when out of budget, its budget facts. */
export type RunOutcomeDb = Pick<PrismaClient, "run" | "runBudgetEvent" | "registryFetch" | "registryAuditRecord">;

/** The parts of a finished run's outcome a status comment reports; shared by GitHub and Jira status comments. */
export async function collectRunOutcome(
  db: RunOutcomeDb,
  run: FinishedRun,
): Promise<{
  pullRequests: PullRequestOutcome[];
  failedChildren: FailedChild[];
  packageRefusals: RegistryRefusalSummary[];
  noChanges: boolean;
  budgetSentence?: string;
  packageAudit?: PackageAuditOutcome;
}> {
  const children = await db.run.findMany({
    where: { parentRunId: run.id },
    select: {
      id: true,
      status: true,
      error: true,
      codingRun: { select: { result: true, failureCategory: true, services: true, packageAuditMode: true } },
    },
    orderBy: { startedAt: "asc" },
  });
  const pullRequests = children
    .map((c) => {
      const pr = pullRequestOutcome(c.codingRun?.result);
      return pr ? { ...pr, runId: c.id } : null;
    })
    .filter((pr): pr is PullRequestOutcome & { runId: string } => pr !== null);
  const failedChildren = children
    .filter((c) => TERMINAL.has(c.status) && c.status !== "succeeded")
    .map((c) => ({
      id: c.id,
      status: c.status,
      failureCategory: c.codingRun?.failureCategory ?? null,
      error: c.error ?? null,
      services: storedServiceNames(c.codingRun?.services),
    }));
  let packageRefusals: RegistryRefusalSummary[] = [];
  const codingIds = children.filter((c) => c.codingRun).map((c) => c.id);
  if (codingIds.length > 0) {
    try {
      const fetches = await db.registryFetch.findMany({
        where: { runId: { in: codingIds } },
        select: {
          ecosystem: true,
          name: true,
          version: true,
          outcome: true,
          reason: true,
          sizeBytes: true,
          filename: true,
          runId: true,
        },
        orderBy: { createdAt: "asc" },
      });
      packageRefusals = summarizeRegistryFetches(fetches).packageRefusals;
    } catch {
      // Registry reporting is best effort; keep the existing status on read failure.
    }
  }
  const packageAudit = await loadPackageAudit(db, children);
  const budgetSentence =
    run.status === "budget_exhausted" || run.status === "refused"
      ? await loadBudgetSentence(db, run.id, run.status)
      : undefined;
  const noChanges = children.some((c) => {
    const result = c.codingRun?.result;
    return result && typeof result === "object" && !Array.isArray(result) && result.outcome === "no_changes";
  });
  return {
    pullRequests,
    failedChildren,
    packageRefusals,
    noChanges,
    ...(budgetSentence ? { budgetSentence } : {}),
    ...(packageAudit ? { packageAudit } : {}),
  };
}

/**
 * Whether a mention run's stored task is a mention on GitHub issue `number`
 * of `repository`, not on a pull request. Read from the task's header block
 * (mentionTaskText's "[GitHub issue #n…]" then "Repository: …"), which only
 * wardby writes: the first section that opens with "[GitHub " is that header
 * (any continuation hints before it are wardby's too), and everything a
 * person wrote comes after it, so a comment cannot pass for an issue header.
 * A review fix round's header names a PR.
 */
export function isIssueMentionTask(taskOverride: string | null, repository: string, number: number): boolean {
  if (!taskOverride) return false;
  const header = splitTaskOverride(taskOverride)
    .task.split("\n\n")
    .find((section) => section.startsWith("[GitHub "));
  if (!header) return false;
  const [first = "", second] = header.split("\n");
  const opener = `[GitHub issue #${number}`;
  return (first === `${opener}]` || first.startsWith(`${opener}: `)) && second === `Repository: ${repository}`;
}

/** Whether the run was started by a mention on a GitHub issue (not a pull request). Never throws. */
async function runCameFromGitHubIssue(
  db: HostStatusDb,
  status: { provider: string; repository: string; number: number },
  runId: string,
): Promise<boolean> {
  if (status.provider !== "github") return false;
  try {
    const run = await db.run.findUnique({ where: { id: runId }, select: { taskOverride: true } });
    return !!run && isIssueMentionTask(run.taskOverride, status.repository, status.number);
  } catch (err) {
    log.warn({ err, runId }, "could not tell whether the run came from an issue");
    return false;
  }
}

/**
 * A GitHub issue's run records the pull requests its coding sub-runs opened
 * or continued, exactly as a Jira issue's does (recordIssuePullRequests, key
 * githubIssueKey): a later mention on the issue continues them. Only for a
 * mention on an issue (isIssueMentionTask), never on a pull request; a pull
 * request continued from another tracked issue's run stays that issue's.
 * Safe to repeat (a retried completion adds no row). Never throws.
 */
async function recordGitHubIssuePullRequests(
  db: HostStatusDb,
  status: { provider: string; repository: string; number: number },
  runId: string,
  pullRequests: PullRequestOutcome[],
): Promise<void> {
  if (status.provider !== "github") return;
  const recordable = pullRequests.filter(
    (pr): pr is PullRequestOutcome & { runId: string; pullRequestUrl: string } => !!pr.pullRequestUrl && !!pr.runId,
  );
  if (recordable.length === 0) return;
  try {
    const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true, taskOverride: true } });
    if (!run || !isIssueMentionTask(run.taskOverride, status.repository, status.number)) return;
    const issue = { provider: "github", key: githubIssueKey(status.repository, status.number) };
    const foreign = await continuedForAnotherIssue(
      db,
      recordable.map((pr) => pr.runId),
      issue,
    );
    await recordIssuePullRequests(
      db,
      issue,
      recordable
        .filter((pr) => !foreign.has(pr.runId))
        .map((pr) => ({
          codeProvider: pr.codeProvider,
          repository: pr.repository,
          number: pr.pullRequestNumber,
          url: pr.pullRequestUrl,
          agentId: run.agentId,
          openedByRunId: pr.runId,
          outcome: pr.outcome,
        })),
    );
  } catch (err) {
    log.warn({ err, runId }, "could not record the GitHub issue's pull requests");
  }
}

/**
 * Writes a finished run's outcome to its status comment and marks it
 * complete: edits the comment when it exists; when it does not yet, posts the
 * outcome as a new comment only if `postIfMissing` (the reconciler, well after
 * the run ended), and otherwise leaves the row for postMentionStatus, which
 * is about to post it. A failed host call leaves the row open for the
 * reconciler to retry. The row is then claimed (completed) in one step, and
 * only the claiming call posts a full reply's follow-up comments.
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
    const { pullRequests, failedChildren, budgetSentence, packageRefusals, noChanges, packageAudit } =
      await collectRunOutcome(db, run);
    await recordGitHubIssuePullRequests(db, status, run.id, pullRequests);
    // A blocked status is built from the refusals alone, so the agent's reply is not posted after it.
    const fullReply = isBlockedByRefusals(run, { pullRequests, failedChildren, packageRefusals, noChanges })
      ? null
      : fullReplyOf(run, pullRequests, failedChildren);
    const body = outcomeBody(run, status.repository, pullRequests, failedChildren, {
      budgetSentence,
      fromIssue: failedChildren.some((c) => c.status === "budget_exhausted")
        ? await runCameFromGitHubIssue(db, status, run.id)
        : false,
      packageRefusals,
      packageAudit,
      noChanges,
      fullReplyFollows: true,
      statusInThread: status.commentKind === "inline",
    });
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
    // Claims the row in one step, saving a posted comment's id at once so a retry edits it instead of
    // posting a second one. Only the completion that claims it posts the full reply, so two racing
    // completions (the run's own and the reconciler's) never post it twice.
    const claimed = await db.runHostStatus.updateMany({
      where: { runId: run.id, completedAt: null },
      data: { commentId, completedAt: new Date() },
    });
    if (claimed.count !== 1) {
      log.warn(
        { runId: run.id },
        "the run's status comment was completed meanwhile; leaving any full reply to that completion",
      );
      return;
    }
    if (fullReply !== null) await postFullReply(host, status, run.id, fullReply);
  } catch (err) {
    log.warn({ err, runId: run.id }, "could not complete the run's status comment");
  }
}

/**
 * Posts the full reply's parts in order, each at most once: the status comment already points to them,
 * so a failed part is logged and the rest skipped (a gap would misnumber the reply), and the row is still
 * completed. The full text stays on the run (`get_run` → `finalText`). Never throws.
 */
async function postFullReply(
  host: CodeReviewHost,
  status: { repository: string; number: number },
  runId: string,
  reply: string,
): Promise<void> {
  const bodies = fullReplyComments(reply, { maxChars: GITHUB_REPLY_MAX_CHARS, maxParts: REPLY_MAX_PARTS });
  for (const [i, body] of bodies.entries()) {
    try {
      await host.comment(status.repository, { number: status.number, body });
    } catch (err) {
      log.warn(
        { err, runId, part: i + 1, parts: bodies.length },
        "could not post a part of the run's full reply; the rest is skipped, the full text stays on the run",
      );
      return;
    }
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
  heading?: string,
): Promise<void> {
  try {
    const status = await db.runHostStatus.findUnique({ where: { runId } });
    if (!status || status.commentId || status.completedAt) return;
    const posted = await host.comment(status.repository, {
      number: status.number,
      body: workingBody(runId, heading),
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
