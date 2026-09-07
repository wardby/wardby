import { createHash, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { OAuthFamily, PrismaClient } from "@prisma/client";
import type { AuthProfile, AuthProvider, AuthTokens, VerifiedToken } from "./types.js";
import { NotSupportedError } from "./types.js";
import { requireSubject } from "./subject.js";
import { SCOPES_SUPPORTED } from "../../mcp/auth/resource-server.js";
import { canonicalUrl } from "../../mcp/transport/http-limits.js";
import { Credentials, DAY, decodeKey, lockUser, type AuthDb } from "../../mcp/auth/self-hosted/credentials.js";
import { Sessions } from "../../mcp/auth/self-hosted/session.js";
import type {
  AuthorizeParams,
  RegisterClientParams,
  SelfHostedAuthConfig,
  TokenParams,
  TokenResult,
} from "./authorization-server.js";
export type {
  AuthorizeParams,
  RegisterClientParams,
  SelfHostedAuthConfig,
  TokenParams,
  TokenResult,
} from "./authorization-server.js";

function validRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      !value.includes("#") &&
      !u.username &&
      !u.password &&
      (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
const registration = z
  .object({
    redirectUris: z.array(z.string().min(1).max(2048).refine(validRedirect)).min(1).max(10),
    clientName: z.string().max(100).optional(),
    grantTypes: z
      .array(z.enum(["authorization_code", "refresh_token"]))
      .min(1)
      .max(2)
      .default(["authorization_code", "refresh_token"]),
    tokenEndpointAuthMethod: z.literal("none").default("none"),
  })
  .strict();
const authorization = z
  .object({
    clientId: z.string().max(100),
    redirectUri: z.string().max(2048),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    codeChallengeMethod: z.literal("S256"),
    scope: z.string().max(512),
    resource: z.string().max(2048),
    state: z.string().max(1024).optional(),
  })
  .strict();

export class SelfHostedAuthProvider implements AuthProvider {
  readonly credentials: Credentials;
  readonly sessions: Sessions;
  readonly config: SelfHostedAuthConfig;
  private readonly key: Buffer;
  constructor(
    config: SelfHostedAuthConfig,
    readonly db: PrismaClient,
  ) {
    this.config = { ...config, canonicalUri: canonicalUrl(config.canonicalUri).href };
    this.key = decodeKey(config.signingKey, "AUTH_SIGNING_KEY");
    const credentialKey = decodeKey(config.credentialHashKey, "AUTH_CREDENTIAL_HASH_KEY");
    if (this.key.equals(credentialKey)) throw new Error("Signing and credential hash keys must be distinct.");
    if (!Number.isInteger(config.maxClients ?? 1000) || (config.maxClients ?? 1000) < 1)
      throw new Error("Invalid OAuth client limit.");
    this.credentials = new Credentials(config.credentialHashKey);
    this.sessions = new Sessions(db, this.credentials);
  }
  asMetadata() {
    const base = new URL(this.config.canonicalUri).origin;
    return {
      issuer: this.config.canonicalUri,
      authorization_endpoint: base + "/authorize",
      token_endpoint: base + "/token",
      registration_endpoint: base + "/register",
      revocation_endpoint: base + "/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SCOPES_SUPPORTED,
      authorization_response_iss_parameter_supported: true,
    };
  }
  async registerClient(params: RegisterClientParams) {
    const p = registration.parse(params);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe("SELECT 1 AS locked FROM pg_advisory_xact_lock(7412901)");
      if ((await tx.oAuthClient.count()) >= (this.config.maxClients ?? 1000))
        throw new Error("Client capacity reached.");
      const clientId = randomUUID();
      await tx.oAuthClient.create({
        data: {
          clientId,
          metadata: {
            redirect_uris: p.redirectUris,
            grant_types: p.grantTypes,
            client_name: p.clientName ?? "Unnamed client",
            token_endpoint_auth_method: "none",
          },
        },
      });
      return { clientId };
    });
  }
  async handleAuthorize(input: AuthorizeParams) {
    const p = authorization.parse(input);
    if (p.resource !== this.config.canonicalUri) throw new Error("Invalid resource.");
    const client = await this.db.oAuthClient.findUnique({ where: { clientId: p.clientId } });
    const metadata = client?.metadata as { redirect_uris?: string[]; grant_types?: string[] } | undefined;
    if (!metadata?.redirect_uris?.includes(p.redirectUri) || !metadata.grant_types?.includes("authorization_code"))
      throw new Error("Invalid client or redirect.");
    const scope = [...new Set(p.scope.split(/\s+/).filter((s) => SCOPES_SUPPORTED.includes(s)))].join(" ");
    const request = await this.db.oAuthAuthorizationRequest.create({
      data: {
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        resource: p.resource,
        requestedScope: scope,
        codeChallenge: p.codeChallenge,
        state: p.state,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    return { interactionId: request.id };
  }
  async consentPage(sessionToken: string, interactionId: string) {
    const session = await this.sessions.get(sessionToken);
    const interaction = await this.db.oAuthAuthorizationRequest.findUnique({
      where: { id: interactionId },
      include: { client: true },
    });
    if (!interaction || interaction.consumedAt || interaction.expiresAt.getTime() <= Date.now())
      throw new Error("Invalid interaction.");
    const challenge = await this.sessions.challenge("consent", session.sessionId, interactionId);
    return { interaction, challenge };
  }
  async consent(sessionToken: string, interactionId: string, challenge: string, approve: boolean) {
    const first = await this.sessions.get(sessionToken);
    return this.db.$transaction(async (tx) => {
      await lockUser(tx, first.userId);
      const session = await this.sessions.get(sessionToken, tx);
      await this.sessions.consumeChallenge(tx, challenge, "consent", session.sessionId, interactionId);
      const interaction = await tx.oAuthAuthorizationRequest.findUnique({ where: { id: interactionId } });
      if (!interaction) throw new Error("Invalid interaction.");
      const used = await tx.oAuthAuthorizationRequest.updateMany({
        where: { id: interactionId, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (used.count !== 1) throw new Error("Invalid interaction.");
      const redirect = new URL(interaction.redirectUri);
      redirect.searchParams.set("iss", this.config.canonicalUri);
      if (interaction.state !== null) redirect.searchParams.set("state", interaction.state);
      if (!approve) redirect.searchParams.set("error", "access_denied");
      else {
        const code = this.credentials.create("rva");
        await tx.oAuthAuthorizationCode.create({
          data: {
            codeId: code.id,
            secretHash: code.hash,
            clientId: interaction.clientId,
            userId: session.userId,
            redirectUri: interaction.redirectUri,
            resource: interaction.resource,
            scope: interaction.requestedScope,
            codeChallenge: interaction.codeChallenge,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        redirect.searchParams.set("code", code.token);
      }
      return redirect.href;
    });
  }
  async handleToken(params: TokenParams): Promise<TokenResult> {
    if (params.resource !== undefined && params.resource !== this.config.canonicalUri)
      throw new Error("Invalid grant.");
    if (params.grantType === "authorization_code") return this.exchange(params);
    if (params.grantType === "refresh_token") return this.rotate(params);
    throw new Error("Unsupported grant.");
  }
  private async exchange(p: Extract<TokenParams, { grantType: "authorization_code" }>): Promise<TokenResult> {
    const id = this.credentials.id(p.code, "rva");
    const code = id ? await this.db.oAuthAuthorizationCode.findUnique({ where: { codeId: id } }) : null;
    if (
      !code ||
      !this.credentials.matches(p.code, code.secretHash) ||
      code.clientId !== p.clientId ||
      code.redirectUri !== p.redirectUri ||
      code.resource !== this.config.canonicalUri ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(p.codeVerifier) ||
      createHash("sha256").update(p.codeVerifier).digest("base64url") !== code.codeChallenge
    )
      throw new Error("Invalid grant.");
    return this.db.$transaction(async (tx) => {
      const user = await lockUser(tx, code.userId);
      const consumed = await tx.oAuthAuthorizationCode.updateMany({
        where: { codeId: code.codeId, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) throw new Error("Invalid grant.");
      const family = await tx.oAuthFamily.create({
        data: {
          id: randomUUID(),
          clientId: code.clientId,
          userId: code.userId,
          scope: code.scope,
          resource: code.resource,
          expiresAt: new Date(Date.now() + 30 * DAY),
        },
      });
      return this.issue(tx, family, user.principal.subject);
    });
  }
  private async rotate(p: Extract<TokenParams, { grantType: "refresh_token" }>): Promise<TokenResult> {
    const id = this.credentials.id(p.refreshToken, "rvr");
    const initial = id ? await this.db.oAuthGrant.findUnique({ where: { id }, include: { family: true } }) : null;
    if (
      !initial ||
      !this.credentials.matches(p.refreshToken, initial.refreshTokenHash) ||
      initial.family.clientId !== p.clientId
    )
      throw new Error("Invalid grant.");
    const result = await this.db.$transaction(async (tx) => {
      const user = await lockUser(tx, initial.family.userId);
      await tx.$queryRawUnsafe('SELECT "id" FROM "OAuthFamily" WHERE "id" = $1 FOR UPDATE', initial.familyId);
      const grant = await tx.oAuthGrant.findUnique({
        where: { id: initial.id },
        include: { family: { include: { client: true } } },
      });
      if (
        !grant ||
        grant.revokedAt ||
        grant.family.revokedAt ||
        grant.family.expiresAt.getTime() <= Date.now() ||
        grant.expiresAt.getTime() <= Date.now()
      )
        return null;
      if (!(grant.family.client.metadata as { grant_types?: string[] }).grant_types?.includes("refresh_token"))
        return null;
      if (grant.consumedAt) {
        // Return instead of throwing: the transaction must COMMIT reuse revocation.
        await this.revokeFamily(tx, grant.familyId);
        return null;
      }
      const result = await this.issue(tx, grant.family, user.principal.subject);
      await tx.oAuthGrant.update({
        where: { id: grant.id },
        data: { consumedAt: new Date(), replacedById: this.credentials.id(result.refreshToken, "rvr")! },
      });
      return result;
    });
    if (!result) throw new Error("Invalid grant.");
    return result;
  }
  private async issue(tx: AuthDb, family: OAuthFamily, subject: string): Promise<TokenResult> {
    const refresh = this.credentials.create("rvr");
    await tx.oAuthGrant.create({
      data: { id: refresh.id, familyId: family.id, refreshTokenHash: refresh.hash, expiresAt: family.expiresAt },
    });
    const accessToken = await new SignJWT({
      scope: family.scope,
      client_id: family.clientId,
      fid: family.id,
      uid: family.userId,
      ver: 2,
    })
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setIssuer(this.config.canonicalUri)
      .setAudience(family.resource)
      .setSubject(requireSubject(subject))
      .setIssuedAt()
      .setExpirationTime("10m")
      .setJti(randomUUID())
      .sign(this.key);
    return { accessToken, tokenType: "Bearer", expiresIn: 600, refreshToken: refresh.token, scope: family.scope };
  }
  private async revokeFamily(tx: AuthDb, id: string) {
    await tx.oAuthFamily.update({ where: { id }, data: { revokedAt: new Date() } });
    await tx.oAuthGrant.updateMany({ where: { familyId: id }, data: { revokedAt: new Date() } });
  }
  async revoke(token: string, clientId: string) {
    const id = this.credentials.id(token, "rvr");
    const grant = id ? await this.db.oAuthGrant.findUnique({ where: { id }, include: { family: true } }) : null;
    if (!grant || !this.credentials.matches(token, grant.refreshTokenHash) || grant.family.clientId !== clientId)
      return;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT "id" FROM "AuthUser" WHERE "id" = $1 FOR UPDATE', grant.family.userId);
      await this.revokeFamily(tx, grant.familyId);
    });
  }
  async verifyBearer(token: string): Promise<VerifiedToken> {
    const { payload } = await jwtVerify(token, this.key, {
      algorithms: ["HS256"],
      typ: "at+jwt",
      issuer: this.config.canonicalUri,
      audience: this.config.canonicalUri,
      requiredClaims: ["sub", "iss", "aud", "iat", "exp", "jti", "client_id", "fid", "uid", "ver"],
    });
    const subject = requireSubject(payload.sub);
    if (
      payload.ver !== 2 ||
      typeof payload.fid !== "string" ||
      typeof payload.uid !== "string" ||
      typeof payload.client_id !== "string"
    )
      throw new Error("Invalid token.");
    const family = await this.db.oAuthFamily.findUnique({
      where: { id: payload.fid },
      include: { user: { include: { principal: true } } },
    });
    if (
      !family ||
      family.revokedAt ||
      family.expiresAt.getTime() <= Date.now() ||
      family.user.status !== "enabled" ||
      family.userId !== payload.uid ||
      family.user.principal.subject !== subject ||
      family.clientId !== payload.client_id ||
      payload.scope !== family.scope
    )
      throw new Error("Invalid token.");
    return { subject, scopes: family.scope.split(/\s+/).filter(Boolean), roles: [] };
  }
  async cleanup() {
    const now = new Date();
    // Retain consumed grants until absolute family expiry for reuse detection.
    await this.db.oAuthFamily.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.oAuthAuthorizationCode.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.oAuthAuthorizationRequest.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authFormChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authSession.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.db.authRateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
  }
  async profile(token: string): Promise<AuthProfile> {
    const v = await this.verifyBearer(token);
    return { subject: v.subject, roles: [] };
  }
  authorizeUrl(): string {
    throw new NotSupportedError("Use browser authorization.");
  }
  async exchangeCode(): Promise<AuthTokens> {
    throw new NotSupportedError("Use the token endpoint.");
  }
  async refresh(): Promise<AuthTokens> {
    throw new NotSupportedError("Use the token endpoint.");
  }
}
