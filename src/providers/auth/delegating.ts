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
import { ROLE_NAMES, isRoleName } from "../../mcp/auth/resource-server.js";

export interface DelegatingAuthConfig {
  issuer?: string;
  audience?: string;
  jwksUri?: string;
  /**
   * AUTH_ROLE_CLAIM: the access-token claim carrying the IdP's roles/groups —
   * an exact top-level claim name first (e.g. Auth0's namespaced
   * `https://wardby.example/roles`, Okta `groups`, FusionAuth `roles`), else
   * a dotted path into nested objects (Keycloak `realm_access.roles`).
   */
  roleClaim?: string;
  /**
   * AUTH_ROLE_MAP: comma-separated `idpValue=wardbyRole` pairs, e.g.
   * `wardby-admin=admin,wardby-packages=package-approver`.
   */
  roleMap?: string;
}

/**
 * Parses AUTH_ROLE_MAP. Whitespace around entries and around `=` is ignored;
 * an unknown wardby role, or a malformed or empty entry, is a startup error.
 * The LAST `=` splits an entry (wardby role names never contain one).
 */
export function parseRoleMap(value: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const entries = value.split(",").map((e) => e.trim());
  if (entries.every((e) => !e)) throw new Error("AUTH_ROLE_MAP is empty.");
  for (const entry of entries) {
    if (!entry) continue;
    const at = entry.lastIndexOf("=");
    const idpValue = at > 0 ? entry.slice(0, at).trim() : "";
    const role = at > 0 ? entry.slice(at + 1).trim() : "";
    if (!idpValue || !role) throw new Error(`AUTH_ROLE_MAP entry "${entry}" must look like idpValue=wardbyRole.`);
    if (!isRoleName(role))
      throw new Error(`AUTH_ROLE_MAP maps "${idpValue}" to unknown role "${role}" (known: ${ROLE_NAMES.join(", ")}).`);
    map.set(idpValue, [...new Set([...(map.get(idpValue) ?? []), role])]);
  }
  return map;
}

/**
 * Resolves `claim` in a verified payload: an exact top-level name wins (claim
 * names may themselves contain dots and slashes), otherwise a dotted path.
 */
function resolveClaim(payload: Record<string, unknown>, claim: string): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, claim)) return payload[claim];
  if (!claim.includes(".")) return undefined;
  let value: unknown = payload;
  for (const part of claim.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Maps a resolved claim (a string, or an array of strings) through the role
 * map; unmapped values are ignored, and any other shape yields no roles.
 */
function rolesFromClaim(value: unknown, map: Map<string, string[]>): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const roles = new Set<string>();
  for (const v of values) if (typeof v === "string") for (const r of map.get(v) ?? []) roles.add(r);
  return [...roles];
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
  private readonly roleMap?: Map<string, string[]>;

  constructor(config: DelegatingAuthConfig, jwks?: JWTVerifyGetKey) {
    if (!config.issuer || !config.audience) throw new Error("AUTH_ISSUER and AUTH_AUDIENCE are required.");
    // Half a configuration would silently give everyone no roles while
    // looking configured — refuse to start instead.
    if ((config.roleClaim !== undefined || config.roleMap !== undefined) && (!config.roleClaim || !config.roleMap))
      throw new Error("AUTH_ROLE_CLAIM and AUTH_ROLE_MAP must be set together (or both left unset).");
    if (config.roleMap) this.roleMap = parseRoleMap(config.roleMap);
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
        // Read from this validated ACCESS token (signature, issuer, audience,
        // expiry all checked above) — never from an ID token. Unconfigured,
        // every caller has no roles and privileged operations are refused.
        wardbyRoles:
          this.config.roleClaim && this.roleMap
            ? rolesFromClaim(resolveClaim(payload, this.config.roleClaim), this.roleMap)
            : [],
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
