/**
 * Scope tiers: the coarse, stable capabilities a token carries. A Scope is only
 * the ceiling on what a token may do; a Permission granted by a Role is the real
 * grant (see ./roles.ts and ./index.ts).
 *
 * Four tiers nest (owner includes admin, admin includes write, write includes
 * read), plus a narrow viewer scope for the desktop viewer that covers one
 * permission only. Each Permission declares exactly one tier.
 */

export const TIERS = ["read", "write", "admin", "owner"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_SCOPES: Readonly<Record<Tier, string>> = {
  read: "wardby:read",
  write: "wardby:write",
  admin: "wardby:admin",
  owner: "wardby:owner",
};

/** The desktop viewer's own scope: it covers {@link VIEWER_PERMISSION} and nothing else. */
export const VIEWER_SCOPE = "wardby:viewer";
const VIEWER_PERMISSION = "admin:view";

/**
 * Permission to tier. The permission names are today's scope names, so this is
 * also the alias table for legacy scope strings: a token carrying one is treated
 * as carrying that permission's tier (admin:view is the exception, see
 * {@link scopesCover}). Features add permissions here, never scopes.
 */
export const PERMISSION_TIER: Readonly<Record<string, Tier>> = {
  "agents:read": "read",
  "documents:read": "read",

  "agents:write": "write",
  "tools:write": "write",
  "runs:trigger": "write",
  "datastore:write": "write",
  "secrets:write": "write",
  "webhooks:write": "write",
  "budget_groups:write": "write",
  "memory:write": "write",
  "documents:write": "write",

  "agents:admin": "admin",
  "packages:approve": "admin",
  "services:manage": "admin",
  "admin:view": "admin",
  "models:admin": "admin",
  "power:manage": "admin",
  "hosts:admin": "admin",
  "teams:manage": "admin",

  "owner:all": "owner",
};

const rank = (tier: Tier): number => TIERS.indexOf(tier);

const TIER_OF_SCOPE: Readonly<Record<string, Tier>> = Object.fromEntries(
  TIERS.map((tier) => [TIER_SCOPES[tier], tier]),
);

/**
 * Whether a token carrying `scopes` reaches `permission`: it holds a tier scope at
 * or above the permission's tier, or a legacy scope string whose tier does.
 * The viewer scope, and the legacy admin:view, cover admin:view only, so the
 * desktop viewer's token never widens to the rest of the admin tier.
 * An unknown permission is never covered.
 */
export function scopesCover(scopes: Iterable<string>, permission: string): boolean {
  const needed = PERMISSION_TIER[permission];
  if (needed === undefined) return false;
  for (const scope of scopes) {
    if (scope === VIEWER_SCOPE || scope === VIEWER_PERMISSION) {
      if (permission === VIEWER_PERMISSION) return true;
      continue;
    }
    const held = TIER_OF_SCOPE[scope] ?? PERMISSION_TIER[scope];
    if (held !== undefined && rank(held) >= rank(needed)) return true;
  }
  return false;
}
