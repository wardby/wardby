/**
 * The router review hook (#646, spec §3): after a review action commits, finds the router for the document or its
 * set, claims a job for the action (once), and starts the router run with a fixed task and read access to the
 * action's documents. Runs in the background; never throws; logs ids and error names only.
 *
 * A set routes as one piece of work (spec §3.1): an action made only of approvals routes only when it completed
 * the set's approval (a plan set's is claimed by the plan hook, which runs first; a native option set's is claimed
 * here), a choice (chooseOption) routes once, and every other action routes once as that action on the set.
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
import { claimJob, continuedJob } from "./jobs.js";
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
    if (action.eventIds.length === 0) return;
    const work = route(db, deps, action).catch((err: unknown) => {
      log.warn(
        { documentId: action.documentId, errorName: err instanceof Error ? err.name : typeof err },
        "review routing failed",
      );
    });
    deps.track?.(work);
  };
}

const setSelect = { select: { id: true, name: true, agentId: true, routerAgentId: true } } as const;

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
    select: { id: true, kind: true, versionNumber: true, note: true, documentId: true, actorGuestId: true },
  });
  const doc = await db.document.findUnique({
    where: { id: action.documentId },
    select: {
      id: true,
      title: true,
      agentId: true,
      routerAgentId: true,
      option: true,
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

  const routerAgentId = await resolveRouter(
    db,
    set
      ? { routerAgentId: set.routerAgentId, writerAgentId: set.agentId }
      : { routerAgentId: doc.routerAgentId, writerAgentId: doc.agentId },
  );
  if (!routerAgentId) return;

  const continued = await continuedJob(db, firstEventId);
  const rootJobId = continued ? (continued.rootJobId ?? continued.id) : null;
  const startedById = action.actorId ?? (await agentActionStarter(db, firstEventId, rootJobId));
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
