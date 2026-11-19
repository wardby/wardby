/**
 * Personal teams (docs/private/adr/0004). Every user has a Team of one whose
 * backing principal is the user's own principal, so ownership and grants are
 * unchanged by it. Create it together with the principal.
 */
import { randomUUID } from "node:crypto";

export const PERSONAL_TEAM_NAME_PREFIX = "personal:";

/** Principal create-data (id, subject, nested Personal team) for a new user. */
export function newUserPrincipalData(subject: string) {
  const id = randomUUID();
  return {
    id,
    subject,
    team: {
      create: {
        name: `${PERSONAL_TEAM_NAME_PREFIX}${id}`,
        personal: true,
        members: { create: { principal: { connect: { id } } } },
      },
    },
  };
}
