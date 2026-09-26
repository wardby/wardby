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
  const p = await db.principal.create({ data: { subject: `make-owner-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

describe.skipIf(!process.env.DATABASE_URL)("make_owner re-stamps repository approvals (PostgreSQL)", () => {
  afterAll(async () => {
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
});
