import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerWebhookTools } from "./webhooks.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeWebhookRow {
  id: string;
  agentId: string;
  secretHash: string;
  status: "enabled" | "disabled";
  ownerId: string | null;
  createdAt: Date;
  lastFiredAt: Date | null;
}
interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

function fakeDb(agents: FakeAgentRow[]) {
  const webhooks = new Map<string, FakeWebhookRow>();
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  let counter = 0;

  return {
    webhook: {
      create: async ({ data }: { data: Partial<FakeWebhookRow> & { agentId: string; secretHash: string } }) => {
        const row: FakeWebhookRow = {
          id: `webhook_${++counter}`,
          status: "enabled",
          ownerId: null,
          createdAt: new Date(),
          lastFiredAt: null,
          ...data,
        };
        webhooks.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: { where: { ownerId: string } }) =>
        [...webhooks.values()].filter((w) => w.ownerId === where.ownerId),
      findUnique: async ({ where }: { where: { id: string } }) => webhooks.get(where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        const row = webhooks.get(where.id);
        webhooks.delete(where.id);
        return row;
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
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

describe("webhook tools", () => {
  it("create_webhook returns a secret once, and it never reappears in list_webhooks", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["webhooks:write"]));
    registerWebhookTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } });
    expect(created.isError).toBeFalsy();
    const body = parseText(created as never) as { id: string; secret: string };
    expect(body.secret).toBeTruthy();

    const listed = await client.callTool({ name: "list_webhooks", arguments: {} });
    const list = parseText(listed as never) as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(JSON.stringify(list)).not.toContain(body.secret);
    await client.close();
  });

  it("create_webhook on a non-owned agent is forbidden", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "someone-else" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["webhooks:write"]));
    registerWebhookTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("delete_webhook removes it from list_webhooks", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["webhooks:write"]));
    registerWebhookTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } });
    const { id } = parseText(created as never) as { id: string };
    await client.callTool({ name: "delete_webhook", arguments: { id } });
    const listed = await client.callTool({ name: "list_webhooks", arguments: {} });
    expect(parseText(listed as never)).toEqual([]);
    await client.close();
  });
});
