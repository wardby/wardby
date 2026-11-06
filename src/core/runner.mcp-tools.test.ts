import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { createPrismaClient } from "./db.js";
import { NativeEngine } from "./engine-native.js";
import { createSecret } from "./secrets.js";
import { fakeMcpServer, textResult } from "./mcp-tools.test-support.js";
import {
  createNativeRunTools,
  executeRun,
  loadNativeRun,
  sandboxWorkerInput,
  type LoadedNativeRun,
  type NativeRunProviders,
} from "./runner.js";
import {
  identityCipher,
  memoryDatastore,
  MODEL,
  noMemory,
  scriptedModel,
  scriptFor,
} from "../native-worker/fixtures.test-support.js";
import { runStepInline } from "../providers/engine/types.js";
import type { McpProviders, McpRequestContext } from "../mcp/context.js";
import { buildMcpServer } from "../mcp/server.js";
import { registerRunTools } from "../mcp/tools/runs.js";

// End-to-end coverage of an attached MCP server's tools in a native run: offered as built-ins under
// their exposed names, served on the control plane, and the server's (fake) secret kept out of
// everything the run writes or reports.

const SECRET = "sk-fake-runner-mcp-0123456789";
const URL_ = "https://mcp.example.com/mcp";
const EXPOSED = "datadog__search";

