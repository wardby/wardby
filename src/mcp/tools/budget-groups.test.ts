import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerBudgetGroupTools } from "./budget-groups.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeGroupRow {
  id: string;
  name: string;
  ownerId: string | null;
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  warnThresholdRatio: number;
}

function fakeDb(agentsByGroup: Record<string, { id: string; name: string }[]> = {}) {
  const groups = new Map<string, FakeGroupRow>();
  let counter = 0;

  return {
    budgetGroup: {
      create: async ({ data }: { data: Partial<FakeGroupRow> & { name: string; ownerId: string | null } }) => {
        const row: FakeGroupRow = {
          id: `bg_${++counter}`,
          dailyBudgetUsd: null,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          ...data,
        };
        groups.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeGroupRow> }) => {
        const row = groups.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        groups.set(where.id, updated);
        return updated;
      },
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...groups.values()];
        if (!where?.OR) return all;
        return all.filter((g) => where.OR!.some((cond) => g.ownerId === cond.ownerId));
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = groups.get(where.id);
        if (!row) return null;
        return { ...row, agents: agentsByGroup[where.id] ?? [] };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = groups.get(where.id);
        groups.delete(where.id);
        return row;
      },
    },
    run: {
      findMany: async () => [],
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    providers: fakeProviders,
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

describe("budget group tools", () => {
  it("create_budget_group requires at least one period cap", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "create_budget_group", arguments: { name: "team" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("creates a group owned by the caller, then lists and gets it back with live spend", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write", "agents:read"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_budget_group",
      arguments: { name: "team", dailyBudgetUsd: 25 },
    });
    expect(created.isError).toBeFalsy();
    const group = parseText(created as never) as { id: string; ownerId: string };
    expect(group.ownerId).toBe("p1");

    const listed = await client.callTool({ name: "list_budget_groups", arguments: {} });
    expect((parseText(listed as never) as unknown[]).length).toBe(1);

    const got = await client.callTool({ name: "get_budget_group", arguments: { id: group.id } });
    const gotBody = parseText(got as never) as { spend: { period: string; capUsd: number }[] };
    expect(gotBody.spend).toEqual([{ period: "day", capUsd: 25, spentUsd: 0, remainingUsd: 25 }]);
    await client.close();
  });

  it("update_budget_group refuses a caller who doesn't own the group", async () => {
    // One shared db, two server instances with different fixed identities
    // — a real second caller talking to the same backing store, not a
    // separate fake with patched-in behavior.
    const db = fakeDb();
    const ownerMcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    ownerMcp.setFixedContext(fakeCtx(db, "owner", ["budget_groups:write"]));
    registerBudgetGroupTools(ownerMcp);
    const ownerClient = await connectClient(ownerMcp);
    const created = await ownerClient.callTool({
      name: "create_budget_group",
      arguments: { name: "team", dailyBudgetUsd: 25 },
    });
    const group = parseText(created as never) as { id: string };
    await ownerClient.close();

    const otherMcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    otherMcp.setFixedContext(fakeCtx(db, "not-the-owner", ["budget_groups:write"]));
    registerBudgetGroupTools(otherMcp);
    const otherClient = await connectClient(otherMcp);
    const updateResult = await otherClient.callTool({
      name: "update_budget_group",
      arguments: { id: group.id, dailyBudgetUsd: 999 },
    });
    expect(updateResult.isError).toBe(true);
    await otherClient.close();
  });

  it("delete_budget_group requires ownership and returns the deleted id", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["budget_groups:write"]));
    registerBudgetGroupTools(mcp);
    const client = await connectClient(mcp);
    const created = await client.callTool({
      name: "create_budget_group",
      arguments: { name: "team", weeklyBudgetUsd: 50 },
    });
    const group = parseText(created as never) as { id: string };

    const deleted = await client.callTool({ name: "delete_budget_group", arguments: { id: group.id } });
    expect(parseText(deleted as never)).toEqual({ deleted: group.id });
    await client.close();
  });
});
