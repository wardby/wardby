import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { EVERYONE_KEY, agentOwnerBindings, isPublicWritable } from "../../core/grants.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerAgentTools } from "./agents.js";
import { registerDatastoreTools } from "./datastore.js";
import { registerGrantTools } from "./grants.js";
import { registerRepositoryTools } from "./repositories.js";
import { registerSecretsTools } from "./secrets.js";
import { registerSubAgentTools } from "./subagents.js";
import { registerToolAuthoringTools } from "./tools.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];
const CANONICAL = "https://host/mcp";

type Result = { isError?: boolean; content: { text: string }[] };

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `public-write-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function agent(ownerId: string, extra: Record<string, unknown> = {}) {
  const a = await db.agent.create({
    data: {
      name: `public-write-${randomUUID()}`,
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      ownerId,
      ...extra,
    },
  });
  agentIds.push(a.id);
  return a;
}

async function everyoneWrite(agentId: string) {
  await db.resourceGrant.create({
    data: {
      resourceType: "agent",
      resourceId: agentId,
      granteeKind: "everyone",
      granteeKey: EVERYONE_KEY,
      level: "write",
    },
  });
}

/** An MCP client acting as `who`, with every scope; `admin` adds the admin role. */
async function connect(who: Principal, admin = false) {
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: admin ? ["admin"] : [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerAgentTools(mcp);
  registerGrantTools(mcp);
  registerSecretsTools(mcp, { buildElicitationUrl: async () => "https://test.invalid/e", protocolElicitation: false });
  registerDatastoreTools(mcp);
  registerRepositoryTools(mcp);
  registerSubAgentTools(mcp);
  registerToolAuthoringTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result,
    close: () => client.close(),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("agents everyone can write hold no owner bindings (PostgreSQL)", () => {
  let owner: Principal;

  beforeAll(async () => {
    owner = await principal();
  });

  afterAll(async () => {
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: { in: agentIds } } });
    await db.agentTool.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agentRepository.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.tool.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("refuses every binding tool on an agent everyone can write", async () => {
    const target = await agent(owner.id);
    const child = await agent(owner.id);
    await everyoneWrite(target.id);
    const tool = await db.tool.create({
      data: {
        name: `t-${randomUUID()}`,
        description: "d",
        paramsZod: "z",
        jsonSchema: {},
        code: "c",
        ownerId: owner.id,
      },
    });
    const mcp = await connect(owner);
    const attempts: [string, Record<string, unknown>][] = [
      ["attach_secret", { agentId: target.id, name: "API_KEY" }],
      ["attach_datastore", { agentId: target.id, datastoreId: "any" }],
      ["link_repository", { agentId: target.id, repository: "o/r", access: "read" }],
      ["attach_subagent", { parentAgentId: target.id, childAgentId: child.id }],
      ["attach_tool", { agentId: target.id, toolId: tool.id, allowedHosts: ["api.example.com"] }],
    ];
    for (const [name, args] of attempts) {
      const result = await mcp.call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toMatch(/writable by everyone/);
    }
    await mcp.close();
    expect(await agentOwnerBindings(db, target.id)).toEqual([]);
  });

  it("still attaches a tool without capabilities to an agent everyone can write", async () => {
    const target = await agent(owner.id);
    await everyoneWrite(target.id);
    const tool = await db.tool.create({
      data: {
        name: `t-${randomUUID()}`,
        description: "d",
        paramsZod: "z",
        jsonSchema: {},
        code: "c",
        ownerId: owner.id,
      },
    });
    const mcp = await connect(owner);
    const result = await mcp.call("attach_tool", { agentId: target.id, toolId: tool.id });
    await mcp.close();
    expect(result.isError).toBeFalsy();
    expect(await db.agentTool.count({ where: { agentId: target.id } })).toBe(1);
    expect(await agentOwnerBindings(db, target.id)).toEqual([]);
  });

  it("refuses an admin's adminOverride link on an agent everyone can write", async () => {
    const admin = await principal();
    const target = await agent(owner.id);
    await everyoneWrite(target.id);
    const mcp = await connect(admin, true);
    const result = await mcp.call("link_repository", {
      agentId: target.id,
      repository: "o/r",
      access: "read",
      adminOverride: true,
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/writable by everyone/);
    expect(await db.agentRepository.count({ where: { agentId: target.id } })).toBe(0);
  });

  it("refuses making an agent everyone can write into a coding agent", async () => {
    const target = await agent(owner.id);
    await everyoneWrite(target.id);
    const mcp = await connect(owner, true);
    const result = await mcp.call("update_agent", {
      id: target.id,
      kind: "coding",
      codingProfile: { repository: "o/r" },
      repositoryAdminOverride: true,
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/writable by everyone/);
    expect(await db.codingAgentProfile.count({ where: { agentId: target.id } })).toBe(0);
  });

  it("refuses everyone write on a coding agent, and counts only capability-granted tools", async () => {
    const coding = await agent(owner.id, {
      kind: "coding",
      codingProfile: { create: { repository: "o/code", protectedPaths: [], repositoryAuthorizedVia: "admin" } },
    });
    expect(await agentOwnerBindings(db, coding.id)).toEqual(["a coding repository"]);
    const mcp = await connect(owner);
    const refused = await mcp.call("grant_access", {
      resourceType: "agent",
      resourceId: coding.id,
      grantee: "everyone",
      level: "write",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/a coding repository/);
    expect(await isPublicWritable(db, coding.id)).toBe(false);
    await mcp.close();

    const native = await agent(owner.id);
    const tool = await db.tool.create({
      data: {
        name: `t-${randomUUID()}`,
        description: "d",
        paramsZod: "z",
        jsonSchema: {},
        code: "c",
        ownerId: owner.id,
      },
    });
    await db.agentTool.create({ data: { agentId: native.id, toolId: tool.id, attachedById: owner.id } });
    expect(await agentOwnerBindings(db, native.id)).toEqual([]);
    await db.agentTool.update({
      where: { agentId_toolId: { agentId: native.id, toolId: tool.id } },
      data: { allowedHosts: ["api.example.com"], capabilitiesGrantedById: owner.id },
    });
    expect(await agentOwnerBindings(db, native.id)).toEqual(["tool capabilities"]);
  });
});
