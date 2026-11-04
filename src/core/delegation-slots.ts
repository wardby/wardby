/** What the once-per-run rule counts: a sub-agent, and for a coding sub-agent, the repository. */
export function delegationSlot(childAgentId: string, repository: string | null): string {
  return repository === null ? childAgentId : `${childAgentId}\n${repository.toLowerCase()}`;
}

/**
 * Slots for runs already delegated. A run refused at dispatch has no CodingRun, so its
 * repository is unknown; for this child that counts as its default. Retrying a refused
 * non-default repository is allowed, and still counts toward the delegation limit.
 */
export function priorDelegationSlots(
  rows: readonly { agentId: string; codingRun?: { repository: string } | null }[],
  childAgentId: string,
  defaultRepository: string | null,
): string[] {
  return rows.map((row) =>
    delegationSlot(row.agentId, row.codingRun?.repository ?? (row.agentId === childAgentId ? defaultRepository : null)),
  );
}

/**
 * At most `limit` dispatches per run (default one: a classifier deciding plan-vs-implement
 * commits to exactly one child), and never the same slot twice, so a retry can't leave two
 * children racing on the same task. A delegation waiting for budget holds its place.
 */
export function delegationLimitRefusal(input: {
  priorSlots: readonly string[];
  waitingSlots: readonly string[];
  slot: string;
  boundName: string;
  limit: number;
}): string | null {
  const { priorSlots, waitingSlots, slot, boundName, limit } = input;
  if (priorSlots.includes(slot) || waitingSlots.includes(slot)) {
    return JSON.stringify({
      error: "already_dispatched",
      message: `This run already delegated to "${boundName}" for this repository; a run delegates to each sub-agent and repository at most once.`,
    });
  }
  if (priorSlots.length < limit && priorSlots.length + waitingSlots.length >= limit) {
    // Only a waiting delegation (parallelDelegations) holds the remaining place.
    return JSON.stringify({
      error: "already_dispatched",
      message: `This run reached its limit of ${limit} delegations: ${priorSlots.length} made and ${waitingSlots.length} waiting for budget.`,
    });
  }
  if (priorSlots.length >= limit) {
    return JSON.stringify({
      error: "already_dispatched",
      message:
        limit === 1
          ? "This run already delegated to a sub-agent; only one delegation is allowed per run."
          : `This run already made ${limit} delegations, the most this agent allows per run.`,
    });
  }
  return null;
}
