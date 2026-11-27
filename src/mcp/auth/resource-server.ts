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
import {
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  check,
  checkAny,
  isOwnerAll as callerIsOwnerAll,
  isRoleName,
  permissionsOf,
  type Denial,
} from "../../authz/index.js";

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

export { ROLE_NAMES, ROLE_PERMISSIONS, isRoleName, permissionsOf };

/**
 * AUTH_OWNER_ALL_ROLE_ONLY: `true` lets a caller whose roles grant owner:all act as
 * owner-all without the owner:all scope on the token, for deployments whose identity
 * provider cannot issue that scope yet. Unset or `false` keeps the scope required.
 * Anything else is a startup error, like WARDBY_ADMIN_UI_TRUSTED_PROXY.
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
 * True when the caller holds the owner tier (the owner scope, or the legacy owner:all)
 * AND a role granting owner:all (wardby_owner): treated like the stdio operator for
 * access checks.
 */
export function isOwnerAll(ctx: Pick<McpRequestContext, "scopes" | "roles">): boolean {
  return callerIsOwnerAll(ctx);
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
 * Throws the McpError for a failed check. A scope denial is a 403 insufficient_scope
 * listing every permission the operation needs (not just the ones missing), so a
 * client can re-auth once with the full set; a role denial carries no scope
 * challenge, because re-authorizing cannot fix it, an operator must grant a role.
 */
function raise(denial: Denial | null, canonicalUri: string): void {
  if (!denial) return;
  if (denial.kind === "scope") throw insufficientScope(denial.permissions, protectedResourceMetadataUrl(canonicalUri));
  throw forbidden(denial.permissions);
}

/**
 * Throws unless every permission is reached by the token's scope tier and granted by a role (src/authz).
 * The 403 for a missing tier names every permission the operation needs, so a client can re-auth once.
 */
export function authorize(ctx: McpRequestContext, ...permissions: string[]): void {
  raise(check(ctx, permissions), ctx.canonicalUri);
}

/**
 * Like authorize, but any ONE of `alternatives` suffices (e.g. package
 * approval: packages:approve or agents:admin).
 */
export function authorizeAny(ctx: McpRequestContext, ...alternatives: string[]): void {
  raise(checkAny(ctx, alternatives), ctx.canonicalUri);
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
