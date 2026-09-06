/**
 * Minimal OAuth 2.1 authorization server, hosted by reevo itself
 * (AUTH_PROVIDER=self-hosted). One process is both AS and resource server,
 * so a single symmetric (HS256) signing key is sufficient — no JWKS
 * publication needed, unlike delegating mode where a third-party client
 * verifies tokens issued elsewhere.
 *
 * The authorization code is itself a short-lived signed JWT (not a DB row):
 * it carries the PKCE challenge + requested scope/resource inline, so
 * `/token` verifies it statelessly instead of a second table + cleanup
 * job for a 60-second-lived value. `OAuthGrant` rows exist only for the
 * *issued* refresh token (Task 4's actual persistent state), not the code.
 *
 * HTTP framing (the /authorize, /token, /register routes) lives in Task 7;
 * this file is pure AS logic the HTTP layer calls into.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { PrismaClient } from "@prisma/client";
import type { AuthProfile, AuthProvider, AuthTokens, VerifiedToken } from "./types.js";
import { AudienceError, NotSupportedError } from "./types.js";

const CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const CODE_AUDIENCE = "reevo:self-hosted-as:code";

export interface SelfHostedAuthConfig {
  /** reevo's own canonical URI — used as both issuer and default audience. */
  canonicalUri: string;
  /** HMAC signing secret (>= 32 bytes recommended). */
  signingKey: string;
}

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  authorization_response_iss_parameter_supported: true;
}

export interface RegisterClientParams {
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  tokenEndpointAuthMethod?: "none" | "client_secret_post";
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
}

export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  resource: string;
  /**
   * The principal approving this request. A real deployment gates
   * `/authorize` behind its own login step and supplies the authenticated
   * user's identity here — this minimal AS has no login UI of its own
   * (out of scope for Phase 4; see design doc "minimal hand-rolled AS").
   */
  subject: string;
  state?: string;
}

export interface AuthorizeResult {
  code: string;
  state?: string;
  /** RFC 9207: echoed back so the client can bind the response to this issuer. */
  iss: string;
}

export type TokenParams =
  | { grantType: "authorization_code"; code: string; codeVerifier: string; redirectUri: string; clientId: string }
  | { grantType: "refresh_token"; refreshToken: string; clientId: string };

export interface TokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken?: string;
  scope: string;
}

interface CodePayload {
  clientId: string;
  subject: string;
  scope: string;
  resource: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return computed === codeChallenge;
}

export class SelfHostedAuthProvider implements AuthProvider {
  private readonly config: SelfHostedAuthConfig;
  private readonly db: PrismaClient;
  private readonly key: Uint8Array;

  constructor(config: SelfHostedAuthConfig, db: PrismaClient) {
    if (config.signingKey.length < 32) {
      throw new Error("AUTH_SIGNING_KEY must be at least 32 characters — required by the self-hosted AS adapter.");
    }
    this.config = config;
    this.db = db;
    this.key = new TextEncoder().encode(config.signingKey);
  }

