/**
 * Resource-server-only AuthProvider: reevo never issues tokens itself, an
 * external OIDC/OAuth IdP is the authorization server. verifyBearer is the
 * whole job — validate a caller-supplied access token (signature via JWKS,
 * audience, expiry, issuer) and map its claims to a VerifiedToken (subject
 * + per-token scopes). The auth-code flow methods (authorizeUrl/
 * exchangeCode/refresh) belong to the external IdP, not to reevo, so they
 * throw rather than half-implement a flow this adapter doesn't own.
 */
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from "jose";
import type { AuthProfile, AuthProvider, AuthTokens, VerifiedToken } from "./types.js";
import { AudienceError, NotSupportedError } from "./types.js";

export interface DelegatingAuthConfig {
  issuer?: string;
  audience?: string;
  jwksUri?: string;
}

/** Splits an OAuth `scope`/`scp` claim (space-delimited string, or already an array) into scopes. */
function scopesFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim === "string") return claim.split(/\s+/).filter(Boolean);
  return [];
}

export class DelegatingAuthProvider implements AuthProvider {
  private readonly config: DelegatingAuthConfig;
  private readonly jwks: JWTVerifyGetKey;

  constructor(config: DelegatingAuthConfig, jwks?: JWTVerifyGetKey) {
    this.config = config;
    if (jwks) {
      this.jwks = jwks;
    } else {
      if (!config.jwksUri) {
        throw new Error("AUTH_JWKS_URI is not set — required by the delegating AuthProvider adapter.");
      }
      this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
    }
  }

  async verifyBearer(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      return {
        subject: String(payload.sub ?? ""),
        email: typeof payload.email === "string" ? payload.email : undefined,
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        scopes: scopesFromClaim(payload.scope ?? payload.scp),
      };
    } catch (err) {
      if (err instanceof joseErrors.JWTClaimValidationFailed && err.claim === "aud") {
        throw new AudienceError(`Token audience does not match the configured resource ("${this.config.audience}").`);
      }
      throw err;
    }
  }

  async profile(idToken: string): Promise<AuthProfile> {
    const verified = await this.verifyBearer(idToken);
    return { subject: verified.subject, email: verified.email, roles: verified.roles ?? [] };
  }

  authorizeUrl(_state: string, _redirectUri: string): string {
    throw new NotSupportedError(
      "DelegatingAuthProvider is resource-server-only; the external IdP's own authorization endpoint issues tokens.",
    );
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<AuthTokens> {
    throw new NotSupportedError(
      "DelegatingAuthProvider is resource-server-only; the external IdP's own token endpoint issues tokens.",
    );
  }

  async refresh(_refreshToken: string): Promise<AuthTokens> {
    throw new NotSupportedError(
      "DelegatingAuthProvider is resource-server-only; the external IdP's own token endpoint handles refresh.",
    );
  }
}
