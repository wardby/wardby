/**
 * The one lookup both delegation paths (control-plane `delegate_to_*` and the sandbox gateway's
 * `durableDelegate`) use to find the child a delegation call already created, so a re-executed
 * delegate step (a resume, or a takeover under a new version) waits on that child again instead
 * of refusing it as a duplicate.
 */
import type { PrismaClient } from "#prisma";

export type DelegationChildDb = Pick<PrismaClient, "run">;

/**
 * The child a delegation call already created, if any: exact key first (Run.parentCallId, the
 * model's tool-call id), then (legacy rows created before parentCallId existed) the single
 * child of that agent with no key, in any status: it may have finished while the lead was
 * between deploys, and its result is what the re-run step is owed. A run delegates to each
 * sub-agent at most once, so a lead has no older finished child of the same agent to confuse it
 * with. Two or more such legacy children are ambiguous and adopt none. `createdAt` is the child row's creation time (Run.startedAt, set when the row is
 * written and never rewritten), from which the caller measures its wait bound.
 */
export async function findDelegationChild(
  db: DelegationChildDb,
  parentRunId: string,
  childAgentId: string,
  parentCallId: string | undefined,
): Promise<{ id: string; createdAt: Date } | null> {
  const select = { id: true, startedAt: true } as const;
  const found = (row: { id: string; startedAt: Date }) => ({ id: row.id, createdAt: row.startedAt });
  if (parentCallId) {
    // Same agent too: a call id is the same call only if it names the same sub-agent. A colliding
    // id from another agent is never adopted: its create then fails on the unique key, which the
    // delegate tool answers with a tool-result error (delegation_conflict), never a run failure.
    const keyed = await db.run.findFirst({ where: { parentRunId, parentCallId, agentId: childAgentId }, select });
    if (keyed) return found(keyed);
  }
  const legacy = await db.run.findMany({
    where: { parentRunId, agentId: childAgentId, parentCallId: null },
    select,
    take: 2,
  });
  return legacy.length === 1 ? found(legacy[0]) : null;
}
