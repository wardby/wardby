/**
 * Auth seam — OAuth 2.1 resource-server identity and scope extraction.
 *
 * Default adapter: DelegatingAuthProvider (resource-server-only; an external
 * IdP is the authorization server). Native adapter: SelfHostedAuthProvider
 * (reevo additionally runs the AS role: PKCE /authorize+/token, its own
 * signed tokens).
 */

export interface AuthProfile {
  subject: string;
  email?: string;
  name?: string;
  /** Application roles resolved from the provider's token claims. */
  roles: string[];
  /** OAuth scopes granted to this token. */
  scopes: string[];
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
   * and map its claims to a profile. This is what the MCP resource-server
   * middleware calls on every authenticated request — both adapters
   * implement it so the middleware never needs to know which is active.
   */
  verifyBearer(token: string): Promise<AuthProfile>;
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
