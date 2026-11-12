// End to end: an OAuth secret connected through create_secret, behind a real (in-process) MCP server
// that requires its tokens, called from a native agent (handleMcpTool) and from a coding run (the
// native gateway's /coding-mcp handler the coding proxy forwards to). The fake's `echo` tool echoes
// the bearer it saw, so every assertion that it comes back as [REDACTED] proves redaction. Fake values only.
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { mcpTokenHash, mintMcpToken } from "../coding/mcp-token.js";
import type { McpProviders, McpRequestContext } from "../mcp/context.js";
import { handleOAuthCallback } from "../mcp/host-events/oauth-callback.js";
import { buildMcpServer } from "../mcp/server.js";
import { registerMcpServerTools } from "../mcp/tools/mcp-servers.js";
import { registerSecretsTools } from "../mcp/tools/secrets.js";
import { safeFetch } from "../sandbox/safe-fetch.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../test-support/fake-oauth-server.test-support.js";
import { handleCodingMcpRequest } from "./coding-mcp.js";
import { createPrismaClient } from "./db.js";
import { oauthRedirectUri } from "./host-identity-links.js";
import type { Logger } from "./logger.js";
import { redactForServer } from "./mcp-servers.js";
import { handleMcpTool, loadMcpToolPins, type McpToolPin } from "./mcp-tools.js";
import type { OAuthLinkAdapter } from "./oauth-link.js";
import {
  OAUTH_SECRET_PURPOSE,
  OAuthSecretMetaSchema,
  oauthSecretAdapter,
  SECRET_REAUTH_REQUIRED,
} from "./oauth-secrets.js";
import { loadAgentSecretValues } from "./secret-guard.js";
import { redactExactSecretValues, REDACTED_MARKER } from "./secret-spans.js";

// Every module logger's lines, at every level.
const logged = vi.hoisted(() => vi.fn());
vi.mock("./logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(log, level).mockImplementation(logged);
    }
    return log;
  });
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(real.logger, level).mockImplementation(logged);
  }
  return real;
});

const db = createPrismaClient();
const HOST = "oauth.fake.test";
const CANONICAL = "https://wardby.example/mcp";
const ORIGIN = "https://wardby.example";
const SECRET_NAME = "browserstack";
const SERVER_NAME = "bs";
/** Every token the fake mints starts with one of these; none may reach any output. */
const LEAKS = ["fake-access", "fake-refresh"];

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

/**
 * The fake advertises https://oauth.fake.test, as a hosted server would, so every production check
 * that refuses plain http or a non-default port (the MCP server URL, the brokered fetch, the token
 * endpoint at refresh) runs unchanged. This fetch stands in for the TLS front: it maps that origin
 * onto the fake's plain listener and lets the fetch policy reach 127.0.0.1 for that one host. Any
 * other destination is refused.
 */
