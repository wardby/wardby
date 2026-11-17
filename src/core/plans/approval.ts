/**
 * What happens when a plan set is approved (docs/private spec §7b). The review event that makes the
 * last counted document of a set approved (a verdict, a force approve, or a removal that leaves only
 * approved documents) fires this once per approval: a reopen clears the approval and a new approval
 * fires it again. `onApproved: "notify"` posts a notice on the plan's issue; `"build"` starts the
 * builder for ticket 1, after checking the builder again (R12), on the set's first approval only: a
 * set whose chain ran before (stopped, reopened or done) gets a notice naming the ticket to build next.
 * A reopen during a live chain posts a notice that the build stops after the current ticket.
 *
 * Every notice holds plan numbers, plan paths, ticket numbers, refusal codes and (for a build) the
 * display name of the person whose verdict completed the approval: never a document's text or a
 * ticket title. Each people- or agent-written value in it (a name, a path) is redacted by exact value
 * against the planner's secret values before it is escaped, the whole notice is redacted again, and
 * its @-mentions and bare URLs are defused, before it is posted. Nothing here throws into a review
 * action: the work after an approval (host calls, the ticket start) runs in the background.
 */
import type { PlanSet, PrismaClient } from "#prisma";
import { readPlanDocument, type PlanDocumentInput } from "../../coding/profile.js";
import type { IssueTrackerRegistry } from "../../providers/issue-tracker/types.js";
import { GITHUB_ISSUE_KEY, projectOf } from "../../providers/issue-tracker/types.js";
import type { ReviewHostRegistry } from "../../providers/review-host/types.js";
import { principalNames } from "../documents/comments.js";
import { logger } from "../logger.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { newestVisiblePlanSet, planRepositoryFilter, ticketTitles, type BuildPlan } from "./build.js";
import type { PlanChainDb, PlanChainHook, PlanChainMergeDb } from "./chain-hook.js";
import type { PostIssueNotice } from "./hooks.js";
import { planNumberFromIssueKey } from "./number.js";
import { defuseAutolinks, defuseNotice, shownPlanPath } from "./wording.js";
import { checkPlanDocumentSetting, type PlanSettingsDb } from "./settings.js";

export { defuseNotice } from "./wording.js";
export {
  planChainHook,
  setPlanChainHook,
  type PlanChainDb,
  type PlanChainHook,
  type PlanChainMergeDb,
} from "./chain-hook.js";

const planLog = logger.child({ module: "plans" });

export interface StartTicketInput {
  builderAgentId: string;
  set: PlanSet;
  ticket: number;
  /** The principal who started it (Run.triggeredById), when known. */
  starterId: string | null;
  trigger: "plan_approved" | "comment";
  /**
   * True: the build chain follows the run (its merge starts the next ticket). False: a single-ticket
   * build (`build ticket <t>` on a "notify" planner), which never touches the chain's fields.
   */
  followedByChain: boolean;
}

/** running: a ticket run of the set is already pending or running (R16); it names that ticket. */
export type StartTicketResult = { runId: string } | { refused: string } | { running: number };

export interface PlanApprovalDeps {
  postIssueNotice: PostIssueNotice;
  startTicket: (input: StartTicketInput) => Promise<StartTicketResult>;
  /** The GitHub App's @-handle for the `build ticket <t>` hint, or null (no App: the notice has no hint). */
  mentionHandle: () => Promise<string | null>;
  /** The planner's secret values: every notice is redacted against them before it is posted. */
  secretValues: (agentId: string) => Promise<readonly string[]>;
  /** Given the background work an approval or the build chain starts (notices, ticket starts); tests await it. */
  track?: (work: Promise<void>) => void;
}

export type PlanReviewHook = (db: PrismaClient, documentId: string, actorId: string | null) => Promise<void>;

let hook: PlanReviewHook | undefined;

export function setPlanReviewHook(next: PlanReviewHook | undefined): void {
  hook = next;
}

export function planReviewHook(): PlanReviewHook | undefined {
  return hook;
}

/** A plan path in a notice (wording.ts). */
const shownPath = shownPlanPath;

/**
 * A person's display name in a public notice: people-written, so one line, no backtick (which would
 * open a code span that defuseNotice leaves alone) and Markdown punctuation escaped.
 */
