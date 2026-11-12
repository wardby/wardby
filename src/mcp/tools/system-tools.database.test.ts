/**
 * System tool MCP tools against real PostgreSQL (#529): make_tool_public and
 * the connection grants need an admin; an admin may update and delete a public
 * tool (clearing other owners' consent), a non-admin still may not; list_tools
 * shows a public tool's connections. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { ChatProvider } from "../../providers/chat/types.js";
import type { Datastore } from "../../providers/datastore/types.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerSystemToolTools } from "./system-tools.js";
import { registerToolAuthoringTools } from "./tools.js";

describe.skipIf(!process.env.DATABASE_URL)("system tool MCP tools (database)", () => {
  const db = createPrismaClient();
  const datastore = {} as Datastore;
  const s = randomUUID();
  const id = (name: string) => `systmcp-${name}-${s}`;
  let alice: Principal;
  let bob: Principal;
  const bobAgent = id("bob-agent");

  async function connect(p: Principal, opts: { admin?: boolean; slack?: boolean } = {}) {
    const chat = opts.slack === false ? {} : { slack: { name: "slack" } as unknown as ChatProvider };
    const providers = { datastore, chat } as unknown as McpProviders;
    const canonicalUri = "https://wardby.example/mcp";
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
    const ctx: McpRequestContext = {
      principal: p,
      scopes: new Set(["agents:read", "agents:write", "tools:write", ...(opts.admin ? ["agents:admin"] : [])]),
      roles: opts.admin ? ["admin"] : [],
      canonicalUri,
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerSystemToolTools(mcp);
    registerToolAuthoringTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      const text = result.content[0].text;
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        // an error message
      }
      return { isError: Boolean(result.isError), text, json };
    };
  }

  const tool = (name: string, ownerId: string | null) =>
    db.tool.create({
      data: {
        id: id(name),
        name: id(name),
        description: "t",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "return 1;",
        ownerId,
      },
    });

  beforeAll(async () => {
    alice = await db.principal.create({ data: { subject: id("alice") } });
    bob = await db.principal.create({ data: { subject: id("bob") } });
    await db.agent.create({
      data: { id: bobAgent, name: bobAgent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: bob.id },
    });
  });

  afterAll(async () => {
    await db.runHook.deleteMany({ where: { agentId: bobAgent } });
    await db.agentTool.deleteMany({ where: { agentId: bobAgent } });
    await db.tool.deleteMany({ where: { name: { endsWith: s } } });
    await db.agent.deleteMany({ where: { id: bobAgent } });
    await db.principal.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await db.$disconnect();
  });

  it("refuses all three to a non-admin", async () => {
    await tool("mine", alice.id);
    const call = await connect(alice);
    for (const [name, args] of [
      ["make_tool_public", { toolId: id("mine") }],
      ["grant_tool_connection", { toolId: id("mine"), connection: "slack", channels: ["*"] }],
      ["revoke_tool_connection", { toolId: id("mine"), connection: "slack" }],
    ] as const) {
      expect((await call(name, args)).isError).toBe(true);
    }
    expect((await db.tool.findUniqueOrThrow({ where: { id: id("mine") } })).ownerId).toBe(alice.id);
  });

  it("publishes, grants, lists and revokes as an admin", async () => {
    await tool("system", alice.id);
    const admin = await connect(alice, { admin: true });
    const published = await admin("make_tool_public", { toolId: id("system") });
    expect(published.json).toMatchObject({ id: id("system"), public: true, publishedById: alice.id });

    expect(
      (await admin("grant_tool_connection", { toolId: id("system"), connection: "slack", channels: [] })).isError,
    ).toBe(true);
    const granted = await admin("grant_tool_connection", {
      toolId: id("system"),
      connection: "slack",
      channels: ["c0abc"],
    });
    expect(granted.json).toMatchObject({ channels: ["C0ABC"], grantedById: alice.id });

    // Anyone who sees the public tool sees what it can reach.
    const listed = await (await connect(bob))("list_tools");
    expect(listed.json.find((t: { id: string }) => t.id === id("system"))).toMatchObject({
      public: true,
      connections: [{ connection: "slack", channels: ["C0ABC"] }],
    });

    expect((await admin("revoke_tool_connection", { toolId: id("system"), connection: "slack" })).json).toMatchObject({
      revoked: true,
    });
  });

  it("refuses a grant when the server has no Slack connection", async () => {
    await tool("noslack", null);
    const admin = await connect(alice, { admin: true, slack: false });
    const res = await admin("grant_tool_connection", { toolId: id("noslack"), connection: "slack", channels: ["*"] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("slack_not_configured");
  });

  it("lets an admin update a public tool another owner uses, clearing that owner's consent", async () => {
    await tool("fixme", null);
    await db.agentTool.create({ data: { agentId: bobAgent, toolId: id("fixme"), capabilitiesGrantedById: bob.id } });
    expect((await (await connect(alice))("update_tool", { toolId: id("fixme"), code: "return 2;" })).isError).toBe(
      true,
    );
    const updated = await (
      await connect(alice, { admin: true })
    )("update_tool", {
      toolId: id("fixme"),
      code: "return 2;",
    });
    expect(updated.json).toMatchObject({ code: "return 2;", consentCleared: { attachments: 1, hooks: 0 } });
    expect(await db.agentTool.findFirst({ where: { toolId: id("fixme") } })).toMatchObject({
      capabilitiesGrantedById: null,
    });
  });

  it("lets an admin delete an unused public tool", async () => {
    await tool("gone", null);
    expect((await (await connect(alice))("delete_tool", { toolId: id("gone") })).isError).toBe(true);
    expect((await (await connect(alice, { admin: true }))("delete_tool", { toolId: id("gone") })).isError).toBe(false);
    expect(await db.tool.findUnique({ where: { id: id("gone") } })).toBeNull();
  });
});
