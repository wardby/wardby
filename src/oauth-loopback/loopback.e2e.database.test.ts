// End to end: an OAuth secret connected through the loopback flow. create_secret (callback "loopback")
// returns a command and a link; the real CLI module (injected stdin and output, a simulated browser)
// talks to a real in-process Wardby HTTP server serving /oauth/loopback/start and /complete, against
// the in-process fake OAuth server; the confirmation code it prints finishes the secret; the fake's
// `echo` tool, called through handleMcpTool, comes back with its bearer redacted. Fake values only.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { oauthRedirectUri } from "../core/host-identity-links.js";
import { setLogLineFilter } from "../core/logger.js";
import { handleMcpTool, loadMcpToolPins } from "../core/mcp-tools.js";
import type { OAuthLinkAdapter } from "../core/oauth-link.js";
import { OAUTH_SECRET_PURPOSE, oauthSecretAdapter } from "../core/oauth-secrets.js";
import { REDACTED_MARKER } from "../core/secret-spans.js";
import type { McpProviders, McpRequestContext } from "../mcp/context.js";
import { buildMcpServer } from "../mcp/server.js";
import { registerMcpServerTools } from "../mcp/tools/mcp-servers.js";
import { OAUTH_LOOPBACK_COMMAND } from "../mcp/tools/oauth-loopback-link.js";
import { registerSecretsTools } from "../mcp/tools/secrets.js";
import { startHttpServer, type HttpServerHandle } from "../mcp/transport/streamable-http.js";
import type { AuthProvider } from "../providers/auth/types.js";
import { safeFetch } from "../sandbox/safe-fetch.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-support/fake-oauth-server.test-support.js";
import { secretConnectCommand } from "./connect.js";

const db = createPrismaClient();
const HOST = "oauth.fake.test";
const SECRET_NAME = "browserstack";
const LEAKS = ["fake-access", "fake-refresh"];
const principalIds: string[] = [];
const agentIds: string[] = [];

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

let fake: FakeOAuthServer;
let http: HttpServerHandle | undefined;
/** Dynamic client registrations the fake received through the server-side fetch. */
let registrations: { redirectUris: unknown }[] = [];

