import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Prisma } from "#prisma";
import type { RepoAccessDecision, RepoAccessGate } from "../../core/repo-access.js";
import type { HostPermission } from "../../providers/review-host/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRepositoryTools } from "./repositories.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
  kind: "native" | "coding";
  codingProfile?: { repository: string } | null;
}

interface FakeRepositoryRow {
  id: string;
  agentId: string;
  provider: string;
  repository: string;
  access: string;
  triggers: string[];
  checkName: string | null;
  reviewFixMaxRounds?: number | null;
  waitForCi?: boolean;
  markReadyWhenPassing?: boolean;
  baseRef?: string | null;
  createdAt: Date;
  authorizedVia?: string | null;
  authorizedById?: string | null;
  authorizedAt?: Date | null;
}

function fakeDb(
  agents: FakeAgentRow[],
  repositories: FakeRepositoryRow[] = [],
  opts: { failUpsertWith?: Error; grants?: FakeGrantSeed[] } = {},
) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const rows: FakeRepositoryRow[] = [...repositories];
  let nextId = rows.length + 1;

  const db = {
    resourceGrant: fakeResourceGrants(opts.grants ?? []),
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    agentRepository: {
      findMany: async (opts?: {
        where?: { provider?: string; repository?: string; agentId?: string; NOT?: { agentId?: string } };
      }) => {
        let result = rows;
        const where = opts?.where;
        if (where?.provider !== undefined) result = result.filter((r) => r.provider === where.provider);
        if (where?.repository !== undefined) result = result.filter((r) => r.repository === where.repository);
        if (where?.agentId !== undefined) result = result.filter((r) => r.agentId === where.agentId);
        if (where?.NOT?.agentId !== undefined) result = result.filter((r) => r.agentId !== where.NOT!.agentId);
        return result.map((r) => ({ ...r }));
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { agentId_provider_repository: { agentId: string; provider: string; repository: string } };
        create: Omit<FakeRepositoryRow, "id" | "createdAt">;
        update: Partial<FakeRepositoryRow>;
      }) => {
        if (opts.failUpsertWith) throw opts.failUpsertWith;
        const { agentId, provider, repository } = where.agentId_provider_repository;
        const existing = rows.find(
          (r) => r.agentId === agentId && r.provider === provider && r.repository === repository,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row: FakeRepositoryRow = { id: `repo${nextId++}`, createdAt: new Date(), ...create };
        rows.push(row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { agentId: string; provider: string; repository: string } }) => {
        const before = rows.length;
        const kept = rows.filter(
          (r) => !(r.agentId === where.agentId && r.provider === where.provider && r.repository === where.repository),
        );
        rows.length = 0;
        rows.push(...kept);
        return { count: before - kept.length };
      },
    },
  };

  return {
    ...db,
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as import("#prisma").PrismaClient;
}

/** A gate whose linked identity (for every principal) has `level` on every repository. */
function gateAt(level: HostPermission | "unlinked" | "error") {
  const rank = ["none", "read", "triage", "write", "maintain", "admin"];
  const authorizePrincipal = vi.fn(async (input: { required: HostPermission }): Promise<RepoAccessDecision> => {
    if (level === "unlinked") return { ok: false, reason: "identity_not_linked" };
    if (level === "error") return { ok: false, reason: "check_failed" };
    return rank.indexOf(level) >= rank.indexOf(input.required)
      ? { ok: true, level }
      : { ok: false, reason: "insufficient_permission", level };
  });
  const gate: RepoAccessGate = { authorizePrincipal, authorizeUse: vi.fn(), authorizeHostUser: vi.fn() };
  return { gate, authorizePrincipal };
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  principalId: string,
  scopes: string[],
  opts: { gate?: RepoAccessGate | null; roles?: string[] } = {},
): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    roles: opts.roles ?? [],
    canonicalUri: CANONICAL_URI,
    providers: {
      ...(opts.gate === null ? {} : { repoAccess: opts.gate ?? gateAt("write").gate }),
    } as unknown as import("../context.js").McpProviders,
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

