import { describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { ACTOR_JWT_AUDIENCE, createActorIdentityVerifier } from "./actor-identity.js";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const verify = createActorIdentityVerifier({
    issuer: "https://idp.test",
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  const mint = (claims: { sub: string; aud?: string; iss?: string; exp?: string }) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setSubject(claims.sub)
      .setAudience(claims.aud ?? ACTOR_JWT_AUDIENCE)
      .setIssuer(claims.iss ?? "https://idp.test")
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? "10m")
      .sign(privateKey);
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

  it("rejects another actor, a wrong audience, a wrong issuer and junk", async () => {
    const { verify, mint } = await setup();
    expect(
      await verify(`Bearer ${await mint({ sub: "actor/wardby-runs/wr-2-tool" })}`, "actor/wardby-runs/wr-1-tool"),
    ).toEqual({ ok: false, code: "wrong_subject" });
    expect((await verify(`Bearer ${await mint({ sub: "x", aud: "other" })}`, "x")).ok).toBe(false);
    expect((await verify(`Bearer ${await mint({ sub: "x", iss: "https://evil" })}`, "x")).ok).toBe(false);
    expect(await verify("Bearer a.b.c", "x")).toEqual({ ok: false, code: "invalid" });
    expect(await verify("placeholder", "x")).toEqual({ ok: false, code: "malformed" });
    expect(await verify(undefined, "x")).toEqual({ ok: false, code: "missing" });
  });
});
