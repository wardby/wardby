import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpTokenHash, mintMcpToken } from "../coding/mcp-token.js";
import { createGatewayServer } from "../native-worker/http-server.js";
import { handleCodingMcpRequest, type CodingMcpDeps } from "./coding-mcp.js";
import { createPrismaClient } from "./db.js";
import type { Logger } from "./logger.js";
import { loadMcpToolPins } from "./mcp-tools.js";
import { fakeMcpServer, textResult } from "./mcp-tools.test-support.js";
import { createSecret } from "./secrets.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";

// Fake values only.
const SECRET = "sk-fake-coding-mcp-ZYXW98765432";
const URL_ = "https://mcp.example.com/mcp?team=your-org";

describe.skipIf(!process.env.DATABASE_URL)("/coding-mcp (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const owner = `cmcp-owner-${suffix}`;
  const agentId = `cmcp-agent-${suffix}`;
  const runId = `cmcp-run-${suffix}`;
  const sessionId = `cmcp-session-${suffix}`;
  const token = mintMcpToken();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const env = { ...process.env };
  const info = vi.fn();
  const log = { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger;

  const deps = (fetchImpl: typeof safeFetch, extra: Partial<CodingMcpDeps> = {}): CodingMcpDeps => ({
    db,
    cipher,
    log,
    fetchImpl,
    stopPollMs: 25,
    ...extra,
  });
  const callBody = (args: Record<string, unknown> = {}, id = 1) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "datadog__search", arguments: args } });
  const resultOf = (body: string) =>
    (JSON.parse(body) as { result: { content: { text: string }[]; isError?: boolean } }).result;

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 2, ownerId: owner },
    });
    await createSecret("DD_KEY", SECRET, owner, cipher, db, {
      broker: {
        hosts: ["mcp.example.com"],
        placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
      },
    });
    const server = await db.mcpServer.create({
      data: {
        ownerId: owner,
        name: "datadog",
        url: URL_,
        secretNames: ["DD_KEY"],
        toolSnapshot: [{ name: "search", description: "Searches logs.", inputSchema: { type: "object" } }],
      },
    });
    await db.agentMcpServer.create({
      data: { agentId, serverId: server.id, allowedTools: ["search"], attachedById: owner },
    });
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
    await db.codingProxySession.create({
      data: {
        id: sessionId,
        runId,
        capabilityHash: `cap-${suffix}`,
        credentialRef: "anthropic/test",
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-4-6"],
        deadlineAt: new Date(Date.now() + 10 * 60_000),
        budgetUsd: 1,
        mcpTools: JSON.parse(JSON.stringify(await loadMcpToolPins(db, agentId))),
        mcpTokenHash: mcpTokenHash(token),
      },
    });
  });
  beforeEach(async () => {
    info.mockClear();
    await db.codingProxySession.update({
      where: { id: sessionId },
      data: { mcpCallCount: 0, status: "active", deadlineAt: new Date(Date.now() + 10 * 60_000) },
    });
    await db.run.update({ where: { id: runId }, data: { status: "running" } });
  });
  afterEach(() => {
    process.env = { ...env };
  });
  afterAll(async () => {
    await db.codingProxySession.deleteMany({ where: { id: sessionId } });
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    await db.mcpServer.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: owner } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("lists the pinned tools for the run's token", async () => {
    const server = fakeMcpServer(() => textResult("unused"));
    const res = await handleCodingMcpRequest(
      `Bearer ${token}`,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      deps(server.impl),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { tools: [{ name: "datadog__search" }] } });
    expect(res.body).not.toContain("mcp.example.com");
    expect(res.body).not.toContain("DD_KEY");
  });

  it("runs the call with the brokered secret and never returns a secret the server echoes", async () => {
    const server = fakeMcpServer((_name, args) =>
      textResult(`q=${String(args.q)} key=${SECRET} b64=${Buffer.from(SECRET).toString("base64")}`),
    );
    const res = await handleCodingMcpRequest(`Bearer ${token}`, callBody({ q: "errors" }), deps(server.impl));
    expect(res.status).toBe(200);
    expect(server.seen[0].authorization).toBe(`Bearer ${SECRET}`);
    const result = resultOf(res.body);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("q=errors");
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(Buffer.from(SECRET).toString("base64"));
    // handleMcpTool's per-call line and the route's line; neither carries the secret, token or arguments.
    const logged = JSON.stringify(info.mock.calls);
    expect(info.mock.calls.map((c) => c[1])).toEqual(["mcp tool call", "coding mcp request"]);
    expect(info.mock.calls[0][0]).toMatchObject({ runId, agentId, tool: "search", outcome: "ok" });
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain("errors");
  });

  it("refuses the token once the session is cancelled or past its deadline", async () => {
    const server = fakeMcpServer(() => textResult("unused"));
    await db.codingProxySession.update({ where: { id: sessionId }, data: { status: "cancelled" } });
    expect((await handleCodingMcpRequest(`Bearer ${token}`, callBody(), deps(server.impl))).status).toBe(401);
    await db.codingProxySession.update({
      where: { id: sessionId },
      data: { status: "active", deadlineAt: new Date(Date.now() - 1000) },
    });
    expect((await handleCodingMcpRequest(`Bearer ${token}`, callBody(), deps(server.impl))).status).toBe(401);
    expect(server.seen).toEqual([]);
  });

  it("counts calls in the database and never lets concurrent calls past the limit", async () => {
    process.env.WARDBY_MCP_MAX_CALLS_PER_RUN = "3";
    const server = fakeMcpServer(() => textResult("ok"));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        handleCodingMcpRequest(`Bearer ${token}`, callBody({}, i + 1), deps(server.impl)),
      ),
    );
    const refused = results.map((r) => resultOf(r.body)).filter((r) => r.isError);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(JSON.parse(r.content[0].text)).toEqual({
        error: "mcp_call_limit",
        message: "This run reached its limit of 3 MCP tool calls.",
      });
    }
    const row = await db.codingProxySession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.mcpCallCount).toBe(3);
  });

  it("stops a call in flight when the run is stopped", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => (started = resolve));
    const server = fakeMcpServer(
      (_name, _args, signal) =>
        new Promise((_resolve, reject) => {
          started();
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const pending = handleCodingMcpRequest(`Bearer ${token}`, callBody(), deps(server.impl));
    await inFlight;
    await db.run.update({ where: { id: runId }, data: { status: "cancelled" } });
    const res = await pending;
    const result = resultOf(res.body);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "mcp_call_timeout", message: "The call was stopped." });
  });

  describe("through the gateway's HTTP listener", () => {
    let listener: Server;
    let base = "";
    beforeAll(async () => {
      const server = fakeMcpServer(() => textResult(`echo ${SECRET}`));
      listener = createGatewayServer({ db, providers: {} as never, codingMcp: deps(server.impl) });
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((done) => listener.close(() => done()));
    });

    it("serves POST /coding-mcp with the run's MCP token", async () => {
      const res = await fetch(`${base}/coding-mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: callBody(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("mcp-session-id")).toBeNull();
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(resultOf(text).content[0].text).toContain("echo");
    });

    it("answers 401 without WWW-Authenticate, 202 for a notification, and 405 for GET", async () => {
      const unauth = await fetch(`${base}/coding-mcp`, { method: "POST", body: callBody() });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("www-authenticate")).toBeNull();
      // A gateway capability is not an MCP token.
      const capability = await fetch(`${base}/coding-mcp`, {
        method: "POST",
        headers: { authorization: `Bearer cap-${suffix}` },
        body: callBody(),
      });
      expect(capability.status).toBe(401);
      const note = await fetch(`${base}/coding-mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(note.status).toBe(202);
      expect(await note.text()).toBe("");
      const get = await fetch(`${base}/coding-mcp`, { headers: { authorization: `Bearer ${token}` } });
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");
    });

    it("refuses an oversized body with 413", async () => {
      const res = await fetch(`${base}/coding-mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "x".repeat(1024 * 1024 + 1),
      });
      expect(res.status).toBe(413);
    });

    it("leaves the worker route untouched by the MCP token", async () => {
      const res = await fetch(`${base}/native-gateway/v1/call`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(res.status).not.toBe(200);
    });
  });
});