describe.skipIf(!process.env.DATABASE_URL)("MCP tools in native runs (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `rmcp-owner-${tag}`;
  const agentId = `rmcp-agent-${tag}`;
  let serverId = "";
  let current = scriptedModel([]);
  const providers: NativeRunProviders = {
    get llm() {
      return current.llm;
    },
    engine: new NativeEngine(),
    datastore: memoryDatastore({}),
    secrets: identityCipher,
    memory: noMemory,
  };

  beforeAll(async () => {
    delete process.env.WARDBY_MCP_SERVERS;
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "Search.", model: MODEL, budgetUsd: 1, maxTurns: 4, ownerId },
    });
    await createSecret("DD_KEY", SECRET, ownerId, identityCipher, db, {
      broker: {
        hosts: ["mcp.example.com"],
        placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
      },
    });
    const server = await db.mcpServer.create({
      data: {
        ownerId,
        name: "datadog",
        url: URL_,
        secretNames: ["DD_KEY"],
        toolSnapshot: [{ name: "search", description: "Searches logs.", inputSchema: { type: "object" } }],
      },
    });
    serverId = server.id;
    await db.agentMcpServer.create({ data: { agentId, serverId, allowedTools: ["search"], attachedById: ownerId } });
  });
  beforeEach(() => {
    providers.sandboxFetch = undefined;
  });
  afterAll(async () => {
    const runs = await db.run.findMany({ where: { agentId }, select: { id: true } });
    const ids = runs.map((r) => r.id);
    await db.runModelUsage.deleteMany({ where: { runId: { in: ids } } });
    await db.runAttribution.deleteMany({ where: { runId: { in: ids } } });
    await db.run.deleteMany({ where: { id: { in: ids } } });
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    await db.mcpServer.deleteMany({ where: { ownerId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId } });
    await db.secret.deleteMany({ where: { ownerId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  async function loadTools(options: { deadlineAt?: Date } = {}) {
    const run = await db.run.create({ data: { agentId, trigger: "manual", status: "running" } });
    const loaded = (await loadNativeRun({
      runId: run.id,
      existingRun: run,
      providers,
      db,
      step: runStepInline,
      reviewHosts: undefined,
      issueTrackers: undefined,
    })) as LoadedNativeRun;
    const tools = createNativeRunTools({
      runId: run.id,
      existingRun: run,
      loaded,
      providers,
      db,
      reviewHosts: undefined,
      repoAccess: undefined,
      issueTrackers: undefined,
      ...options,
    });
    return { run, loaded, tools };
  }

  async function getRun(runId: string): Promise<string> {
    const principal = await db.principal.findUniqueOrThrow({ where: { id: ownerId } });
    const mcpProviders = { secrets: identityCipher } as unknown as McpProviders;
    const mcp = buildMcpServer({ providers: mcpProviders, db, config: { canonicalUri: "https://wardby.example/mcp" } });
    const ctx: McpRequestContext = {
      principal,
      scopes: new Set(["agents:read"]),
      roles: [],
      canonicalUri: "https://wardby.example/mcp",
      providers: mcpProviders,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerRunTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = (await client.callTool({ name: "get_run", arguments: { runId } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await client.close();
    expect(result.isError, result.content[0].text).toBeFalsy();
    return result.content[0].text;
  }

  it("offers the exposed name with the prefixed description and pins it in the load result", async () => {
    const { loaded } = await loadTools();
    expect(loaded.mcpTools?.map((p) => p.exposedName)).toEqual([EXPOSED]);
    expect(loaded.tools.find((t) => t.name === EXPOSED)?.description).toBe("From MCP server datadog: Searches logs.");
  });

  it("leaves mcpTools out of the load result when the agent has none", async () => {
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    try {
      const { loaded } = await loadTools();
      expect("mcpTools" in loaded).toBe(false);
      expect(loaded.tools.some((t) => t.name === EXPOSED)).toBe(false);
    } finally {
      await db.agentMcpServer.create({ data: { agentId, serverId, allowedTools: ["search"], attachedById: ownerId } });
    }
  });

  it("hands a sandbox worker the exposed name as a built-in, never as a user tool", async () => {
    const { run, loaded, tools } = await loadTools();
    const input = sandboxWorkerInput(run.id, loaded, tools);
    expect(input.builtinTools).toContain(EXPOSED);
    expect(Object.keys(input.userTools)).not.toContain(EXPOSED);
    expect(JSON.stringify(input)).not.toContain(SECRET);
  });

  it("serves the call in a run and keeps the server's secret out of the tool result, finalText and get_run", async () => {
    const server = fakeMcpServer((_name, args) => textResult(`found ${String(args.q)} with key ${SECRET}`));
    providers.sandboxFetch = server.impl;
    // The model's final answer repeats the secret, as if it had learned it some other way.
    current = scriptedModel(scriptFor(EXPOSED, { q: "errors" }, [`Done; the key was ${SECRET}.`]));
    const run = await db.run.create({ data: { agentId, trigger: "manual", nativeExecutionMode: "control_plane" } });
    const finished = await executeRun(run.id, providers, db);
    expect(finished.status).toBe("succeeded");
    expect(server.seen[0].authorization).toBe(`Bearer ${SECRET}`);
    const toolMessage = current.requests[1].messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("found errors with key [REDACTED]");
    expect(JSON.stringify(current.requests)).not.toContain(SECRET);
    expect(current.requests[0].tools?.map((t) => t.name)).toContain(EXPOSED);
    const stored = await db.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.finalText).toContain("Done; the key was");
    expect(stored.finalText).not.toContain(SECRET);
    expect(await getRun(run.id)).not.toContain(SECRET);
  });

  it("aborts a call in flight when the run is stopped", async () => {
    const { run, tools } = await loadTools();
    const server = fakeMcpServer(() => new Promise(() => {}));
    providers.sandboxFetch = server.impl;
    const handler = tools.builtinHandler(EXPOSED)!;
    const pending = handler("{}");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.run.update({ where: { id: run.id }, data: { status: "cancelled" } });
    expect(JSON.parse(await pending)).toEqual({ error: "mcp_call_timeout", message: "The call was stopped." });
  }, 15_000);

  it("cuts a call to the sandbox session's deadline", async () => {
    const { tools } = await loadTools({ deadlineAt: new Date(Date.now() + 150) });
    providers.sandboxFetch = fakeMcpServer(() => new Promise(() => {})).impl;
    const started = Date.now();
    const out = JSON.parse(await tools.builtinHandler(EXPOSED)!("{}"));
    expect(out.error).toBe("mcp_call_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("adds the server's secret to what a sandbox launcher and the gateway redact", async () => {
    const { tools } = await loadTools();
    expect((await tools.mcpSecretValues()).includes(SECRET)).toBe(true);
  });
});