function errorText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

function setup(
  agents: FakeAgentRow[],
  principalId: string,
  repositories: FakeRepositoryRow[] = [],
  opts: {
    gate?: RepoAccessGate | null;
    roles?: string[];
    scopes?: string[];
    failUpsertWith?: Error;
    grants?: FakeGrantSeed[];
  } = {},
) {
  const db = fakeDb(agents, repositories, { failUpsertWith: opts.failUpsertWith, grants: opts.grants });
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, principalId, opts.scopes ?? ["agents:read", "agents:write"], opts));
  registerRepositoryTools(mcp);
  return { db, mcp };
}

describe("repository tools", () => {
  it("describes link_repository as a full replace of the link", async () => {
    const { mcp } = setup([], "p1");
    const client = await connectClient(mcp);
    const { tools } = await client.listTools();
    const link = tools.find((t) => t.name === "link_repository")!;
    expect(link.description).toMatch(/replaces/i);
    expect(link.description).toContain("full desired state");
  });

  it("links a native agent owned by the caller, normalizing the repository", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const link = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "ChFields/Knock-Knock-Jokes",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(link.isError).toBeFalsy();
    const parsed = parseText(link as never) as { linked: boolean; link: Record<string, unknown> };
    expect(parsed.linked).toBe(true);
    expect(parsed.link).toMatchObject({
      agentId: "a1",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      access: "write",
      triggers: ["pull_request"],
      checkName: "wardby review",
    });

    const listed = await client.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    const { repositories } = parseText(listed as never) as { repositories: Record<string, unknown>[] };
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      triggers: ["pull_request"],
      checkName: "wardby review",
    });
    await client.close();
  });

  describe("coding agents", () => {
    const agents = (): FakeAgentRow[] => [
      { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" },
      {
        id: "c1",
        name: "coder",
        ownerId: "p1",
        kind: "coding",
        codingProfile: { repository: "acme/default" },
      },
    ];

    it("links a coding agent to a repository, write only and without triggers", async () => {
      const { mcp } = setup(agents(), "p1");
      const client = await connectClient(mcp);
      const ok = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "c1", repository: "acme/service-a", access: "write", baseRef: "develop" },
      });
      expect(ok.isError).toBeFalsy();
      expect((parseText(ok as never) as { link: unknown }).link).toMatchObject({
        repository: "acme/service-a",
        access: "write",
        triggers: [],
        baseRef: "develop",
      });
      await client.close();
    });

    it.each([
      [{ access: "read" }, "write"],
      [{ access: "write", triggers: ["push"] }, "triggers"],
      [{ access: "write", markReadyWhenPassing: true }, "markReadyWhenPassing"],
    ])("refuses a coding link with %j", async (extra, message) => {
      const { mcp } = setup(agents(), "p1");
      const client = await connectClient(mcp);
      const result = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "c1", repository: "acme/service-a", ...extra },
      });
      expect(result.isError).toBeTruthy();
      expect(errorText(result as never)).toContain(message);
      await client.close();
    });

    it("refuses the coding agent's own default repository", async () => {
      const { mcp } = setup(agents(), "p1");
      const client = await connectClient(mcp);
      const result = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "c1", repository: "acme/default", access: "write" },
      });
      expect(errorText(result as never)).toContain("already its default");
      await client.close();
    });

    it("refuses baseRef on a native agent's link", async () => {
      const { mcp } = setup(agents(), "p1");
      const client = await connectClient(mcp);
      const result = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "a1", repository: "acme/service-a", access: "write", baseRef: "develop" },
      });
      expect(errorText(result as never)).toContain("baseRef");
      await client.close();
    });

    it("refuses an unsafe baseRef without echoing it", async () => {
      const { mcp } = setup(agents(), "p1");
      const client = await connectClient(mcp);
      const result = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "c1", repository: "acme/service-a", access: "write", baseRef: "--evil;rm" },
      });
      expect(errorText(result as never)).toContain("safe branch ref");
      expect(errorText(result as never)).not.toContain("evil");
      await client.close();
    });
  });

  it("rejects bad repositories, bad access, and unknown triggers", async () => {
    const { mcp } = setup(
      [
        { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" },
        { id: "c1", name: "coder", ownerId: "p1", kind: "coding" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const badRepoResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "https://evil.example/x/y", access: "write" },
    });
    expect(badRepoResult.isError).toBeTruthy();
    expect(errorText(badRepoResult as never)).toContain("invalid repository");

    const badAccessResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "admin" },
    });
    expect(badAccessResult.isError).toBeTruthy();

    const badTriggerResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["tag"] },
    });
    expect(badTriggerResult.isError).toBeTruthy();
    await client.close();
  });

  it("requires write access and a checkName for event triggers", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const readWithTrigger = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "read", triggers: ["mention"] },
    });
    expect(readWithTrigger.isError).toBeTruthy();
    expect(errorText(readWithTrigger as never)).toContain("Event triggers need write access.");

    const missingCheckName = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["pull_request"] },
    });
    expect(missingCheckName.isError).toBeTruthy();
    expect(errorText(missingCheckName as never)).toContain("checkName is required");
    await client.close();
  });

  it("accepts the push trigger for a native agent with write access", async () => {
    const { mcp } = setup([{ id: "a1", name: "watcher", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const link = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["push"] },
    });
    expect(link.isError).toBeFalsy();
    const parsed = parseText(link as never) as { link: Record<string, unknown> };
    expect(parsed.link).toMatchObject({ triggers: ["push"], checkName: null });
    await client.close();
  });

  it("requires write access for the push trigger", async () => {
    const { mcp } = setup([{ id: "a1", name: "watcher", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const readPush = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "read", triggers: ["push"] },
    });
    expect(readPush.isError).toBeTruthy();
    expect(errorText(readPush as never)).toContain("Event triggers need write access.");
    await client.close();
  });

  it("allows one mention agent per repository and one agent per check name", async () => {
    const { mcp } = setup(
      [
        { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" },
        { id: "a2", name: "mentioner", ownerId: "p1", kind: "native" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const seedMention = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a2", repository: "openai/example", access: "write", triggers: ["mention"] },
    });
    expect(seedMention.isError).toBeFalsy();

    const conflictMention = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["mention"] },
    });
    expect(conflictMention.isError).toBeTruthy();
    expect(errorText(conflictMention as never)).toContain("already handles @-mentions");

    const seedCheck = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a2",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(seedCheck.isError).toBeFalsy();

    const conflictCheck = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(conflictCheck.isError).toBeTruthy();
    expect(errorText(conflictCheck as never)).toContain("already uses check name");

    // Re-linking a1 itself (update) with a2's mention repo but no triggers is fine
    // and re-linking the check-name repo with a different agent's OWN existing
    // link is an update, not a conflict.
    const selfUpdate = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a2",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(selfUpdate.isError).toBeFalsy();
    await client.close();
  });

  it("links a review_fix agent with a cap, and rejects a cap without the trigger or out of range", async () => {
    const { mcp } = setup([{ id: "a1", name: "delivery", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const ok = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["mention", "review_fix"],
        reviewFixMaxRounds: 3,
      },
    });
    expect(ok.isError).toBeFalsy();
    const parsed = parseText(ok as never) as { link: Record<string, unknown> };
    expect(parsed.link).toMatchObject({ reviewFixMaxRounds: 3 });

    const noTrigger = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["mention"],
        reviewFixMaxRounds: 3,
      },
    });
    expect(errorText(noTrigger as never)).toContain("reviewFixMaxRounds needs the review_fix trigger");

    const tooMany = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["review_fix"],
        reviewFixMaxRounds: 11,
      },
    });
    expect(tooMany.isError).toBeTruthy();
    await client.close();
  });

  it("allows one review_fix agent per repository", async () => {
    const { mcp } = setup(
      [
        { id: "a1", name: "one", ownerId: "p1", kind: "native" },
        { id: "a2", name: "two", ownerId: "p1", kind: "native" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);
    await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["review_fix"] },
    });
    const second = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a2", repository: "openai/example", access: "write", triggers: ["review_fix"] },
    });
    expect(errorText(second as never)).toContain("already handles automatic review fixes");
    await client.close();
  });

  it("refuses a hosted provider at the tool's schema", async () => {
    const { db, mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", provider: "bitbucket", repository: "bitbucket:acme/api", access: "write" },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("data/provider must be equal to one of the allowed values");
    expect(await db.agentRepository.findMany({})).toEqual([]);
    const { tools } = await client.listTools();
    const link = tools.find((t) => t.name === "link_repository")!;
    expect((link.inputSchema.properties as Record<string, { enum?: string[] }>).provider.enum).toEqual([
      "github",
      "local",
    ]);
    await client.close();
  });

  it("requires write access for the review_fix trigger", async () => {
    const { mcp } = setup([{ id: "a1", name: "delivery", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "read", triggers: ["review_fix"] },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("Event triggers need write access.");
    await client.close();
  });

  it("links a waitForCi agent, and rejects it without the pull_request trigger", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const ok = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        waitForCi: true,
      },
    });
    expect(ok.isError).toBeFalsy();
    const parsed = parseText(ok as never) as { link: Record<string, unknown> };
    expect(parsed.link).toMatchObject({ waitForCi: true });

    const listed = await client.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    const { repositories } = parseText(listed as never) as { repositories: Record<string, unknown>[] };
    expect(repositories[0]).toMatchObject({ waitForCi: true });

    const noTrigger = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/other",
        access: "write",
        triggers: ["mention"],
        waitForCi: true,
      },
    });
    expect(noTrigger.isError).toBeTruthy();
    expect(errorText(noTrigger as never)).toContain("waitForCi needs the pull_request trigger");
    await client.close();
  });

  it("defaults waitForCi to false and clears it when re-linking without it", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const first = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
        waitForCi: true,
      },
    });
    expect((parseText(first as never) as { link: Record<string, unknown> }).link).toMatchObject({ waitForCi: true });

    const relinked = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/example",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect((parseText(relinked as never) as { link: Record<string, unknown> }).link).toMatchObject({
      waitForCi: false,
    });
    await client.close();
  });

  it("stores markReadyWhenPassing on a write link", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const res = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "acme/web",
        access: "write",
        markReadyWhenPassing: true,
      },
    });
    expect(res.isError).toBeFalsy();
    const parsed = parseText(res as never) as { link: Record<string, unknown> };
    expect(parsed.link).toMatchObject({ markReadyWhenPassing: true });
    await client.close();
  });

  it("refuses markReadyWhenPassing on a read link", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const res = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "acme/web",
        access: "read",
        markReadyWhenPassing: true,
      },
    });
    expect(res.isError).toBeTruthy();
    expect(errorText(res as never)).toContain("markReadyWhenPassing needs write access.");
    await client.close();
  });

  it("defaults markReadyWhenPassing to false and clears it when re-linking without it", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);
    const first = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "acme/web",
        access: "write",
        markReadyWhenPassing: true,
      },
    });
    expect((parseText(first as never) as { link: Record<string, unknown> }).link).toMatchObject({
      markReadyWhenPassing: true,
    });

    const relinked = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "acme/web",
        access: "write",
      },
    });
    expect((parseText(relinked as never) as { link: Record<string, unknown> }).link).toMatchObject({
      markReadyWhenPassing: false,
    });
    await client.close();
  });

  it("refuses to link an agent the caller does not own", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "someone-else", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write" },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("not found");
    await client.close();
  });

  it("repositories are owner bindings: a write-grantee can't link or unlink, a read-grantee can list", async () => {
    const agent: FakeAgentRow = { id: "a1", name: "reviewer", ownerId: "owner", kind: "native" };
    const existing: FakeRepositoryRow = {
      id: "repo1",
      agentId: "a1",
      provider: "github",
      repository: "openai/example",
      access: "write",
      triggers: [],
      checkName: null,
      createdAt: new Date(),
    };
    const writer = setup([agent], "writer", [existing], {
      grants: [{ resourceType: "agent", resourceId: "a1", principalId: "writer", level: "write" }],
    });
    const client = await connectClient(writer.mcp);
    const linked = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/other", access: "write" },
    });
    expect(linked.isError).toBeTruthy();
    expect(errorText(linked as never)).toMatch(/owner/);
    const unlinked = await client.callTool({
      name: "unlink_repository",
      arguments: { agentId: "a1", repository: "openai/example" },
    });
    expect(unlinked.isError).toBeTruthy();
    await client.close();

    const reader = setup([agent], "reader", [existing], {
      grants: [{ resourceType: "agent", resourceId: "a1", principalId: "reader", level: "read" }],
    });
    const readerClient = await connectClient(reader.mcp);
    const listed = await readerClient.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    expect(listed.isError).toBeFalsy();
    expect((parseText(listed as never) as { repositories: unknown[] }).repositories).toHaveLength(1);
    await readerClient.close();
  });

  it("unlinks and lists", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write" },
    });
    const unlinked = await client.callTool({
      name: "unlink_repository",
      arguments: { agentId: "a1", repository: "openai/example" },
    });
    expect(unlinked.isError).toBeFalsy();
    expect(parseText(unlinked as never)).toEqual({ unlinked: true });

    const listed = await client.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    expect(parseText(listed as never)).toEqual({ repositories: [] });
    await client.close();
  });
});

