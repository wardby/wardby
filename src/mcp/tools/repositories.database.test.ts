import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result,
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

  describe("remote links (#536)", () => {
    it("stores asRemote for a valid read remote link, lists it, and defaults to false without as", async () => {
      const c = await connect(owner);
      const ok = await c.link({ agentId, repository: "acme/upstream", access: "read", ref: "main", as: "remote" });
      expect(ok.isError).toBeFalsy();
      const plain = await c.link({ agentId, repository: "acme/folder", access: "read", ref: "main" });
      expect(plain.isError).toBeFalsy();
      const explicitFolder = await c.link({
        agentId,
        repository: "acme/folder2",
        access: "read",
        ref: "main",
        as: "folder",
      });
      expect(explicitFolder.isError).toBeFalsy();
      const rows = await db.agentRepository.findMany({
        where: { agentId, repository: { in: ["acme/upstream", "acme/folder", "acme/folder2"] } },
      });
      expect(Object.fromEntries(rows.map((r) => [r.repository, r.asRemote]))).toEqual({
        "acme/upstream": true,
        "acme/folder": false,
        "acme/folder2": false,
      });
      const listed = await c.call("list_repositories", { agentId });
      const upstream = (
        JSON.parse(listed.content[0].text).repositories as { repository: string; asRemote: boolean }[]
      ).find((r) => r.repository === "acme/upstream");
      expect(upstream?.asRemote).toBe(true);
      await c.close();
    });

    it.each([
      ["write access", { repository: "acme/w", access: "write", as: "remote" }],
      ["the reserved name origin", { repository: "acme/o", access: "read", ref: "main", as: "remote", name: "origin" }],
      ["a default name of origin", { repository: "acme/origin", access: "read", ref: "main", as: "remote" }],
    ])("refuses as remote with %s", async (_label, args) => {
      const c = await connect(owner);
      const result = await c.link({ agentId, ...args });
      expect(result.isError).toBeTruthy();
      expect(result.content[0].text).toMatch(/^repository_remote_invalid:/);
      expect(await db.agentRepository.count({ where: { agentId, repository: args.repository } })).toBe(0);
      await c.close();
    });

    it("refuses as remote on a host other than the default repository's", async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-link-")));
      execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
      vi.stubEnv("LOCAL_REPO_ROOTS", root);
      try {
        const c = await connect(owner);
        const result = await c.link({
          agentId,
          repository: `local:${root}`,
          access: "read",
          ref: "main",
          as: "remote",
        });
        expect(result.isError).toBeTruthy();
        expect(result.content[0].text).toMatch(/^repository_remote_invalid:/);
        await c.close();
      } finally {
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("refuses as remote on a non-coding agent", async () => {
      const native = await db.agent.create({
        data: {
          name: `repo-links-native-${randomUUID()}`,
          systemPrompt: "x",
          model: "gpt-5.6-luna",
          budgetUsd: 1,
          ownerId: owner.id,
        },
      });
      agentIds.push(native.id);
      const c = await connect(owner);
      const result = await c.link({ agentId: native.id, repository: "acme/up", access: "read", as: "remote" });
      expect(result.isError).toBeTruthy();
      expect(result.content[0].text).toMatch(/^repository_remote_invalid:/);
      await c.close();
    });
  });
});
