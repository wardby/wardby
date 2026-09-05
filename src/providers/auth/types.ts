/**
 * Auth seam — OIDC identity and role extraction.
 *
 * Default adapter: GenericOidcAuthProvider (any standards-compliant OIDC IdP).
 * Native adapter:  FusionAuthAuthProvider (role mapping from FusionAuth claims).
 */

export interface AuthProfile {
  subject: string;
  email?: string;
  name?: string;
  /** Application roles resolved from the provider's token claims. */
  roles: string[];
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
}
