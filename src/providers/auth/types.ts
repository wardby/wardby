/**
 * Auth seam — OAuth 2.1 resource-server identity and scope extraction.
 *
 * Default adapter: DelegatingAuthProvider (resource-server-only; an external
 * IdP is the authorization server). Native adapter: SelfHostedAuthProvider
 * (wardby additionally runs the AS role: PKCE /authorize+/token, its own
 * signed tokens).
 */

/**
 * The interactive-login identity shape (returned by `profile(idToken)`).
 * Identity only — no scopes here. Scopes are a per-token authorization
 * grant, not a property of who someone is: the same subject can present
 * two different tokens carrying two different scope sets, so a scope
 * field on an identity type would conflate a grant with an identity the
 * moment more than one token exists for the same subject.
 */
export interface AuthProfile {
  subject: string;
  email?: string;
  name?: string;
  /** Application roles resolved from the provider's token claims. */
  roles: string[];
}

/**
 * The result of validating a bearer access token (returned by
 * `verifyBearer`). Distinct from `AuthProfile` precisely because it DOES
 * carry scopes — this is per-token, not per-identity.
 */
export interface VerifiedToken {
  subject: string;
  /** OAuth scopes granted to this specific token. */
  scopes: string[];
  email?: string;
  roles?: string[];
  /**
   * wardby roles (not the IdP's raw `roles`), decided by the provider at
   * verification time: self-hosted reads AuthUser.roles live; delegating
   * maps the configured signed claim through AUTH_ROLE_MAP. Absent = none.
   */
  wardbyRoles?: string[];
  /**
   * The token's identity claims that `whoami` reports, copied from the verified
   * token and limited to IDENTITY_CLAIMS (string values only): never the token
   * itself, never any other claim.
   */
  identityClaims?: Readonly<Record<string, string>>;
}

/** The token claims `whoami` may show its caller: who the token says they are, and which client asked. */
export const IDENTITY_CLAIMS = ["sub", "uid", "cid", "client_id", "azp"] as const;

/** IDENTITY_CLAIMS from a verified token's payload, string values only. */
export function identityClaimsOf(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of IDENTITY_CLAIMS) {
    const value = payload[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
}

export interface AuthProvider {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<AuthTokens>;
  refresh(refreshToken: string): Promise<AuthTokens>;
  /** Validate the id token and map its claims to a profile with roles. */
  profile(idToken: string): Promise<AuthProfile>;
  /**
   * Validate a bearer access token (signature, audience, expiry, issuer)
   * and map its claims to a verified-token result. This is what the MCP
   * resource-server middleware calls on every authenticated request — both
   * adapters implement it so the middleware never needs to know which is
   * active.
   */
  verifyBearer(token: string): Promise<VerifiedToken>;
}

/** Thrown by verifyBearer when a token's audience doesn't match the configured canonical URI. */
export class AudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudienceError";
  }
}

/** Thrown by authorizeUrl/exchangeCode/refresh on an adapter that doesn't run those flows itself. */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}
