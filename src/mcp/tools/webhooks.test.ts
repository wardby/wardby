import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerWebhookTools } from "./webhooks.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

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

function fakeDb(agents: FakeAgentRow[], grants: FakeGrantSeed[] = []) {
  const webhooks = new Map<string, FakeWebhookRow>();
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  let counter = 0;

  return {
    resourceGrant: fakeResourceGrants(grants),
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
      // Mirrors listWebhooks' where: created by the caller, or on an agent it owns.
      findMany: async ({ where }: { where: { OR?: [{ ownerId: string }, { agent: { ownerId: string } }] } }) =>
        [...webhooks.values()].filter(
          (w) =>
            !where.OR ||
            w.ownerId === where.OR[0].ownerId ||
            agentRows.get(w.agentId)?.ownerId === where.OR[1].agent.ownerId,
        ),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = webhooks.get(where.id);
        return row ? { ...row, agent: agentRows.get(row.agentId) ?? { ownerId: null } } : null;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = webhooks.get(where.id);
        webhooks.delete(where.id);
        return row;
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
  } as unknown as import("#prisma").PrismaClient;
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

  describe("under grants", () => {
    async function as(
      principalId: string,
      grants: FakeGrantSeed[],
      db = fakeDb([{ id: "a1", ownerId: "owner" }], grants),
    ) {
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, principalId, ["webhooks:write"]));
      registerWebhookTools(mcp);
      return { db, client: await connectClient(mcp) };
    }
    const grant = (level: string): FakeGrantSeed => ({
      resourceType: "agent",
      resourceId: "a1",
      principalId: "g",
      level,
    });

    it("create_webhook needs write on the agent (a standing trigger)", async () => {
      const writer = await as("g", [grant("write")]);
      expect(
        (await writer.client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } })).isError,
      ).toBeFalsy();
      await writer.client.close();
      const runner = await as("g", [grant("execute")]);
      const refused = await runner.client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toMatch(/needs write/);
      await runner.client.close();
    });

    it("the agent owner sees and can delete a webhook a grantee created on their agent", async () => {
      const db = fakeDb([{ id: "a1", ownerId: "owner" }], [grant("write")]);
      const grantee = await as("g", [], db);
      const created = await grantee.client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } });
      const { id } = parseText(created as never) as { id: string };
      await grantee.client.close();

      const owner = await as("owner", [], db);
      const listed = parseText((await owner.client.callTool({ name: "list_webhooks", arguments: {} })) as never);
      expect((listed as { id: string }[]).map((w) => w.id)).toEqual([id]);
      const deleted = await owner.client.callTool({ name: "delete_webhook", arguments: { id } });
      expect(deleted.isError).toBeFalsy();
      expect(parseText((await owner.client.callTool({ name: "list_webhooks", arguments: {} })) as never)).toEqual([]);
      await owner.client.close();
    });

    it("a stranger can neither list nor delete someone else's webhook", async () => {
      const db = fakeDb([{ id: "a1", ownerId: "owner" }]);
      const owner = await as("owner", [], db);
      const { id } = parseText(
        (await owner.client.callTool({ name: "create_webhook", arguments: { agentId: "a1" } })) as never,
      ) as { id: string };
      await owner.client.close();
      const stranger = await as("stranger", [], db);
      expect(parseText((await stranger.client.callTool({ name: "list_webhooks", arguments: {} })) as never)).toEqual(
        [],
      );
      expect((await stranger.client.callTool({ name: "delete_webhook", arguments: { id } })).isError).toBe(true);
      await stranger.client.close();
    });
  });
});
