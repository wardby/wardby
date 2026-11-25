/**
 * The authorization module: whether a caller may exercise a permission. A request
 * must pass the token's scope tier, then a role granting the permission. (Resource
 * access, ownership and grants, is layered on later.) The module depends on
 * nothing in the MCP layer; callers translate a {@link Denial} into their own error.
 */
import { ROLE_NAMES, ROLE_PERMISSIONS, grantedPermissions, permissionsOf } from "./roles.js";
import { scopesCover } from "./tiers.js";

/** What the module needs to know about a caller. */
export interface Caller {
  /** The scopes the token carries (tier scopes, the viewer scope, or legacy strings). */
  scopes: ReadonlySet<string>;
  /** The caller's roles, resolved per request. Absent or empty means member only. */
  roles?: readonly string[] | null;
}

/** Why a check failed. A scope denial is fixed by re-authorizing; a role denial needs an operator. */
export type Denial =
  { kind: "scope"; permissions: string[] } | { kind: "role"; permissions: string[]; grantedBy: string[] };

const roleDenial = (permissions: string[]): Denial => ({
  kind: "role",
  permissions,
  grantedBy: ROLE_NAMES.filter((r) => permissions.some((p) => ROLE_PERMISSIONS[r].includes(p))),
});

/** Every permission must be reached by the token's tier and granted by a role; null means allowed. */
export function check(caller: Caller, permissions: readonly string[]): Denial | null {
  if (!permissions.every((p) => scopesCover(caller.scopes, p))) return { kind: "scope", permissions: [...permissions] };
  const granted = grantedPermissions(caller.roles);
  const missing = permissions.filter((p) => !granted.has(p));
  return missing.length > 0 ? roleDenial(missing) : null;
}

/**
 * Like {@link check}, but any ONE of `alternatives` suffices (package approval:
 * packages:approve or agents:admin). The first alternative is the one named when
 * no alternative is reached by the token.
 */
export function checkAny(caller: Caller, alternatives: readonly string[]): Denial | null {
  const reached = alternatives.filter((p) => scopesCover(caller.scopes, p));
  if (reached.length === 0) return { kind: "scope", permissions: alternatives.slice(0, 1) };
  const granted = grantedPermissions(caller.roles);
  if (reached.some((p) => granted.has(p))) return null;
  // A role DOES grant an alternative the token does not reach: re-authorizing is the fix.
  const reachable = alternatives.find((p) => !scopesCover(caller.scopes, p) && granted.has(p));
  if (reachable) return { kind: "scope", permissions: [reachable] };
  return roleDenial(reached);
}

/**
 * True when the caller holds the owner tier AND a role granting owner:all
 * (wardby_owner): treated like the stdio operator for access checks.
 */
export function isOwnerAll(caller: Caller): boolean {
  return scopesCover(caller.scopes, "owner:all") && permissionsOf(caller.roles).has("owner:all");
}

export {
  MEMBER_PERMISSIONS,
  PRIVILEGED_PERMISSIONS,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  grantedPermissions,
  isRoleName,
  permissionsOf,
} from "./roles.js";
export { PERMISSION_TIER, TIERS, TIER_SCOPES, VIEWER_SCOPE, scopesCover, type Tier } from "./tiers.js";
