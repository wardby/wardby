import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../mcp/server.js";
import { registerToolAuthoringTools } from "../mcp/tools/tools.js";
import type { McpRequestContext } from "../mcp/context.js";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { Engine, EngineRunContext } from "../providers/engine/types.js";
import type { LlmProvider } from "../providers/index.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import { runAgent, type RunnerDb } from "./runner.js";

/**
 * Closes finding #1's gap end-to-end: attach_tool (the MCP tool, the same
 * code path an operator actually calls) persists
 * allowedSharedDatastorePrefixes, and runAgent's sandboxed tool execution
 * honors exactly that persisted grant — not a hand-built attachment row
 * that bypasses attach_tool entirely, like runner.test.ts's other
 * sharedDatastore tests do. Proves the write path (tools.ts) and the read
 * path (runner.ts / datastores.ts) are actually connected.
 */

interface Row {
  id: string;
  name?: string;
  ownerId: string | null;
  kind?: "native" | "coding";
}

function buildCombinedDb(
  agentRow: Row,
  toolRow: Row & { paramsZod: string; jsonSchema: unknown; code: string; description: string },
) {
  const agents = new Map<string, any>([
    [agentRow.id, { ...agentRow, systemPrompt: "sys", model: "m", budgetUsd: 10, maxTurns: 10 }],
  ]);
  const tools = new Map<string, any>([[toolRow.id, toolRow]]);
  const attachments: {
    agentId: string;
    toolId: string;
    allowedSecrets?: string[];
    allowedDatastorePrefixes?: string[];
    allowedHosts?: string[];
    allowedSharedDatastorePrefixes?: Record<string, string[]>;
  }[] = [];
  const agentDatastores: { agentId: string; boundName: string; datastoreId: string }[] = [];
  const runs = new Map<string, any>();
  let counter = 0;

  const db = {
    agent: {
      findUnique: async ({ where }: any) =>
        (where.name ? [...agents.values()].find((a) => a.name === where.name) : agents.get(where.id)) ?? null,
    },
    tool: {
      findUnique: async ({ where }: any) => tools.get(where.id) ?? null,
    },
    run: {
      create: async ({ data }: any) => {
        const id = `run_${++counter}`;
        const record = {
          id,
          status: "pending",
          trigger: "manual",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          error: null,
          startedAt: new Date(),
          finishedAt: null,
          heartbeatAt: null,
          ...data,
        };
        runs.set(id, record);
        return record;
      },
      findUnique: async ({ where }: any) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const record = runs.get(where.id);
        if (!record) throw new Error(`No Run with id "${where.id}".`);
        return record;
      },
      update: async ({ where, data }: any) => {
        const record = { ...runs.get(where.id), ...data };
        runs.set(where.id, record);
        return record;
      },
      updateMany: async ({ where, data }: any) => {
        const record = runs.get(where.id);
        if (!record) return { count: 0 };
        if (where.status !== undefined) {
          const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
          if (!allowed.includes(record.status)) return { count: 0 };
        }
        runs.set(where.id, { ...record, ...data });
        return { count: 1 };
      },
      findMany: async () => [],
    },
    agentTool: {
      upsert: async ({ where, create, update }: any) => {
        const idx = attachments.findIndex(
          (a) => a.agentId === where.agentId_toolId.agentId && a.toolId === where.agentId_toolId.toolId,
        );
        if (idx === -1) {
          attachments.push({ ...create });
          return attachments[attachments.length - 1];
        }
        attachments[idx] = { ...attachments[idx], ...update };
        return attachments[idx];
      },
      findMany: async ({ where }: any) =>
        attachments.filter((a) => a.agentId === where.agentId).map((a) => ({ ...a, tool: tools.get(a.toolId) })),
      // attach_tool's same-name guard: this fixture never attaches two
      // same-named tools to one agent.
      findFirst: async () => null,
    },
    agentSecret: {
      findFirst: async () => null,
    },
    agentDatastore: {
      findFirst: async ({ where }: any) =>
        agentDatastores.find((d) => d.agentId === where.agentId && d.boundName === where.boundName) ?? null,
    },
    budgetGroup: {
      findUnique: async () => null,
    },
    agentSubAgent: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    $transaction: async (callback: any) => callback(db),
  };

  return { db: db as unknown as RunnerDb, agentDatastores };
}