  asMetadata(): AsMetadata {
    const base = this.config.canonicalUri.replace(/\/mcp$/, "");
    return {
      issuer: this.config.canonicalUri,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  async registerClient(params: RegisterClientParams): Promise<RegisteredClient> {
    const clientId = randomUUID();
    const isPublic = params.tokenEndpointAuthMethod === "none";
    const clientSecret = isPublic ? undefined : randomBytes(32).toString("base64url");
    await this.db.oAuthClient.create({
      data: {
        clientId,
        clientSecret,
        metadata: {
          redirect_uris: params.redirectUris,
          grant_types: params.grantTypes ?? ["authorization_code", "refresh_token"],
          client_name: params.clientName ?? null,
          token_endpoint_auth_method: params.tokenEndpointAuthMethod ?? "none",
        },
      },
    });
    return { clientId, clientSecret };
  }

  async handleAuthorize(params: AuthorizeParams): Promise<AuthorizeResult> {
    const client = await this.db.oAuthClient.findUnique({ where: { clientId: params.clientId } });
    if (!client) {
      throw new Error(`Unknown OAuth client "${params.clientId}".`);
    }
    const redirectUris = (client.metadata as { redirect_uris?: string[] }).redirect_uris ?? [];
    if (!redirectUris.includes(params.redirectUri)) {
      throw new Error(`redirect_uri "${params.redirectUri}" is not registered for client "${params.clientId}".`);
    }
    // This AS instance IS the one resource server (itself) — it never
    // mediates access to a third-party RS, so the requested `resource`
    // must equal our own canonical URI. Trusting a client-supplied
    // `resource` blindly as the token audience would be an audience-
    // confusion vector; RFC 8707 binding means validating it, not just
    // echoing it.
    if (params.resource !== this.config.canonicalUri) {
      throw new Error(`resource "${params.resource}" is not this server ("${this.config.canonicalUri}").`);
    }

    const payload: CodePayload = {
      clientId: params.clientId,
      subject: params.subject,
      scope: params.scope,
      resource: params.resource,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
    };
    const code = await new SignJWT({ ...payload })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(this.config.canonicalUri)
      .setAudience(CODE_AUDIENCE)
      .setExpirationTime(`${CODE_TTL_SECONDS}s`)
      .sign(this.key);

    return { code, state: params.state, iss: this.config.canonicalUri };
  }

  async handleToken(params: TokenParams): Promise<TokenResult> {
    if (params.grantType === "authorization_code") {
      return this.handleAuthorizationCodeGrant(params);
    }
    return this.handleRefreshTokenGrant(params);
  }

  private async handleAuthorizationCodeGrant(
    params: Extract<TokenParams, { grantType: "authorization_code" }>,
  ): Promise<TokenResult> {
    const { payload } = await jwtVerify(params.code, this.key, {
      issuer: this.config.canonicalUri,
      audience: CODE_AUDIENCE,
    });
    const code = payload as unknown as CodePayload;

    if (code.clientId !== params.clientId) {
      throw new Error("Authorization code was not issued to this client.");
    }
    if (code.redirectUri !== params.redirectUri) {
      throw new Error("redirect_uri does not match the one used at the authorization step.");
    }
    if (!pkceMatches(params.codeVerifier, code.codeChallenge)) {
      throw new Error("PKCE verification failed: code_verifier does not match code_challenge.");
    }

    return this.issueTokens({ clientId: code.clientId, subject: code.subject, scope: code.scope, resource: code.resource });
  }

  private async handleRefreshTokenGrant(
    params: Extract<TokenParams, { grantType: "refresh_token" }>,
  ): Promise<TokenResult> {
    const grant = await this.db.oAuthGrant.findUnique({ where: { refreshToken: params.refreshToken } });
    if (!grant || grant.clientId !== params.clientId) {
      throw new Error("Unknown or mismatched refresh token.");
    }
    if (grant.expiresAt.getTime() <= Date.now()) {
      throw new Error("Refresh token grant has expired.");
    }
    return this.issueTokens({
      clientId: grant.clientId,
      subject: grant.principalId,
      scope: grant.scope,
      resource: this.config.canonicalUri,
    });
  }

  private async issueTokens(params: { clientId: string; subject: string; scope: string; resource: string }): Promise<TokenResult> {
    const accessToken = await new SignJWT({ scope: params.scope })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(params.subject)
      .setIssuedAt()
      .setIssuer(this.config.canonicalUri)
      .setAudience(params.resource)
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);

    const refreshToken = randomBytes(32).toString("base64url");
    await this.db.oAuthGrant.create({
      data: {
        clientId: params.clientId,
        principalId: params.subject,
        scope: params.scope,
        refreshToken,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });

    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      scope: params.scope,
    };
  }

  async verifyBearer(token: string): Promise<VerifiedToken> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.config.canonicalUri,
        audience: this.config.canonicalUri,
      });
      const scopeClaim = payload.scope;
      return {
        subject: String(payload.sub ?? ""),
        roles: [],
        scopes: typeof scopeClaim === "string" ? scopeClaim.split(/\s+/).filter(Boolean) : [],
      };
    } catch (err) {
      if (err instanceof joseErrors.JWTClaimValidationFailed && err.claim === "aud") {
        throw new AudienceError(`Token audience does not match this resource server ("${this.config.canonicalUri}").`);
      }
      throw err;
    }
  }

  async profile(idToken: string): Promise<AuthProfile> {
    const verified = await this.verifyBearer(idToken);
    return { subject: verified.subject, email: verified.email, roles: verified.roles ?? [] };
  }

  authorizeUrl(_state: string, _redirectUri: string): string {
    throw new NotSupportedError("Use asMetadata().authorization_endpoint and handleAuthorize() directly; this adapter is the AS itself, not a redirect-based client helper.");
  }

  async exchangeCode(_code: string, _redirectUri: string): Promise<AuthTokens> {
    throw new NotSupportedError("Use handleToken() directly; this adapter is the AS itself.");
  }

  async refresh(_refreshToken: string): Promise<AuthTokens> {
    throw new NotSupportedError("Use handleToken({grantType:'refresh_token', ...}) directly; this adapter is the AS itself.");
  }
}
