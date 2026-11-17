/**
 * What happens when a plan set is approved (docs/private spec §7b). The review event that makes the
 * last counted document of a set approved (a verdict, a force approve, or a removal that leaves only
 * approved documents) fires this once per approval: a reopen clears the approval and a new approval
 * fires it again. `onApproved: "notify"` posts a notice on the plan's issue; `"build"` starts the
 * builder for ticket 1, after checking the builder again (R12).
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
import { defuseMentions } from "../reply-parts.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { ticketTitles, type BuildPlan } from "./build.js";
import type { PostIssueNotice } from "./hooks.js";
import { planNumberFromIssueKey } from "./number.js";
import { checkPlanDocumentSetting } from "./settings.js";

const planLog = logger.child({ module: "plans" });

export interface StartTicketInput {
  builderAgentId: string;
  set: PlanSet;
  ticket: number;
  /** The principal who started it (Run.triggeredById), when known. */
  starterId: string | null;
  trigger: "plan_approved" | "comment";
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
  /** Given the background work an approval starts (its notice, the ticket start); tests await it. */
  track?: (work: Promise<void>) => void;
}

export type PlanReviewHook = (db: PrismaClient, documentId: string, actorId: string | null) => Promise<void>;

/** What the build chain reads and writes (C3, C4). */
export type PlanChainDb = Pick<PrismaClient, "planSet" | "codingRun">;

/** The build chain (R13): built by `createPlanChainHook(deps)` in composition (C3), with the deps above. */
export interface PlanChainHook {
  /** A pull request closed (pr_closed); only a merged PR of the chain's current ticket starts the next one. */
  onMerged(db: PlanChainDb, pr: { repository: string; number: number; merged: boolean }): Promise<void>;
  /** A run ended (B6's terminal hook): a ticket run that did not succeed stops the chain. */
  onTicketFinished(db: PlanChainDb, runId: string): Promise<void>;
  /** `@<handle> build ticket <t>` on the plan's issue (C4). */
  buildTicketFromComment(
    db: PlanChainDb,
    input: { repository: string; number: number; ticket: number; starterName: string },
  ): Promise<"started" | "refused" | "none">;
}

let hook: PlanReviewHook | undefined;

export function setPlanReviewHook(next: PlanReviewHook | undefined): void {
  hook = next;
}

export function planReviewHook(): PlanReviewHook | undefined {
  return hook;
}

/** @-mentions outside `code` spans defused: names and paths ping nobody; the hint stays copyable. */
export function defuseNotice(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : defuseMentions(part)))
    .join("");
}

/** A bare URL (`https://…`, `www.…`) with its scheme broken by a zero-width space, so nothing autolinks it. */
const defuseAutolinks = (text: string) =>
  text.replace(/(https?|ftp)(:\/\/)/gi, "$1\u200b$2").replace(/(www)(\.)/gi, "$1\u200b$2");

/** A plan path in a notice: one line, never a code-span delimiter, a design without its trailing slash. */
const shownPath = (path: string) => defuseAutolinks(path.replace(/\/$/, "").replace(/[`\r\n]+/g, ""));

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

/** The ticket of a pending or running build run of the set, or null. Works on a transaction too. */
export async function runningPlanTicket(
  db: Pick<PrismaClient, "codingRun">,
  planSetId: string,
): Promise<number | null> {
  const running = await db.codingRun.findFirst({
    where: { planSetId, planTicket: { not: null }, run: { status: { in: ["pending", "running"] } } },
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
  prefix?: string,
): Promise<void> {
  // Redacted raw, before shownName escapes it: an escaped secret (`a\\_b`) would no longer match.
  const name = starterName === null ? null : redactExactSecretValues(starterName, await deps.secretValues(set.agentId));
  let text: string;
  if ("runId" in started) text = planBuildStartedNotice(set.number, ticket, name);
  else if ("running" in started) text = `Plan ${set.number}: already building ticket ${started.running}.`;
  else {
    const code = refusalCode(started.refused);
    await db.planSet.update({ where: { id: set.id }, data: { chainStopped: code } });
    text = `Plan ${set.number}: ticket ${ticket} did not start (${code}).`;
  }
  await postPlanNotice(deps, set, prefix ? `${prefix}\n${text}` : text);
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

type ApprovedSet = NonNullable<Awaited<ReturnType<typeof claimApproval>>>;

/**
 * Under the set's row lock, so review events on one set are decided one at a time on the states they
 * see: ends the approval when a counted document is no longer approved, or claims it (approvedAt from
 * null) when every one is. Returns the set only to the event that claimed it.
 */
async function claimApproval(db: PrismaClient, planSetId: string) {
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
      if (set.approvedAt) {
        await tx.planSet.update({
          where: { id: set.id },
          data: {
            approvedAt: null,
            ...(set.chainTicket !== null && set.chainStopped === null ? { chainStopped: "reopened" } : {}),
          },
        });
      }
      return null;
    }
    // Exactly once per approval: only the event that sets approvedAt from null goes on.
    if (set.approvedAt) return null;
    await tx.planSet.update({ where: { id: set.id }, data: { approvedAt: new Date() } });
    return set;
  });
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
  // R12, spec §7b: the builder is checked again now, against the access the owner has today.
  // Reviewers are not re-checked here (publish checks them), so only the builder can fail.
  const builderOnly: PlanDocumentInput = {
    store: setting.store,
    onApproved: setting.onApproved,
    ...(setting.path ? { path: setting.path } : {}),
    ...(setting.builderAgentId ? { builderAgentId: setting.builderAgentId } : {}),
  };
  try {
    await checkPlanDocumentSetting(db, { id: set.agent.id, ownerId: set.agent.ownerId }, builderOnly);
  } catch {
    await db.planSet.update({ where: { id: set.id }, data: { chainStopped: "plan_builder_invalid" } });
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
  await db.planSet.update({ where: { id: set.id }, data: { chainTicket: 1, chainStopped: null } });
  // The set's own row only: no document text goes to the start.
  const { documents: _documents, agent: _agent, ...row } = set;
  const started = await deps
    .startTicket({
      builderAgentId: setting.builderAgentId!,
      set: row,
      ticket: 1,
      starterId: actorId,
      trigger: "plan_approved",
    })
    .catch((err: unknown): StartTicketResult => {
      // A start that threw (not a refusal) stops the chain with a notice instead of leaving it silent.
      planLog.warn(
        { planSetId: set.id, errorName: err instanceof Error ? err.name : typeof err },
        "ticket start failed",
      );
      return { refused: "start_failed" };
    });
  const starterName = actorId ? ((await principalNames(db, [actorId])).get(actorId) ?? null) : null;
  await reportTicketStart(db, deps, row, 1, started, starterName, planApprovedNotice(set.number, versions, null));
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
      const set = await claimApproval(db, doc.planSetId);
      if (!set) return;
      // The review action returns now; host calls and the ticket start follow in the background.
      const work = afterApproval(db, deps, set, actorId).catch(logFailure({ documentId, planSetId: set.id }));
      deps.track?.(work);
    } catch (err) {
      // Never throws: a review verdict is never undone by its plan follow-up.
      logFailure({ documentId })(err);
    }
  };
}