const tlsFront: typeof safeFetch = async (input, init, options) => {
  const url = new URL(input);
  if (url.hostname !== HOST || url.protocol !== "https:" || url.port !== "") {
    throw new Error("fetch_destination_blocked");
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

const principalIds: string[] = [];
const agentIds: string[] = [];
const runIds: string[] = [];
let fake: FakeOAuthServer;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `oauth-e2e-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function agentOf(ownerId: string): Promise<string> {
  const agentId = `oauth-e2e-agent-${randomUUID()}`;
  agentIds.push(agentId);
  await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId } });
  return agentId;
}

/** The wardby MCP server as the HTTP transport builds it: production providers, no fetch policy override. */
async function wardbyMcp(p: Principal) {
  const providers = { secrets: cipher, sandboxFetch: tlsFront } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(["secrets:write", "tools:write", "agents:read", "agents:write"]),
    roles: [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerSecretsTools(mcp, {
    buildElicitationUrl: async (t) => `${ORIGIN}/x?t=${t}`,
    protocolElicitation: false,
    oauthLoopback: { origin: async () => ORIGIN, audience: "http" },
  });
  registerMcpServerTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const outputs: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = result.content[0].text;
    outputs.push(text);
    return { isError: Boolean(result.isError), text };
  };
  return { call, outputs, close: () => client.close() };
}

/** Approves the authorize URL at the fake as the user, then loads wardby's callback page; returns its HTML. */
async function visitCallback(authorizeUrl: string): Promise<string> {
  const cb = new URL(await fake.approve(authorizeUrl));
  let body = "";
  const res = {
    setHeader: () => undefined,
    writeHead: () => res,
    end: (b: string) => {
      body = b;
      return res;
    },
  } as unknown as ServerResponse;
  const adapter = oauthSecretAdapter(cipher, undefined, tlsFront) as OAuthLinkAdapter<unknown, unknown>;
  await handleOAuthCallback(new URL(`${ORIGIN}/oauth/callback${cb.search}`), res, {
    db,
    cipher,
    adapters: new Map([[OAUTH_SECRET_PURPOSE, adapter]]),
    redirectUri: (purpose) => oauthRedirectUri(ORIGIN, purpose),
  });
  return body;
}

type Call = Awaited<ReturnType<typeof wardbyMcp>>["call"];

/** create_secret with oauth, the sign-in, the callback page, and the confirmation: the whole connect. */
async function connectSecret(call: Call): Promise<string> {
  const started = await call("create_secret", { name: SECRET_NAME, oauth: { resource: fake.mcpUrl } });
  expect(started.isError, started.text).toBe(false);
  const { url } = JSON.parse(started.text) as { url: string };
  const html = await visitCallback(url);
  for (const leak of LEAKS) expect(html).not.toContain(leak);
  const code = /([A-Z2-7]{4}-[A-Z2-7]{4})/.exec(html)?.[1] ?? "";
  expect(code).not.toBe("");
  const done = await call("create_secret", { name: SECRET_NAME, confirmationCode: code });
  expect(done.isError, done.text).toBe(false);
  expect(JSON.parse(done.text)).toMatchObject({ name: SECRET_NAME, kind: "oauth", status: "connected" });
  return html;
}

const secretRow = (ownerId: string) =>
  db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId, name: SECRET_NAME } } });

/** The tokens wardby holds now, read straight from the row. */
async function storedTokens(ownerId: string): Promise<{ accessToken: string; refreshToken?: string }> {
  return JSON.parse(await cipher.decrypt((await secretRow(ownerId)).ciphertext)) as {
    accessToken: string;
    refreshToken?: string;
  };
}

/** Moves the stored expiry (the clock wardby reads), leaving the tokens as they are. */
async function setStoredExpiry(ownerId: string, msFromNow: number): Promise<void> {
  const row = await secretRow(ownerId);
  const meta = OAuthSecretMetaSchema.parse(row.oauth);
  await db.secret.update({
    where: { id: row.id },
    data: { oauth: { ...meta, expiresAt: new Date(Date.now() + msFromNow).toISOString() } },
  });
}

/** Steps 1 and 2: connect the OAuth secret, register the fake as an MCP server on it, attach to an agent. */
async function connectedServer() {
  const p = await principal();
  const mcp = await wardbyMcp(p);
  const html = await connectSecret(mcp.call);
  expect(html).toContain(`Signed in to ${HOST}`);

  const registered = await mcp.call("register_mcp_server", {
    name: SERVER_NAME,
    url: fake.mcpUrl,
    secretNames: [SECRET_NAME],
  });
  expect(registered.isError, registered.text).toBe(false);
  const server = JSON.parse(registered.text) as { id: string; tools: { name: string }[] };
  expect(server.tools.map((t) => t.name)).toEqual(["echo"]);
  // Listing the tools was the first authenticated request: the connected token was good, no refresh.
  expect(fake.tokenRequests).toBe(0);

  const agentId = await agentOf(p.id);
  const attached = await mcp.call("attach_mcp_server", { agentId, serverId: server.id, allowedTools: ["echo"] });
  expect(attached.isError, attached.text).toBe(false);
  const pin = (await loadMcpToolPins(db, agentId)).find((x) => x.toolName === "echo");
  if (!pin) throw new Error("echo was not pinned");
  expect(pin.exposedName).toBe(`${SERVER_NAME}__echo`);
  return { p, mcp, serverId: server.id, agentId, pin, html };
}

/** Asserts no fake token, in any form wardby would redact, appears in `text`. */
function expectNoTokens(text: string, label: string): void {
  for (const leak of LEAKS) expect(text, label).not.toContain(leak);
  for (const leak of LEAKS) expect(text, label).not.toContain(Buffer.from(leak).toString("base64").slice(0, 12));
}

describe.skipIf(!process.env.DATABASE_URL)("OAuth secret end to end through an MCP server (PostgreSQL)", () => {
  beforeEach(async () => {
    logged.mockClear();
    fake = await startFakeOAuthServer({ publicHost: HOST, publicScheme: "https", checkClient: true });
  });
  afterEach(async () => {
    await fake.close();
  });
  afterAll(async () => {
    await db.codingProxySession.deleteMany({ where: { runId: { in: runIds } } });
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agentMcpServer.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("native agent: call, refresh on expiry, 401 and retry, revoked refresh token, reconnect; no token in any output", async () => {
    const { p, mcp, serverId, agentId, pin } = await connectedServer();
    const callLog = { info: vi.fn(), warn: vi.fn() };
    const runId = `run-${randomUUID()}`;
    const results: string[] = [];
    const callEcho = async (msg: string) => {
      const text = await handleMcpTool(pin, JSON.stringify({ msg }), {
        db,
        cipher,
        agentId,
        runId,
        signal: new AbortController().signal,
        fetchImpl: tlsFront,
        log: callLog as never,
      });
      results.push(text);
      return text;
    };
    /** What the run's own redaction (run records, step text) would mask: read as stored. */
    const runRedaction = async () => (await loadAgentSecretValues(db, cipher, agentId)).flatMap((n) => n.values);
    const expectStepTextRedacts = async (token: string) => {
      const step = `Called ${pin.exposedName}; the server said its bearer was ${token}.`;
      const masked = redactExactSecretValues(step, await runRedaction());
      expect(masked).toContain(REDACTED_MARKER);
      expectNoTokens(masked, "step text");
    };

    // The fake's tokens are not token-shaped: only exact-value redaction (the secret's live values)
    // can turn the echoed bearer into the marker, so the assertions below test exactly that.
    expect(redactForServer('{"bearer":"fake-access-1"}', [])).toContain("fake-access-1");

    // Step 3: a native call. The echo proves the server saw a bearer, and it comes back redacted.
    const first = await callEcho("hello-1");
    expect(JSON.parse(first)).toEqual({ args: { msg: "hello-1" }, bearer: REDACTED_MARKER });
    expect(fake.tokenRequests).toBe(0);
    const token1 = (await storedTokens(p.id)).accessToken;
    expect(token1).toMatch(/^fake-access-/);
    await expectStepTextRedacts(token1);

    // Step 4a: the stored token reaches its expiry: exactly one refresh before the call's first
    // request, and the result is redacted against the token minted for this call.
    await setStoredExpiry(p.id, -1000);
    const second = await callEcho("hello-2");
    expect(JSON.parse(second)).toEqual({ args: { msg: "hello-2" }, bearer: REDACTED_MARKER });
    expect(fake.tokenRequests).toBe(1);
    const token2 = (await storedTokens(p.id)).accessToken;
    expect(token2).not.toBe(token1);
    await expectStepTextRedacts(token2);

    // Step 4b: wardby's clock says the token is good, but the server no longer takes it: it answers
    // 401, the broker forces one refresh and retries once, and the call succeeds.
    fake.revoked.add(token2);
    const third = await callEcho("hello-3");
    expect(JSON.parse(third)).toEqual({ args: { msg: "hello-3" }, bearer: REDACTED_MARKER });
    expect(fake.tokenRequests).toBe(2);
    const token3 = (await storedTokens(p.id)).accessToken;
    expect([token1, token2]).not.toContain(token3);
    await expectStepTextRedacts(token3);

    // Step 5: the provider revokes the refresh token, and the access token expires. The refresh is
    // refused (the fake echoes the spent refresh token in error_description): reauth, no token text.
    const { refreshToken } = await storedTokens(p.id);
    expect(refreshToken).toMatch(/^fake-refresh-/);
    fake.revoked.add(refreshToken!);
    await setStoredExpiry(p.id, -1000);
    const failed = await callEcho("hello-4");
    expect(JSON.parse(failed)).toEqual({ error: "mcp_server_error", message: SECRET_REAUTH_REQUIRED(SECRET_NAME) });
    expect(failed).toContain("secret_reauth_required");
    expect(failed).not.toContain("fake-");
    expect(fake.tokenRequests).toBe(3);
    expect(OAuthSecretMetaSchema.parse((await secretRow(p.id)).oauth)).toMatchObject({
      status: "reauth_required",
      reauthReason: "invalid_grant",
    });

    // Step 6: connect again under the same name. The server row and the attachment are untouched, and
    // the very next call works with the new tokens.
    const secretBefore = await secretRow(p.id);
    const serverBefore = await db.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    const attachmentBefore = await db.agentMcpServer.findUniqueOrThrow({
      where: { agentId_serverId: { agentId, serverId } },
    });
    await connectSecret(mcp.call);
    expect((await secretRow(p.id)).id).toBe(secretBefore.id);
    expect(await db.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).toEqual(serverBefore);
    expect(await db.agentMcpServer.findUniqueOrThrow({ where: { agentId_serverId: { agentId, serverId } } })).toEqual(
      attachmentBefore,
    );
    const tokenRequestsBefore = fake.tokenRequests;
    const again = await callEcho("hello-5");
    expect(JSON.parse(again)).toEqual({ args: { msg: "hello-5" }, bearer: REDACTED_MARKER });
    expect(fake.tokenRequests).toBe(tokenRequestsBefore);
    await expectStepTextRedacts((await storedTokens(p.id)).accessToken);

    // No token, in any call's result or error, any wardby tool's output, the per-call log, or any module log.
    for (const [i, text] of results.entries()) expectNoTokens(text, `result ${i}`);
    for (const [i, text] of mcp.outputs.entries()) expectNoTokens(text, `wardby tool output ${i}`);
    expect(callLog.info).toHaveBeenCalledTimes(results.length);
    expectNoTokens(JSON.stringify([callLog.info.mock.calls, callLog.warn.mock.calls]), "call log");
    expect(logged).toHaveBeenCalled(); // the refresh and reauth lines were captured
    expectNoTokens(JSON.stringify(logged.mock.calls), "module logs");
    await mcp.close();
  }, 30_000);

  it("coding agent: a call through the /coding-mcp gateway handler refreshes and stays redacted", async () => {
    const { p, mcp, agentId } = await connectedServer();
    const suffix = randomUUID().slice(0, 8);
    const runId = `oauth-e2e-run-${suffix}`;
    runIds.push(runId);
    const token = mintMcpToken();
    await db.run.create({ data: { id: runId, agentId, status: "running", executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "test",
        repository: "your-org/your-repo",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "claude-code",
        model: "claude-sonnet-4-6",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.01,
        budgetLimitedBy: "week",
      },
    });
    const pins: McpToolPin[] = await loadMcpToolPins(db, agentId);
    await db.codingProxySession.create({
      data: {
        id: `oauth-e2e-session-${suffix}`,
        runId,
        capabilityHash: `cap-${suffix}`,
        credentialRef: "anthropic/test",
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-4-6"],
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        budgetUsd: 1,
        mcpTools: JSON.parse(JSON.stringify(pins)) as object,
        mcpTokenHash: mcpTokenHash(token),
      },
    });
    const info = vi.fn();
    const log = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const gateway = (body: unknown) =>
      handleCodingMcpRequest(`Bearer ${token}`, JSON.stringify(body), {
        db,
        cipher,
        log,
        fetchImpl: tlsFront,
        stopPollMs: 25,
      });

    const listed = await gateway({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({ result: { tools: [{ name: `${SERVER_NAME}__echo` }] } });
    expect(listed.body).not.toContain(HOST);

    // The stored token is due, so this call refreshes first: the result is redacted against the new one.
    await setStoredExpiry(p.id, -1000);
    const called = await gateway({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: `${SERVER_NAME}__echo`, arguments: { msg: "from-coding" } },
    });
    expect(called.status).toBe(200);
    const result = (JSON.parse(called.body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ args: { msg: "from-coding" }, bearer: REDACTED_MARKER });
    expect(fake.tokenRequests).toBe(1);
    const fresh = (await storedTokens(p.id)).accessToken;
    expect(fresh).not.toBe("");
    expect(called.body).not.toContain(fresh);

    for (const out of [listed.body, called.body, ...mcp.outputs]) expectNoTokens(out, "gateway or tool output");
    expect(info).toHaveBeenCalled();
    expectNoTokens(JSON.stringify(info.mock.calls), "gateway log");
    expectNoTokens(JSON.stringify(logged.mock.calls), "module logs");
    await mcp.close();
  }, 30_000);
});
