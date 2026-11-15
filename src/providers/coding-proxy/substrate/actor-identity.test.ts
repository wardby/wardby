import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { ACTOR_JWT_AUDIENCE, createActorIdentityVerifier } from "./actor-identity.js";

const INVALID = { ok: false, code: "invalid" };

type SigningKey = Parameters<SignJWT["sign"]>[0];

type Claims = { sub: string; aud?: string; iss?: string; exp?: number | string | null };

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const verify = createActorIdentityVerifier({
    issuer: "https://idp.test",
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  // exp: omitted -> 10 minutes from now; null -> no exp claim at all.
  const mint = (claims: Claims, key: SigningKey = privateKey, alg = "ES256", kid = "k1") => {
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg, kid })
      .setSubject(claims.sub)
      .setAudience(claims.aud ?? ACTOR_JWT_AUDIENCE)
      .setIssuer(claims.iss ?? "https://idp.test")
      .setIssuedAt();
    if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? "10m");
    return jwt.sign(key);
  };
  return { verify, mint };
}

describe("actor identity", () => {
  it("accepts the paired tool actor", async () => {
    const { verify, mint } = await setup();
    const token = await mint({ sub: "actor/wardby-runs/wr-1-tool" });
    expect(await verify(`Bearer ${token}`, "actor/wardby-runs/wr-1-tool")).toEqual({
      ok: true,
      subject: "actor/wardby-runs/wr-1-tool",
    });
  });

  it("accepts the bearer scheme in any case", async () => {
    const { verify, mint } = await setup();
    const token = await mint({ sub: "x" });
    expect(await verify(`bearer ${token}`, "x")).toEqual({ ok: true, subject: "x" });
  });

  it("rejects another actor", async () => {
    const { verify, mint } = await setup();
    expect(
      await verify(`Bearer ${await mint({ sub: "actor/wardby-runs/wr-2-tool" })}`, "actor/wardby-runs/wr-1-tool"),
    ).toEqual({ ok: false, code: "wrong_subject" });
  });

  it("rejects a wrong audience", async () => {
    const { verify, mint } = await setup();
    expect(await verify(`Bearer ${await mint({ sub: "x", aud: "other" })}`, "x")).toEqual(INVALID);
  });

  it("rejects a wrong issuer", async () => {
    const { verify, mint } = await setup();
    expect(await verify(`Bearer ${await mint({ sub: "x", iss: "https://evil" })}`, "x")).toEqual(INVALID);
  });

  it("rejects an expired token", async () => {
    const { verify, mint } = await setup();
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    expect(await verify(`Bearer ${await mint({ sub: "x", exp: pastExp })}`, "x")).toEqual(INVALID);
  });

  it("rejects a token without exp", async () => {
    const { verify, mint } = await setup();
    expect(await verify(`Bearer ${await mint({ sub: "x", exp: null })}`, "x")).toEqual(INVALID);
  });

  it("rejects a token signed by a different ES256 key with kid k1", async () => {
    const { verify, mint } = await setup();
    const other = await generateKeyPair("ES256");
    expect(await verify(`Bearer ${await mint({ sub: "x" }, other.privateKey)}`, "x")).toEqual(INVALID);
  });

  it("rejects an HS256 token with kid k1", async () => {
    const { verify, mint } = await setup();
    const secret = new TextEncoder().encode("0123456789abcdef0123456789abcdef");
    expect(await verify(`Bearer ${await mint({ sub: "x" }, secret, "HS256")}`, "x")).toEqual(INVALID);
  });

  it("rejects junk", async () => {
    const { verify } = await setup();
    expect(await verify("Bearer a.b.c", "x")).toEqual(INVALID);
    expect(await verify("placeholder", "x")).toEqual({ ok: false, code: "malformed" });
    expect(await verify(undefined, "x")).toEqual({ ok: false, code: "missing" });
  });
});
