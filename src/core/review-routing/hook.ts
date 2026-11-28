/**
 * The router review hook (#646, spec §3): after a review action commits, finds the router for the document or its
 * set, claims a job for the action (once), and starts the router run with a fixed task and read access to the
 * action's documents. Runs in the background; never throws; logs ids and error names only.
 *
 * A set routes as one piece of work (spec §3.1): an action made only of approvals routes only when it completed
 * the set's approval (a plan set's is claimed by the plan hook, which runs first; a native option set's is claimed
 * here), a choice (chooseOption) routes once, a submit routes only when the set enters review (once per round), and every
 * other action routes once as that action on the set. An action that continues a job (an agent's own, or a plan
 * publish's submits for the planner run) is one more start of that job, counted against the router's limit.
 */
import type { PrismaClient } from "#prisma";
import { readPlanDocument } from "../../coding/profile.js";
import { logger } from "../logger.js";
import { principalNames } from "../documents/comments.js";
import type { ReviewAction, ReviewActionHook } from "../documents/review-hooks.js";
import { choiceNote } from "../documents/review.js";
import { claimSetApproval } from "../documents/sets.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { resolveRouter } from "./lineage.js";
import { claimJob, continuedJob, countJobStart } from "./jobs.js";
import { routerTask } from "./task.js";

const log = logger.child({ module: "review-routing" });

export type StartRouter = (input: {
  routerAgentId: string;
  task: string;
  triggeredById: string | null;
  jobId: string;
  documentIds: string[];
}) => Promise<{ runId: string } | { refused: string }>;

export interface ReviewRouterDeps {
  startRouter: StartRouter;
  /**
   * An agent's secret values: a plan set's option labels and plan paths are agent-written (an older row's label
   * was copied from its raw path), so they are redacted against the planner's values before they reach the task.
   */
  secretValues: (agentId: string) => Promise<readonly string[]>;
}

export function createReviewRouterHook(deps: {
  startRouter: StartRouter;
  secretValues: ReviewRouterDeps["secretValues"];
  track?: (work: Promise<void>) => void;
}): ReviewActionHook {
  return async (db, action) => {
    if (action.eventIds.length === 0 || action.deferRouting) return;
    const work = route(db, deps, action).catch((err: unknown) => {
      log.warn(
        { documentId: action.documentId, errorName: err instanceof Error ? err.name : typeof err },
        "review routing failed",
      );
    });
    deps.track?.(work);
  };
}

const setSelect = {
  select: { id: true, name: true, agentId: true, ownerId: true, routerAgentId: true, createdByRunId: true },
} as const;

/** The user's own words in a choice's stored note ("Chose <option>: <note>"), or the whole note if it differs. */
function choiceWords(note: string | null, option: string): string | null {
  if (!note || note === choiceNote(option, null)) return null;
  const prefix = `${choiceNote(option, null)}: `;
  return note.startsWith(prefix) ? note.slice(prefix.length) : note;
}

