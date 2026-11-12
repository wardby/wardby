import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test-support/fake-oauth-server.test-support.js";
import { discoverOAuth, type OAuthMetadata } from "./discovery.js";
import { OAuthProtocolError } from "./http.js";
import { buildAuthorizeUrl, exchangeCode, refreshTokens, registerClient, revokeToken } from "./tokens.js";

const warned = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    vi.spyOn(log, "warn").mockImplementation(warned);
    return log;
  });
  return real;
});

const opts = { privateHostAllowlist: ["127.0.0.1"] };
const REDIRECT = "http://127.0.0.1:9999/callback";

interface Recorded {
  method: string;
  path: string;
  contentType: string;
  authorization: string;
  body: string;
}
let servers: Server[] = [];
let fake: FakeOAuthServer | undefined;

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
  await fake?.close();
  fake = undefined;
});

async function stub(status: number, reply: unknown): Promise<{ url: string; log: Recorded[] }> {
  const log: Recorded[] = [];
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      log.push({
        method: req.method ?? "",
        path: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        authorization: req.headers.authorization ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, log };
}

function meta(base: string, extra: Partial<OAuthMetadata> = {}): OAuthMetadata {
  return {
    resource: "https://mcp.example.com/mcp",
    issuer: base,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    registrationEndpoint: `${base}/register`,
    revocationEndpoint: `${base}/revoke`,
    ...extra,
  };
}

describe("registerClient", () => {
  it("posts the public-client registration body and returns the client id", async () => {
    const s = await stub(201, { client_id: "cid-1" });
    const client = await registerClient(meta(s.url), REDIRECT, opts);
    expect(client).toEqual({ clientId: "cid-1" });
    expect(s.log[0]?.contentType).toBe("application/json");
    expect(JSON.parse(s.log[0]?.body ?? "")).toEqual({
      client_name: "Wardby",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("keeps a client_secret when the provider issues one", async () => {
    const s = await stub(201, { client_id: "cid-2", client_secret: "shh" });
    expect(await registerClient(meta(s.url), REDIRECT, opts)).toEqual({ clientId: "cid-2", clientSecret: "shh" });
  });

  it("fails with registration_failed without an endpoint, on refusal, or on a bad body", async () => {
    const none = meta("http://127.0.0.1:1", { registrationEndpoint: undefined });
    await expect(registerClient(none, REDIRECT, opts)).rejects.toMatchObject({ code: "registration_failed" });
    const refused = await stub(400, { error: "invalid_redirect_uri", error_description: "SECRET-TEXT" });
    const err = await registerClient(meta(refused.url), REDIRECT, opts).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "registration_failed" });
    expect((err as Error).message).not.toContain("SECRET-TEXT");
    const bad = await stub(201, { nope: true });
    await expect(registerClient(meta(bad.url), REDIRECT, opts)).rejects.toMatchObject({ code: "registration_failed" });
  });

  it("names the RFC 7591 error code and status, keeps the description out of the error, bounds it in the log", async () => {
    const long = `${"x".repeat(400)}`;
    const refused = await stub(400, {
      error: "invalid_redirect_uri",
      error_description: `bad\u0007 uri SECRET-TEXT ${long}`,
    });
    warned.mockClear();
    const err = (await registerClient(meta(refused.url), REDIRECT, opts).catch(
      (e: unknown) => e,
    )) as OAuthProtocolError;
    expect(err).toMatchObject({
      code: "registration_failed",
      registration: { status: 400, providerError: "invalid_redirect_uri" },
    });
    expect(JSON.stringify(err.registration)).not.toContain("SECRET-TEXT");
    expect(err.message).not.toContain("SECRET-TEXT");
    const [fields] = warned.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      host: "127.0.0.1",
      status: 400,
      error: "invalid_redirect_uri",
      reason: "registration_failed",
    });
    const description = fields.description as string;
    expect(description).toContain("SECRET-TEXT");
    expect(description.length).toBe(300);
    expect(description).not.toContain("\u0007");
  });

  it("drops an error code that is not a short snake_case token", async () => {
    const s = await stub(400, { error: "Bad <script>", error_description: "d" });
    const err = (await registerClient(meta(s.url), REDIRECT, opts).catch((e: unknown) => e)) as OAuthProtocolError;
    expect(err.registration).toEqual({ status: 400 });
  });

  it("carries only the status for a 403 HTML body", async () => {
    const s = await stub(403, "<html>Forbidden SECRET-TEXT</html>");
    const err = (await registerClient(meta(s.url), REDIRECT, opts).catch((e: unknown) => e)) as OAuthProtocolError;
    expect(err.registration).toEqual({ status: 403 });
    expect(JSON.stringify(err)).not.toContain("SECRET-TEXT");
  });

  it("reports a reply without client_id with its status", async () => {
    const s = await stub(201, { token_endpoint_auth_method: "none" });
    const err = (await registerClient(meta(s.url), REDIRECT, opts).catch((e: unknown) => e)) as OAuthProtocolError;
    expect(err).toMatchObject({ code: "registration_failed", registration: { status: 201 } });
  });

  it("names a known unsupported auth method, else 'unsupported', and ignores unknown fields", async () => {
    const jwt = await stub(201, { client_id: "c", token_endpoint_auth_method: "private_key_jwt" });
    await expect(registerClient(meta(jwt.url), REDIRECT, opts)).rejects.toMatchObject({
      registration: { authMethod: "private_key_jwt" },
    });
    const odd = await stub(201, { client_id: "c", token_endpoint_auth_method: "SECRET-TEXT" });
    const err = (await registerClient(meta(odd.url), REDIRECT, opts).catch((e: unknown) => e)) as OAuthProtocolError;
    expect(err.registration).toEqual({ status: 201, authMethod: "unsupported" });
    const extra = await stub(201, { client_id: "c", something_new: { a: 1 } });
    expect(await registerClient(meta(extra.url), REDIRECT, opts)).toEqual({ clientId: "c" });
  });

  it("gives provider_unavailable on 5xx, 429 or a network error at the registration endpoint", async () => {
    for (const status of [503, 429]) {
      const s = await stub(status, "down");
      await expect(registerClient(meta(s.url), REDIRECT, opts)).rejects.toMatchObject({
        code: "provider_unavailable",
      });
    }
    await expect(registerClient(meta("http://127.0.0.1:1"), REDIRECT, opts)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("registers against the fake server", async () => {
    fake = await startFakeOAuthServer();
    const m = await discoverOAuth(fake.mcpUrl, opts);
    const c = await registerClient(m, REDIRECT, opts);
    expect(c.clientId).toMatch(/^fake-client-/);
  });
});

describe("buildAuthorizeUrl", () => {
  it("carries the PKCE and resource parameters", () => {
    const m = meta("https://auth.example.com");
    const u = new URL(
      buildAuthorizeUrl(
        m,
        { clientId: "cid" },
        { state: "st", codeChallenge: "ch", redirectUri: REDIRECT, scope: "read write" },
      ),
    );
    expect(u.origin + u.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      resource: "https://mcp.example.com/mcp",
      scope: "read write",
    });
  });

  it("omits scope when none is given and keeps existing query parameters", () => {
    const m = meta("https://auth.example.com", { authorizationEndpoint: "https://auth.example.com/a?tenant=1" });
    const u = new URL(
      buildAuthorizeUrl(m, { clientId: "cid" }, { state: "s", codeChallenge: "c", redirectUri: REDIRECT }),
    );
    expect(u.searchParams.has("scope")).toBe(false);
    expect(u.searchParams.get("tenant")).toBe("1");
  });
});

describe("exchangeCode", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("sends code, verifier, redirect, resource and client id; computes expiresAt", async () => {
    const s = await stub(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "read" });
    const t = await exchangeCode(
      meta(s.url),
      { clientId: "cid", clientSecret: "sec" },
      { code: "c1", codeVerifier: "v1", redirectUri: REDIRECT },
      opts,
      undefined,
      now,
    );
    expect(t).toEqual({
      accessToken: "AT",
      refreshToken: "RT",
      expiresAt: new Date(now.getTime() + 3600_000),
      scope: "read",
    });
    expect(s.log[0]?.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(s.log[0]?.body))).toEqual({
      grant_type: "authorization_code",
      code: "c1",
      code_verifier: "v1",
      redirect_uri: REDIRECT,
      client_id: "cid",
      client_secret: "sec",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("gives expiresAt null without expires_in and omits client_secret for public clients", async () => {
    const s = await stub(200, { access_token: "AT" });
    const t = await exchangeCode(
      meta(s.url),
      { clientId: "cid" },
      { code: "c", codeVerifier: "v", redirectUri: REDIRECT },
      opts,
    );
    expect(t).toEqual({ accessToken: "AT", expiresAt: null });
    expect(new URLSearchParams(s.log[0]?.body).has("client_secret")).toBe(false);
  });

  it("accepts a numeric-string expires_in and clamps a huge one to a year", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const args = [{ clientId: "cid" }, { code: "c", codeVerifier: "v", redirectUri: REDIRECT }] as const;
    const a = await stub(200, { access_token: "AT", expires_in: "3600" });
    expect((await exchangeCode(meta(a.url), ...args, opts, undefined, now)).expiresAt).toEqual(
      new Date(now.getTime() + 3600_000),
    );
    const b = await stub(200, { access_token: "AT", expires_in: 1e12 });
    expect((await exchangeCode(meta(b.url), ...args, opts, undefined, now)).expiresAt).toEqual(
      new Date(now.getTime() + 31_536_000 * 1000),
    );
  });

  it.each([{ expires_in: "soon" }, { expires_in: 0 }, { expires_in: -5 }, { expires_in: "-5" }])(
    "rejects an unusable expires_in %j as bad_response",
    async (extra) => {
      const s = await stub(200, { access_token: "AT", ...extra });
      await expect(
        exchangeCode(meta(s.url), { clientId: "cid" }, { code: "c", codeVerifier: "v", redirectUri: REDIRECT }, opts),
      ).rejects.toMatchObject({ code: "bad_response" });
    },
  );

  it("rejects a response without an access token as bad_response", async () => {
    const s = await stub(200, { token_type: "Bearer" });
    await expect(
      exchangeCode(meta(s.url), { clientId: "cid" }, { code: "c", codeVerifier: "v", redirectUri: REDIRECT }, opts),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("completes a full flow against the fake server", async () => {
    fake = await startFakeOAuthServer();
    const m = await discoverOAuth(fake.mcpUrl, opts);
    const client = await registerClient(m, REDIRECT, opts);
    const verifier = "v".repeat(50);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = buildAuthorizeUrl(m, client, { state: "s", codeChallenge: challenge, redirectUri: REDIRECT });
    const cb = new URL(await fake.approve(url));
    const t = await exchangeCode(
      m,
      client,
      { code: cb.searchParams.get("code") ?? "", codeVerifier: verifier, redirectUri: REDIRECT },
      opts,
    );
    expect(t.accessToken).toMatch(/^fake-access-/);
    const r = await refreshTokens(m, client, t.refreshToken ?? "", opts);
    expect(r.refreshToken).not.toBe(t.refreshToken);
  });
});

describe("refreshTokens", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("sends refresh_token, client id/secret and resource; no refresh_token in reply keeps none", async () => {
    const s = await stub(200, { access_token: "AT2", expires_in: 60 });
    const t = await refreshTokens(
      meta(s.url),
      { clientId: "cid", clientSecret: "sec" },
      "RT-old",
      opts,
      undefined,
      now,
    );
    expect(t).toEqual({ accessToken: "AT2", expiresAt: new Date(now.getTime() + 60_000) });
    expect(t.refreshToken).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(s.log[0]?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "RT-old",
      client_id: "cid",
      client_secret: "sec",
      resource: "https://mcp.example.com/mcp",
    });
  });

  it("maps invalid_grant without leaking the echoed refresh token anywhere on the error", async () => {
    fake = await startFakeOAuthServer();
    const m = await discoverOAuth(fake.mcpUrl, opts);
    const err = await refreshTokens(m, { clientId: "x" }, "fake-refresh-BBBB", opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthProtocolError);
    expect((err as OAuthProtocolError).code).toBe("invalid_grant");
    const e = err as Error;
    const everything = [
      e.message,
      e.stack ?? "",
      JSON.stringify(e.cause ?? null),
      JSON.stringify(e, Object.getOwnPropertyNames(e)),
      ...Object.values(e).map((v) => JSON.stringify(v) ?? ""),
    ].join("\n");
    expect(everything).not.toContain("fake-refresh-BBBB");
    expect(e.cause).toBeUndefined();
  });

  it("maps invalid_client, 5xx and network failure", async () => {
    const c = await stub(401, { error: "invalid_client", error_description: "LEAK" });
    const e1 = await refreshTokens(meta(c.url), { clientId: "c" }, "r", opts).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: "invalid_client" });
    expect((e1 as Error).message).not.toContain("LEAK");
    const five = await stub(503, "down");
    await expect(refreshTokens(meta(five.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(refreshTokens(meta("http://127.0.0.1:1"), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  it("treats 429 as provider_unavailable, on refresh and on revoke", async () => {
    const s = await stub(429, { error: "slow_down" });
    await expect(refreshTokens(meta(s.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(
      revokeToken({ revocationEndpoint: `${s.url}/revoke` }, { clientId: "c" }, "t", "refresh_token", opts),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("treats a 401 or 403 without an invalid_client error as bad_response", async () => {
    for (const [status, reply] of [
      [401, { error: "unauthorized" }],
      [401, "<html>nope</html>"],
      [403, {}],
    ] as const) {
      const s = await stub(status, reply);
      await expect(refreshTokens(meta(s.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
        code: "bad_response",
      });
    }
  });

  it("maps a 400 invalid_client to invalid_client", async () => {
    const s = await stub(400, { error: "invalid_client" });
    await expect(refreshTokens(meta(s.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "invalid_client",
    });
  });

  it("maps invalid_target (a resource the server does not know) to a fixed bad_response without the provider text", async () => {
    fake = await startFakeOAuthServer();
    const m = await discoverOAuth(fake.mcpUrl, opts);
    const err = await refreshTokens(
      { ...m, resource: `${fake.url}/not-this-resource` },
      { clientId: "x" },
      "fake-refresh-CCCC",
      opts,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthProtocolError);
    expect((err as OAuthProtocolError).code).toBe("bad_response");
    expect((err as Error).message).toBe("The OAuth provider refused the token request.");
    expect((err as Error).cause).toBeUndefined();
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toMatch(/unknown resource|invalid_target|CCCC/);
    // The server rejected it before looking at the refresh token.
    expect(fake.tokenRequests).toBe(0);
  });

  it("treats an unrecognised 4xx as bad_response", async () => {
    const s = await stub(400, { error: "weird" });
    await expect(refreshTokens(meta(s.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "bad_response",
    });
  });
});

describe("revokeToken", () => {
  it("is a no-op without an endpoint", async () => {
    await expect(revokeToken({}, { clientId: "c" }, "t", "refresh_token", opts)).resolves.toBeUndefined();
  });

  it("posts token, hint and client credentials", async () => {
    const s = await stub(200, "");
    await revokeToken(
      { revocationEndpoint: `${s.url}/revoke` },
      { clientId: "c", clientSecret: "s" },
      "tok",
      "access_token",
      opts,
    );
    expect(s.log[0]?.path).toBe("/revoke");
    expect(Object.fromEntries(new URLSearchParams(s.log[0]?.body))).toEqual({
      token: "tok",
      token_type_hint: "access_token",
      client_id: "c",
      client_secret: "s",
    });
  });

  it("succeeds when a 200 revocation response carries a text body", async () => {
    const s = await stub(200, "OK");
    await expect(
      revokeToken({ revocationEndpoint: `${s.url}/revoke` }, { clientId: "c" }, "t", "refresh_token", opts),
    ).resolves.toBeUndefined();
  });

  it("still rejects a non-JSON 200 body on a non-revocation call", async () => {
    const s = await stub(200, "OK");
    await expect(refreshTokens(meta(s.url), { clientId: "c" }, "r", opts)).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  it("throws provider_unavailable on a 5xx and revokes on the fake server", async () => {
    const five = await stub(500, "x");
    await expect(
      revokeToken({ revocationEndpoint: `${five.url}/revoke` }, { clientId: "c" }, "t", "refresh_token", opts),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    fake = await startFakeOAuthServer();
    const m = await discoverOAuth(fake.mcpUrl, opts);
    await revokeToken(m, { clientId: "c" }, "fake-refresh-1", "refresh_token", opts);
    expect(fake.revoked.has("fake-refresh-1")).toBe(true);
  });
});

describe("token endpoint client authentication", () => {
  const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body));
  const input = { code: "c1", codeVerifier: "v1", redirectUri: REDIRECT };

  it("records the registered token_endpoint_auth_method", async () => {
    for (const method of ["none", "client_secret_post", "client_secret_basic"] as const) {
      const s = await stub(201, { client_id: "cid", client_secret: "sec", token_endpoint_auth_method: method });
      expect(await registerClient(meta(s.url), REDIRECT, opts)).toEqual({
        clientId: "cid",
        clientSecret: "sec",
        authMethod: method,
      });
    }
  });

  it("refuses a registration whose auth method wardby cannot use", async () => {
    const s = await stub(201, { client_id: "cid", token_endpoint_auth_method: "private_key_jwt" });
    await expect(registerClient(meta(s.url), REDIRECT, opts)).rejects.toMatchObject({ code: "registration_failed" });
  });

  it("client_secret_basic: sends the secret by HTTP Basic, not in the form", async () => {
    const s = await stub(200, { access_token: "AT" });
    const client = { clientId: "c id", clientSecret: "s:é", authMethod: "client_secret_basic" as const };
    await exchangeCode(meta(s.url), client, input, opts);
    await refreshTokens(meta(s.url), client, "RT", opts);
    await revokeToken(meta(s.url), client, "tok", "access_token", opts);
    const expected = `Basic ${Buffer.from(`${encodeURIComponent("c id").replace(/%20/g, "+")}:${encodeURIComponent("s:é")}`).toString("base64")}`;
    for (const entry of s.log) {
      expect(entry.authorization).toBe(expected);
      expect(form(entry.body)).not.toHaveProperty("client_secret");
      expect(form(entry.body)).not.toHaveProperty("client_id");
    }
  });

  it("client_secret_post: sends the secret in the form, no Authorization header", async () => {
    const s = await stub(200, { access_token: "AT" });
    const client = { clientId: "cid", clientSecret: "sec", authMethod: "client_secret_post" as const };
    await exchangeCode(meta(s.url), client, input, opts);
    await refreshTokens(meta(s.url), client, "RT", opts);
    for (const entry of s.log) {
      expect(entry.authorization).toBe("");
      expect(form(entry.body)).toMatchObject({ client_id: "cid", client_secret: "sec" });
    }
  });

  it("none: sends only the client id, even when a secret is known", async () => {
    const s = await stub(200, { access_token: "AT" });
    const client = { clientId: "cid", clientSecret: "sec", authMethod: "none" as const };
    await exchangeCode(meta(s.url), client, input, opts);
    await refreshTokens(meta(s.url), client, "RT", opts);
    for (const entry of s.log) {
      expect(entry.authorization).toBe("");
      expect(form(entry.body).client_id).toBe("cid");
      expect(form(entry.body)).not.toHaveProperty("client_secret");
    }
  });
});