export function shownName(name: string): string {
  return defuseAutolinks(
    name
      .replace(/[\s`]+/g, " ")
      .trim()
      .replace(/[\\*_[\]<>|~#!]/g, (c) => `\\${c}`),
  );
}

function hint(handle: string | null, ticket: string, purpose: string): string {
  return handle ? ` Comment \`@${handle} build ticket ${ticket}\` ${purpose}.` : "";
}

export function planApprovedNotice(number: number, versions: BuildPlan["versions"], handle: string | null): string {
  const named = versions.map((v) => `${shownPath(v.path)} v${v.versionNumber}`).join(", ");
  return `Plan ${number} approved (${named}).${hint(handle, "<t>", "to build")}`;
}

export function planBuildStartedNotice(number: number, ticket: number, starterName: string | null): string {
  return `Plan ${number}: building ticket ${ticket}${starterName ? `, started by ${shownName(starterName)}` : ""}.`;
}

/** Why a ticket start was held back (R16): the set is not approved, or a ticket run of it is in flight. */
export type TicketStartBlock = { refused: "plan_not_approved" } | { running: number };

/**
 * The guard of a ticket start (R16), in the start's persist transaction: takes the set's row lock,
 * then lets the start through (null) only while the set is approved and no ticket run of it is
 * pending or running; otherwise says which of the two held it back, as seen under the lock. A reopen,
 * or another start (the chain's, or a `build ticket <t>` comment's), waits for the lock and then sees
 * this start's run.
 */
export async function planTicketStartBlock(
  tx: Pick<PrismaClient, "codingRun" | "$queryRaw">,
  planSetId: string,
): Promise<TicketStartBlock | null> {
  const rows = await tx.$queryRaw<{ approvedAt: Date | null }[]>`
    SELECT "approvedAt" FROM "PlanSet" WHERE "id" = ${planSetId} FOR UPDATE`;
  if (!rows[0]?.approvedAt) return { refused: "plan_not_approved" };
  const running = await runningPlanTicket(tx, planSetId);
  return running === null ? null : { running };
}

/** planTicketStartBlock as a yes/no: true lets the start through. */
export async function lockPlanSetForTicketStart(
  tx: Pick<PrismaClient, "codingRun" | "$queryRaw">,
  planSetId: string,
): Promise<boolean> {
  return (await planTicketStartBlock(tx, planSetId)) === null;
}

/**
 * A ticket run of the set in flight: pending or running. A fix-round continuation of an earlier ticket
 * run (rootCodingRunId set) counts too (R16: never more than one run at a time), but it is never the
 * chain's run: it is never followed, and the merge of its root's PR waits for it (onMerged).
 */
const inFlightTicketRun = (planSetId: string) => ({
  planSetId,
  planTicket: { not: null },
  run: { status: { in: ["pending" as const, "running" as const] } },
});

/** The ticket of a pending or running build run of the set, or null. Works on a transaction too. */
export async function runningPlanTicket(
  db: Pick<PrismaClient, "codingRun">,
  planSetId: string,
): Promise<number | null> {
  const running = await db.codingRun.findFirst({
    where: inFlightTicketRun(planSetId),
    select: { planTicket: true },
  });
  return running?.planTicket ?? null;
}

type CountedDocument = {
  id: string;
  planPath: string | null;
  kind: string;
  currentVersion: { number: number } | null;
};

/** plan.md first, then by path: the order every notice and the PR line use. */
export function planVersionsOf(documents: readonly CountedDocument[]): BuildPlan["versions"] {
  return [...documents]
    .filter((d) => d.planPath !== null && d.currentVersion !== null)
    .sort((a, b) =>
      a.planPath === "plan.md" ? -1 : b.planPath === "plan.md" ? 1 : (a.planPath ?? "").localeCompare(b.planPath ?? ""),
    )
    .map((d) => ({
      documentId: d.id,
      path: d.planPath!,
      kind: d.kind === "design" ? ("design" as const) : ("document" as const),
      versionNumber: d.currentVersion!.number,
    }));
}

/** Posts a notice on the set's issue: redacted against the planner's secret values, mentions defused. */
export async function postPlanNotice(
  deps: Pick<PlanApprovalDeps, "postIssueNotice" | "secretValues">,
  set: Pick<PlanSet, "agentId" | "accessAgentId" | "issueProvider" | "issueKey" | "repository">,
  text: string,
): Promise<void> {
  const redacted = redactExactSecretValues(text, await deps.secretValues(set.agentId));
  await deps.postIssueNotice(
    {
      issueProvider: set.issueProvider,
      issueKey: set.issueKey,
      repository: set.repository,
      agentIds:
        set.accessAgentId && set.accessAgentId !== set.agentId ? [set.accessAgentId, set.agentId] : [set.agentId],
    },
    defuseNotice(redacted),
  );
}

/** A refusal as shown in a notice: a code only, never a message that could carry other text. */
const refusalCode = (refused: string) => (/^[a-z][a-z0-9_]{0,63}$/.test(refused) ? refused : "refused");

/** Posts the outcome of a ticket start; a refusal stops the chain. Shared by C2, C3 and C4. */
export async function reportTicketStart(
  db: Pick<PrismaClient, "planSet">,
  deps: Pick<PlanApprovalDeps, "postIssueNotice" | "secretValues">,
  set: PlanSet,
  ticket: number,
  started: StartTicketResult,
  starterName: string | null,
  options: { prefix?: string; stopsChain?: boolean } = {},
): Promise<void> {
  // Redacted raw, before shownName escapes it: an escaped secret (`a\\_b`) would no longer match.
  const name = starterName === null ? null : redactExactSecretValues(starterName, await deps.secretValues(set.agentId));
  let text: string;
  if ("runId" in started) text = planBuildStartedNotice(set.number, ticket, name);
  else if ("running" in started) text = `Plan ${set.number}: already building ticket ${started.running}.`;
  else {
    const code = refusalCode(started.refused);
    // Only while the chain is still on this ticket and not stopped: a reopen, or another stop already
    // recorded, keeps its own code. A single-ticket build (stopsChain false) never touches the chain.
    if (options.stopsChain !== false) {
      await db.planSet.updateMany({
        where: { id: set.id, chainTicket: ticket, chainStopped: null },
        data: { chainStopped: code, chainRunId: null },
      });
    }
    text = `Plan ${set.number}: ticket ${ticket} did not start (${code}).`;
  }
  await postPlanNotice(deps, set, options.prefix ? `${options.prefix}\n${text}` : text);
}

/**
 * A start that found a ticket run of the set already pending or running (R16): the chain follows that
 * run, so its merge (not the one asked for) moves the chain on. False when that run is gone by now
 * (it ended in between): the caller stops the chain rather than follow nothing.
 */
async function followRunningTicket(
  db: PlanChainDb,
  planSetId: string,
  asked: number,
  running: number,
): Promise<boolean> {
  // Never a fix round: the chain follows a ticket's own run, whose PR a merge moves on.
  const run = await db.codingRun.findFirst({
    where: { ...inFlightTicketRun(planSetId), planTicket: running, rootCodingRunId: null },
    select: { runId: true },
  });
  if (!run) return false;
  await db.planSet.updateMany({
    where: { id: planSetId, chainTicket: asked, chainStopped: null },
    data: { chainTicket: running, chainRunId: run.runId },
  });
  return true;
}

/**
 * Starts a ticket and, when the chain follows it (input.followedByChain), makes the chain follow the
 * run it started (or the one already running). A start that throws (not a refusal) becomes
 * `start_failed`, so the chain stops with a notice instead of staying silent. Only the error's name
 * is logged.
 */
async function startOrStartFailed(
  db: PlanChainDb,
  deps: Pick<PlanApprovalDeps, "startTicket">,
  input: StartTicketInput,
): Promise<StartTicketResult> {
  const started = await deps.startTicket(input).catch((err: unknown): StartTicketResult => {
    planLog.warn(
      { planSetId: input.set.id, errorName: err instanceof Error ? err.name : typeof err },
      "ticket start failed",
    );
    return { refused: "start_failed" };
  });
  if (!input.followedByChain) return started;
  if ("runId" in started) {
    // The start's own transaction records it too (composition); this covers any other startTicket.
    await db.planSet.updateMany({
      where: { id: input.set.id, chainTicket: input.ticket, chainStopped: null },
      data: { chainRunId: started.runId },
    });
  } else if ("running" in started) {
    // The run in flight ended before the chain could follow it: nothing would ever move the chain.
    if (!(await followRunningTicket(db, input.set.id, input.ticket, started.running))) {
      return { refused: "start_failed" };
    }
  }
  return started;
}

type PlanAgent = { id: string; ownerId: string | null; codingProfile: { planDocument: unknown } | null };

/**
 * R12, spec §7b: the builder is checked again before every start, against the access the owner has
 * today. Reviewers are not re-checked here (publish checks them), so only the builder can fail.
 * The builder's agent id, or null when it cannot build now (plan_builder_invalid).
 */
async function checkedBuilder(db: PlanSettingsDb, agent: PlanAgent): Promise<string | null> {
  let setting: ReturnType<typeof readPlanDocument>;
  try {
    setting = readPlanDocument(agent.codingProfile?.planDocument, agent.ownerId);
  } catch {
    return null;
  }
  if (!setting?.builderAgentId) return null;
  // Checked as a build hand-off whatever onApproved says: a `build ticket <t>` comment starts the
  // builder of a "notify" planner too.
  const builderOnly: PlanDocumentInput = {
    store: setting.store,
    onApproved: "build",
    ...(setting.path ? { path: setting.path } : {}),
    builderAgentId: setting.builderAgentId,
  };
  try {
    await checkPlanDocumentSetting(db, { id: agent.id, ownerId: agent.ownerId }, builderOnly);
  } catch {
    return null;
  }
  return setting.builderAgentId;
}

/**
 * The issue notice poster (R25, C2): a GitHub issue gets a comment from the App; a Jira issue gets one
 * only through an issue-project link with write access of one of `agentIds`, with that link's comment
 * visibility, as every other Jira reply does. Posts the text as given (callers redact and defuse).
 */
export function issueNoticePoster(input: {
  db: Pick<PrismaClient, "agentIssueProject">;
  reviewHosts: ReviewHostRegistry;
  issueTrackers: IssueTrackerRegistry;
}): PostIssueNotice {
  return async (set, text) => {
    if (!set.issueKey) return;
    if (set.issueProvider === "github") {
      const number = planNumberFromIssueKey("github", set.issueKey);
      if (number === undefined || !GITHUB_ISSUE_KEY.test(set.issueKey)) return;
      const repository = set.issueKey.slice(0, set.issueKey.lastIndexOf("#"));
      await input.reviewHosts.github?.comment(repository, { number, body: text });
      return;
    }
    if (set.issueProvider === "jira") {
      const tracker = input.issueTrackers.jira;
      if (!tracker) return;
      for (const agentId of set.agentIds ?? []) {
        const link = await input.db.agentIssueProject.findUnique({
          where: {
            agentId_provider_projectKey: { agentId, provider: "jira", projectKey: projectOf(set.issueKey) },
          },
          select: { access: true, commentVisibilityRole: true },
        });
        if (link?.access !== "write") continue;
        await tracker.comment(set.issueKey, {
          markdown: text,
          ...(link.commentVisibilityRole ? { visibilityRole: link.commentVisibilityRole } : {}),
        });
        return;
      }
    }
  };
}

/** Calls the plan review hook for a set (a publish that removed or added documents), with no actor. */
export async function planSetChanged(db: PrismaClient, planSetId: string): Promise<void> {
  const current = planReviewHook();
  if (!current) return;
  const any = await db.document.findFirst({ where: { planSetId }, select: { id: true } }).catch(() => null);
  if (any) await current(db, any.id, null);
}

/** Bounds for the set's row-lock transaction: a wait for the lock counts toward its timeout. */
const PLAN_TX = { maxWait: 5_000, timeout: 20_000 } as const;

type ClaimedApproval = NonNullable<Awaited<ReturnType<typeof claimApproval>>>;
type ApprovedSet = Extract<ClaimedApproval, { approved: true }>["set"];

/**
 * Under the set's row lock, so review events on one set are decided one at a time on the states they
 * see: ends the approval when a counted document is no longer approved, or claims it (approvedAt from
 * null) when every one is. Returns what it wrote: the set to the event that claimed the approval, or
 * the set and the chain's ticket to the event that stopped a live chain with "reopened"; else null.
 */
async function claimApproval(db: PrismaClient, planSetId: string, actorId: string | null) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "PlanSet" WHERE "id" = ${planSetId} FOR UPDATE`;
    const set = await tx.planSet.findUnique({
      where: { id: planSetId },
      include: {
        documents: {
          where: { removedFromPlan: false, planPath: { not: null } },
          include: { currentVersion: { select: { number: true, markdown: true } } },
        },
        agent: { select: { id: true, ownerId: true, codingProfile: { select: { planDocument: true } } } },
      },
    });
    if (!set) return null;
    const allApproved =
      set.documents.length > 0 && set.documents.every((d) => d.reviewState === "approved" && d.currentVersion);
    if (!allApproved) {
      // A reopen (or a new waiting document) ends the approval; a running chain stops before its next
      // ticket, unless it already stopped for a reason of its own (that code is kept).
      if (!set.approvedAt) return null;
      const stopsChain = set.chainTicket !== null && set.chainStopped === null;
      const { documents: _documents, agent: _agent, ...row } = set;
      const ended = await tx.planSet.update({
        where: { id: set.id },
        data: {
          approvedAt: null,
          approvedById: null,
          ...(stopsChain ? { chainStopped: "reopened", chainRunId: null } : {}),
        },
      });
      return stopsChain ? { approved: false as const, set: ended, ticket: row.chainTicket! } : null;
    }
    // Exactly once per approval: only the event that sets approvedAt from null goes on.
    if (set.approvedAt) return null;
    // The approver: the recorded starter of every ticket run this approval starts.
    const approved = await tx.planSet.update({
      where: { id: set.id },
      data: { approvedAt: new Date(), approvedById: actorId },
    });
    return {
      approved: true as const,
      set: { ...set, approvedAt: approved.approvedAt, approvedById: approved.approvedById },
    };
  }, PLAN_TX);
}

/** What follows a claimed approval: a notice ("notify"), or the builder check and ticket 1 ("build"). */
async function afterApproval(
  db: PrismaClient,
  deps: PlanApprovalDeps,
  set: ApprovedSet,
  actorId: string | null,
): Promise<void> {
  let setting: ReturnType<typeof readPlanDocument>;
  try {
    setting = readPlanDocument(set.agent.codingProfile?.planDocument, set.agent.ownerId);
  } catch {
    setting = null;
  }
  if (!setting) return;
  // Agent-written paths are redacted raw, before shownPath reshapes them.
  const secrets = await deps.secretValues(set.agentId);
  const versions = planVersionsOf(set.documents).map((v) => ({ ...v, path: redactExactSecretValues(v.path, secrets) }));
  // The `build ticket <t>` command is a GitHub mention (C4): a Jira issue's notice has no hint.
  const handle = set.issueProvider === "github" ? await deps.mentionHandle().catch(() => null) : null;
  if (setting.onApproved === "notify") {
    await postPlanNotice(deps, set, planApprovedNotice(set.number, versions, handle));
    return;
  }
  // A set built before (its chain stopped, or it ran, or it finished): a re-approval never starts a
  // build by itself. The notice says which ticket to build next; after a finished chain, any ticket.
  if (set.chainTicket !== null || set.chainStopped !== null) {
    const done = set.chainStopped === "done";
    const next = done ? "<t>" : String(set.chainTicket ?? 1);
    await postPlanNotice(
      deps,
      set,
      `${planApprovedNotice(set.number, versions, null)}${hint(handle, next, done ? "to build one again" : "to continue")}`,
    );
    return;
  }
  const builderAgentId = await checkedBuilder(db, set.agent);
  if (!builderAgentId) {
    await db.planSet.update({
      where: { id: set.id },
      data: { chainStopped: "plan_builder_invalid", chainRunId: null },
    });
    await postPlanNotice(
      deps,
      set,
      `Plan ${set.number} approved, but its builder cannot build it now (plan_builder_invalid).${hint(handle, "1", "once it is fixed")}`,
    );
    return;
  }
  const plan = set.documents.find((d) => d.planPath === "plan.md");
  if (!ticketTitles(plan?.currentVersion?.markdown ?? "").has(1)) {
    await postPlanNotice(
      deps,
      set,
      `Plan ${set.number} approved, but plan.md has no \`## Tickets\` section with \`### Ticket <t>:\` headings.${hint(handle, "<t>", "to build one")}`,
    );
    return;
  }
  await db.planSet.update({ where: { id: set.id }, data: { chainTicket: 1, chainStopped: null, chainRunId: null } });
  // The set's own row only: no document text goes to the start.
  const { documents: _documents, agent: _agent, ...row } = set;
  const started = await startOrStartFailed(db, deps, {
    builderAgentId,
    set: row,
    ticket: 1,
    starterId: actorId,
    trigger: "plan_approved",
    followedByChain: true,
  });
  const starterName = actorId ? ((await principalNames(db, [actorId])).get(actorId) ?? null) : null;
  await reportTicketStart(db, deps, row, 1, started, starterName, {
    prefix: planApprovedNotice(set.number, versions, null),
  });
}

