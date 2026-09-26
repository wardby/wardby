import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey, type CryptoKey } from "jose";
import { DelegatingAuthProvider, parseRoleMap } from "./delegating.js";
import { AudienceError } from "./types.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "https://host/mcp";
const KID = "test-key";

let jwks: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function mintToken(
  overrides: {
    audience?: string;
    issuer?: string;
    subject?: string;
    scope?: string;
    expiresIn?: string;
    key?: CryptoKey;
  } = {},
): Promise<string> {
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
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
    await expect(
      new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks).verifyBearer(token),
    ).rejects.toThrow();
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

  // An http(s) origin with an empty path and the same origin with "/" name one
  // resource. The protected-resource metadata advertises the "/" form while an
  // operator typically configures the IdP's audience without it, so tokens
  // legitimately arrive spelled either way and both must verify.
  it.each([
    ["configured bare, token normalized", "https://host", "https://host/"],
    ["configured normalized, token bare", "https://host/", "https://host"],
    ["configured bare, token bare", "https://host", "https://host"],
    ["configured normalized, token normalized", "https://host/", "https://host/"],
  ])("accepts equivalent audience spellings (%s)", async (_label, configured, tokenAud) => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: configured }, jwks);
    const token = await mintToken({ audience: tokenAud });
    await expect(provider.verifyBearer(token)).resolves.toMatchObject({ subject: "user-123" });
  });

  it("still rejects a different resource on the same host", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: "https://host/mcp" }, jwks);
    for (const aud of ["https://host/", "https://host/other", "https://evil-host/mcp"]) {
      await expect(provider.verifyBearer(await mintToken({ audience: aud }))).rejects.toThrow(AudienceError);
    }
  });

  it("matches an opaque non-URL audience exactly", async () => {
    const provider = new DelegatingAuthProvider({ issuer: ISSUER, audience: "wardby-api" }, jwks);
    await expect(provider.verifyBearer(await mintToken({ audience: "wardby-api" }))).resolves.toMatchObject({
      subject: "user-123",
    });
    await expect(provider.verifyBearer(await mintToken({ audience: "wardby-api/" }))).rejects.toThrow(AudienceError);
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

describe("parseRoleMap (AUTH_ROLE_MAP)", () => {
  it("parses idpValue=wardbyRole pairs, ignoring whitespace and empty entries", () => {
    const map = parseRoleMap(" wardby-admin = admin , wardby-packages=package-approver,, ");
    expect(Object.fromEntries(map)).toEqual({ "wardby-admin": ["admin"], "wardby-packages": ["package-approver"] });
  });
  it("lets one IdP value map to several roles, and splits on the last '='", () => {
    const map = parseRoleMap("ops=admin,ops=package-approver,cn=a=b=admin");
    expect(map.get("ops")).toEqual(["admin", "package-approver"]);
    expect(map.get("cn=a=b")).toEqual(["admin"]);
  });
  it.each(["wardby-admin=root", "wardby-admin=Admin", "=admin", "wardby-admin=", "wardby-admin", "", " , "])(
    "rejects %j at startup",
    (value) => expect(() => parseRoleMap(value)).toThrow(/AUTH_ROLE_MAP/),
  );
});

describe("DelegatingAuthProvider role claim (AUTH_ROLE_CLAIM / AUTH_ROLE_MAP)", () => {
  async function tokenWith(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT({ scope: "agents:read agents:admin", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("1h")
      .setSubject("user-123")
      .sign(privateKey);
  }
  const MAP = "wardby-admin=admin,wardby-packages=package-approver";
  const provider = (roleClaim?: string, roleMap: string | undefined = MAP) =>
    new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE, roleClaim, roleMap }, jwks);
  const roles = async (p: DelegatingAuthProvider, claims: Record<string, unknown>) =>
    (await p.verifyBearer(await tokenWith(claims))).wardbyRoles;

  it("Okta: top-level groups array, two groups", async () => {
    const p = provider("groups");
    expect(await roles(p, { groups: ["Everyone", "wardby-admin"] })).toEqual(["admin"]);
    expect(await roles(p, { groups: ["Everyone", "wardby-packages"] })).toEqual(["package-approver"]);
    expect((await roles(p, { groups: ["wardby-admin", "wardby-packages"] }))?.sort()).toEqual([
      "admin",
      "package-approver",
    ]);
    expect(await roles(p, { groups: ["Everyone"] })).toEqual([]);
  });

  it("FusionAuth: top-level roles array of application roles", async () => {
    const p = provider("roles", "admin=admin,package-approver=package-approver");
    expect(await roles(p, { roles: ["package-approver"] })).toEqual(["package-approver"]);
    expect(await roles(p, { roles: ["admin", "viewer"] })).toEqual(["admin"]);
  });

  it("Auth0: a namespaced URL claim name is matched exactly, never split on dots", async () => {
    const claim = "https://wardby.example/roles";
    expect(await roles(provider(claim), { [claim]: ["wardby-admin"] })).toEqual(["admin"]);
    // The exact top-level claim wins over any dotted-path reading of the same name.
    expect(
      await roles(provider(claim), { [claim]: ["other"], "https://wardby": { "example/roles": ["wardby-admin"] } }),
    ).toEqual([]);
  });

  it("Keycloak: dotted path into nested objects (realm and client roles)", async () => {
    expect(
      await roles(provider("realm_access.roles"), {
        realm_access: { roles: ["offline_access", "wardby-admin"] },
      }),
    ).toEqual(["admin"]);
    expect(
      await roles(provider("resource_access.wardby-mcp-cli.roles"), {
        resource_access: { "wardby-mcp-cli": { roles: ["wardby-packages"] } },
      }),
    ).toEqual(["package-approver"]);
  });

  it("a single string claim value is mapped too", async () => {
    expect(await roles(provider("wardby_role"), { wardby_role: "wardby-admin" })).toEqual(["admin"]);
    expect(await roles(provider("wardby_role"), { wardby_role: "wardby-admin2" })).toEqual([]);
  });

  it("missing or wrong-type claims yield no roles", async () => {
    const p = provider("roles");
    for (const claims of [
      {},
      { roles: { "wardby-admin": true } },
      { roles: 1 },
      { roles: [1, true, { admin: true }] },
      { roles: null },
    ])
      expect(await roles(p, claims)).toEqual([]);
    expect(await roles(provider("realm_access.roles"), { realm_access: "wardby-admin" })).toEqual([]);
  });

  it("without configuration every caller has no roles, whatever the token claims", async () => {
    const p = new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE }, jwks);
    expect(await roles(p, { roles: ["admin"], groups: ["wardby-admin"] })).toEqual([]);
  });

  it("refuses a half-configured or invalid role mapping at startup", () => {
    expect(() => new DelegatingAuthProvider({ issuer: ISSUER, audience: AUDIENCE, roleClaim: "roles" }, jwks)).toThrow(
      /AUTH_ROLE_CLAIM and AUTH_ROLE_MAP/,
    );
    expect(() => provider(undefined, MAP)).toThrow(/AUTH_ROLE_CLAIM and AUTH_ROLE_MAP/);
    expect(() => provider("", MAP)).toThrow(/AUTH_ROLE_CLAIM and AUTH_ROLE_MAP/);
    expect(() => provider("roles", "wardby-admin=superuser")).toThrow(/unknown role "superuser"/);
  });
});
