import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import { buildSecretsAccessor } from "../../core/secrets.js";
import { principalGranteeKey } from "../../core/grants.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `make-owner-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

describe.skipIf(!process.env.DATABASE_URL)("make_owner re-stamps repository approvals (PostgreSQL)", () => {
  afterAll(async () => {
    await db.webhook.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agentSubAgent.deleteMany({ where: { parentAgentId: { in: agentIds } } });
    await db.agentTool.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agentDatastore.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.tool.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.datastore.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("turns admin/grandfathered stamps into host_permission when the owner changes", async () => {
    const [admin, a, b] = [await principal(), await principal(), await principal()];
    const agent = await db.agent.create({
      data: {
        name: `make-owner-${randomUUID()}`,
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: a.id,
        codingProfile: {
          create: {
            repository: "o/code",
            protectedPaths: ["CODEOWNERS"],
            repositoryAuthorizedVia: "grandfathered",
          },
        },
      },
    });
    agentIds.push(agent.id);
    await db.agentRepository.createMany({
      data: [
        {
          agentId: agent.id,
          provider: "github",
          repository: "o/bot",
          access: "write",
          authorizedVia: "admin",
          authorizedById: admin.id,
        },
        {
          agentId: agent.id,
          provider: "github",
          repository: "o/own",
          access: "read",
          authorizedVia: "host_permission",
          authorizedById: a.id,
        },
      ],
    });

    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext({
      principal: admin,
      scopes: new Set(["agents:admin"]),
      roles: ["admin"],
      canonicalUri: "https://host/mcp",
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    });
    registerAgentTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(st);
    await client.connect(ct);
    const result = (await client.callTool({ name: "make_owner", arguments: { agentId: agent.id, ownerId: b.id } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).repositoryApprovalsRevoked).toEqual(["o/bot", "o/code"]);

    const links = await db.agentRepository.findMany({ where: { agentId: agent.id }, orderBy: { repository: "asc" } });
    expect(links.map((l) => [l.repository, l.authorizedVia, l.authorizedById])).toEqual([
      ["o/bot", "host_permission", null],
      ["o/own", "host_permission", a.id],
    ]);
    expect(await db.codingAgentProfile.findUniqueOrThrow({ where: { agentId: agent.id } })).toMatchObject({
      repositoryAuthorizedVia: "host_permission",
      repositoryAuthorizedById: null,
    });
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).ownerId).toBe(b.id);
  });

  it("R2-1: make_owner removes old-owner bindings and suspends capabilities", async () => {
    const [admin, a, b, c] = [await principal(), await principal(), await principal(), await principal()];
    const newAgent = async (ownerId: string) => {
      const agent = await db.agent.create({
        data: { name: `make-owner-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId },
      });
      agentIds.push(agent.id);
      return agent;
    };
    const agent = await newAgent(a.id);
    const aChild = await newAgent(a.id);
    const bChild = await newAgent(b.id);
    const aSecret = await db.secret.create({ data: { name: "A", ciphertext: "a-value", keyId: "k", ownerId: a.id } });
    const bSecret = await db.secret.create({ data: { name: "B", ciphertext: "b-value", keyId: "k", ownerId: b.id } });
    await db.agentSecret.createMany({
      data: [
        { agentId: agent.id, secretId: aSecret.id, boundName: "A_SECRET" },
        { agentId: agent.id, secretId: bSecret.id, boundName: "B_SECRET" },
      ],
    });
    const aStore = await db.datastore.create({ data: { name: `a-${randomUUID()}`, ownerId: a.id } });
    const bStore = await db.datastore.create({ data: { name: `b-${randomUUID()}`, ownerId: b.id } });
    await db.agentDatastore.createMany({
      data: [
        { agentId: agent.id, datastoreId: aStore.id, boundName: "a-store" },
        { agentId: agent.id, datastoreId: bStore.id, boundName: "b-store" },
      ],
    });
    const tool = await db.tool.create({
      data: { name: "a-tool", description: "d", paramsZod: "z", jsonSchema: {}, code: "c", ownerId: a.id },
    });
    await db.agentTool.create({
      data: {
        agentId: agent.id,
        toolId: tool.id,
        allowedSecrets: ["A_SECRET", "B_SECRET"],
        allowedHosts: ["a.example"],
        attachedById: a.id,
        capabilitiesGrantedById: a.id,
      },
    });
    await db.agentSubAgent.createMany({
      data: [
        { parentAgentId: agent.id, childAgentId: aChild.id, boundName: "a-child" },
        { parentAgentId: agent.id, childAgentId: bChild.id, boundName: "b-child" },
      ],
    });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        granteeKind: "principal",
        granteePrincipalId: c.id,
        granteeKey: principalGranteeKey(c.id),
        level: "execute",
      },
    });
    const cHook = await db.webhook.create({ data: { agentId: agent.id, ownerId: c.id, secretHash: "h1" } });
    await db.webhook.create({ data: { agentId: agent.id, ownerId: b.id, secretHash: "h2" } });

    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext({
      principal: admin,
      scopes: new Set(["agents:admin"]),
      roles: ["admin"],
      canonicalUri: "https://host/mcp",
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    });
    registerAgentTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(st);
    await client.connect(ct);
    const result = (await client.callTool({ name: "make_owner", arguments: { agentId: agent.id, ownerId: b.id } })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    await client.close();
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.ownerId).toBe(b.id);
    expect(body.bindingsRemoved).toEqual([
      { kind: "secret", boundName: "A_SECRET", resourceId: aSecret.id },
      { kind: "datastore", boundName: "a-store", resourceId: aStore.id },
    ]);
    expect(body.toolCapabilitiesSuspended).toEqual([{ toolId: tool.id, toolName: "a-tool" }]);
    expect(body.subAgentEdgesRemoved).toEqual([
      { parentAgentId: agent.id, childAgentId: aChild.id, boundName: "a-child" },
    ]);
    expect(body.grantsReset).toBe(1);
    expect(body.webhooksInactive).toEqual([{ id: cHook.id, createdBy: c.id }]);

    // The new owner's own bindings survive; the old owner's are gone.
    expect((await db.agentSecret.findMany({ where: { agentId: agent.id } })).map((r) => r.boundName)).toEqual([
      "B_SECRET",
    ]);
    expect((await db.agentDatastore.findMany({ where: { agentId: agent.id } })).map((r) => r.boundName)).toEqual([
      "b-store",
    ]);
    expect((await db.agentSubAgent.findMany({ where: { parentAgentId: agent.id } })).map((e) => e.boundName)).toEqual([
      "b-child",
    ]);
    expect(await db.resourceGrant.count({ where: { resourceId: agent.id } })).toBe(0);
    // The attachment row is untouched; it is inert until b re-grants it.
    expect(await db.agentTool.findFirstOrThrow({ where: { agentId: agent.id } })).toMatchObject({
      capabilitiesGrantedById: a.id,
    });
    const cipher = { keyId: () => "k", encrypt: async (v: string) => v, decrypt: async (v: string) => v };
    const secrets = buildSecretsAccessor(agent.id, cipher, db);
    expect(await secrets.get("A_SECRET")).toBeUndefined();
    expect(await secrets.get("B_SECRET")).toBe("b-value");
  });

  it("adopting an owner-less agent keeps its grants", async () => {
    const [admin, owner] = [await principal(), await principal()];
    const agent = await db.agent.create({
      data: { name: `make-owner-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        granteeKind: "everyone",
        granteeKey: "everyone",
        level: "execute",
        source: "migration_public",
      },
    });
    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext({
      principal: admin,
      scopes: new Set(["agents:admin"]),
      roles: ["admin"],
      canonicalUri: "https://host/mcp",
      providers,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    });
    registerAgentTools(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(st);
    await client.connect(ct);
    const result = (await client.callTool({
      name: "make_owner",
      arguments: { agentId: agent.id, ownerId: owner.id },
    })) as { isError?: boolean; content: { text: string }[] };
    await client.close();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).grantsReset).toBe(0);
    expect(await db.resourceGrant.count({ where: { resourceId: agent.id } })).toBe(1);
  });
});
