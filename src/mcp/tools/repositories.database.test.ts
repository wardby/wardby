import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerRepositoryTools } from "./repositories.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];
const CANONICAL = "https://host/mcp";

type Result = { isError?: boolean; content: { text: string }[] };

async function connect(who: Principal) {
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: ["admin"],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerRepositoryTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    link: async (args: Record<string, unknown>) =>
      (await client.callTool({
        name: "link_repository",
        arguments: { adminOverride: true, ...args },
      })) as Result,
    close: () => client.close(),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("link_repository on a coding agent (PostgreSQL)", () => {
  let owner: Principal;
  let agentId: string;

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `repo-links-${randomUUID()}` } });
    principalIds.push(owner.id);
    const agent = await db.agent.create({
      data: {
        name: `repo-links-${randomUUID()}`,
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: owner.id,
        codingProfile: { create: { repository: "acme/main", protectedPaths: [], repositoryAuthorizedVia: "admin" } },
      },
    });
    agentId = agent.id;
    agentIds.push(agentId);
    // A link as the multi-repo migration leaves it: write access, a backfilled (non-default) name.
    await db.agentRepository.create({
      data: { agentId, provider: "github", repository: "acme/legacy", name: "legacy-2", access: "write", triggers: [] },
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db.agentRepository.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("re-linking a backfilled coding link updates it instead of adding a duplicate", async () => {
    const c = await connect(owner);
    const result = await c.link({ agentId, repository: "acme/legacy", access: "write", baseRef: "develop" });
    expect(result.isError).toBeFalsy();
    const rows = await db.agentRepository.findMany({ where: { agentId, repository: "acme/legacy" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "legacy-2", baseRef: "develop" });
    await c.close();
  });

  it("refuses a name another repository's link already uses", async () => {
    const c = await connect(owner);
    const result = await c.link({ agentId, repository: "acme/other", access: "write", name: "legacy-2" });
    expect(result.isError).toBeTruthy();
    expect(result.content[0].text).toMatch(/^repository_name_taken:/);
    expect(await db.agentRepository.count({ where: { agentId, repository: "acme/other" } })).toBe(0);
    await c.close();
  });

  it("counts default-set links against CODING_MAX_RUN_REPOSITORIES", async () => {
    vi.stubEnv("CODING_MAX_RUN_REPOSITORIES", "2");
    const c = await connect(owner);
    // The default repository plus one link fills a limit of 2; re-linking a member does not count it twice.
    expect(
      (await c.link({ agentId, repository: "acme/one", access: "write", inDefaultSet: true })).isError,
    ).toBeFalsy();
    expect(
      (await c.link({ agentId, repository: "acme/one", access: "write", inDefaultSet: true })).isError,
    ).toBeFalsy();
    const over = await c.link({ agentId, repository: "acme/two", access: "write", inDefaultSet: true });
    expect(over.isError).toBeTruthy();
    expect(over.content[0].text).toMatch(/^repository_set_too_large:/);
    expect(await db.agentRepository.count({ where: { agentId, repository: "acme/two" } })).toBe(0);
    await c.close();
  });
});
