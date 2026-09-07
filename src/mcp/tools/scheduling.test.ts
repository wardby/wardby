import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerSchedulingTools } from "./scheduling.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
  schedule: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  kind?: "native" | "coding";
  codingProfile?: { defaultTask: string | null } | null;
}

function fakeDb(agents: FakeAgentRow[]) {
  const rows = new Map(agents.map((a) => [a.id, a]));
  const transactionDb = {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeAgentRow> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        rows.set(where.id, updated);
        return updated;
      },
    },
  };
  return {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
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

describe("scheduling tools", () => {
  it("set_schedule validates the cron expression and persists it", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1", schedule: null, timezone: "UTC", scheduleEnabled: true }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerSchedulingTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "set_schedule",
      arguments: { agentId: "a1", schedule: "0 * * * *", timezone: "America/Chicago" },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { schedule: string; timezone: string; scheduleEnabled: boolean };
    expect(body.schedule).toBe("0 * * * *");
    expect(body.timezone).toBe("America/Chicago");
    expect(body.scheduleEnabled).toBe(true);
    await client.close();
  });

  it("set_schedule rejects an invalid cron expression", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1", schedule: null, timezone: "UTC", scheduleEnabled: true }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerSchedulingTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "set_schedule",
      arguments: { agentId: "a1", schedule: "not a cron", timezone: "UTC" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("set_schedule requires a default task for coding agents", async () => {
    const db = fakeDb([
      {
        id: "a1",
        ownerId: "p1",
        schedule: null,
        timezone: "UTC",
        scheduleEnabled: false,
        kind: "coding",
        codingProfile: { defaultTask: null },
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerSchedulingTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "set_schedule",
      arguments: { agentId: "a1", schedule: "0 * * * *", timezone: "UTC" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/default task/i);
    await client.close();
  });

  it("set_schedule by a non-owner is forbidden", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "owner-1", schedule: null, timezone: "UTC", scheduleEnabled: true }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerSchedulingTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "set_schedule",
      arguments: { agentId: "a1", schedule: "0 * * * *", timezone: "UTC" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("disable_schedule clears scheduleEnabled for the owner", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1", schedule: "0 * * * *", timezone: "UTC", scheduleEnabled: true }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerSchedulingTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "disable_schedule", arguments: { agentId: "a1" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { scheduleEnabled: boolean };
    expect(body.scheduleEnabled).toBe(false);
    await client.close();
  });
});