function fakeSharedDatastore(): Datastore {
  const sharedStore = new Map<string, DatastoreValue>();
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async delete() {},
    async list() {
      return [];
    },
    async getShared(datastoreId, key) {
      return sharedStore.get(`${datastoreId}:${key}`);
    },
    async setShared(datastoreId, key, value) {
      sharedStore.set(`${datastoreId}:${key}`, value);
    },
    async deleteShared(datastoreId, key) {
      sharedStore.delete(`${datastoreId}:${key}`);
    },
    async listShared(datastoreId, prefix) {
      const p = `${datastoreId}:${prefix ?? ""}`;
      return [...sharedStore.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.slice(datastoreId.length + 1))
        .sort();
    },
  };
}

function fakeMemory(): AgentMemoryStore {
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async list() {
      return [];
    },
    async search() {
      return [];
    },
    async delete() {},
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("attach_tool -> runAgent shared-datastore grant, end to end", () => {
  it("a boundName granted via attach_tool lets the sandbox write/read within its prefix and denies outside it", async () => {
    const agentRow: Row = { id: "a1", name: "shared-e2e", ownerId: "p1" };
    const toolRow = {
      id: "t1",
      name: "kb_tool",
      description: "x",
      paramsZod: "z.object({ key: z.string() })",
      jsonSchema: {},
      code: "await sharedDatastore.set('kb', params.key, 'v'); return await sharedDatastore.get('kb', params.key);",
      ownerId: "p1",
    };
    const { db, agentDatastores } = buildCombinedDb(agentRow, toolRow);
    agentDatastores.push({ agentId: "a1", boundName: "kb", datastoreId: "ds1" });

    const fakeProviders = {
      datastore: fakeSharedDatastore(),
    } as unknown as import("../providers/index.js").ProviderRegistry;

    const mcp = buildMcpServer({
      providers: fakeProviders,
      db: db as never,
      config: { canonicalUri: "https://host/mcp" },
    });
    const ctx: McpRequestContext = {
      principal: { id: "p1", subject: "p1", createdAt: new Date() },
      scopes: new Set(["tools:write"]),
      canonicalUri: "https://host/mcp",
      providers: fakeProviders,
      db: db as never,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    // The real MCP tool an operator calls — this is the write path finding
    // #1 said was dead. Only "allowed:" is granted for boundName "kb".
    const attach = await client.callTool({
      name: "attach_tool",
      arguments: {
        agentId: "a1",
        toolId: "t1",
        allowedSharedDatastorePrefixes: { kb: ["allowed:"] },
      },
    });
    expect(attach.isError).toBeFalsy();
    await client.close();

    // Prove it was actually persisted, not silently dropped.
    const rows = await (db as any).agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0].allowedSharedDatastorePrefixes).toEqual({ kb: ["allowed:"] });

    // Now run the agent for real and exercise the grant through the sandbox.
    let captured: EngineRunContext | undefined;
    const engine: Engine = {
      async run(runCtx) {
        captured = runCtx;
        return {
          status: "succeeded",
          finalText: "",
          turns: 1,
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        };
      },
    };

    await runAgent(
      "shared-e2e",
      {
        llm: {} as LlmProvider,
        engine,
        datastore: fakeSharedDatastore(),
        secrets: {} as SecretCipher,
        memory: fakeMemory(),
      },
      db,
    );

    const allowed = JSON.parse(await captured!.runSandboxTool("kb_tool", JSON.stringify({ key: "allowed:1" })));
    expect(allowed).toBe("v");

    const denied = JSON.parse(await captured!.runSandboxTool("kb_tool", JSON.stringify({ key: "blocked:1" })));
    expect(denied).toMatchObject({
      error: "thrown",
      message: expect.stringContaining("datastore_prefix_not_allowed"),
    });
  });
});
