/**
 * The run hook MCP tools against real PostgreSQL: create/update/list/delete,
 * the agent-owner rule for secrets and hosts, includeFinalText needing an
 * admin, config checked against the tool's params schema and refused when it
 * holds a secret value, test_run_hook's synthetic delivery, and delete_tool
 * refusing while a hook uses the tool. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { attachSecret, createSecret } from "../../core/secrets.js";
import type { Datastore } from "../../providers/datastore/types.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerRunHookTools } from "./run-hooks.js";
import { registerToolAuthoringTools } from "./tools.js";

const SECRET = "fake-run-hook-secret-4242";

describe.skipIf(!process.env.DATABASE_URL)("run hook MCP tools (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const datastore = {
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    list: async () => [],
  } as unknown as Datastore;
  const s = randomUUID();
  const id = (name: string) => `rhmcp-${name}-${s}`;
  const secretName = `RH_KEY_${s.slice(0, 8)}`;
  let owner: Principal;
  let other: Principal;
  const agent = id("agent");
  const tool = id("tool");
  const strictTool = id("strict-tool");

  async function connect(p: Principal, opts: { admin?: boolean } = {}) {
    const providers = { secrets: cipher, datastore } as unknown as McpProviders;
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
    registerRunHookTools(mcp);
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

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: id("owner") } });
    other = await db.principal.create({ data: { subject: id("other") } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(secretName, SECRET, owner.id, cipher, db);
    await attachSecret(agent, secretName, owner.id, db);
    await db.tool.create({
      data: {
        id: tool,
        name: tool,
        description: "t",
        paramsZod:
          "z.object({ event: z.object({ kind: z.string() }).passthrough(), config: z.object({}).passthrough() })",
        jsonSchema: {},
        ownerId: owner.id,
        code: "return params.event.kind;",
      },
    });
    await db.tool.create({
      data: {
        id: strictTool,
        name: strictTool,
        description: "t",
        paramsZod: "z.object({ event: z.object({}).passthrough(), config: z.object({ to: z.string() }) })",
        jsonSchema: {},
        ownerId: owner.id,
        code: "return 1;",
      },
    });
  });

  afterAll(async () => {
    await db.runHook.deleteMany({ where: { agentId: agent } });
    await db.tool.deleteMany({ where: { id: { in: [tool, strictTool] } } });
    await db.agentSecret.deleteMany({ where: { agentId: agent } });
    await db.secret.deleteMany({ where: { ownerId: owner.id } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    await db.$disconnect();
  });

  it("creates a hook with the owner's capabilities, lists it, updates and deletes it", async () => {
    const call = await connect(owner);
    const created = await call("create_run_hook", {
      agentId: agent,
      toolId: tool,
      events: ["run_completed"],
      statuses: ["failed"],
      config: { channel: "C0123" },
      allowedSecrets: [secretName],
      allowedHosts: ["slack.com"],
    });
    expect(created.isError).toBe(false);
    const hook = created.json.hook;
    expect(hook).toMatchObject({
      agentId: agent,
      toolId: tool,
      toolName: tool,
      events: ["run_completed"],
      statuses: ["failed"],
      runs: "top_level",
      includeFinalText: false,
      config: { channel: "C0123" },
      allowedSecrets: [secretName],
      allowedHosts: ["slack.com"],
      capabilitiesGranted: true,
      enabled: true,
    });

    const listed = await call("list_run_hooks", { agentId: agent });
    expect(listed.json.hooks.find((h: { id: string }) => h.id === hook.id)).toMatchObject({ pending: 0, failed: 0 });

    const updated = await call("update_run_hook", { hookId: hook.id, events: [], runs: "all", enabled: false });
    expect(updated.json.hook).toMatchObject({ events: [], runs: "all", enabled: false, allowedSecrets: [] });

    expect((await call("delete_run_hook", { hookId: hook.id })).json).toEqual({ deleted: true, hookId: hook.id });
    expect(await db.runHook.findUnique({ where: { id: hook.id } })).toBeNull();
  });

  it("needs an admin for includeFinalText", async () => {
    const refused = await connect(owner);
    const res = await refused("create_run_hook", { agentId: agent, toolId: tool, includeFinalText: true });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("final_text_needs_admin");
    const admin = await connect(owner, { admin: true });
    const ok = await admin("create_run_hook", { agentId: agent, toolId: tool, includeFinalText: true });
    expect(ok.json.hook.includeFinalText).toBe(true);
    const row = await db.runHook.findUniqueOrThrow({ where: { id: ok.json.hook.id } });
    expect(row.finalTextApprovedById).toBe(owner.id);
  });

  it("refuses a config the tool's params schema rejects", async () => {
    const call = await connect(owner);
    const res = await call("create_run_hook", { agentId: agent, toolId: strictTool, config: { wrong: 1 } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("hook_config_rejected");
  });

  it("refuses a config that holds one of the agent's secret values", async () => {
    const call = await connect(owner);
    const res = await call("create_run_hook", { agentId: agent, toolId: tool, config: { token: SECRET } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("hook_config_has_secret");
    expect(res.text).not.toContain(SECRET);
  });

  it("refuses unknown event kinds and statuses", async () => {
    const call = await connect(owner);
    expect((await call("create_run_hook", { agentId: agent, toolId: tool, events: ["nope"] })).isError).toBe(true);
    expect((await call("create_run_hook", { agentId: agent, toolId: tool, statuses: ["running"] })).isError).toBe(true);
  });

  it("only the agent's owner grants secrets and hosts", async () => {
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agent,
        granteeKind: "principal",
        granteePrincipalId: other.id,
        granteeKey: `principal:${other.id}`,
        level: "write",
        grantedById: owner.id,
      },
    });
    try {
      const call = await connect(other);
      const res = await call("create_run_hook", { agentId: agent, toolId: tool, allowedHosts: ["slack.com"] });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Only the agent's owner");
    } finally {
      await db.resourceGrant.deleteMany({ where: { resourceId: agent, granteePrincipalId: other.id } });
    }
  });

  it("test_run_hook runs the tool on a synthetic run_completed event", async () => {
    const call = await connect(owner);
    const created = await call("create_run_hook", { agentId: agent, toolId: tool });
    expect((await call("test_run_hook", { hookId: created.json.hook.id })).json).toEqual({ ok: true });
  });

  it("delete_tool refuses while a hook uses the tool, and detach removes the hook", async () => {
    const call = await connect(owner);
    await call("create_run_hook", { agentId: agent, toolId: strictTool, config: { to: "x" } });
    const refused = await call("delete_tool", { toolId: strictTool });
    expect(refused.isError).toBe(true);
    const deleted = await call("delete_tool", { toolId: strictTool, detach: true });
    expect(deleted.isError).toBe(false);
    expect(await db.runHook.count({ where: { toolId: strictTool } })).toBe(0);
  });
});
