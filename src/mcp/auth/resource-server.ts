/**
 * OAuth 2.1 resource-server surface: PRM (.well-known) discovery, bearer
 * validation, and scope enforcement. Works identically regardless of which
 * AuthProvider (delegating | self-hosted) is active — both implement
 * verifyBearer, so this file never branches on auth mode.
 */
import type { PrismaClient } from "#prisma";
import type { AuthProvider } from "../../providers/auth/types.js";
import { resolvePrincipal } from "./principal.js";
import { resolveStanding } from "../../core/teams/standing.js";
import { McpError, unauthorized, insufficientScope } from "../errors.js";
import type { McpRequestContext, McpProviders } from "../context.js";

/** The initial capability tiers (§Scopes → capability tiers in the design doc). */
export const SCOPES_SUPPORTED = [
  "agents:read",
  "agents:write",
  "tools:write",
  "runs:trigger",
  "datastore:write",
  "secrets:write",
  "webhooks:write",
  "budget_groups:write",
  // Approve coding agents' package allowlists (see docs/coding-packages.md).
  "packages:approve",
  // Create, update and delete coding-run service catalog entries (see docs/coding-services.md).
  // Reading the catalog is agents:read.
  "services:manage",
  // Reassigns an agent's owner regardless of who currently owns it (or
  // whether it's public) — a step above agents:write, which only ever lets
  // a caller act on agents they already own or that are unowned.
  "agents:admin",
  // set_agent_memory / delete_agent_memory (reading memory is agents:read).
  "memory:write",
  // Read-only, deployment-wide view of runs for the admin viewer (docs/viewer-api.md).
  // Privileged: it shows every owner's runs, so only the admin role grants it.
  "admin:view",
  // Add, override, disable and reset model catalog entries (see docs/models.md).
  // Reading the catalog (list_models, get_model) is agents:read.
  "models:admin",
  // Scale the coding proxy and native gateway to zero now (power_sleep) and
  // read their state (power_status); low-power mode only (docs/getting-started-gke.md).
  "power:manage",
  // Register host providers and approve their tools (docs/host-providers.md).
  // Bound tools decide who has permission and who wrote a comment.
  "hosts:admin",
  "teams:manage",
  // Documents: read/list, and create/change/share (no role needed; document access itself is per document).
  "documents:read",
  "documents:write",
  // wardby_owner only: read/write on every owner's management resources (isOwnerAll).
  "owner:all",
];

/**
 * Scopes whose operations reach beyond the caller's own (or public)
 * resources — they double as the permission names roles grant:
 * agents:admin reassigns ANY agent's owner (make_owner) and sets a BYO
 * workerImageRef; packages:approve widens coding agents' package allowlists;
 * services:manage changes the coding-run service catalog, which decides what
 * runs next to every coding run that names an entry; admin:view reads every
 * owner's runs (the admin viewer API); models:admin changes the model catalog,
 * which prices every principal's runs; power:manage scales the shared coding
 * proxy and native gateway to zero (power_sleep) and reads their state;
 * hosts:admin registers host providers, whose approved tools run in the push
 * and pull request flow; teams:manage creates, renames and deletes teams and
 * edits their membership (assigning a team's roles stays admin-only);
 * owner:all acts as the owner of every owner's management resources (isOwnerAll).
 * A token scope only DELEGATES — it never authorizes on its own:
 * requireScope/requireAnyScope honour one only when one of the caller's
 * roles (McpRequestContext.roles, resolved live per request) grants it.
 */
