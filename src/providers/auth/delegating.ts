/**
 * Resource-server-only AuthProvider: wardby never issues tokens itself, an
 * external OIDC/OAuth IdP is the authorization server. verifyBearer is the
 * whole job — validate a caller-supplied access token (signature via JWKS,
 * audience, expiry, issuer) and map its claims to a VerifiedToken (subject
 * + per-token scopes). The auth-code flow methods (authorizeUrl/
 * exchangeCode/refresh) belong to the external IdP, not to wardby, so they
 * throw rather than half-implement a flow this adapter doesn't own.
 */
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from "jose";
import type { AuthProfile, AuthProvider, AuthTokens, VerifiedToken } from "./types.js";
import { AudienceError, NotSupportedError } from "./types.js";
import { requireSubject } from "./subject.js";

export interface DelegatingAuthConfig {
  issuer?: string;
  audience?: string;
  jwksUri?: string;
}

/**
 * Every spelling of the configured audience a token may legitimately carry.
 *
 * `aud` is compared as an exact string, but for an http(s) URI an empty path
 * and "/" denote the same resource (RFC 3986 §6.2.3) — and the two halves of
 * this system disagree about which spelling to use. The protected-resource
 * metadata advertises the normalized ("/") form, so a spec-compliant client
 * asks its IdP for that; an IdP whose audience is configured from a
 * hand-written identifier (Auth0's API Identifier, say) echoes back whatever
 * the operator typed, usually without the slash. Matching only one form
 * rejects real tokens from the other, and the startup check in
 * mcp/index.ts normalizes both sides, so the misconfiguration passes
 * validation and only surfaces as an opaque invalid_token at request time.
 *
 * A non-URL audience (some IdPs use opaque identifiers) has exactly one form.
 */
export function audienceCandidates(audience: string): string[] {
  try {
    const url = new URL(audience);
    const forms = [audience, url.href];
    // Only an empty path is interchangeable with "/". A trailing slash on a
    // non-empty path ("…/mcp/" vs "…/mcp") is significant, so those stay
    // distinct resources and keep matching strictly.
    if (url.pathname === "/") forms.push(url.href.replace(/\/$/, ""));
    return [...new Set(forms)];
  } catch {
    return [audience];
  }
}

/** Splits an OAuth `scope`/`scp` claim (space-delimited string, or already an array) into scopes. */
function scopesFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim === "string") return claim.split(/\s+/).filter(Boolean);
  return [];
}

export class DelegatingAuthProvider implements AuthProvider {
  private readonly config: DelegatingAuthConfig;
  private readonly audiences: string[];
  private readonly jwks: JWTVerifyGetKey;

  constructor(config: DelegatingAuthConfig, jwks?: JWTVerifyGetKey) {
    if (!config.issuer || !config.audience) throw new Error("AUTH_ISSUER and AUTH_AUDIENCE are required.");
    this.config = config;
    this.audiences = audienceCandidates(config.audience);
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
        audience: this.audiences,
        requiredClaims: ["sub", "exp", "iss", "aud"],
      });
      return {
        subject: requireSubject(payload.sub),
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
