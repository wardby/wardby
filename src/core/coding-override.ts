/**
 * Who may supply a coding agent's task text, base ref or repository.
 *
 * A non-owner's coding task steers what the owner's repository authority
 * does, so it is allowed only to the agent's owner, or to anyone the owner
 * opted in for (codingProfile.allowWebhookTaskOverride, the same opt-in
 * webhooks use). Strictly the owner: the stdio operator's owner-level access
 * does not make it the owner whose repository authority the task steers.
 *
 * One rule for the paths that hand a coding agent task text on behalf of a
 * principal: trigger_agent and documents (linking and send). Not the only
 * path: webhooks have no principal and read the opt-in directly, and the
 * runner's cross-owner sub-agent checks compare owners (an owner-less agent
 * counts as one owner) before applying the same opt-in. Resource-sharing
 * grants spec §3.4.5.
 */
export interface CodingOverrideAgent {
  ownerId: string | null;
  codingProfile: { allowWebhookTaskOverride: boolean } | null;
}

/** Whether `principalId` may supply task text, baseRef or repository for this agent. */
export function codingOverrideAllowed(principalId: string, agent: CodingOverrideAgent): boolean {
  const isOwner = agent.ownerId !== null && agent.ownerId === principalId;
  return isOwner || agent.codingProfile?.allowWebhookTaskOverride === true;
}