export const PRIVILEGED_SCOPES: readonly string[] = [
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

/**
 * The built-in roles and the permissions (privileged scope names) each
 * grants. No roles = member: every non-privileged scope, nothing privileged.
 */
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
 * AUTH_OWNER_ALL_ROLE_ONLY: `true` lets a caller whose roles grant owner:all act as
 * owner-all without the owner:all scope on the token, for deployments whose identity
 * provider cannot issue that scope yet. Unset or `false` keeps the scope required.
 * Anything else is a startup error.
 */
export function parseOwnerAllRoleOnly(env: NodeJS.ProcessEnv): boolean {
  const raw = env.AUTH_OWNER_ALL_ROLE_ONLY?.trim();
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new Error(`AUTH_OWNER_ALL_ROLE_ONLY must be "true" or "false", got "${raw}".`);
}

/** A token's scopes, plus owner:all when AUTH_OWNER_ALL_ROLE_ONLY is on and a role grants it. */
export function effectiveScopes(
  tokenScopes: Iterable<string>,
  roles: readonly string[] | null | undefined,
  ownerAllRoleOnly: boolean,
): Set<string> {
  const scopes = new Set(tokenScopes);
  if (ownerAllRoleOnly && permissionsOf(roles).has("owner:all")) scopes.add("owner:all");
  return scopes;
}

/**
 * True when the caller holds the owner:all scope AND a role granting it
 * (wardby_owner): treated like the stdio operator for access checks.
 */
export function isOwnerAll(ctx: Pick<McpRequestContext, "scopes" | "roles">): boolean {
  return ctx.scopes.has("owner:all") && permissionsOf(ctx.roles).has("owner:all");
}

/** Intersects a space-delimited scope string with `allowed`, deduplicated, keeping request order. */
export function limitScope(scope: string, allowed: readonly string[]): string {
  return [...new Set(scope.split(/\s+/).filter((s) => allowed.includes(s)))].join(" ");
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/** RFC 9728 §3.1: insert `/.well-known/oauth-protected-resource` before the resource's path. */
export function protectedResourceMetadataUrl(canonicalUri: string): string {
  const url = new URL(canonicalUri);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadata(config: {
  canonicalUri: string;
  authorizationServers: string[];
}): ProtectedResourceMetadata {
  return {
    resource: config.canonicalUri,
    authorization_servers: config.authorizationServers,
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
  };
}

export interface AuthenticateHeaders {
  authorization?: string;
}

export interface AuthenticateDeps {
  authProvider: AuthProvider;
  db: PrismaClient;
  providers: McpProviders;
  canonicalUri: string;
}

/**
 * Validates the bearer token in the `Authorization` header only — never a
 * query string, so a caller passing a token any other way is structurally
 * invisible here and falls through to the missing-header 401.
 */
export async function authenticate(headers: AuthenticateHeaders, deps: AuthenticateDeps): Promise<McpRequestContext> {
  const resourceMetadataUrl = protectedResourceMetadataUrl(deps.canonicalUri);
  const header = headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw unauthorized("Missing or malformed Authorization header (expected: Bearer <token>).", resourceMetadataUrl);
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw unauthorized("Missing or malformed Authorization header (expected: Bearer <token>).", resourceMetadataUrl);
  }

  let verified;
  try {
    verified = await deps.authProvider.verifyBearer(token);
  } catch {
    throw unauthorized("Invalid token.", resourceMetadataUrl);
  }

  const principal = await resolvePrincipal(verified.subject, deps.db);
  // Direct roles are decided by the provider on THIS request (self-hosted:
  // AuthUser.roles read from the database; delegating: the configured signed
  // role claim). Standing adds the roles and principals of the caller's teams,
  // read live, never cached: removing a member bites on their next request.
  const standing = await resolveStanding(deps.db, principal.id, verified.wardbyRoles ?? []);
  return {
    principal,
    scopes: new Set(verified.scopes),
    tokenIdentity: verified.identityClaims,
    roles: [...standing.roles],
    actsFor: standing.actsFor,
    teamIds: standing.teamIds,
    canonicalUri: deps.canonicalUri,
    providers: deps.providers,
    db: deps.db,
    // authenticate() only sees the HTTP Authorization header, before the
    // JSON-RPC body (and its _meta envelope) is even parsed — the real
    // per-call value is computed later, in server.ts's resolveCtx, once the
    // envelope is available. Callers using ONLY this function's return
    // value (streamable-http.ts's auth gate) never read this field or mcpReq.
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

/**
 * Whether the token carries `scope`. An owner-all caller (owner:all + wardby_owner)
 * holds every privileged scope implicitly: owner:all is the consent to act as an
 * owner of everything, so it never needs to be re-consented scope by scope. The role
 * check (requirePermission) still applies, and wardby_owner grants all of them.
 */
function holdsScope(ctx: McpRequestContext, scope: string): boolean {
  return ctx.scopes.has(scope) || (PRIVILEGED_SCOPES.includes(scope) && isOwnerAll(ctx));
}

/**
 * Throws a 403 insufficient_scope McpError listing every scope this
 * operation needs (not just the ones the caller is missing) — so a client
 * can re-auth once with the full required set instead of round-tripping
 * per missing scope.
 */
export function requireScope(ctx: McpRequestContext, canonicalUri: string, ...scopes: string[]): void {
  const held = scopes.every((s) => holdsScope(ctx, s));
  if (!held) throw insufficientScope(scopes, protectedResourceMetadataUrl(canonicalUri));
  requirePermission(ctx, scopes);
}

/**
 * Like requireScope, but any ONE of `alternatives` suffices (e.g. package
 * approval: packages:approve or agents:admin). The first alternative is the
 * one named in the insufficient_scope challenge.
 */
export function requireAnyScope(ctx: McpRequestContext, canonicalUri: string, ...alternatives: string[]): void {
  const held = alternatives.filter((s) => holdsScope(ctx, s));
  if (held.length === 0) throw insufficientScope(alternatives.slice(0, 1), protectedResourceMetadataUrl(canonicalUri));
  // One held alternative that is non-privileged, or that a role permits, suffices.
  const permitted = permissionsOf(ctx.roles);
  if (held.some((s) => !PRIVILEGED_SCOPES.includes(s) || permitted.has(s))) return;
  // A role DOES grant one of the unheld alternatives: re-authorizing for that
  // scope is the fix, so say so with a scope challenge, not a role 403.
  const reachable = alternatives.find((s) => !ctx.scopes.has(s) && permitted.has(s));
  if (reachable) throw insufficientScope([reachable], protectedResourceMetadataUrl(canonicalUri));
  throw forbidden(held);
}

/**
 * The one role check: a privileged scope is honoured only when one of the
 * caller's roles grants it as a permission. This is authorization, not
 * delegation, so the 403 carries no scope challenge — a client re-authorizing
 * for more scopes can't fix it; an operator must grant a role.
 */
function requirePermission(ctx: McpRequestContext, scopes: readonly string[]): void {
  const permitted = permissionsOf(ctx.roles);
  const missing = scopes.filter((s) => PRIVILEGED_SCOPES.includes(s) && !permitted.has(s));
  if (missing.length > 0) throw forbidden(missing);
}

function forbidden(permissions: readonly string[]): McpError {
  const grantedBy = ROLE_NAMES.filter((r) => permissions.some((p) => ROLE_PERMISSIONS[r].includes(p)));
  return new McpError(
    403,
    `Forbidden: ${permissions.join(" ")} requires a role that grants it (${grantedBy.join(" or ")}); ` +
      "the token's scope alone is not enough. An operator grants roles (self-hosted: " +
      "`wardby auth user grant --subject <subject> --role <role>`; delegating: AUTH_ROLE_CLAIM/AUTH_ROLE_MAP).",
  );
}

export { McpError, insufficientScope };
