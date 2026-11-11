import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeOAuthServer, type FakeOAuthServer } from "./fake-oauth-server.test-support.js";

let srv: FakeOAuthServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirect = "http://127.0.0.1:9/cb";

async function register(s: FakeOAuthServer): Promise<string> {
  const r = await fetch(`${s.url}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect] }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function codeFor(s: FakeOAuthServer, clientId: string): Promise<string> {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st1",
    resource: s.mcpUrl,
  });
  const cb = new URL(await s.approve(`${s.url}/authorize?${q.toString()}`));
  expect(cb.searchParams.get("state")).toBe("st1");
  return cb.searchParams.get("code") ?? "";
}

function token(s: FakeOAuthServer, params: Record<string, string>): Promise<Response> {
  return fetch(`${s.url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

function exchange(s: FakeOAuthServer, clientId: string, code: string, v = verifier) {
  return token(s, {
    grant_type: "authorization_code",
    code,
    code_verifier: v,
    client_id: clientId,
    redirect_uri: redirect,
    resource: s.mcpUrl,
  });
}

function mcp(s: FakeOAuthServer, body: unknown, bearer?: string): Promise<Response> {
  return fetch(s.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("fake OAuth server", () => {
  it("serves discovery at the root path only", async () => {
    srv = await startFakeOAuthServer();
    const prm = await fetch(`${srv.url}/.well-known/oauth-protected-resource`);
    expect(await prm.json()).toEqual({
      resource: srv.mcpUrl,
      authorization_servers: [srv.url],
      scopes_supported: ["read", "write", "admin"],
      bearer_methods_supported: ["header"],
    });
    expect((await fetch(`${srv.url}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    const as = (await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).toMatchObject({
      issuer: srv.url,
      authorization_endpoint: `${srv.url}/authorize`,
      token_endpoint: `${srv.url}/token`,
      registration_endpoint: `${srv.url}/register`,
      revocation_endpoint: `${srv.url}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("omits optional metadata when options are off", async () => {
    srv = await startFakeOAuthServer({ revocation: false, dcr: false, s256: false });
    const as = (await (await fetch(`${srv.url}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      unknown
    >;
    expect(as).not.toHaveProperty("revocation_endpoint");
    expect(as).not.toHaveProperty("registration_endpoint");
    expect(as).not.toHaveProperty("code_challenge_methods_supported");
  });

  it("runs authorize, PKCE exchange, rotation and spent-refresh echo", async () => {
    srv = await startFakeOAuthServer();
    const cid = await register(srv);
    const bad = await exchange(srv, cid, await codeFor(srv, cid), "w".repeat(50));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_grant");

    const ok = await exchange(srv, cid, await codeFor(srv, cid));
    expect(ok.status).toBe(200);
    const t1 = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(t1.access_token).toMatch(/^fake-access-\d+$/);
    expect(t1.refresh_token).toMatch(/^fake-refresh-\d+$/);
    expect(t1.expires_in).toBe(3600);

    const rr = await token(srv, {
      grant_type: "refresh_token",
      refresh_token: t1.refresh_token,
      client_id: cid,
      resource: srv.mcpUrl,
    });
    expect(rr.status).toBe(200);
    const t2 = (await rr.json()) as { access_token: string; refresh_token: string };
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(srv.tokenRequests).toBe(1);

    const spent = await token(srv, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: cid });
    expect(spent.status).toBe(400);
    expect(await spent.json()).toEqual({ error: "invalid_grant", error_description: t1.refresh_token });
    expect(srv.tokenRequests).toBe(2);
  });

  it("keeps the refresh token when rotation is off", async () => {
    srv = await startFakeOAuthServer();
    srv.rotateRefresh = false;
    const cid = await register(srv);
    const t1 = (await (await exchange(srv, cid, await codeFor(srv, cid))).json()) as { refresh_token: string };
    const t2 = (await (
      await token(srv, { grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: cid })
    ).json()) as { refresh_token: string };
    expect(t2.refresh_token).toBe(t1.refresh_token);
  });

  it("revokes tokens", async () => {
    srv = await startFakeOAuthServer();
    const cid = await register(srv);
    const t = (await (await exchange(srv, cid, await codeFor(srv, cid))).json()) as {
      access_token: string;
      refresh_token: string;
    };
    const rv = await fetch(`${srv.url}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.refresh_token, client_id: cid }),
    });
    expect(rv.status).toBe(200);
    expect(srv.revoked.has(t.refresh_token)).toBe(true);
    const r = await token(srv, { grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: cid });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error_description: string }).error_description).toBe(t.refresh_token);
    expect((await mcp(srv, { jsonrpc: "2.0", id: 1, method: "tools/list" }, t.access_token)).status).toBe(401);
  });

  it("protects /mcp and echoes the bearer", async () => {
    srv = await startFakeOAuthServer();
    const un = await mcp(srv, { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(un.status).toBe(401);
    expect(un.headers.get("www-authenticate")).toBe(
      `Bearer realm="${srv.mcpUrl}", resource_metadata="${srv.url}/.well-known/oauth-protected-resource"`,
    );
    const cid = await register(srv);
    const t = (await (await exchange(srv, cid, await codeFor(srv, cid))).json()) as { access_token: string };
    const init = await mcp(srv, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, t.access_token);
    expect(init.status).toBe(200);
    const list = (await (await mcp(srv, { jsonrpc: "2.0", id: 2, method: "tools/list" }, t.access_token)).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((x) => x.name)).toEqual(["echo"]);
    const call = (await (
      await mcp(
        srv,
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { a: 1 } } },
        t.access_token,
      )
    ).json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(call.result.content[0].text)).toEqual({ args: { a: 1 }, bearer: t.access_token });
  });

  it("expires access tokens by ttl", async () => {
    srv = await startFakeOAuthServer();
    srv.accessTtlSeconds = 0;
    const cid = await register(srv);
    const t = (await (await exchange(srv, cid, await codeFor(srv, cid))).json()) as { access_token: string };
    expect((await mcp(srv, { jsonrpc: "2.0", id: 1, method: "tools/list" }, t.access_token)).status).toBe(401);
  });
});
