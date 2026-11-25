import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerAgentTools } from "./agents.js";
import { registerGrantTools } from "./grants.js";

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

async function codingAgent(ownerId: string, profile: Record<string, unknown> = {}) {
  return agent(ownerId, {
    kind: "coding",
    codingProfile: {
      create: { repository: "o/code", protectedPaths: [".github/**"], repositoryAuthorizedVia: "admin", ...profile },
    },
  });
}

async function grant(agentId: string, principalId: string, level: string) {
  await db.resourceGrant.create({
    data: {
      resourceType: "agent",
      resourceId: agentId,
      granteeKind: "principal",
      granteePrincipalId: principalId,
      granteeKey: `principal:${principalId}`,
      level,
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("plan settings (PostgreSQL)", () => {
  let owner: Principal;
  let writer: Principal;
  let stranger: Principal;

  beforeAll(async () => {
    owner = await principal();
    writer = await principal();
    stranger = await principal();
  });

  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("refuses a reviewer with no access to the agent", async () => {
    const target = await codingAgent(owner.id);
    const mcp = await connect(owner);
    const result = await mcp.call("update_agent", {
      id: target.id,
      codingProfile: { planDocument: { store: "wardby", reviewers: [stranger.id] } },
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/plan_reviewer_invalid/);
  });

  it("saves reviewers who can read, defaulting to the owner", async () => {
    const target = await codingAgent(owner.id);
    await grant(target.id, writer.id, "read");
    const mcp = await connect(owner);
    const saved = await mcp.call("update_agent", {
      id: target.id,
      codingProfile: { planDocument: { store: "wardby", reviewers: [writer.id] } },
    });
    expect(saved.isError).toBeFalsy();
    const defaulted = await mcp.call("update_agent", {
      id: target.id,
      codingProfile: { planDocument: { store: "wardby" } },
    });
    await mcp.close();
    expect(defaulted.isError).toBeFalsy();
    const row = await db.codingAgentProfile.findUnique({ where: { agentId: target.id } });
    expect(row?.planDocument).toMatchObject({ reviewers: [owner.id] });
  });

  it("refuses a builder without buildFromPlan, and accepts one with it", async () => {
    const planner = await codingAgent(owner.id);
    const plain = await codingAgent(owner.id);
    const builder = await codingAgent(owner.id, { buildFromPlan: true });
    const mcp = await connect(owner);
    const refused = await mcp.call("update_agent", {
      id: planner.id,
      codingProfile: { planDocument: { store: "wardby", onApproved: "build", builderAgentId: plain.id } },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/plan_builder_invalid/);
    const accepted = await mcp.call("update_agent", {
      id: planner.id,
      codingProfile: { planDocument: { store: "wardby", onApproved: "build", builderAgentId: builder.id } },
    });
    await mcp.close();
    expect(accepted.isError).toBeFalsy();
  });

  it("checks reviewers on create_agent: only the creator passes", async () => {
    const mcp = await connect(owner);
    const refused = await mcp.call("create_agent", {
      name: `plan-settings-${randomUUID()}`,
      systemPrompt: "x",
      model: "claude-sonnet-4-6",
      budgetUsd: 1,
      kind: "coding",
      codingProfile: { repository: "o/r", planDocument: { store: "wardby", reviewers: [stranger.id] } },
      repositoryAdminOverride: true,
    });
    await mcp.close();
    expect(refused.isError).toBe(true);
  });

  it("keeps the whole codingProfile owner-only", async () => {
    const target = await codingAgent(owner.id);
    await grant(target.id, writer.id, "write");
    const mcp = await connect(writer);
    const result = await mcp.call("update_agent", {
      id: target.id,
      codingProfile: { planDocument: { store: "wardby" } },
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/only its owner/);
  });

  it("does not re-check reviewers on edits that leave planDocument out (R20)", async () => {
    const target = await codingAgent(owner.id);
    await grant(target.id, writer.id, "read");
    const mcp = await connect(owner);
    const saved = await mcp.call("update_agent", {
      id: target.id,
      codingProfile: { planDocument: { store: "wardby", reviewers: [writer.id] } },
    });
    expect(saved.isError).toBeFalsy();
    await db.resourceGrant.deleteMany({ where: { resourceId: target.id } });
    const renamed = await mcp.call("update_agent", { id: target.id, name: `plan-settings-${randomUUID()}` });
    const patched = await mcp.call("update_agent", { id: target.id, codingProfile: { timeoutSec: 600 } });
    await mcp.close();
    expect(renamed.isError).toBeFalsy();
    expect(patched.isError).toBeFalsy();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("codingProfile.tunnelHosts (PostgreSQL)", () => {
  const saved = { port: process.env.CODING_TUNNEL_PORT, level: process.env.CODING_TUNNEL_AGENT_HOSTS };
  beforeAll(() => {
    process.env.CODING_TUNNEL_PORT = "8789";
    process.env.CODING_TUNNEL_AGENT_HOSTS = "any";
  });
  afterAll(async () => {
    for (const [name, value] of [
      ["CODING_TUNNEL_PORT", saved.port],
      ["CODING_TUNNEL_AGENT_HOSTS", saved.level],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
  });

  it("stores the patterns and the * approval in the profile columns", async () => {
    const owner = await principal();
    const created = await codingAgent(owner.id);
    const admin = await connect(owner, true);
    const result = await admin.call("update_agent", {
      id: created.id,
      codingProfile: { tunnelHosts: ["*", "*.Example.com", "api.example.org"] },
    });
    await admin.close();
    expect(result.isError, result.content[0].text).toBeFalsy();
    const row = await db.codingAgentProfile.findUniqueOrThrow({ where: { agentId: created.id } });
    expect(row.tunnelHosts).toEqual(["*", "*.example.com", "api.example.org"]);
    expect(row.tunnelAnyHostAuthorizedById).toBe(owner.id);
    expect(row.tunnelAnyHostAuthorizedAt).toBeInstanceOf(Date);

    const plain = await connect(owner);
    const cleared = await plain.call("update_agent", { id: created.id, codingProfile: { tunnelHosts: [] } });
    await plain.close();
    expect(cleared.isError, cleared.content[0].text).toBeFalsy();
    const after = await db.codingAgentProfile.findUniqueOrThrow({ where: { agentId: created.id } });
    expect(after).toMatchObject({
      tunnelHosts: [],
      tunnelAnyHostAuthorizedById: null,
      tunnelAnyHostAuthorizedAt: null,
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("documentTools setting (PostgreSQL)", () => {
  let owner: Principal;
  let stranger: Principal;

  beforeAll(async () => {
    owner = await principal();
    stranger = await principal();
  });

  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("create_agent on a native agent stores the defaults and get_agent shows them", async () => {
    const mcp = await connect(owner);
    const created = await mcp.call("create_agent", {
      name: `dt-${randomUUID()}`,
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      documentTools: { access: "write" },
    });
    expect(created.isError).toBeFalsy();
    const made = JSON.parse(created.content[0].text);
    agentIds.push(made.id);
    expect(made.documentTools).toEqual({
      access: "write",
      reviewers: [owner.id],
      finalApproverId: null,
      maxNewPerRun: 5,
      plans: [],
    });
    const got = JSON.parse((await mcp.call("get_agent", { id: made.id })).content[0].text);
    await mcp.close();
    expect(got.documentTools.access).toBe("write");
  });

  it("refuses documentTools on a coding agent with a 400 naming the setting", async () => {
    const target = await codingAgent(owner.id);
    const mcp = await connect(owner);
    const result = await mcp.call("update_agent", { id: target.id, documentTools: { access: "read" } });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/document_tools_invalid: only native agents/);
  });

  it("refuses a reviewer who cannot read the agent", async () => {
    const target = await agent(owner.id);
    const mcp = await connect(owner);
    const result = await mcp.call("update_agent", {
      id: target.id,
      documentTools: { access: "write", reviewers: [stranger.id] },
    });
    await mcp.close();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/document_tools_invalid: every reviewer/);
  });

  it("update_agent with null clears the setting", async () => {
    const target = await agent(owner.id);
    const mcp = await connect(owner);
    const set = await mcp.call("update_agent", { id: target.id, documentTools: { access: "read" } });
    expect(JSON.parse(set.content[0].text).documentTools.access).toBe("read");
    const cleared = await mcp.call("update_agent", { id: target.id, documentTools: null });
    await mcp.close();
    expect(cleared.isError).toBeFalsy();
    expect(JSON.parse(cleared.content[0].text).documentTools).toBeNull();
    expect((await db.agent.findUnique({ where: { id: target.id } }))?.documentTools).toBeNull();
  });
});
