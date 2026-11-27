/**
 * Document sets (#646, spec §6): documents reviewed together, where a person can choose one option.
 * A set lives in one of two homes. A plan set keeps its approval on the PlanSet row and its membership
 * in Document.planSetId (as before the shared set existed); a native writer's option set keeps both on
 * its DocumentSet row (Document.setId). A plan set also has a DocumentSet, which carries the plan's
 * router for routing only. claimSetApproval decides a set's approval once for either home.
 * Ids only: nothing here logs or returns document text.
 */
import { Prisma } from "#prisma";
import type { PrismaClient } from "#prisma";
import { routerForRun } from "../review-routing/lineage.js";

/** Which set, and so which home its approval and membership live in. */
export type SetRef = { kind: "plan"; planSetId: string } | { kind: "documents"; setId: string };

type Tx = Prisma.TransactionClient;
type SetsDb = Pick<PrismaClient, "documentSet" | "run">;

/**
 * The set id for a native writer's run and set name: created on first use, with the router of the run
 * tree (routerForRun). Concurrent first uses agree on one set. Not for use inside an interactive
 * transaction: a losing insert is retried as a read, which a failed statement would abort.
 */
export async function ensureNamedSet(
  db: SetsDb,
  input: { agentId: string; ownerId: string | null; runId: string; name: string },
): Promise<string> {
  const where = { createdByRunId_name: { createdByRunId: input.runId, name: input.name } };
  const existing = await db.documentSet.findUnique({ where, select: { id: true } });
  if (existing) return existing.id;
  const routerAgentId = await routerForRun(db, input.runId);
  try {
    const created = await db.documentSet.create({
      data: {
        agentId: input.agentId,
        ownerId: input.ownerId,
        name: input.name,
        createdByRunId: input.runId,
        routerAgentId,
      },
      select: { id: true },
    });
    return created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return (await db.documentSet.findUniqueOrThrow({ where, select: { id: true } })).id;
    }
    throw err;
  }
}

/** A plan set's shared set (unnamed), with the router of the planner run's tree; call it with the PlanSet create. */
export async function createPlanDocumentSet(
  tx: Tx | SetsDb,
  input: { agentId: string; ownerId: string | null; runId: string },
): Promise<string> {
  const routerAgentId = await routerForRun(tx, input.runId);
  const created = await tx.documentSet.create({
    data: { agentId: input.agentId, ownerId: input.ownerId, createdByRunId: input.runId, routerAgentId },
    select: { id: true },
  });
  return created.id;
}

/** Where a set's approval and counted documents live: the one place the two homes differ. */
const home = {
  /** Takes the set's row lock; its approval as seen under the lock, or null when the set is gone. */
  async lock(tx: Tx, ref: SetRef): Promise<{ approvedAt: Date | null } | null> {
    const rows =
      ref.kind === "plan"
        ? await tx.$queryRaw<{ approvedAt: Date | null }[]>`
            SELECT "approvedAt" FROM "PlanSet" WHERE "id" = ${ref.planSetId} FOR UPDATE`
        : await tx.$queryRaw<{ approvedAt: Date | null }[]>`
            SELECT "approvedAt" FROM "DocumentSet" WHERE "id" = ${ref.setId} FOR UPDATE`;
    return rows[0] ?? null;
  },
  /** The documents whose approval counts: still in the set; a plan's only with a plan path. */
  counted(ref: SetRef): Prisma.DocumentWhereInput {
    return ref.kind === "plan"
      ? { planSetId: ref.planSetId, removedFromPlan: false, planPath: { not: null } }
      : { setId: ref.setId, removedFromPlan: false };
  },
  async write(tx: Tx, ref: SetRef, data: { approvedAt: Date | null; approvedById: string | null }): Promise<void> {
    if (ref.kind === "plan") await tx.planSet.update({ where: { id: ref.planSetId }, data });
    else await tx.documentSet.update({ where: { id: ref.setId }, data });
  },
};

export type SetApprovalClaim = { approved: true; approvedAt: Date } | { approved: false; ended: true } | null;

/**
 * The set's approval decision inside the caller's transaction, under the set's row lock, so review events on
 * one set are decided one at a time on the states they see: when every counted document is approved (with a
 * current version) and the set is not, claims it (approvedAt from null, approvedById the actor) and returns
 * `{approved: true}`; when not every one is and the set is approved, ends the approval and returns
 * `{approved: false, ended: true}`; else null. Exactly once per approval: only the claiming event gets true.
 */
export async function claimSetApprovalIn(tx: Tx, ref: SetRef, actorId: string | null): Promise<SetApprovalClaim> {
  const locked = await home.lock(tx, ref);
  if (!locked) return null;
  const documents = await tx.document.findMany({
    where: home.counted(ref),
    select: { reviewState: true, currentVersionId: true },
  });
  const allApproved =
    documents.length > 0 && documents.every((d) => d.reviewState === "approved" && d.currentVersionId);
  if (!allApproved) {
    // A reopen (or a new waiting document) ends the approval.
    if (!locked.approvedAt) return null;
    await home.write(tx, ref, { approvedAt: null, approvedById: null });
    return { approved: false, ended: true };
  }
  if (locked.approvedAt) return null;
  const approvedAt = new Date();
  await home.write(tx, ref, { approvedAt, approvedById: actorId });
  return { approved: true, approvedAt };
}

/** Bounds for the set's row-lock transaction: a wait for the lock counts toward its timeout. */
export const SET_TX = { maxWait: 5_000, timeout: 20_000 } as const;

/** claimSetApprovalIn in a transaction of its own. */
export async function claimSetApproval(
  db: Pick<PrismaClient, "$transaction">,
  ref: SetRef,
  actorId: string | null,
): Promise<SetApprovalClaim> {
  return db.$transaction((tx) => claimSetApprovalIn(tx, ref, actorId), SET_TX);
}