/** Only the error's name is logged: never its message, which could carry a document's text. */
const logFailure = (fields: Record<string, string>) => (err: unknown) => {
  planLog.warn({ ...fields, errorName: err instanceof Error ? err.name : typeof err }, "plan review hook failed");
};

export function createPlanReviewHook(deps: PlanApprovalDeps): PlanReviewHook {
  return async (db, documentId, actorId) => {
    try {
      const doc = await db.document.findUnique({ where: { id: documentId }, select: { planSetId: true } });
      if (!doc?.planSetId) return;
      const claimed = await claimApproval(db, doc.planSetId, actorId);
      if (!claimed) return;
      const set = claimed.set;
      // The review action returns now; host calls and the ticket start follow in the background.
      const work = (
        claimed.approved
          ? afterApproval(db, deps, claimed.set, actorId)
          : postPlanNotice(
              deps,
              set,
              `Plan ${set.number}: a document was reopened; the build stops after ticket ${claimed.ticket}.`,
            )
      ).catch(logFailure({ documentId, planSetId: set.id }));
      deps.track?.(work);
    } catch (err) {
      // Never throws: a review verdict is never undone by its plan follow-up.
      logFailure({ documentId })(err);
    }
  };
}

/** RunStatus values (schema.prisma `enum RunStatus`) that end a ticket run without success. */
const STOPPING_STATUSES = new Set<string>(["failed", "refused", "lost", "budget_exhausted", "cancelled"]);

