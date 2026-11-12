/**
 * Who may supply a coding agent's task text, base ref or repository.
 *
 * A non-owner's coding task steers what the owner's repository authority
 * does, so it is allowed only to the agent's owner, or to anyone the owner
 * opted in for (codingProfile.allowWebhookTaskOverride, the same opt-in
 * webhooks use). Strictly the owner: the stdio operator's owner-level access
 * does not make it the owner whose repository authority the task steers.
 *
 * One rule for every path that hands a coding agent task text on someone's
 * behalf: trigger_agent and documents (linking and send). Resource-sharing
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
