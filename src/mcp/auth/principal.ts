/**
 * Find-or-create a Principal by subject. `subject` is either the IdP's
 * subject claim (delegating/self-hosted, from a validated AuthProfile) or
 * the configured LOCAL_PRINCIPAL (stdio, no token) — either way, the caller
 * always carries an owner, so a deployment that later moves from stdio to
 * HTTP+OAuth doesn't orphan locally-authored agents. A new principal is created
 * together with its Personal team (docs/private/adr/0004).
 */
import type { PrismaClient, Principal } from "#prisma";
import { newUserPrincipalData } from "../../core/teams/personal.js";
import { requireSubject } from "../../providers/auth/subject.js";

export async function resolvePrincipal(subject: string, db: PrismaClient): Promise<Principal> {
  requireSubject(subject);
  return db.principal.upsert({
    where: { subject },
    create: newUserPrincipalData(subject),
    update: {},
  });
}