/** The PR number a coding run's result records, if any. */
const pullRequestOf = (result: unknown): number | null => {
  const n = (result as { pullRequestNumber?: unknown } | null)?.pullRequestNumber;
  return typeof n === "number" ? n : null;
};

/**
 * The build chain (spec §7b, R13). The chain follows one ticket run (PlanSet.chainRunId), set by every
 * ticket start: only that run's pull request moves it. Merged, the next ticket starts (never while
 * another ticket run of the set is pending or running), recorded as started by the approver; closed
 * unmerged, the chain stops (pr_closed). That run ending without success, or with no pull request
 * (no_pull_request), stops it too, as does a reopen (claimApproval). Each step is claimed with a
 * conditional update on the set's chain fields, so a repeated delivery acts once. The work runs in the
 * background (deps.track), so neither the webhook nor the run's terminal write waits for host calls.
 * Notices hold plan and ticket numbers and a code only: never a ticket title. Never throws.
 */
export function createPlanChainHook(deps: PlanApprovalDeps): PlanChainHook {
  const background = (what: string, work: () => Promise<void>): Promise<void> => {
    const done = work().catch((err: unknown) => {
      planLog.warn({ errorName: err instanceof Error ? err.name : typeof err }, `plan chain ${what} failed`);
    });
    deps.track?.(done);
    return Promise.resolve();
  };
  const postStopped = async (set: PlanSet, ticket: number, code: string) => {
    // The `build ticket <t>` command is a GitHub mention (C4): a Jira issue's notice has no hint.
    const handle = set.issueProvider === "github" ? await deps.mentionHandle().catch(() => null) : null;
    await postPlanNotice(
      deps,
      set,
      `Plan ${set.number} stopped at ticket ${ticket} (${refusalCode(code)}).${hint(handle, String(ticket), "to continue")}`,
    );
  };
  /** The set as the chain reads it: plan.md's text (for its tickets) and the planner (for R12). */
  const chainSetInclude = {
    documents: {
      where: { removedFromPlan: false, planPath: "plan.md" },
      include: { currentVersion: { select: { markdown: true } } },
    },
    agent: { select: { id: true, ownerId: true, codingProfile: { select: { planDocument: true } } } },
  } as const;
  type ChainSet = PlanSet & {
    documents: { currentVersion: { markdown: string | null } | null }[];
    agent: PlanAgent;
  };
  /**
   * Starts ticket `next` after the chain's ticket merged, recorded as started by the approver. Claimed
   * with a conditional update against the chain's state as read (`from`), so a repeat acts once.
   */
  const startNext = async (
    db: PlanChainMergeDb,
    set: ChainSet,
    from: { chainTicket: number; chainRunId: string },
    next: number,
  ): Promise<void> => {
    const { documents: _documents, agent, ...row } = set;
    const claimed = await db.planSet.updateMany({
      where: { id: set.id, ...from, chainStopped: null, approvedAt: { not: null } },
      data: { chainTicket: next, chainRunId: null },
    });
    if (claimed.count !== 1) return;
    const builderAgentId = await checkedBuilder(db, agent);
    const started: StartTicketResult = builderAgentId
      ? await startOrStartFailed(db, deps, {
          builderAgentId,
          set: row,
          ticket: next,
          starterId: set.approvedById,
          trigger: "plan_approved",
          followedByChain: true,
        })
      : { refused: "plan_builder_invalid" };
    await reportTicketStart(db, deps, row, next, started, null);
  };
  return {
    onMerged: (db, pr) =>
      background("merge", async () => {
        const runs = await db.codingRun.findMany({
          where: {
            // Matched as the host compares names (case-insensitively, exactly), like every plan lookup.
            repository: planRepositoryFilter(pr.repository),
            planSetId: { not: null },
            planTicket: { not: null },
            result: { path: ["pullRequestNumber"], equals: pr.number },
          },
          select: { runId: true, planTicket: true },
        });
        if (runs.length === 0) return;
        // Only the PR of the run the chain follows: an older run's PR of the same ticket (before a
        // reopen, say) never moves a re-approved chain.
        const set: ChainSet | null = await db.planSet.findFirst({
          where: { chainRunId: { in: runs.map((r) => r.runId) }, chainStopped: null },
          include: chainSetInclude,
        });
        if (!set?.chainRunId || set.chainTicket === null) return;
        const { documents, agent: _agent, ...row } = set;
        const ticket = set.chainTicket;
        const chainRunId = set.chainRunId;
        // The chain already moved on past this run (its merge was heard while a fix round ran): a repeat.
        if (runs.find((r) => r.runId === chainRunId)?.planTicket !== ticket) return;
        const following = { id: set.id, chainRunId, chainStopped: null };
        if (!pr.merged) {
          const stopped = await db.planSet.updateMany({
            where: following,
            data: { chainStopped: "pr_closed", chainRunId: null },
          });
          if (stopped.count === 1) await postStopped(row, ticket, "pr_closed");
          return;
        }
        if (!set.approvedAt) return;
        // R16: another ticket's own run in flight holds the next start. A fix round is handled below.
        const otherTicket = await db.codingRun.findFirst({
          where: { ...inFlightTicketRun(set.id), rootCodingRunId: null },
          select: { runId: true },
        });
        if (otherTicket) return;
        const tickets = ticketTitles(documents[0]?.currentVersion?.markdown ?? "");
        const next = ticket + 1;
        if (!tickets.has(next)) {
          // Recorded as done (not cleared), so a later re-approval knows the plan was built.
          const cleared = await db.planSet.updateMany({
            where: following,
            data: { chainStopped: "done", chainRunId: null },
          });
          if (cleared.count === 1)
            await postPlanNotice(deps, row, `Plan ${set.number}: all ${tickets.size} tickets built.`);
          return;
        }
        if ((await runningPlanTicket(db, set.id)) === null) {
          await startNext(db, set, { chainTicket: ticket, chainRunId }, next);
          return;
        }
        // A fix round in flight (R16): the merge is recorded by moving the chain on to the next ticket
        // while it still follows the merged run, and the fix round's end starts it (onTicketFinished).
        const waiting = await db.planSet.updateMany({
          where: { ...following, chainTicket: ticket },
          data: { chainTicket: next },
        });
        if (waiting.count !== 1) return;
        // The fix round may have ended in between, before it could see the chain waiting.
        if ((await runningPlanTicket(db, set.id)) !== null) return;
        await startNext(db, { ...set, chainTicket: next }, { chainTicket: next, chainRunId }, next);
      }),
    onTicketFinished: (db, runId) =>
      background("finish", async () => {
        const coding = await db.codingRun.findUnique({
          where: { runId },
          select: {
            planTicket: true,
            planSetId: true,
            rootCodingRunId: true,
            result: true,
            run: { select: { status: true } },
          },
        });
        if (!coding?.planSetId || coding.planTicket === null) return;
        if (coding.rootCodingRunId !== null) {
          // A fix round ended. It never stops the chain; when the chain waits on it (the PR of the run
          // the chain follows merged meanwhile, onMerged), the next ticket starts now.
          const set: ChainSet | null = await db.planSet.findFirst({
            where: { id: coding.planSetId, chainRunId: { not: null }, chainStopped: null, approvedAt: { not: null } },
            include: chainSetInclude,
          });
          if (!set?.chainRunId || set.chainTicket === null) return;
          const followed = await db.codingRun.findUnique({
            where: { runId: set.chainRunId },
            select: { planTicket: true },
          });
          if (followed?.planTicket === null || followed?.planTicket === set.chainTicket) return;
          if ((await runningPlanTicket(db, set.id)) !== null) return;
          await startNext(db, set, { chainTicket: set.chainTicket, chainRunId: set.chainRunId }, set.chainTicket);
          return;
        }
        const status = coding.run.status;
        const code = STOPPING_STATUSES.has(status)
          ? status
          : status === "succeeded" && pullRequestOf(coding.result) === null
            ? "no_pull_request"
            : null;
        if (!code) return;
        // Only the run the chain follows: an older run never stops it.
        const stopped = await db.planSet.updateMany({
          where: { id: coding.planSetId, chainRunId: runId, chainStopped: null },
          data: { chainStopped: code, chainRunId: null },
        });
        if (stopped.count !== 1) return;
        const set = await db.planSet.findUniqueOrThrow({ where: { id: coding.planSetId } });
        await postStopped(set, set.chainTicket ?? coding.planTicket, code);
      }),
    buildTicketFromComment: async (db, input) => {
      // The issue's newest approved plan set whose planner names a builder, and which that builder's
      // own lookup would pick (plans/build.ts newestVisiblePlanSet): the command and the build gate
      // always agree on the set. A GitHub issue numbers its plan, so a Jira plan is never matched here.
      let set: PlanSet;
      let agent: PlanAgent;
      let setting: ReturnType<typeof readPlanDocument>;
      let tickets: Map<number, string>;
      try {
        // Every set of the repository and number, as the gate sees them (approved or not, any tracker).
        const sets = await db.planSet.findMany({
          where: { repository: planRepositoryFilter(input.repository), number: input.number },
          include: chainSetInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        let found: (typeof sets)[number] | undefined;
        setting = null;
        for (const candidate of sets) {
          if (!candidate.approvedAt || (candidate.issueProvider !== null && candidate.issueProvider !== "github")) {
            continue;
          }
          let named: ReturnType<typeof readPlanDocument>;
          try {
            named = readPlanDocument(candidate.agent.codingProfile?.planDocument, candidate.agent.ownerId);
          } catch {
            named = null;
          }
          if (!named?.builderAgentId) continue;
          const builder = await db.agent.findUnique({
            where: { id: named.builderAgentId },
            select: { ownerId: true },
          });
          // A missing or ownerless builder is the set's to refuse (plan_builder_invalid at the R12 check,
          // or the gate's plan_not_approved), so the set is still the one the command acts on.
          if (builder?.ownerId && (await newestVisiblePlanSet(db, sets, builder.ownerId)) !== candidate) continue;
          found = candidate;
          setting = named;
          break;
        }
        if (!found || !setting) return "none";
        const { documents, agent: planner, ...row } = found;
        set = row;
        agent = planner;
        tickets = ticketTitles(documents[0]?.currentVersion?.markdown ?? "");
      } catch (err) {
        planLog.warn({ errorName: err instanceof Error ? err.name : typeof err }, "plan build ticket lookup failed");
        return "none";
      }
      // From here the comment was a plan command: it is answered on the issue, never passed on as a mention.
      const posted = (work: Promise<void>) => {
        const done = work.catch((err: unknown) => {
          planLog.warn({ errorName: err instanceof Error ? err.name : typeof err }, "plan build ticket notice failed");
        });
        deps.track?.(done);
      };
      // "build" (re)starts the chain from this ticket; "notify" builds this ticket only (R13).
      const chained = setting.onApproved === "build";
      const notice = (started: StartTicketResult, starterName: string | null) =>
        posted(reportTicketStart(db, deps, set, input.ticket, started, starterName, { stopsChain: chained }));
      try {
        // A plan.md that lists its tickets: only one of them can be built.
        if (tickets.size > 0 && !tickets.has(input.ticket)) {
          posted(postPlanNotice(deps, set, `Plan ${set.number} has no ticket ${input.ticket}.`));
          return "refused";
        }
        // R16, spec §7b: never more than one ticket run at a time, a fix round included (the start's
        // guard checks again).
        const running = await runningPlanTicket(db, set.id);
        if (running !== null) {
          notice({ running }, null);
          return "refused";
        }
        if (chained) {
          // A stop code is cleared, and this ticket's merge moves the chain on as the approval's own start would.
          await db.planSet.updateMany({
            where: { id: set.id, approvedAt: { not: null } },
            data: { chainTicket: input.ticket, chainStopped: null, chainRunId: null },
          });
          set = { ...set, chainTicket: input.ticket, chainStopped: null, chainRunId: null };
        }
        // R12: the builder is checked again before every start.
        const builderAgentId = await checkedBuilder(db, agent);
        const started: StartTicketResult = builderAgentId
          ? await startOrStartFailed(db, deps, {
              builderAgentId,
              set,
              ticket: input.ticket,
              // Mention runs record no principal; the notice names the comment's author.
              starterId: null,
              trigger: "comment",
              followedByChain: chained,
            })
          : { refused: "plan_builder_invalid" };
        notice(started, input.starterName);
        return "runId" in started ? "started" : "refused";
      } catch (err) {
        planLog.warn({ errorName: err instanceof Error ? err.name : typeof err }, "plan build ticket failed");
        notice({ refused: "start_failed" }, null);
        return "refused";
      }
    },
  };
}
