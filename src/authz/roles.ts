/**
 * Roles and the permissions they grant. Every permission goes through a role:
 * the privileged ones through the built-in roles below, the rest through the
 * implicit member role every signed-in caller has.
 */
import { PERMISSION_TIER } from "./tiers.js";

/**
 * Permissions whose operations reach beyond the caller's own (or public)
 * resources: agents:admin reassigns ANY agent's owner (make_owner) and sets a BYO
 * workerImageRef; packages:approve widens coding agents' package allowlists;
 * services:manage changes the coding-run service catalog; admin:view reads every
 * owner's runs (the admin viewer API); models:admin changes the model catalog,
 * which prices every principal's runs; power:manage scales the shared coding
 * proxy and native gateway to zero; hosts:admin registers host providers;
 * teams:manage creates, renames and deletes teams and edits their membership;
 * owner:all acts as the owner of every owner's management resources.
 * A token scope only DELEGATES: one of these is honoured only when a role of the
 * caller grants it.
 */
export const PRIVILEGED_PERMISSIONS: readonly string[] = [
  "agents:admin",
  "packages:approve",
  "services:manage",
  "admin:view",
  "models:admin",
  "power:manage",
  "hosts:admin",
  "teams:manage",
  "owner:all",
];

/** The built-in roles and the permissions each grants. */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  admin: [
    "agents:admin",
    "packages:approve",
    "services:manage",
    "admin:view",
    "models:admin",
    "power:manage",
    "hosts:admin",
    "teams:manage",
  ],
  // Superset of admin: also read/write on every owner's management resources
  // (agents, runs, tools, budget groups, MCP servers, documents, webhooks,
  // grants, datastores, secrets metadata), owner-only fields, bindings and task
  // ownership. Secret values are never returned. Assign to people, not broad teams.
  wardby_owner: [
    "agents:admin",
    "packages:approve",
    "services:manage",
    "admin:view",
    "models:admin",
    "power:manage",
    "hosts:admin",
    "teams:manage",
    "owner:all",
  ],
  "package-approver": ["packages:approve"],
  "service-manager": ["services:manage"],
  "model-manager": ["models:admin"],
  // Read-only, deployment-wide viewer access (admin:view) without the rest of admin.
  viewer: ["admin:view"],
  "host-manager": ["hosts:admin"],
  // Team create/rename/delete and membership; assigning a team's roles stays admin-only.
  "team-manager": ["teams:manage"],
};
export const ROLE_NAMES: readonly string[] = Object.keys(ROLE_PERMISSIONS);

export function isRoleName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, name);
}

/** The permissions granted by `roles`; unknown role names grant nothing. */
export function permissionsOf(roles: readonly string[] | null | undefined): Set<string> {
  return new Set((roles ?? []).filter(isRoleName).flatMap((r) => ROLE_PERMISSIONS[r]));
}

/**
 * The implicit member role: every signed-in caller holds it, and it grants every
 * permission that is not privileged. It is not a name an operator can assign.
 */
export const MEMBER_PERMISSIONS: readonly string[] = Object.keys(PERMISSION_TIER).filter(
  (permission) => !PRIVILEGED_PERMISSIONS.includes(permission),
);

/** Everything `roles` grant plus the implicit member role. */
export function grantedPermissions(roles: readonly string[] | null | undefined): Set<string> {
  return new Set([...MEMBER_PERMISSIONS, ...permissionsOf(roles)]);
}
