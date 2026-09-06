import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey, type CryptoKey } from "jose";
import { DelegatingAuthProvider } from "./delegating.js";
import { AudienceError } from "./types.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://host/mcp";
const KID = "test-key";

let jwks: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function mintToken(overrides: {
  audience?: string;
  issuer?: string;
  subject?: string;
  scope?: string;
  expiresIn?: string;
  key?: CryptoKey;
} = {}): Promise<string> {
  return new SignJWT({ scope: overrides.scope ?? "agents:read agents:write" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime(overrides.expiresIn ?? "1h")
    .setSubject(overrides.subject ?? "user-123")
    .sign(overrides.key ?? privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: sk } = await generateKeyPair("RS256", { extractable: true });
  privateKey = sk;
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "RS256";
  jwks = createLocalJWKSet({ keys: [jwk] });
});

describe("DelegatingAuthProvider.verifyBearer", () => {
  it.each([undefined, null, 123, "", "  ", "a".repeat(513)])("rejects signed invalid subjects %j", async (sub) => {
    const token = await new SignJWT({ sub: sub as string, scope: "agents:read" })
      .setProtectedHeader({ alg: "RS256", kid: KID }).setIssuer(ISSUER).setAudience(AUDIENCE)
      .setExpirationTime("1h").sign(privateKey);
    await expect(new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks).verifyBearer(token)).rejects.toThrow();
  });
  it("maps a valid signed token to a VerifiedToken", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    const token = await mintToken({ scope: "agents:read agents:write" });
    const profile = await provider.verifyBearer(token);
    expect(profile.subject).toBe("user-123");
    expect(profile.scopes.sort()).toEqual(["agents:read", "agents:write"]);
    expect(profile.roles).toEqual([]);
  });

  it("throws AudienceError on wrong audience", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    const token = await mintToken({ audience: "https://someone-else/mcp" });
    await expect(provider.verifyBearer(token)).rejects.toThrow(AudienceError);
  });

  it("throws on an expired token", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    const token = await mintToken({ expiresIn: "-1h" });
    await expect(provider.verifyBearer(token)).rejects.toThrow();
  });

  it("throws on a bad signature", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    const { privateKey: otherKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await mintToken({ key: otherKey });
    await expect(provider.verifyBearer(token)).rejects.toThrow();
  });
});

describe("DelegatingAuthProvider auth-code flow", () => {
  it("authorizeUrl/exchangeCode/refresh throw NotSupported (resource-server-only)", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    expect(() => provider.authorizeUrl("state", "https://client/callback")).toThrow();
    await expect(provider.exchangeCode("code", "https://client/callback")).rejects.toThrow();
    await expect(provider.refresh("refresh-token")).rejects.toThrow();
  });
});