/** Maps https://oauth.fake.test onto the fake's plain listener (the stand-in for a TLS front) and records registrations. */
const tlsFront: typeof safeFetch = async (input, init, options) => {
  const url = new URL(input);
  if (url.hostname !== HOST || url.protocol !== "https:" || url.port !== "") {
    throw new Error("fetch_destination_blocked");
  }
  if (url.pathname === "/register" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { redirect_uris?: unknown };
    registrations.push({ redirectUris: body.redirect_uris });
  }
  const listen = new URL(fake.listenUrl);
  url.protocol = "http:";
  url.port = listen.port;
  return safeFetch(url.toString(), init, {
    ...options,
    privateHostAllowlist: [HOST],
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });
};

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe.skipIf(!process.env.DATABASE_URL)("OAuth loopback sign-in end to end through the CLI (PostgreSQL)", () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    registrations = [];
    setLogLineFilter((line) => {
      logged.push(line);
      return line;
    });
  });
  afterEach(async () => {
    setLogLineFilter((line) => line);
    await http?.close();
    http = undefined;
    await fake?.close();
  });
  afterAll(async () => {
    await db.agentMcpServer.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.oAuthLinkRequest.deleteMany({ where: { principalId: { in: principalIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("create_secret -> CLI -> confirmationCode -> connected -> echo redacted; no link, code, state or token leaks", async () => {
    fake = await startFakeOAuthServer({ publicHost: HOST, publicScheme: "https", checkClient: true });
    const p: Principal = await db.principal.create({ data: { subject: `oauth-loopback-e2e-${randomUUID()}` } });
    principalIds.push(p.id);

    // A real Wardby HTTP server serving the loopback routes, and the MCP server whose tools mint its links.
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const canonicalUri = `${origin}/mcp`;
    const providers = { secrets: cipher, sandboxFetch: tlsFront } as unknown as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
    const secretAdapter = oauthSecretAdapter(cipher, undefined, tlsFront) as OAuthLinkAdapter<unknown, unknown>;
    http = await startHttpServer({
      mcp,
      config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
      auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
      oauthCallback: {
        db,
        cipher,
        adapters: new Map([[OAUTH_SECRET_PURPOSE, secretAdapter]]),
        redirectUri: (purpose) => oauthRedirectUri(origin, purpose),
      },
      oauthLoopback: { db, cipher, fetchImpl: tlsFront },
    });

    const ctx: McpRequestContext = {
      principal: p,
      scopes: new Set(["secrets:write", "tools:write", "agents:read", "agents:write"]),
      roles: [],
      canonicalUri,
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (t) => `${origin}/x?t=${t}`,
      protocolElicitation: false,
      oauthLoopback: { origin: () => Promise.resolve(origin), audience: "http" },
    });
    registerMcpServerTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const toolResults: string[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      const text = result.content[0].text;
      toolResults.push(text);
      return { isError: Boolean(result.isError), text };
    };

    // 1. create_secret with callback "loopback" returns the command and the link.
    const started = await call("create_secret", {
      name: SECRET_NAME,
      oauth: { resource: fake.mcpUrl, callback: "loopback" },
    });
    expect(started.isError, started.text).toBe(false);
    const created = JSON.parse(started.text) as { status: string; command: string; link: string };
    expect(created.status).toBe("pending");
    expect(created.command).toBe(OAUTH_LOOPBACK_COMMAND);
    expect(created.link.startsWith(`${origin}/oauth/loopback#`)).toBe(true);
    const linkToken = created.link.slice(created.link.indexOf("#") + 1);
    expect(linkToken.length).toBeGreaterThan(20);
    // No registration yet: nothing runs against the provider until the CLI starts the sign-in.
    expect(registrations).toHaveLength(0);

    // 2. The real CLI against the real server. The simulated browser follows the authorize URL through
    // the fake's approval, then loads the CLI's own 127.0.0.1 callback.
    const cliOut: string[] = [];
    const httpBodies: { path: string; status: number; text: string }[] = [];
    const recordingFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      httpBodies.push({
        path: new URL(input instanceof Request ? input.url : input).pathname,
        status: res.status,
        text: await res.clone().text(),
      });
      return res;
    };
    let authorizeUrl = "";
    let callbackUrl = "";
    let callbackPage = "";
    const exit = await secretConnectCommand(["-"], {
      readLink: async () => created.link,
      out: (line) => cliOut.push(line),
      fetch: recordingFetch,
      openBrowser: async (url) => {
        authorizeUrl = url;
        callbackUrl = await fake.approve(url);
        const res = await fetch(callbackUrl);
        callbackPage = await res.text();
        return true;
      },
    });
    expect(exit, cliOut.join("\n")).toBe(0);
    const cliText = cliOut.join("\n");

    // 6. Exactly one registration, and it names the CLI's own port.
    const cb = new URL(callbackUrl);
    expect(cb.hostname).toBe("127.0.0.1");
    expect(cb.pathname).toBe("/callback");
    const redirectUri = `http://127.0.0.1:${cb.port}/callback`;
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(registrations).toEqual([{ redirectUris: [redirectUri] }]);

    // 3. The CLI printed a confirmation code; it finishes the secret.
    const code = /Confirmation code: ([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(cliText)?.[1] ?? "";
    expect(code).not.toBe("");
    expect(cliText).toContain(`create_secret({ name: "${SECRET_NAME}", confirmationCode: "${code}" })`);
    const done = await call("create_secret", { name: SECRET_NAME, confirmationCode: code });
    expect(done.isError, done.text).toBe(false);
    expect(JSON.parse(done.text)).toMatchObject({ name: SECRET_NAME, kind: "oauth", status: "connected" });

    // 4. Register the fake as an MCP server on the secret; the echoed bearer comes back redacted.
    const registered = await call("register_mcp_server", {
      name: "bs",
      url: fake.mcpUrl,
      secretNames: [SECRET_NAME],
    });
    expect(registered.isError, registered.text).toBe(false);
    const serverRow = JSON.parse(registered.text) as { id: string };
    const agentId = `oauth-loopback-agent-${randomUUID()}`;
    agentIds.push(agentId);
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: p.id },
    });
    const attached = await call("attach_mcp_server", { agentId, serverId: serverRow.id, allowedTools: ["echo"] });
    expect(attached.isError, attached.text).toBe(false);
    const pin = (await loadMcpToolPins(db, agentId)).find((x) => x.toolName === "echo");
    if (!pin) throw new Error("echo was not pinned");
    const echoed = await handleMcpTool(pin, JSON.stringify({ msg: "hi" }), {
      db,
      cipher,
      agentId,
      runId: `run-${randomUUID()}`,
      signal: new AbortController().signal,
      fetchImpl: tlsFront,
      log: { info: () => undefined, warn: () => undefined } as never,
    });
    expect(JSON.parse(echoed)).toEqual({ args: { msg: "hi" }, bearer: REDACTED_MARKER });
    await client.close();

    // 5. What must not leave its boundary. The link is the deliverable of the first tool result and
    // the state is in the authorize address (the start response and the browser), both by design;
    // everywhere else neither may appear. The authorization code appears nowhere we can observe.
    const authCode = cb.searchParams.get("code") ?? "";
    const state = cb.searchParams.get("state") ?? "";
    expect(authCode).not.toBe("");
    expect(state).not.toBe("");
    const startBody = httpBodies.find((b) => b.path === "/oauth/loopback/start");
    const completeBody = httpBodies.find((b) => b.path === "/oauth/loopback/complete");
    expect(startBody?.status).toBe(200);
    expect(completeBody?.status).toBe(200);
    const observed: Record<string, string> = {
      "CLI output": cliText,
      "tool results after the first": toolResults.slice(1).join("\n"),
      "complete response": completeBody?.text ?? "",
      "callback page": callbackPage,
      "log lines": logged.join("\n"),
      "echo result": echoed,
    };
    for (const [label, text] of Object.entries(observed)) {
      expect(text, label).not.toContain(linkToken);
      expect(text, label).not.toContain(authCode);
      expect(text, label).not.toContain(state);
      for (const leak of LEAKS) expect(text, label).not.toContain(leak);
    }
    // The first tool result carries the link by design, nothing else secret; the start response carries
    // the state by design (never the link, code or a token).
    const everywhereElse: Record<string, string> = {
      "first tool result": started.text,
      "start response": startBody?.text ?? "",
    };
    for (const [label, text] of Object.entries(everywhereElse)) {
      expect(text, label).not.toContain(authCode);
      for (const leak of LEAKS) expect(text, label).not.toContain(leak);
    }
    expect(startBody?.text ?? "").not.toContain(linkToken);
    expect(started.text).not.toContain(state);
    for (const body of httpBodies) {
      expect(body.text, body.path).not.toContain(linkToken);
      expect(body.text, body.path).not.toContain(authCode);
      for (const leak of LEAKS) expect(body.text, body.path).not.toContain(leak);
    }
  });
});