async function route(db: PrismaClient, deps: ReviewRouterDeps, action: ReviewAction): Promise<void> {
  const events = await db.documentReviewEvent.findMany({
    where: { id: { in: action.eventIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      versionNumber: true,
      note: true,
      documentId: true,
      actorGuestId: true,
      createdAt: true,
    },
  });
  const doc = await db.document.findUnique({
    where: { id: action.documentId },
    select: {
      id: true,
      title: true,
      agentId: true,
      ownerId: true,
      routerAgentId: true,
      option: true,
      versions: { where: { number: 1 }, select: { runId: true } },
      planPath: true,
      set: setSelect,
      planSet: {
        select: {
          id: true,
          number: true,
          agentId: true,
          set: setSelect,
          agent: { select: { ownerId: true, codingProfile: { select: { planDocument: true } } } },
        },
      },
    },
  });
  if (!doc || events.length === 0) return;
  const firstEventId = events[0].id;
  const kinds = events.map((e) => e.kind);
  // chooseOption rejects other documents of the set; rejectDocument rejects only its own.
  const chose = events.some((e) => e.kind === "rejected" && e.documentId !== doc.id);
  const approvalsOnly = !chose && kinds.every((k) => k === "approved");
  const planSet = doc.planSet;
  // A plan set's shared set carries its router; a native option set is its own home.
  const set = planSet ? planSet.set : doc.set;

  let builderStarted = false;
  if (planSet) {
    // The plan hook (run first) claims a plan set's approval: only the action it claimed it for routes an approval,
    // and that action's approval starts the builder when the planner builds on approval.
    const claimed = action.planApprovalClaimed === true;
    if (approvalsOnly && !claimed) return;
    builderStarted = claimed && onApproved(planSet.agent) === "build";
  } else if (set) {
    // Every action decides the native set's approval (a reopen ends it); only the completing approval routes.
    const claim = await claimSetApproval(db, { kind: "documents", setId: set.id }, action.actorId);
    if (approvalsOnly && claim?.approved !== true) return;
  }
  // A set enters review once per round (spec §3.1): a submit after another member's in the same round routes nothing.
  if (set && kinds.every(entersReview) && (await setAlreadySubmitted(db, doc, events[0]))) return;

  // Checked before any job is claimed: a router its person can no longer run is no router.
  const routerAgentId = await resolveRouter(
    db,
    set
      ? {
          routerAgentId: set.routerAgentId,
          writerAgentId: set.agentId,
          ownerId: set.ownerId,
          recordedByRunId: set.createdByRunId,
        }
      : {
          routerAgentId: doc.routerAgentId,
          writerAgentId: doc.agentId,
          ownerId: doc.ownerId,
          recordedByRunId: doc.versions[0]?.runId ?? null,
        },
  );
  if (!routerAgentId) return;

  const continued = await continuedJob(db, firstEventId, action.actorRunId);
  const rootJobId = continued ? (continued.rootJobId ?? continued.id) : null;
  // An action that continues a job is attributed to that job's person (spec §3.5), even when made as the owner.
  const startedById = rootJobId
    ? await agentActionStarter(db, firstEventId, rootJobId)
    : (action.actorId ?? (await agentActionStarter(db, firstEventId, null)));
  const job = await claimJob(db, {
    reviewEventId: firstEventId,
    documentId: set ? null : doc.id,
    setId: set?.id ?? null,
    routerAgentId,
    startedById,
    rootJobId,
  });
  if (!job) return;
  try {
    // A router run that continues a job is a start of that job (spec §4): counted on the root, refused past it.
    if (rootJobId) {
      const counted = await countJobStart(db, { id: job.id, routerAgentId, rootJobId, routerRunId: null });
      if (counted) {
        await db.reviewJob.update({ where: { id: job.id }, data: { outcome: "review_route_limit" } });
        log.info({ jobId: job.id, routerAgentId, code: "review_route_limit" }, "router not started");
        return;
      }
    }
    const eventDocumentIds = [...new Set(events.map((e) => e.documentId))];
    const members = planSet
      ? await db.document.findMany({ where: { planSetId: planSet.id, removedFromPlan: false }, select: { id: true } })
      : set
        ? await db.document.findMany({ where: { setId: set.id, removedFromPlan: false }, select: { id: true } })
        : [];
    const documentIds = [...new Set([doc.id, ...members.map((d) => d.id), ...eventDocumentIds])];

    const byName = action.actorId
      ? ((await principalNames(db, [action.actorId])).get(action.actorId) ?? null)
      : events[0].actorGuestId
        ? "a guest"
        : null;
    // A plan's labels are redacted here, at the point of use; loading the planner's values failing fails closed
    // (the catch below records route_failed and nothing starts).
    const planSecrets = planSet ? await deps.secretValues(planSet.agentId) : [];
    const label = (value: string | null) => (value && planSet ? redactExactSecretValues(value, planSecrets) : value);
    // The granted documents, in grant order, each with its label when it is a set's member.
    const rows = await db.document.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, option: true, planPath: true, planSetId: true, setId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const documents = documentIds.map((id) => {
      const row = byId.get(id);
      const member = row && (row.planSetId !== null || row.setId !== null);
      return { id, label: member ? label(row.option ?? row.planPath) : null };
    });
    const chosenOption = chose ? label(doc.option ?? doc.planPath ?? null) : null;
    const rejectedEvents = events.filter((e) => e.kind === "rejected" && e.documentId !== doc.id);
    const rejected = chose
      ? (
          await db.document.findMany({
            where: { id: { in: rejectedEvents.map((e) => e.documentId) } },
            select: { option: true, planPath: true },
          })
        )
          .map((d) => label(d.option ?? d.planPath))
          .filter((o): o is string => !!o)
          .sort()
      : [];
    // Only stored (redacted) notes: a choice's note is stored on each rejected document as "Chose <option>: <note>".
    const note = chose
      ? choiceWords(rejectedEvents.find((e) => e.note)?.note ?? null, chosenOption ?? "")
      : (events.find((e) => e.note)?.note ?? null);
    const task = routerTask({
      action: chose ? "option_chosen" : events[events.length - 1].kind,
      subject:
        set || planSet
          ? { kind: "set", title: planSet ? `Plan ${planSet.number}` : (set?.name ?? doc.title) }
          : { kind: "document", title: doc.title },
      versions: [...new Set(events.map((e) => e.versionNumber))],
      documents,
      ...(chosenOption ? { chosen: { option: chosenOption, rejected } } : {}),
      byName,
      note,
      builderStarted,
    });
    const started = await deps.startRouter({
      routerAgentId,
      task,
      triggeredById: startedById,
      jobId: job.id,
      documentIds,
    });
    await db.reviewJob.update({
      where: { id: job.id },
      data: "runId" in started ? { routerRunId: started.runId, outcome: "started" } : { outcome: started.refused },
    });
    if ("refused" in started) log.info({ jobId: job.id, routerAgentId, code: started.refused }, "router not started");
  } catch (err) {
    // A claimed job never stays without an outcome.
    await db.reviewJob.update({ where: { id: job.id }, data: { outcome: "route_failed" } }).catch(() => undefined);
    log.warn(
      { jobId: job.id, documentId: action.documentId, errorName: err instanceof Error ? err.name : typeof err },
      "review routing failed",
    );
  }
}

/** A submit, or a revision answering requested changes: the set (re-)enters review. */
const entersReview = (kind: string) => kind === "submitted" || kind === "revised";

/**
 * A decision that sends a set member back for work: the set's next submit or revision starts a new review round.
 * Approvals do not: an approval while the set is still being submitted ends no round.
 */
const ROUND_ENDING_KINDS = ["changes_requested", "rejected", "reopened", "archived", "unarchived"];

/**
 * Whether another member of the document's set was submitted or revised earlier in this review round (by time,
 * then id): the set entered review then. A round starts after the last decision on any member
 * (ROUND_ENDING_KINDS), so a revision after changes were requested routes again, once for the set. Plan sets by planSetId, native option sets by setId.
 */
async function setAlreadySubmitted(
  db: PrismaClient,
  doc: { id: string; planSet: { id: string } | null; set: { id: string } | null },
  first: { id: string; createdAt: Date },
): Promise<boolean> {
  const members = await db.document.findMany({
    where: doc.planSet ? { planSetId: doc.planSet.id } : { setId: doc.set!.id },
    select: { id: true },
  });
  const others = members.map((m) => m.id).filter((id) => id !== doc.id);
  if (others.length === 0) return false;
  const before = (at: { id: string; createdAt: Date }) => [
    { createdAt: { lt: at.createdAt } },
    { createdAt: at.createdAt, id: { lt: at.id } },
  ];
  const decision = await db.documentReviewEvent.findFirst({
    where: { documentId: { in: members.map((m) => m.id) }, kind: { in: ROUND_ENDING_KINDS }, OR: before(first) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
  const earlier = await db.documentReviewEvent.findFirst({
    where: {
      documentId: { in: others },
      kind: { in: ["submitted", "revised"] },
      AND: [
        { OR: before(first) },
        ...(decision
          ? [
              {
                OR: [
                  { createdAt: { gt: decision.createdAt } },
                  { createdAt: decision.createdAt, id: { gt: decision.id } },
                ],
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  });
  return earlier !== null;
}

/** The planner's onApproved, read as plans/approval.ts reads it; an unreadable setting is none. */
function onApproved(planner: { ownerId: string | null; codingProfile: { planDocument: unknown } | null }) {
  try {
    return readPlanDocument(planner.codingProfile?.planDocument, planner.ownerId)?.onApproved ?? null;
  } catch {
    return null;
  }
}

/**
 * Who an agent's own action is attributed to (spec §3.5): the person whose job it continues, else the person
 * who started the agent's run tree; null for a guest's action or a tree nobody started.
 */
async function agentActionStarter(db: PrismaClient, eventId: string, rootJobId: string | null): Promise<string | null> {
  if (rootJobId) {
    const root = await db.reviewJob.findUnique({ where: { id: rootJobId }, select: { startedById: true } });
    return root?.startedById ?? null;
  }
  const event = await db.documentReviewEvent.findUnique({ where: { id: eventId }, select: { actorRunId: true } });
  if (!event?.actorRunId) return null;
  const run = await db.run.findUnique({ where: { id: event.actorRunId }, select: { triggeredById: true } });
  return run?.triggeredById ?? null;
}
