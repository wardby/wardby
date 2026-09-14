import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerMemoryTools } from "./memory.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

function fakeMemory() {
  const store = new Map<string, string>();
  return {
    get: async (agentId: string, key: string) => store.get(`${agentId}:${key}`),
    set: async (agentId: string, key: string, content: string) => {
      store.set(`${agentId}:${key}`, content);
    },
    delete: async (agentId: string, key: string) => {
      store.delete(`${agentId}:${key}`);
    },
    list: async (agentId: string) =>
      [...store.keys()].filter((k) => k.startsWith(`${agentId}:`)).map((k) => k.slice(`${agentId}:`.length)),
    search: async () => [],
  };
}

function fakeDb(agents: FakeAgentRow[]) {
  const rows = new Map(agents.map((a) => [a.id, a]));
  return {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  memory: ReturnType<typeof fakeMemory>,
  principalId: string,
  scopes: string[],
): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: { memory } as unknown as import("../../providers/index.js").ProviderRegistry,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
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

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("agent memory tools", () => {
  it("set_agent_memory (memory:write) then get_agent_memory (agents:read) round-trip for the owner", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "p1", ["agents:read", "memory:write"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    const setResult = await client.callTool({
      name: "set_agent_memory",
      arguments: { agentId: "a1", key: "k1", content: "v1" },
    });
    expect(setResult.isError).toBeFalsy();

    const getResult = await client.callTool({ name: "get_agent_memory", arguments: { agentId: "a1", key: "k1" } });
    expect(getResult.isError).toBeFalsy();
    expect(parseText(getResult as never)).toEqual({ content: "v1" });
    await client.close();
  });

  it("get_agent_memory returns null content for an unset key", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "p1", ["agents:read"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_agent_memory", arguments: { agentId: "a1", key: "missing" } });
    expect(parseText(result as never)).toEqual({ content: null });
    await client.close();
  });

  it("set_agent_memory requires memory:write, not agents:read", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "p1", ["agents:read"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "set_agent_memory",
      arguments: { agentId: "a1", key: "k1", content: "v1" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  it("memory access to another owner's agent is not found (no cross-agent leakage)", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "owner-1" }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "not-the-owner", ["agents:read", "memory:write"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    const getResult = await client.callTool({ name: "get_agent_memory", arguments: { agentId: "a1", key: "k1" } });
    expect(getResult.isError).toBe(true);

    const setResult = await client.callTool({
      name: "set_agent_memory",
      arguments: { agentId: "a1", key: "k1", content: "v1" },
    });
    expect(setResult.isError).toBe(true);
    await client.close();
  });

  it("a public (ownerId: null) agent's memory is readable and writable by any principal", async () => {
    const db = fakeDb([{ id: "a1", ownerId: null }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "anyone", ["agents:read", "memory:write"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    const listResult = await client.callTool({ name: "list_agent_memory", arguments: { agentId: "a1" } });
    expect(listResult.isError).toBeFalsy();

    const setResult = await client.callTool({
      name: "set_agent_memory",
      arguments: { agentId: "a1", key: "k1", content: "v1" },
    });
    expect(setResult.isError).toBeFalsy();

    const deleteResult = await client.callTool({
      name: "delete_agent_memory",
      arguments: { agentId: "a1", key: "k1" },
    });
    expect(deleteResult.isError).toBeFalsy();
    await client.close();
  });

  it("delete_agent_memory removes a key, and list_agent_memory reflects it", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const memory = fakeMemory();
    const mcp = buildMcpServer({ providers: { memory } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, memory, "p1", ["agents:read", "memory:write"]));
    registerMemoryTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "set_agent_memory", arguments: { agentId: "a1", key: "k1", content: "v1" } });
    const listed = await client.callTool({ name: "list_agent_memory", arguments: { agentId: "a1" } });
    expect(parseText(listed as never)).toEqual(["k1"]);

    await client.callTool({ name: "delete_agent_memory", arguments: { agentId: "a1", key: "k1" } });
    const listedAfter = await client.callTool({ name: "list_agent_memory", arguments: { agentId: "a1" } });
    expect(parseText(listedAfter as never)).toEqual([]);
    await client.close();
  });
});
