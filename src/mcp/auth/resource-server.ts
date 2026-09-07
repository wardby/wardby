/**
 * OAuth 2.1 resource-server surface: PRM (.well-known) discovery, bearer
 * validation, and scope enforcement. Works identically regardless of which
 * AuthProvider (delegating | self-hosted) is active — both implement
 * verifyBearer, so this file never branches on auth mode.
 */
import type { PrismaClient } from "@prisma/client";
import type { AuthProvider } from "../../providers/auth/types.js";
import { resolvePrincipal } from "./principal.js";
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
  // Reassigns an agent's owner regardless of who currently owns it (or
  // whether it's public) — a step above agents:write, which only ever lets
  // a caller act on agents they already own or that are unowned.
  "agents:admin",
];

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
  return {
    principal,
    scopes: new Set(verified.scopes),
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
 * Throws a 403 insufficient_scope McpError listing every scope this
 * operation needs (not just the ones the caller is missing) — so a client
 * can re-auth once with the full required set instead of round-tripping
 * per missing scope.
 */
export function requireScope(ctx: McpRequestContext, canonicalUri: string, ...scopes: string[]): void {
  const held = scopes.every((s) => ctx.scopes.has(s));
  if (held) return;
  throw insufficientScope(scopes, protectedResourceMetadataUrl(canonicalUri));
}

export { McpError };
