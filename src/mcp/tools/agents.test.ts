import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  schedule: string | null;
  timezone: string;
  ownerId: string | null;
  tools: unknown[];
}

function fakeDb(seed: FakeAgentRow[] = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  let counter = rows.size;
  return {
    agent: {
      create: async ({ data }: { data: Partial<FakeAgentRow> & { name: string } }) => {
        const row: FakeAgentRow = {
          id: `agent_${++counter}`,
          systemPrompt: "",
          model: "",
          budgetUsd: 0,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: null,
          tools: [],
          ...data,
        } as FakeAgentRow;
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...rows.values()];
        if (!where?.OR) return all;
        return all.filter((r) => where.OR!.some((cond) => r.ownerId === cond.ownerId));
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeAgentRow> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        rows.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row;
      },
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() } as never,
    scopes: new Set(scopes),
    providers: fakeProviders,
    db,
    clientSupportsTasks: false,
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("agent CRUD tools", () => {
  it("create_agent persists with owner = caller", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "greeter", systemPrompt: "be nice", model: "gpt-4o", budgetUsd: 5 },
    });
    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.name).toBe("greeter");
    expect(created.ownerId).toBe("p1");

    await client.close();
  });

  it("create_agent without agents:write scope is rejected (insufficient_scope, not forbidden)", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "x", systemPrompt: "x", model: "x", budgetUsd: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  it("update_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      { id: "a1", name: "shared", systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 10, schedule: null, timezone: "UTC", ownerId: "owner-1", tools: [] },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "update_agent", arguments: { id: "a1", systemPrompt: "hacked" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/owned|forbidden/i);
    await client.close();
  });

  it("delete_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      { id: "a1", name: "shared", systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 10, schedule: null, timezone: "UTC", ownerId: "owner-1", tools: [] },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("list_agents returns caller's own agents plus public (null-owner) ones, not other owners'", async () => {
    const db = fakeDb([
      { id: "a1", name: "mine", systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 10, schedule: null, timezone: "UTC", ownerId: "p1", tools: [] },
      { id: "a2", name: "public", systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 10, schedule: null, timezone: "UTC", ownerId: null, tools: [] },
      { id: "a3", name: "someone-elses", systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 10, schedule: null, timezone: "UTC", ownerId: "p2", tools: [] },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.isError).toBeFalsy();
    const list = JSON.parse((result.content as { text: string }[])[0].text) as { name: string }[];
    const names = list.map((a) => a.name).sort();
    expect(names).toEqual(["mine", "public"]);
    await client.close();
  });
});
