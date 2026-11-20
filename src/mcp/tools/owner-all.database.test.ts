import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `owner-all-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function agentOf(owner: Principal, kind: "native" | "coding" = "native") {
  const agent = await db.agent.create({
    data: {
      name: `owner-all-${randomUUID()}`,
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      kind,
      ownerId: owner.id,
      ...(kind === "coding"
        ? {
            codingProfile: {
              create: {
                repository: "o/code",
                protectedPaths: ["CODEOWNERS"],
                repositoryAuthorizedVia: "host_permission",
              },
            },
          }
        : {}),
    },
  });
  agentIds.push(agent.id);
  return agent;
}

async function connect(caller: Principal, scopes: string[], roles: string[]) {
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: "https://host/mcp" } });
  mcp.setFixedContext({
    principal: caller,
    scopes: new Set(scopes),
    roles,
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
  return client;
}

type Result = { isError?: boolean; content: { text: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;

const OWNER_ALL = ["agents:read", "agents:write", "owner:all"];

describe.skipIf(!process.env.DATABASE_URL)("wardby_owner (owner:all + role) over agent tools (PostgreSQL)", () => {
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("reads, lists and edits an agent it neither owns nor was granted", async () => {
    const [owner, boss] = [await principal(), await principal()];
    const agent = await agentOf(owner);
    const client = await connect(boss, OWNER_ALL, ["wardby_owner"]);

    const got = await call(client, "get_agent", { id: agent.id });
    expect(got.isError).toBeFalsy();
    expect(JSON.parse(got.content[0].text).id).toBe(agent.id);

    const listed = JSON.parse((await call(client, "list_agents", { summary: true })).content[0].text) as {
      id: string;
      access: string;
    }[];
    expect(listed.find((a) => a.id === agent.id)?.access).toBe("owner");

    const updated = await call(client, "update_agent", { id: agent.id, model: "claude-haiku-4-5" });
    expect(updated.isError).toBeFalsy();
    await client.close();
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).model).toBe("claude-haiku-4-5");
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).ownerId).toBe(owner.id);
  });

  it("changes another owner's coding profile and repository, approved as an admin's, and its owner", async () => {
    const [owner, boss, next] = [await principal(), await principal(), await principal()];
    const agent = await agentOf(owner, "coding");
    const client = await connect(boss, OWNER_ALL, ["wardby_owner"]);

    const edited = await call(client, "update_agent", { id: agent.id, codingProfile: { repository: "o/other" } });
    expect(edited.isError).toBeFalsy();
    expect(await db.codingAgentProfile.findUniqueOrThrow({ where: { agentId: agent.id } })).toMatchObject({
      repository: "o/other",
      repositoryAuthorizedVia: "admin",
      repositoryAuthorizedById: boss.id,
    });

    const moved = await call(client, "make_owner", { agentId: agent.id, ownerId: next.id });
    await client.close();
    expect(moved.isError).toBeFalsy();
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).ownerId).toBe(next.id);
  });

  it.each([
    ["the scope without the role", OWNER_ALL, []],
    ["the role without the scope", ["agents:read", "agents:write"], ["wardby_owner"]],
    ["admin alone", ["agents:read", "agents:write", "agents:admin"], ["admin"]],
  ])("grants nothing with %s", async (_label, scopes, roles) => {
    const [owner, other] = [await principal(), await principal()];
    const agent = await agentOf(owner);
    const client = await connect(other, scopes, roles);

    const got = await call(client, "get_agent", { id: agent.id });
    const updated = await call(client, "update_agent", { id: agent.id, model: "claude-haiku-4-5" });
    await client.close();
    expect(got.isError).toBe(true);
    expect(got.content[0].text).toMatch(/not found/);
    expect(updated.isError).toBe(true);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).model).toBe("gpt-5.6-luna");
  });
});
