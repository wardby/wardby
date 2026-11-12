import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { oauthRedirectUri } from "../../core/host-identity-links.js";
import { OAUTH_SECRET_PURPOSE, oauthSecretAdapter } from "../../core/oauth-secrets.js";
import type { OAuthLinkAdapter } from "../../core/oauth-link.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test-support/fake-oauth-server.test-support.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { handleOAuthCallback } from "../host-events/oauth-callback.js";
import { buildMcpServer } from "../server.js";
import { registerSecretsTools } from "./secrets.js";

const db = createPrismaClient();
const HOST = "oauth.fake.test";
// The fake listens on 127.0.0.1; clients reach it through a dotted name so the broker schema validates.
const OPTS = {
  privateHostAllowlist: [HOST],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
};
const CANONICAL = "https://wardby.example/mcp";
const ORIGIN = "https://wardby.example";
const principalIds: string[] = [];

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

let fake: FakeOAuthServer;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `secret-oauth-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function connect(p: Principal, canonicalUri = CANONICAL) {
  const providers = { secrets: cipher, sandboxFetchOptions: OPTS } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(["secrets:write"]),
    roles: [],
    canonicalUri,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerSecretsTools(mcp, {
    buildElicitationUrl: async (t) => `${ORIGIN}/x?t=${t}`,
    protocolElicitation: false,
    oauthLoopback: { origin: async () => "https://test.invalid", audience: "http" },
  });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
  return { call, close: () => client.close() };
}

/** Approves the authorize URL at the fake provider, then loads the callback page; returns its HTML. */
async function visitCallback(authorizeUrl: string): Promise<string> {
  const callbackUrl = await fake.approve(authorizeUrl);
  const cb = new URL(callbackUrl);
  let body = "";
  const res = {
    setHeader: () => undefined,
    writeHead: () => res,
    end: (b: string) => {
      body = b;
      return res;
    },
  } as unknown as ServerResponse;
  const adapter = oauthSecretAdapter(cipher, OPTS) as OAuthLinkAdapter<unknown, unknown>;
  await handleOAuthCallback(new URL(`${ORIGIN}/oauth/callback${cb.search}`), res, {
    db,
    cipher,
    adapters: new Map([[OAUTH_SECRET_PURPOSE, adapter]]),
    redirectUri: (purpose) => oauthRedirectUri(ORIGIN, purpose),
  });
  return body;
}

const LEAKS = ["fake-access", "fake-refresh", "fake-client-secret"];

describe.skipIf(!process.env.DATABASE_URL)("create_secret with oauth (PostgreSQL, fake OAuth server)", () => {
  beforeEach(async () => {
    fake = await startFakeOAuthServer({ publicHost: HOST });
  });
  afterEach(async () => {
    await fake.close();
  });
  afterAll(async () => {
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("connects end to end: sign-in link, callback page code, confirmation; nothing secret in any output", async () => {
    const p = await principal();
    const { call, close } = await connect(p);

    const started = await call("create_secret", { name: "browserstack", oauth: { resource: fake.mcpUrl } });
    expect(started.isError).toBe(false);
    const pending = JSON.parse(started.text) as { status: string; url: string; message: string };
    expect(Object.keys(pending).sort()).toEqual(["message", "status", "url"]);
    expect(pending.status).toBe("pending");
    expect(pending.message).toBe(
      "Open this link in your browser and sign in, then call create_secret again with the same name and the confirmationCode the page shows.",
    );
    const authorize = new URL(pending.url);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/oauth/callback`);

    const html = await visitCallback(pending.url);
    expect(html).toContain(`Signed in to ${HOST}`);
    expect(html).toContain("<code>create_secret</code>");
    const code = /([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(html)?.[1] ?? "";
    expect(code).not.toBe("");

    const done = await call("create_secret", { name: "browserstack", confirmationCode: code });
    expect(done.isError).toBe(false);
    const connected = JSON.parse(done.text) as Record<string, unknown>;
    expect(Object.keys(connected).sort()).toEqual(["expiresAt", "kind", "name", "status"]);
    expect(connected).toMatchObject({ name: "browserstack", kind: "oauth", status: "connected" });

    const clientId = authorize.searchParams.get("client_id")!;
    // The sign-in link itself carries the state and client id by design; nothing else does.
    for (const out of [started.text, html, done.text]) {
      for (const leak of LEAKS) expect(out).not.toContain(leak);
    }
    for (const out of [html, done.text]) {
      expect(out).not.toContain(authorize.searchParams.get("state")!);
      expect(out).not.toContain(clientId);
    }
    expect(html).not.toContain(clientId);
    expect(html).not.toContain("fake-");
    await close();
  });

  it("delete_secret revokes the refresh and access tokens at the provider, then deletes and audits", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    const started = await call("create_secret", { name: "revoke-me", oauth: { resource: fake.mcpUrl } });
    const html = await visitCallback((JSON.parse(started.text) as { url: string }).url);
    const code = /([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(html)?.[1] ?? "";
    expect((await call("create_secret", { name: "revoke-me", confirmationCode: code })).isError).toBe(false);
    const row = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId: p.id, name: "revoke-me" } } });
    const tokens = JSON.parse(await cipher.decrypt(row.ciphertext)) as { accessToken: string; refreshToken: string };
    expect(fake.revoked.size).toBe(0);

    const deleted = await call("delete_secret", { id: row.id });
    expect(deleted.isError).toBe(false);
    expect(JSON.parse(deleted.text)).toEqual({ deleted: row.id });
    expect(fake.revoked.has(tokens.refreshToken)).toBe(true);
    expect(fake.revoked.has(tokens.accessToken)).toBe(true);
    expect(await db.secret.findUnique({ where: { id: row.id } })).toBeNull();
    const audit = await db.secretBrokerChange.findMany({ where: { secretId: row.id }, orderBy: { createdAt: "asc" } });
    expect(audit.at(-1)).toMatchObject({ after: null, via: "mcp", actorId: p.id });
    for (const leak of [tokens.accessToken, tokens.refreshToken]) {
      expect(deleted.text).not.toContain(leak);
      expect(JSON.stringify(audit)).not.toContain(leak);
    }
    await close();
  });

  it("refuses oauth over stdio (no canonical URI)", async () => {
    const p = await principal();
    const { call, close } = await connect(p, "stdio");
    const r = await call("create_secret", { name: "bs", oauth: { resource: fake.mcpUrl } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Connecting an OAuth secret needs wardby's HTTP transport");
    expect(r.text).toContain("MCP_CANONICAL_URI");
    await close();
  });

  it("refuses value or broker together with oauth", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    const withValue = await call("create_secret", { name: "bs", value: "x", oauth: { resource: fake.mcpUrl } });
    expect(withValue.isError).toBe(true);
    expect(withValue.text).toContain("not both");
    const withBroker = await call("create_secret", {
      name: "bs",
      broker: { hosts: ["a.example"], placement: { kind: "query", name: "k" } },
      oauth: { resource: fake.mcpUrl },
    });
    expect(withBroker.isError).toBe(true);
    expect(withBroker.text).toContain("do not pass broker with oauth");
    await close();
  });

  it("maps flow errors to fixed messages", async () => {
    const p = await principal();
    const { call, close } = await connect(p);

    const down = await call("create_secret", { name: "bs", oauth: { resource: `http://${HOST}:1/mcp` } });
    expect(down.isError).toBe(true);
    expect(down.text).toContain("secret_oauth_provider_unavailable");
    expect(down.text).not.toContain("refresh");

    const noPkce = await startFakeOAuthServer({ publicHost: HOST, s256: false });
    const noMeta = await call("create_secret", { name: "bs", oauth: { resource: noPkce.mcpUrl } });
    await noPkce.close();
    expect(noMeta.isError).toBe(true);
    expect(noMeta.text).toContain("secret_oauth_discovery_failed");

    const wrongCode = await call("create_secret", { name: "never-started", confirmationCode: "AAAA-AAAA" });
    expect(wrongCode.isError).toBe(true);
    expect(wrongCode.text).toContain("No OAuth sign-in for secret");

    await call("create_secret", { name: "plain", value: "v" });
    const taken = await call("create_secret", { name: "plain", oauth: { resource: fake.mcpUrl } });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("secret_oauth_name_taken");
    await close();
  });

  it("refuses a value-less create_secret on an OAuth secret's name before minting a link", async () => {
    const p = await principal();
    await db.secret.create({
      data: {
        ownerId: p.id,
        name: "oauth-named",
        ciphertext: await cipher.encrypt("{}"),
        keyId: "test-key",
        oauth: { status: "connected" },
      },
    });
    const { call, close } = await connect(p);
    const r = await call("create_secret", { name: "oauth-named" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("secret_oauth_managed");
    expect(r.text).not.toContain("x?t=");
    await close();
  });

  it("refuses confirmationCode together with value, broker or oauth", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    for (const extra of [
      { value: "x" },
      { broker: { hosts: ["a.example"], placement: { kind: "query", name: "k" } } },
      { oauth: { resource: fake.mcpUrl } },
    ]) {
      const r = await call("create_secret", { name: "bs", confirmationCode: "AAAA-AAAA", ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Pass confirmationCode on its own");
    }
    await close();
  });

  it("answers bad OAuth input with 400 and OAuth wording", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    const http = await call("create_secret", { name: "bs", oauth: { resource: "ftp://x.example/mcp" } });
    expect(http.isError).toBe(true);
    expect(http.text).toContain(
      "secret_oauth_resource_invalid: the OAuth resource must be an https URL with a host name",
    );
    const ip = await call("create_secret", { name: "bs", oauth: { resource: "https://10.1.2.3/mcp" } });
    expect(ip.isError).toBe(true);
    expect(ip.text).toContain("secret_oauth_resource_invalid");
    expect(ip.text).not.toContain("MCP server URL");
    const longName = await call("create_secret", { name: "n".repeat(2000), oauth: { resource: fake.mcpUrl } });
    expect(longName.isError).toBe(true);
    expect(longName.text).toContain("secret_oauth_input_too_long");
    expect(longName.text).not.toContain("bridge_input_limit");
    const longClient = await call("create_secret", {
      name: "bs",
      oauth: { resource: fake.mcpUrl, clientId: "c".repeat(600) },
    });
    expect(longClient.text).toContain("secret_oauth_input_too_long");
    await close();
  });
});
