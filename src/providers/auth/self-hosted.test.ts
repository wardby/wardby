import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { decodeJwt, SignJWT } from "jose";
import { SelfHostedAuthProvider } from "./self-hosted.js";
import { IdentityService, DAY } from "../../mcp/auth/self-hosted/credentials.js";
import { authCommand } from "../../mcp/auth/self-hosted/cli.js";
import { PostgresRateLimiter } from "../../mcp/auth/self-hosted/rate-limit.js";

const uri = "https://reevo.example/mcp";
const signingKey = "a1".repeat(32);
const credentialHashKey = "b2".repeat(32);
const db = new PrismaClient();
const config = { canonicalUri: uri, signingKey, credentialHashKey };
const provider = new SelfHostedAuthProvider(config, db);
const identities = new IdentityService(db, credentialHashKey);
const subjects: string[] = [];
const clients: string[] = [];
async function setup() {
  const subject = "security-" + randomUUID(); subjects.push(subject);
  const user = await identities.createUser(subject);
  const client = await provider.registerClient({ redirectUris: ["https://client.example/cb?existing=1"] });
  clients.push(client.clientId);
  const challenge = await provider.sessions.challenge("login", null, "cookie:interaction");
  const session = await provider.sessions.login(user.loginKey, challenge, "cookie:interaction");
  const verifier = randomBytes(32).toString("base64url");
  const params = { clientId: client.clientId, redirectUri: "https://client.example/cb?existing=1", codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256", resource: uri, scope: "agents:read secrets:write unsupported", state: "opaque-state" };
  async function code() {
    const request = await provider.handleAuthorize(params);
    const page = await provider.consentPage(session, request.interactionId);
    const redirect = new URL(await provider.consent(session, request.interactionId, page.challenge, true));
    expect(redirect.searchParams.get("state")).toBe("opaque-state");
    return { grantType: "authorization_code" as const, clientId: client.clientId, redirectUri: params.redirectUri, code: redirect.searchParams.get("code")!, codeVerifier: verifier, resource: uri };
  }
  return { subject, user, client, session, params, code };
}

it.each(["", "a".repeat(32), "zz".repeat(32)])("rejects invalid signing keys %s", (key) => {
  expect(() => new SelfHostedAuthProvider({ ...config, signingKey: key }, db)).toThrow();
});
it("rejects reused credential/signing keys", () => expect(() => new SelfHostedAuthProvider({ ...config, credentialHashKey: signingKey }, db)).toThrow());
it("advertises only public S256 clients", () => {
  expect(provider.asMetadata().token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(provider.asMetadata().code_challenge_methods_supported).toEqual(["S256"]);
});

describe.skipIf(!process.env.DATABASE_URL)("secure self-hosted OAuth (PostgreSQL)", () => {
  afterAll(async () => {
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clients } } });
    await db.authUser.deleteMany({ where: { principal: { subject: { in: subjects } } } });
    await db.principal.deleteMany({ where: { subject: { in: subjects } } });
    await db.$disconnect();
  });
  it("provisions a key once through the CLI and lists no credential hashes", async () => {
    const subject = "cli-security-" + randomUUID(); subjects.push(subject);
    const lines: string[] = [];
    await authCommand(["user", "create", "--subject", subject], db, credentialHashKey, (s) => lines.push(s));
    expect(lines).toHaveLength(1);
    const { loginKey } = JSON.parse(lines[0]) as { loginKey: string };
    expect(loginKey).toMatch(/^rvk_/);
    const list = await identities.listKeys(subject);
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(loginKey);
    expect(JSON.stringify(list)).not.toContain("secretHash");
  });
  it.each(["client_secret_post", "client_secret_basic", "private_key_jwt"])("rejects confidential method %s", async (method) => {
    await expect(provider.registerClient({ redirectUris: ["https://client.example/cb"], tokenEndpointAuthMethod: method })).rejects.toThrow();
  });
  it.each(["http://public.example/cb", "https://user:password@client/cb", "https://client/cb#fragment", "javascript:alert(1)"])("rejects redirect %s", async (redirect) => {
    await expect(provider.registerClient({ redirectUris: [redirect] })).rejects.toThrow();
  });
  it("session identity alone chooses the subject, and only consent yields a code", async () => {
    const f = await setup();
    await expect(provider.handleAuthorize({ ...f.params, subject: "victim" } as typeof f.params)).rejects.toThrow();
    await expect(provider.consentPage("", (await provider.handleAuthorize(f.params)).interactionId)).rejects.toThrow();
    const token = await provider.handleToken(await f.code());
    expect(await provider.verifyBearer(token.accessToken)).toMatchObject({ subject: f.subject, scopes: ["agents:read", "secrets:write"] });
    expect(decodeJwt(token.accessToken)).toMatchObject({ iss: uri, aud: uri, sub: f.subject, client_id: f.client.clientId, ver: 2 });
    expect(decodeJwt(token.accessToken).exp! - decodeJwt(token.accessToken).iat!).toBe(600);
  });
  it("atomically consumes a code under concurrent and subsequent redemption", async () => {
    const f = await setup(); const grant = await f.code();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => provider.handleToken(grant)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(provider.handleToken(grant)).rejects.toThrow();
  });
  it("rejects PKCE, client, redirect, resource, and expired code substitution", async () => {
    const f = await setup(); const grant = await f.code();
    for (const overrides of [{ codeVerifier: "x".repeat(43) }, { clientId: "other" }, { redirectUri: "https://client.example/cb" }, { resource: "https://other/mcp" }]) await expect(provider.handleToken({ ...grant, ...overrides })).rejects.toThrow();
    await db.oAuthAuthorizationCode.update({ where: { codeId: provider.credentials.id(grant.code, "rva") }, data: { expiresAt: new Date(0) } });
    await expect(provider.handleToken(grant)).rejects.toThrow();
  });
  it("rejects plain PKCE and exact redirect mismatches", async () => {
    const f = await setup();
    await expect(provider.handleAuthorize({ ...f.params, codeChallengeMethod: "plain" })).rejects.toThrow();
    await expect(provider.handleAuthorize({ ...f.params, redirectUri: "https://client.example/cb?existing=2" })).rejects.toThrow();
  });
  it("denial consumes interaction without issuing code; CSRF cannot be replayed or swapped", async () => {
    const f = await setup(); const a = await provider.handleAuthorize(f.params); const b = await provider.handleAuthorize(f.params);
    const page = await provider.consentPage(f.session, a.interactionId);
    await expect(provider.consent(f.session, b.interactionId, page.challenge, true)).rejects.toThrow();
    const denied = new URL(await provider.consent(f.session, a.interactionId, page.challenge, false));
    expect(denied.searchParams.get("error")).toBe("access_denied"); expect(denied.searchParams.has("code")).toBe(false);
    await expect(provider.consent(f.session, a.interactionId, page.challenge, true)).rejects.toThrow();
  });
  it("stores only hashes and rotates refresh tokens with reuse revoking replacements and access", async () => {
    const f = await setup(); const code = await f.code(); const first = await provider.handleToken(code);
    const refresh = { grantType: "refresh_token" as const, clientId: f.client.clientId, refreshToken: first.refreshToken };
    const next = await provider.handleToken(refresh);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    const row = await db.oAuthGrant.findUniqueOrThrow({ where: { id: provider.credentials.id(first.refreshToken, "rvr") } });
    expect(row.refreshTokenHash).toHaveLength(64); expect(row.consumedAt).not.toBeNull();
    const rows = await db.authLoginKey.findMany({ where: { userId: f.user.userId } });
    expect(JSON.stringify(rows)).not.toContain(f.user.loginKey);
    expect(JSON.stringify(row)).not.toContain(first.refreshToken);
    await expect(provider.handleToken(refresh)).rejects.toThrow();
    await expect(provider.handleToken({ ...refresh, refreshToken: next.refreshToken })).rejects.toThrow();
    await expect(provider.verifyBearer(next.accessToken)).rejects.toThrow();
  });
  it("concurrent refresh permits one winner and commits family revocation", async () => {
    const f = await setup(); const first = await provider.handleToken(await f.code());
    const p = { grantType: "refresh_token" as const, clientId: f.client.clientId, refreshToken: first.refreshToken };
    const result = await Promise.allSettled(Array.from({ length: 4 }, () => provider.handleToken(p)));
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const family = await db.oAuthFamily.findUniqueOrThrow({ where: { id: decodeJwt(first.accessToken).fid as string } });
    expect(family.revokedAt).not.toBeNull();
  });
  it("rejects wrong-client refresh without revoking the legitimate family", async () => {
    const f = await setup(); const first = await provider.handleToken(await f.code());
    await expect(provider.handleToken({ grantType: "refresh_token", clientId: "other", refreshToken: first.refreshToken })).rejects.toThrow();
    await expect(provider.verifyBearer(first.accessToken)).resolves.toMatchObject({ subject: f.subject });
    await provider.revoke(first.refreshToken, f.client.clientId);
    await expect(provider.verifyBearer(first.accessToken)).rejects.toThrow();
  });
  it("login rejects stolen challenges, replay, key alteration, expiry, revocation, and disabled users", async () => {
    const f = await setup();
    const challenge = await provider.sessions.challenge("login", null, "cookie");
    await expect(provider.sessions.login(f.user.loginKey, challenge, "other-cookie")).rejects.toThrow();
    const fresh = await provider.sessions.login(f.user.loginKey, challenge, "cookie", f.session);
    await expect(provider.sessions.get(f.session)).rejects.toThrow();
    await expect(provider.sessions.login(f.user.loginKey, challenge, "cookie")).rejects.toThrow();
    const wrong = await provider.sessions.challenge("login", null, "cookie");
    await expect(provider.sessions.login(f.user.loginKey + "x", wrong, "cookie")).rejects.toThrow();
    await db.authLoginKey.updateMany({ where: { userId: f.user.userId }, data: { expiresAt: new Date(0) } });
    await expect(provider.sessions.login(f.user.loginKey, await provider.sessions.challenge("login", null, "cookie"), "cookie")).rejects.toThrow();
    const replacement = await identities.createKey(f.subject);
    await identities.revokeKey(provider.credentials.id(replacement, "rvk")!);
    await expect(provider.sessions.login(replacement, await provider.sessions.challenge("login", null, "cookie"), "cookie")).rejects.toThrow();
    await identities.disableUser(f.subject);
    await expect(provider.sessions.get(fresh)).rejects.toThrow();
    await expect(identities.createKey(f.subject)).rejects.toThrow();
  });
  it("rejects tampered, idle, and expired sessions; logout invalidates before reuse", async () => {
    const f = await setup();
    await expect(provider.sessions.get(f.session + "x")).rejects.toThrow();
    const session = await provider.sessions.get(f.session);
    const challenge = await provider.sessions.challenge("logout", session.sessionId, "logout");
    await provider.sessions.logout(f.session, challenge);
    await expect(provider.sessions.get(f.session)).rejects.toThrow();
    for (const data of [{ lastSeenAt: new Date(Date.now() - DAY) }, { expiresAt: new Date(0) }]) {
      const s = await provider.sessions.login(f.user.loginKey, await provider.sessions.challenge("login", null, "new"), "new");
      await db.authSession.update({ where: { sessionId: provider.credentials.id(s, "rvs") }, data });
      await expect(provider.sessions.get(s)).rejects.toThrow();
    }
  });
  it("rejects legacy signed tokens even when the old signing key is retained", async () => {
    const legacy = await new SignJWT({ scope: "agents:read" }).setProtectedHeader({ alg: "HS256" }).setIssuer(uri).setAudience(uri).setSubject("victim").setExpirationTime("1h").sign(Buffer.from(signingKey, "hex"));
    await expect(provider.verifyBearer(legacy)).rejects.toThrow();
  });
  it("shares login throttles across limiter instances", async () => {
    const a = new PostgresRateLimiter(db, provider.credentials); const b = new PostgresRateLimiter(db, provider.credentials); const id = randomUUID();
    await a.check("test", id, 1); await expect(b.check("test", id, 1)).rejects.toThrow(/Rate limited/);
  });
});
