import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { SelfHostedAuthProvider } from "./self-hosted.js";

// registerClient/handleAuthorize/handleToken persist OAuthClient/OAuthGrant
// rows — run against a real local Postgres, skipped without DATABASE_URL
// (same pattern as lease.test.ts / Phase 2). No real HTTP involved: this
// exercises the AS methods directly, as Task 7's HTTP layer will call them.
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[reevo-run tests] DATABASE_URL not set — skipping SelfHostedAuthProvider PKCE/DCR tests " +
      "(OAuthClient/OAuthGrant persistence). Set DATABASE_URL before trusting an auth change " +
      "based on a green run that skipped it.",
  );
}

const CANONICAL_URI = "https://host/mcp";
const SIGNING_KEY = "s".repeat(32);

function pkcePair() {
  const codeVerifier = randomUUID() + randomUUID();
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

describe.skipIf(!databaseUrl)("SelfHostedAuthProvider (database)", () => {
  const db = new PrismaClient();
  const usedClientIds: string[] = [];

  afterAll(async () => {
    await db.oAuthGrant.deleteMany({ where: { clientId: { in: usedClientIds } } });
    await db.oAuthClient.deleteMany({ where: { clientId: { in: usedClientIds } } });
    await db.$disconnect();
  });

  function newProvider() {
    return new SelfHostedAuthProvider({ canonicalUri: CANONICAL_URI, signingKey: SIGNING_KEY }, db);
  }

  it("asMetadata() carries RFC 8414 fields incl. authorization_response_iss_parameter_supported", () => {
    const provider = newProvider();
    const meta = provider.asMetadata();
    expect(meta.issuer).toBe(CANONICAL_URI);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.code_challenge_methods_supported).toContain("S256");
  });

  it("registerClient stores an OAuthClient and returns a public client (no secret)", async () => {
    const provider = newProvider();
    const client = await provider.registerClient({
      redirectUris: ["https://client.example/callback"],
      clientName: "test-client",
      tokenEndpointAuthMethod: "none",
    });
    usedClientIds.push(client.clientId);
    expect(client.clientId).toBeTruthy();
    expect(client.clientSecret).toBeUndefined();
    const stored = await db.oAuthClient.findUnique({ where: { clientId: client.clientId } });
    expect(stored).not.toBeNull();
  });

  it("full PKCE flow: authorize -> token -> verifyBearer", async () => {
    const provider = newProvider();
    const client = await provider.registerClient({
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    usedClientIds.push(client.clientId);
    const { codeVerifier, codeChallenge } = pkcePair();

    const authResult = await provider.handleAuthorize({
      clientId: client.clientId,
      redirectUri: "https://client.example/callback",
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: "agents:read agents:write",
      resource: CANONICAL_URI,
      subject: "user-abc",
    });
    expect(authResult.iss).toBe(CANONICAL_URI);

    const tokenResult = await provider.handleToken({
      grantType: "authorization_code",
      code: authResult.code,
      codeVerifier,
      redirectUri: "https://client.example/callback",
      clientId: client.clientId,
    });
    expect(tokenResult.tokenType).toBe("Bearer");
    expect(tokenResult.refreshToken).toBeTruthy();

    const profile = await provider.verifyBearer(tokenResult.accessToken);
    expect(profile.subject).toBe("user-abc");
    expect(profile.scopes.sort()).toEqual(["agents:read", "agents:write"]);
  });

  it("wrong code_verifier is rejected", async () => {
    const provider = newProvider();
    const client = await provider.registerClient({
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    usedClientIds.push(client.clientId);
    const { codeChallenge } = pkcePair();

    const authResult = await provider.handleAuthorize({
      clientId: client.clientId,
      redirectUri: "https://client.example/callback",
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: "agents:read",
      resource: CANONICAL_URI,
      subject: "user-abc",
    });

    await expect(
      provider.handleToken({
        grantType: "authorization_code",
        code: authResult.code,
        codeVerifier: "not-the-right-verifier",
        redirectUri: "https://client.example/callback",
        clientId: client.clientId,
      }),
    ).rejects.toThrow();
  });

  it("expired refresh-token grant is rejected", async () => {
    const provider = newProvider();
    const client = await provider.registerClient({
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    usedClientIds.push(client.clientId);

    const grant = await db.oAuthGrant.create({
      data: {
        clientId: client.clientId,
        principalId: "user-abc",
        scope: "agents:read",
        refreshToken: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(
      provider.handleToken({ grantType: "refresh_token", refreshToken: grant.refreshToken!, clientId: client.clientId }),
    ).rejects.toThrow();
  });

  it("issued access token's audience is the requested resource", async () => {
    const provider = newProvider();
    const client = await provider.registerClient({
      redirectUris: ["https://client.example/callback"],
      tokenEndpointAuthMethod: "none",
    });
    usedClientIds.push(client.clientId);
    const { codeVerifier, codeChallenge } = pkcePair();

    const authResult = await provider.handleAuthorize({
      clientId: client.clientId,
      redirectUri: "https://client.example/callback",
      codeChallenge,
      codeChallengeMethod: "S256",
      scope: "agents:read",
      resource: CANONICAL_URI,
      subject: "user-abc",
    });
    const tokenResult = await provider.handleToken({
      grantType: "authorization_code",
      code: authResult.code,
      codeVerifier,
      redirectUri: "https://client.example/callback",
      clientId: client.clientId,
    });

    // A different SelfHostedAuthProvider configured with a different canonical
    // URI (different audience) must refuse this token.
    const wrongAudienceProvider = new SelfHostedAuthProvider(
      { canonicalUri: "https://someone-else/mcp", signingKey: SIGNING_KEY },
      db,
    );
    await expect(wrongAudienceProvider.verifyBearer(tokenResult.accessToken)).rejects.toThrow();
  });
});