describe("link_repository authorization (H5-1)", () => {
  const OWNED: FakeAgentRow = { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" };
  const link = (extra: Record<string, unknown> = {}) => ({
    name: "link_repository",
    arguments: { agentId: "a1", repository: "chfields/knock-knock-jokes", access: "write", ...extra },
  });

  it("refuses a member with no linked GitHub account, pointing at link_host_account", async () => {
    const { mcp } = setup([OWNED], "p1", [], { gate: gateAt("unlinked").gate });
    const client = await connectClient(mcp);
    const result = await client.callTool(link());
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("link_host_account");
    await client.close();
  });

  it("refuses a write link but allows a read link for a member with read access", async () => {
    const { gate, authorizePrincipal } = gateAt("read");
    const { mcp } = setup([OWNED], "p1", [], { gate });
    const client = await connectClient(mcp);
    const write = await client.callTool(link());
    expect(write.isError).toBeTruthy();
    expect(errorText(write as never)).toMatch(/has read access.*needs write/);
    const read = await client.callTool(link({ access: "read" }));
    expect(read.isError).toBeFalsy();
    expect(authorizePrincipal).toHaveBeenLastCalledWith({
      principalId: "p1",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      required: "read",
      fresh: true,
    });
    await client.close();
  });

  it("stamps a link authorized through the owner's GitHub access", async () => {
    const { mcp } = setup([OWNED], "p1", [], { gate: gateAt("maintain").gate });
    const client = await connectClient(mcp);
    const result = await client.callTool(link());
    const { link: row } = parseText(result as never) as { link: FakeRepositoryRow };
    expect(row).toMatchObject({ authorizedVia: "host_permission", authorizedById: "p1" });
    expect(new Date(row.authorizedAt as unknown as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await client.close();
  });

  it("records an explicit admin approval without asking GitHub", async () => {
    const { gate, authorizePrincipal } = gateAt("none");
    const { mcp } = setup([OWNED], "p1", [], {
      gate,
      roles: ["admin"],
      scopes: ["agents:read", "agents:write", "agents:admin"],
    });
    const client = await connectClient(mcp);
    const result = await client.callTool(link({ adminOverride: true }));
    expect(result.isError).toBeFalsy();
    const { link: row } = parseText(result as never) as { link: FakeRepositoryRow };
    expect(row).toMatchObject({ authorizedVia: "admin", authorizedById: "p1" });
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses adminOverride from a member, even holding the agents:admin scope", async () => {
    const { gate, authorizePrincipal } = gateAt("admin");
    const { mcp } = setup([OWNED], "p1", [], { gate, scopes: ["agents:read", "agents:write", "agents:admin"] });
    const client = await connectClient(mcp);
    const result = await client.callTool(link({ adminOverride: true }));
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toMatch(/requires a role/);
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses a public (owner-less) agent, admin or not", async () => {
    const { gate, authorizePrincipal } = gateAt("admin");
    const { mcp } = setup([{ ...OWNED, ownerId: null }], "p1", [], {
      gate,
      roles: ["admin"],
      scopes: ["agents:read", "agents:write", "agents:admin"],
      grants: [{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" }],
    });
    const client = await connectClient(mcp);
    for (const extra of [{}, { adminOverride: true }]) {
      const result = await client.callTool(link(extra));
      expect(result.isError).toBeTruthy();
      expect(errorText(result as never)).toMatch(/no owner|without an owner/);
    }
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("fails closed when GitHub cannot be asked or no gate is configured", async () => {
    const failing = setup([OWNED], "p1", [], { gate: gateAt("error").gate });
    const c1 = await connectClient(failing.mcp);
    expect((await c1.callTool(link())).isError).toBeTruthy();
    await c1.close();
    const none = setup([OWNED], "p1", [], { gate: null });
    const c2 = await connectClient(none.mcp);
    const result = await c2.callTool(link());
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toMatch(/adminOverride/);
    await c2.close();
  });

  describe("trusted GitHub accounts", () => {
    const refusing = (reason: "github_account_not_allowed" | "check_failed") => {
      const { gate, authorizePrincipal } = gateAt("admin");
      gate.checkAccount = vi.fn(async () => ({ ok: false, reason }));
      return { gate, authorizePrincipal };
    };

    it("refuses a repository outside the trusted set, even with adminOverride, without asking the host", async () => {
      const { gate, authorizePrincipal } = refusing("github_account_not_allowed");
      const { mcp } = setup([OWNED], "p1", [], {
        gate,
        roles: ["admin"],
        scopes: ["agents:read", "agents:write", "agents:admin"],
      });
      const client = await connectClient(mcp);
      for (const extra of [{}, { adminOverride: true }]) {
        const result = await client.callTool(link(extra));
        expect(result.isError).toBeTruthy();
        expect(errorText(result as never)).toContain("github_account_not_allowed: ");
      }
      expect(authorizePrincipal).not.toHaveBeenCalled();
      await client.close();
    });

    it("refuses when the trusted set can't be checked", async () => {
      const { gate } = refusing("check_failed");
      const { mcp } = setup([OWNED], "p1", [], { gate });
      const client = await connectClient(mcp);
      const result = await client.callTool(link());
      expect(result.isError).toBeTruthy();
      expect(errorText(result as never)).toMatch(/could not check/i);
      await client.close();
    });

    it("links when the account is served", async () => {
      const { gate } = gateAt("write");
      gate.checkAccount = vi.fn(async () => undefined);
      const { mcp } = setup([OWNED], "p1", [], { gate });
      const client = await connectClient(mcp);
      expect((await client.callTool(link())).isError).toBeFalsy();
      await client.close();
    });
  });
});

describe("link_repository check names (H5-2)", () => {
  const OWNED: FakeAgentRow = { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" };

  it("allows a checkName only with the pull_request trigger", async () => {
    const { mcp } = setup([OWNED], "p1");
    const client = await connectClient(mcp);
    for (const triggers of [undefined, [], ["mention"]]) {
      const result = await client.callTool({
        name: "link_repository",
        arguments: { agentId: "a1", repository: "o/r", access: "write", checkName: "wardby review", triggers },
      });
      expect(result.isError).toBeTruthy();
      expect(errorText(result as never)).toContain("checkName needs the pull_request trigger");
    }
    await client.close();
  });

  it("checks a name against every other link in the repository, whatever its triggers", async () => {
    const legacy: FakeRepositoryRow = {
      id: "r9",
      agentId: "a9",
      provider: "github",
      repository: "o/r",
      access: "write",
      triggers: [],
      checkName: "wardby review",
      createdAt: new Date(),
    };
    const { mcp } = setup([OWNED], "p1", [legacy]);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "o/r",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("already uses check name");
    await client.close();
  });

  it("maps a unique-index race on the check name to 409", async () => {
    const race = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    const { mcp } = setup([OWNED], "p1", [], { failUpsertWith: race });
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "o/r", access: "write", triggers: ["pull_request"], checkName: "x" },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("already uses check name");
    await client.close();
  });
});

describe("link_repository admin override on someone else's agent (M-3)", () => {
  const OTHERS: FakeRepositoryRow[] = [];
  const agent: FakeAgentRow = { id: "a1", name: "reviewer", ownerId: "someone-else", kind: "native" };
  const call = {
    name: "link_repository",
    arguments: { agentId: "a1", repository: "bot/repo", access: "write", adminOverride: true },
  };
  const ADMIN_SCOPES = ["agents:read", "agents:write", "agents:admin"];

  it("lets an admin approve a repository for an agent they don't own, recording the approver", async () => {
    const { gate, authorizePrincipal } = gateAt("none");
    const { mcp } = setup([agent], "admin-1", OTHERS, { gate, roles: ["admin"], scopes: ADMIN_SCOPES });
    const client = await connectClient(mcp);
    const result = await client.callTool(call);
    expect(result.isError).toBeFalsy();
    expect((parseText(result as never) as { link: FakeRepositoryRow }).link).toMatchObject({
      agentId: "a1",
      authorizedVia: "admin",
      authorizedById: "admin-1",
    });
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses a member, even holding the agents:admin scope, and an admin without the override", async () => {
    const member = setup([agent], "p1", [], { scopes: ADMIN_SCOPES });
    const c1 = await connectClient(member.mcp);
    const refused = await c1.callTool(call);
    expect(refused.isError).toBeTruthy();
    expect(errorText(refused as never)).toMatch(/requires a role/);
    await c1.close();

    const admin = setup([agent], "admin-1", [], { roles: ["admin"], scopes: ADMIN_SCOPES });
    const c2 = await connectClient(admin.mcp);
    const noOverride = await c2.callTool({ ...call, arguments: { ...call.arguments, adminOverride: undefined } });
    expect(noOverride.isError).toBeTruthy();
    // Admins get no implicit access to others' agents: the agent is hidden.
    expect(errorText(noOverride as never)).toContain("not found");
    await c2.close();
  });
});

describe("link_repository local repositories", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-link-")));
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    vi.stubEnv("LOCAL_REPO_ROOTS", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  const agent: FakeAgentRow = { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" };

  it("links a local repository without a host gate, stamping local_root", async () => {
    const { gate, authorizePrincipal } = gateAt("unlinked");
    const { mcp } = setup([agent], "p1", [], { gate });
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: `local:${root}`, access: "read" },
    });
    expect(result.isError).toBeFalsy();
    expect(parseText(result as never)).toMatchObject({
      linked: true,
      link: { provider: "local", repository: `local:${root}`, triggers: [], authorizedVia: "local_root" },
    });
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses triggers on a local link", async () => {
    const { mcp } = setup([agent], "p1");
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: `local:${root}`,
        access: "write",
        triggers: ["pull_request"],
        checkName: "r",
      },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result as never)).toContain("local repositories support manual review only");
    await client.close();
  });

  it("refuses a repository outside the trusted roots", async () => {
    vi.stubEnv("LOCAL_REPO_ROOTS", join(tmpdir(), "elsewhere-entirely"));
    const { mcp } = setup([agent], "p1");
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: `local:${root}`, access: "read" },
    });
    expect(errorText(result as never)).toContain("local_repo_not_allowed");
    await client.close();
  });
});
