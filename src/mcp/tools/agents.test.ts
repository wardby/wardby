import { describe, it, expect, vi } from "vitest";
import type { RepoAccessDecision, RepoAccessGate } from "../../core/repo-access.js";
import type { HostPermission } from "../../providers/review-host/types.js";
import { Prisma } from "#prisma";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";
/** A gate whose linked identity (for every principal) has `level` on every repository. */
function gateAt(level: HostPermission | "unlinked") {
  const rank = ["none", "read", "triage", "write", "maintain", "admin"];
  const authorizePrincipal = vi.fn(async (input: { required: HostPermission }): Promise<RepoAccessDecision> => {
    if (level === "unlinked") return { ok: false, reason: "identity_not_linked" };
    return rank.indexOf(level) >= rank.indexOf(input.required)
      ? { ok: true, level }
      : { ok: false, reason: "insufficient_permission", level };
  });
  const gate: RepoAccessGate = { authorizePrincipal, authorizeUse: vi.fn(), authorizeHostUser: vi.fn() };
  return { gate, authorizePrincipal };
}
const fakeProviders = { repoAccess: gateAt("admin").gate } as unknown as import("../context.js").McpProviders;

interface FakeAgentRow {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  schedule: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  ownerId: string | null;
  tools: unknown[];
  kind: "native" | "coding";
  codingProfile: FakeCodingProfile | null;
  budgetGroupId: string | null;
  effort?: string | null;
}

interface FakeLink {
  agentId: string;
  repository: string;
  authorizedVia: string | null;
  authorizedById?: string | null;
}

interface FakeCodingProfile {
  provider: "codex" | "claude-code";
  repository: string;
  baseRef: string;
  defaultTask: string | null;
  timeoutSec: number;
  protectedPaths: string[];
  toolchain?: "node" | "node-python";
  toolchainVersion?: string | null;
  workerImageRef?: string | null;
}

type FakeAgentSeed = Omit<FakeAgentRow, "kind" | "codingProfile" | "scheduleEnabled" | "budgetGroupId"> &
  Partial<Pick<FakeAgentRow, "kind" | "codingProfile" | "scheduleEnabled" | "budgetGroupId">>;

function fakeDb(
  seed: FakeAgentSeed[] = [],
  budgetGroups: { id: string; ownerId: string | null }[] = [],
  principals: string[] = [],
  links: FakeLink[] = [],
  grants: FakeGrantSeed[] = [],
) {
  const principalIds = new Set(principals);
  const rows = new Map(
    seed.map((r) => [
      r.id,
      {
        kind: "native" as const,
        codingProfile: null,
        scheduleEnabled: true,
        budgetGroupId: null,
        ...r,
      },
    ]),
  );
  const groupsById = new Map(budgetGroups.map((g) => [g.id, g]));
  let counter = rows.size;
  const transactionDb = {
    resourceGrant: fakeResourceGrants(grants),
    // make_owner's binding cleanup; these fixtures hold no such rows.
    agentSecret: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    agentDatastore: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    agentSubAgent: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    webhook: { findMany: async () => [] },
    agent: {
      create: async ({
        data,
      }: {
        data: Partial<FakeAgentRow> & { name: string; codingProfile?: { create: FakeCodingProfile } };
      }) => {
        const { codingProfile, ...agentData } = data;
        const row: FakeAgentRow = {
          id: `agent_${++counter}`,
          systemPrompt: "",
          model: "",
          budgetUsd: 0,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          scheduleEnabled: true,
          ownerId: null,
          tools: [],
          kind: "native",
          codingProfile: codingProfile?.create ?? null,
          budgetGroupId: null,
          ...agentData,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      // Mirrors readableAgentsWhere: own rows, or ids granted to the caller.
      findMany: async ({ where }: { where?: { OR?: ({ ownerId: string } | { id: { in: string[] } })[] } } = {}) => {
        const all = [...rows.values()];
        if (!where?.OR) return all;
        return all.filter((r) =>
          where.OR!.some((cond) => ("ownerId" in cond ? r.ownerId === cond.ownerId : cond.id.in.includes(r.id))),
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeAgentRow> & {
          codingProfile?: { create?: FakeCodingProfile; update?: FakeCodingProfile; delete?: boolean };
        };
      }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const { codingProfile, ...agentData } = data;
        const updated = {
          ...row,
          ...agentData,
          codingProfile: codingProfile?.delete
            ? null
            : (codingProfile?.create ??
              (codingProfile?.update ? { ...row.codingProfile!, ...codingProfile.update } : row.codingProfile)),
        };
        rows.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row;
      },
    },
    agentTool: {
      count: async ({ where }: { where: { agentId: string } }) => rows.get(where.agentId)?.tools.length ?? 0,
      findMany: async ({ where }: { where: { agentId: string } }) =>
        (rows.get(where.agentId)?.tools ?? []) as { capabilitiesGrantedById?: string | null; tool: { id: string } }[],
    },
    budgetGroup: {
      findUnique: async ({ where }: { where: { id: string } }) => groupsById.get(where.id) ?? null,
    },
    principal: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        principalIds.has(where.id) ? { id: where.id, subject: where.id, createdAt: new Date() } : null,
    },
    agentRepository: {
      findMany: async ({ where }: { where: { agentId: string; authorizedVia?: { in: string[] } } }) =>
        links.filter(
          (l) =>
            l.agentId === where.agentId &&
            (!where.authorizedVia || where.authorizedVia.in.includes(l.authorizedVia ?? "")),
        ),
      updateMany: async ({
        where,
        data,
      }: {
        where: { agentId: string; authorizedVia: { in: string[] } };
        data: Partial<FakeLink>;
      }) => {
        const hit = links.filter(
          (l) => l.agentId === where.agentId && where.authorizedVia.in.includes(l.authorizedVia ?? ""),
        );
        for (const l of hit) Object.assign(l, data);
        return { count: hit.length };
      },
    },
    codingAgentProfile: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { agentId: string; repositoryAuthorizedVia: { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        const row = rows.get(where.agentId);
        const profile = row?.codingProfile as Record<string, unknown> | null | undefined;
        if (!row || !profile || !where.repositoryAuthorizedVia.in.includes(String(profile.repositoryAuthorizedVia))) {
          return { count: 0 };
        }
        rows.set(where.agentId, { ...row, codingProfile: { ...profile, ...data } as never });
        return { count: 1 };
      },
    },
  };
  const db = {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
  };
  return db as unknown as import("#prisma").PrismaClient;
}

// Callers default to NO roles (a member), as production does: a privileged
// field accidentally gated by scope alone then fails these tests. Tests of a
// privileged operation's scope gate pass ["admin"] explicitly.
function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  principalId: string,
  scopes: string[],
  roles: string[] = [],
  providers = fakeProviders,
): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    roles,
    canonicalUri: CANONICAL_URI,
    providers,
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

describe("agent CRUD tools", () => {
  it("create_agent persists with owner = caller", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "greeter", systemPrompt: "be nice", model: "gpt-4o", budgetUsd: 5 },
    });
    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.name).toBe("greeter");
    expect(created.ownerId).toBe("p1");
    expect(created.kind).toBe("native");
    expect(created.codingProfile).toBeNull();

    await client.close();
  });

  it("create_agent defaults memoryEnabled to false, and update_agent can turn it on", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_agent",
      arguments: { name: "rememberer", systemPrompt: "be nice", model: "gpt-4o", budgetUsd: 5 },
    });
    const agent = JSON.parse((created.content as { text: string }[])[0].text);
    expect(agent.memoryEnabled).toBe(false);

    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: agent.id, memoryEnabled: true },
    });
    expect(JSON.parse((updated.content as { text: string }[])[0].text).memoryEnabled).toBe(true);

    await client.close();
  });

  it("create_agent atomically creates a normalized coding profile", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          repository: "OpenAI/Example.git",
          baseRef: "refs/heads/main",
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.kind).toBe("coding");
    expect(created.codingProfile).toMatchObject({
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      timeoutSec: 1800,
    });
    await client.close();
  });

  it("workspaceDiskMb round-trips through create_agent, get_agent, and update_agent(null)", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write", "agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", workspaceDiskMb: 8192 },
      },
    });
    expect(created.isError).toBeFalsy();
    const createdAgent = JSON.parse((created.content as { text: string }[])[0].text);
    expect(createdAgent.codingProfile.workspaceDiskMb).toBe(8192);

    const fetched = await client.callTool({ name: "get_agent", arguments: { id: createdAgent.id } });
    expect(JSON.parse((fetched.content as { text: string }[])[0].text).codingProfile.workspaceDiskMb).toBe(8192);

    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: createdAgent.id, codingProfile: { workspaceDiskMb: null } },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile.workspaceDiskMb).toBeNull();
    await client.close();
  });

  it("collectExclude round-trips through create_agent and update_agent with agents:write", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write", "agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", collectExclude: ["web/dist"] },
      },
    });
    expect(created.isError).toBeFalsy();
    const createdAgent = JSON.parse((created.content as { text: string }[])[0].text);
    expect(createdAgent.codingProfile.collectExclude).toEqual(["web/dist"]);

    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: createdAgent.id, codingProfile: { collectExclude: [] } },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile.collectExclude).toEqual([]);
    await client.close();
  });

  it("create_agent accepts a Claude Code profile with a Claude model", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "claude-coder",
        systemPrompt: "Make the requested change.",
        model: "claude-sonnet-5",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { provider: "claude-code", repository: "OpenAI/Example.git" },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text).codingProfile.provider).toBe("claude-code");
    await client.close();
  });

  it("create_agent rejects a model from a different coding provider", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "mismatched-coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { provider: "claude-code", repository: "openai/example" },
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not supported by coding provider/);
    await client.close();
  });

  it.each([
    {
      label: "missing profile",
      arguments: { kind: "coding" },
    },
    {
      label: "scheduled without a default task",
      arguments: { kind: "coding", schedule: "0 * * * *", codingProfile: { repository: "openai/example" } },
    },
    {
      label: "profile on a native agent",
      arguments: { codingProfile: { repository: "openai/example" } },
    },
    {
      label: "credentialed repository",
      arguments: { kind: "coding", codingProfile: { repository: "https://token@github.com/openai/example" } },
    },
  ])("create_agent rejects $label", async ({ arguments: extra }) => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "coder", systemPrompt: "code", model: "gpt-5.6-luna", budgetUsd: 1, ...extra },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("update_agent transitions native to coding and coding back to native atomically", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const toCoding = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "OpenAI/Example" } },
    });
    expect(toCoding.isError).toBeFalsy();
    expect(JSON.parse((toCoding.content as { text: string }[])[0].text)).toMatchObject({
      kind: "coding",
      codingProfile: { repository: "openai/example" },
    });

    const toNative = await client.callTool({ name: "update_agent", arguments: { id: "a1", kind: "native" } });
    expect(toNative.isError).toBeFalsy();
    expect(JSON.parse((toNative.content as { text: string }[])[0].text)).toMatchObject({
      kind: "native",
      codingProfile: null,
    });
    await client.close();
  });

  it("update_agent rejects a coding transition while native tools remain attached", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [{}],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "openai/example" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/attached|tool/i);
    await client.close();
  });

  it("update_agent validates a merged coding profile and preserves schedule invariants", async () => {
    const profile: FakeCodingProfile = {
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: "Keep dependencies current.",
      timeoutSec: 1800,
      protectedPaths: ["CODEOWNERS"],
    };
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: "0 * * * *",
        timezone: "UTC",
        scheduleEnabled: true,
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: profile,
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "OpenAI/Other.git", timeoutSec: 600 } },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile).toMatchObject({
      repository: "openai/other",
      timeoutSec: 600,
      defaultTask: "Keep dependencies current.",
    });

    const unsafeClear = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { defaultTask: null } },
    });
    expect(unsafeClear.isError).toBe(true);
    expect(JSON.stringify(unsafeClear)).toMatch(/default task/i);
    await client.close();
  });

  it("update_agent preserves toolchain fields it was not asked to change", async () => {
    const profile: FakeCodingProfile = {
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: "Keep dependencies current.",
      timeoutSec: 1800,
      protectedPaths: ["CODEOWNERS"],
      toolchain: "node-python",
      toolchainVersion: "3.12",
    };
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        scheduleEnabled: true,
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: profile,
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    // No codingProfile in this call at all — only an unrelated top-level field changes.
    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", model: "gpt-4.1-nano" },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile).toMatchObject({
      toolchain: "node-python",
      toolchainVersion: "3.12",
    });
    await client.close();
  });

  it("update_agent rejects changing a coding provider without a compatible model", async () => {
    const profile: FakeCodingProfile = {
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: null,
      timeoutSec: 1800,
      protectedPaths: ["CODEOWNERS"],
    };
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: profile,
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { provider: "claude-code" } },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/not supported by coding provider/);
    await client.close();
  });

  it("create_agent without agents:write scope is rejected (insufficient_scope, not forbidden)", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "x", systemPrompt: "x", model: "x", budgetUsd: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  const VALID_WORKER_IMAGE_REF = `ghcr.io/example/coding-worker-driver@sha256:${"a".repeat(64)}`;

  it("create_agent with a workerImageRef requires agents:admin, not just agents:write", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "byo-coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", workerImageRef: VALID_WORKER_IMAGE_REF },
      },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Insufficient scope/);
    await client.close();
  });

  it("create_agent with a workerImageRef succeeds when the caller also holds agents:admin", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write", "agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "byo-coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", workerImageRef: VALID_WORKER_IMAGE_REF },
      },
    });

    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.codingProfile.workerImageRef).toBe(VALID_WORKER_IMAGE_REF);
    await client.close();
  });

  it("changing packageAllowlist needs packages:approve or agents:admin", async () => {
    for (const [scopes, allowed] of [
      [["agents:write"], false],
      [["agents:write", "packages:approve"], true],
      [["agents:write", "agents:admin"], true],
    ] as const) {
      const db = fakeDb();
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, "p1", [...scopes], ["admin"]));
      registerAgentTools(mcp);
      const client = await connectClient(mcp);
      const result = await client.callTool({
        name: "create_agent",
        arguments: {
          name: "coder",
          systemPrompt: "Make the requested change.",
          model: "gpt-5.6-luna",
          budgetUsd: 0.25,
          kind: "coding",
          codingProfile: { repository: "openai/example", packageAllowlist: { npm: ["react"] } },
        },
      });
      expect(Boolean(result.isError)).toBe(!allowed);
      await client.close();
    }
  });

  const codingAgentSeed = () => ({
    id: "a1",
    name: "coder",
    systemPrompt: "x",
    model: "gpt-5.6-luna",
    budgetUsd: 1,
    maxTurns: 10,
    schedule: null,
    timezone: "UTC",
    ownerId: "p1",
    tools: [],
    kind: "coding" as const,
    codingProfile: {
      provider: "codex" as const,
      repository: "openai/example",
      baseRef: "main",
      defaultTask: null,
      timeoutSec: 1800,
      protectedPaths: ["CODEOWNERS"],
    },
  });

  it.each([
    [["agents:write"], false],
    [["agents:write", "packages:approve"], true],
    [["agents:write", "agents:admin"], true],
  ] as const)("update_agent changing packageAllowlist with %j allowed=%s", async (scopes, allowed) => {
    const db = fakeDb([codingAgentSeed()]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", [...scopes], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { packageAllowlist: { npm: ["react"] } } },
    });
    expect(Boolean(result.isError)).toBe(!allowed);
    if (!allowed) {
      const text = (result.content as { text: string }[])[0].text;
      expect(text).toMatch(/insufficient_scope|scope/i);
      expect(text).toContain("packages:approve");
    }
    await client.close();
  });

  it("packagePolicy alone needs packages:approve on create_agent", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: { repository: "openai/example", packagePolicy: { minReleaseAgeDays: 0 } },
      },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("packages:approve");
    await client.close();
  });

  it("packagePolicy alone needs packages:approve on update_agent", async () => {
    const db = fakeDb([codingAgentSeed()]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { packagePolicy: { minReleaseAgeDays: 0 } } },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("packages:approve");
    await client.close();
  });

  it("update_agent patching workerImageRef requires agents:admin, not just agents:write", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "coder",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: {
          provider: "codex",
          repository: "openai/example",
          baseRef: "main",
          defaultTask: null,
          timeoutSec: 1800,
          protectedPaths: ["CODEOWNERS"],
        },
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { workerImageRef: VALID_WORKER_IMAGE_REF } },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Insufficient scope/);
    await client.close();
  });

  it("update_agent can patch other coding-profile fields without agents:admin", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "coder",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: {
          provider: "codex",
          repository: "openai/example",
          baseRef: "main",
          defaultTask: null,
          timeoutSec: 1800,
          protectedPaths: ["CODEOWNERS"],
        },
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { toolchainVersion: "3.12" } },
    });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it("update_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "update_agent", arguments: { id: "a1", systemPrompt: "hacked" } });
    expect(result.isError).toBe(true);
    // Another owner's agent is hidden, not merely forbidden.
    expect((result.content as { text: string }[])[0].text).toMatch(/not found/i);
    await client.close();
  });

  it("delete_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("delete_agent explains, instead of leaking a Prisma error, when the agent has run history", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "has-runs",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
      },
    ]);
    // What Postgres raises: Run.agentId references the agent with no onDelete rule.
    (db.agent as unknown as { delete: () => Promise<never> }).delete = async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated on the constraint: `Run_agentId_fkey`",
        { code: "P2003", clientVersion: "test" },
      );
    };
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toMatch(/run history/i);
    expect(text).toMatch(/disable_schedule/);
    expect(text).not.toMatch(/prisma|Run_agentId_fkey/i);
    await client.close();
  });

  describe("privileged operations by role (the token also carries every privileged scope)", () => {
    const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
    const ALL = ["agents:write", "agents:admin", "packages:approve"];
    async function as(roles: string[], scopes = ALL) {
      const db = fakeDb([codingAgentSeed()], [], ["new-owner"]);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, "p1", scopes, roles));
      registerAgentTools(mcp);
      return connectClient(mcp);
    }
    const ops = {
      make_owner: { name: "make_owner", arguments: { agentId: "a1", ownerId: "new-owner" } },
      workerImageRef: {
        name: "create_agent",
        arguments: {
          name: "byo-coder",
          systemPrompt: "x",
          model: "gpt-5.6-luna",
          budgetUsd: 0.25,
          kind: "coding",
          codingProfile: { repository: "openai/example", workerImageRef: VALID_WORKER_IMAGE_REF },
        },
      },
      packages: {
        name: "update_agent",
        arguments: { id: "a1", codingProfile: { packageAllowlist: { npm: ["react"] } } },
      },
    } as const;

    it.each([
      [[], { make_owner: false, workerImageRef: false, packages: false }],
      [["package-approver"], { make_owner: false, workerImageRef: false, packages: true }],
      [["admin"], { make_owner: true, workerImageRef: true, packages: true }],
    ] as const)("roles %j", async (roles, allowed) => {
      for (const [op, call] of Object.entries(ops) as [keyof typeof ops, (typeof ops)[keyof typeof ops]][]) {
        const client = await as([...roles]);
        const result = await client.callTool(call);
        expect(Boolean(result.isError), `${op} for ${JSON.stringify(roles)}`).toBe(!allowed[op]);
        if (!allowed[op]) expect(text(result)).toMatch(/requires a role that grants it/);
        await client.close();
      }
    });

    it("package-approver still needs packages:approve on the token", async () => {
      const client = await as(["package-approver"], ["agents:write"]);
      const result = await client.callTool(ops.packages);
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Insufficient scope/);
      await client.close();
    });

    it("non-privileged edits still work for a member", async () => {
      const client = await as([], ["agents:write"]);
      const result = await client.callTool({ name: "update_agent", arguments: { id: "a1", systemPrompt: "y" } });
      expect(result.isError).toBeFalsy();
      await client.close();
    });
  });

  it("make_owner reassigns an already-owned agent to a different principal, with agents:admin", async () => {
    const db = fakeDb(
      [
        {
          id: "a1",
          name: "shared",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "owner-1",
          tools: [],
        },
      ],
      [],
      ["new-owner"],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "make_owner", arguments: { agentId: "a1", ownerId: "new-owner" } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as { text: string }[])[0].text) as { ownerId: string };
    expect(body.ownerId).toBe("new-owner");
    await client.close();
  });

  it("make_owner assigns an owner to a public (null-owner) agent", async () => {
    const db = fakeDb(
      [
        {
          id: "a1",
          name: "public",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: null,
          tools: [],
        },
      ],
      [],
      ["new-owner"],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "make_owner", arguments: { agentId: "a1", ownerId: "new-owner" } });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it("make_owner refuses ownerId: null (sharing is done with grants, not owner-less agents)", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "make_owner", arguments: { agentId: "a1", ownerId: null } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/grant_access/);
    expect((await db.agent.findUnique({ where: { id: "a1" } }))?.ownerId).toBe("owner-1");
    await client.close();
  });

  it("make_owner without agents:admin scope is rejected, even for the agent's own owner", async () => {
    const db = fakeDb(
      [
        {
          id: "a1",
          name: "mine",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "p1",
          tools: [],
        },
      ],
      [],
      ["p1"],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "make_owner", arguments: { agentId: "a1", ownerId: "p1" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Insufficient scope/);
    await client.close();
  });

  it("make_owner 404s for a missing agent", async () => {
    const db = fakeDb([], [], ["new-owner"]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "make_owner",
      arguments: { agentId: "missing", ownerId: "new-owner" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("make_owner rejects a target principal that doesn't exist", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "make_owner",
      arguments: { agentId: "a1", ownerId: "no-such-principal" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("list_agents returns the caller's own agents plus agents granted to it, with the access held", async () => {
    const db = fakeDb(
      [
        {
          id: "a1",
          name: "mine",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "p1",
          tools: [],
        },
        {
          id: "a2",
          name: "public",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: null,
          tools: [],
        },
        {
          id: "a3",
          name: "someone-elses",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "p2",
          tools: [],
        },
        {
          id: "a4",
          name: "shared-with-me",
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "p2",
          tools: [],
        },
      ],
      [],
      [],
      [],
      [
        // The migration's grant for a formerly public agent, and a direct share.
        { resourceType: "agent", resourceId: "a2", granteeKind: "everyone", level: "execute" },
        { resourceType: "agent", resourceId: "a4", principalId: "p1", level: "write" },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.isError).toBeFalsy();
    const list = JSON.parse((result.content as { text: string }[])[0].text) as { name: string; access: string }[];
    expect(Object.fromEntries(list.map((a) => [a.name, a.access]))).toEqual({
      mine: "owner",
      public: "execute",
      "shared-with-me": "write",
    });
    await client.close();
  });

  it("an owner-less agent with no grant is invisible (no more implicit public)", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "orphan",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: null,
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    expect(JSON.parse((listed.content as { text: string }[])[0].text)).toEqual([]);
    const got = await client.callTool({ name: "get_agent", arguments: { id: "a1" } });
    expect(got.isError).toBe(true);
    await client.close();
  });

  it("create_agent accepts a budgetGroupId for a group the caller can read (public)", async () => {
    const db = fakeDb([], [{ id: "g1", ownerId: null }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 1, budgetGroupId: "g1" },
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content as { text: string }[])[0].text) as { budgetGroupId: string };
    expect(body.budgetGroupId).toBe("g1");
    await client.close();
  });

  it("create_agent rejects a budgetGroupId for a group owned by someone else", async () => {
    const db = fakeDb([], [{ id: "g1", ownerId: "someone-else" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "grouped", systemPrompt: "s", model: "m", budgetUsd: 1, budgetGroupId: "g1" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("update_agent can clear an agent's budgetGroupId back to null", async () => {
    const db = fakeDb(
      [
        {
          id: "a1",
          name: "grouped",
          systemPrompt: "s",
          model: "m",
          budgetUsd: 1,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          ownerId: "p1",
          tools: [],
          budgetGroupId: "g1",
        },
      ],
      [{ id: "g1", ownerId: null }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", budgetGroupId: null },
    });
    const body = JSON.parse((result.content as { text: string }[])[0].text) as { budgetGroupId: string | null };
    expect(body.budgetGroupId).toBeNull();
    await client.close();
  });

  describe("effort", () => {
    async function setup(seed: FakeAgentSeed[] = []) {
      const db = fakeDb(seed);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
      registerAgentTools(mcp);
      return connectClient(mcp);
    }
    const nativeSeed = (effort: string | null): FakeAgentSeed => ({
      id: "a1",
      name: "reviewer",
      systemPrompt: "s",
      model: "claude-sonnet-5",
      budgetUsd: 1,
      maxTurns: 10,
      schedule: null,
      timezone: "UTC",
      ownerId: "p1",
      tools: [],
      effort,
    });
    const body = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      JSON.parse((result.content as { text: string }[])[0].text);
    const base = { name: "reviewer", systemPrompt: "s", budgetUsd: 1 };

    it("create_agent stores an effort the model accepts, and defaults to unset", async () => {
      const client = await setup();
      const set = await client.callTool({
        name: "create_agent",
        arguments: { ...base, model: "claude-sonnet-5", effort: "low" },
      });
      expect(set.isError).toBeFalsy();
      expect(body(set).effort).toBe("low");
      const unset = await client.callTool({
        name: "create_agent",
        arguments: { ...base, name: "other", model: "claude-sonnet-5" },
      });
      expect(body(unset).effort).toBeUndefined();
      await client.close();
    });

    it.each([
      { model: "claude-haiku-4-5", effort: "low" },
      { model: "gpt-4o", effort: "high" },
    ])("create_agent rejects effort $effort on $model", async ({ model, effort }) => {
      const client = await setup();
      const result = await client.callTool({ name: "create_agent", arguments: { ...base, model, effort } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(`Model \\"${model}\\" does not accept effort \\"${effort}\\"`);
      await client.close();
    });

    it("create_agent rejects an unknown effort level", async () => {
      const client = await setup();
      const result = await client.callTool({
        name: "create_agent",
        arguments: { ...base, model: "claude-sonnet-5", effort: "extreme" },
      });
      expect(result.isError).toBe(true);
      await client.close();
    });

    it("create_agent rejects effort on a coding agent", async () => {
      const client = await setup();
      const result = await client.callTool({
        name: "create_agent",
        arguments: {
          ...base,
          model: "claude-sonnet-5",
          effort: "low",
          kind: "coding",
          codingProfile: { provider: "claude-code", repository: "your-org/your-repo" },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/only valid for native agents/);
      await client.close();
    });

    it("update_agent sets and clears effort", async () => {
      const client = await setup([nativeSeed(null)]);
      const set = await client.callTool({ name: "update_agent", arguments: { id: "a1", effort: "xhigh" } });
      expect(set.isError).toBeFalsy();
      expect(body(set).effort).toBe("xhigh");
      const cleared = await client.callTool({ name: "update_agent", arguments: { id: "a1", effort: null } });
      expect(cleared.isError).toBeFalsy();
      expect(body(cleared).effort).toBeNull();
      await client.close();
    });

    it("update_agent rejects a level the agent's model does not accept", async () => {
      const client = await setup([{ ...nativeSeed(null), model: "claude-haiku-4-5" }]);
      const result = await client.callTool({ name: "update_agent", arguments: { id: "a1", effort: "low" } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('Model \\"claude-haiku-4-5\\" does not accept effort \\"low\\"');
      await client.close();
    });

    it("update_agent re-validates an existing effort when the model changes", async () => {
      const client = await setup([nativeSeed("medium")]);
      const rejected = await client.callTool({
        name: "update_agent",
        arguments: { id: "a1", model: "claude-haiku-4-5" },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain('does not accept effort \\"medium\\"');

      const allowed = await client.callTool({
        name: "update_agent",
        arguments: { id: "a1", model: "claude-haiku-4-5", effort: null },
      });
      expect(allowed.isError).toBeFalsy();
      expect(body(allowed)).toMatchObject({ model: "claude-haiku-4-5", effort: null });
      await client.close();
    });

    it("update_agent rejects effort on a coding agent, including a native agent becoming coding", async () => {
      const client = await setup([nativeSeed("low")]);
      const result = await client.callTool({
        name: "update_agent",
        arguments: {
          id: "a1",
          kind: "coding",
          codingProfile: { provider: "claude-code", repository: "your-org/your-repo" },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/only valid for native agents/);
      await client.close();
    });
  });
});

describe("agent tools under grants", () => {
  const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
  const base = (extra: Partial<FakeAgentSeed> = {}): FakeAgentSeed => ({
    id: "a1",
    name: "shared",
    systemPrompt: "x",
    model: "gpt-5.6-luna",
    budgetUsd: 1,
    maxTurns: 10,
    schedule: null,
    timezone: "UTC",
    ownerId: "owner",
    tools: [],
    ...extra,
  });
  const grant = (level: string): FakeGrantSeed => ({
    resourceType: "agent",
    resourceId: "a1",
    principalId: "g",
    level,
  });
  async function as(
    principalId: string,
    seed: FakeAgentSeed,
    grants: FakeGrantSeed[],
    scopes = ["agents:write", "agents:read"],
  ) {
    const db = fakeDb([seed], [], [], [], grants);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, principalId, scopes));
    registerAgentTools(mcp);
    return { db, client: await connectClient(mcp) };
  }

  it("update_agent: a write-grantee edits the prompt; execute and read grantees get 403", async () => {
    const writer = await as("g", base(), [grant("write")]);
    const ok = await writer.client.callTool({ name: "update_agent", arguments: { id: "a1", systemPrompt: "new" } });
    expect(ok.isError).toBeFalsy();
    expect((await writer.db.agent.findUnique({ where: { id: "a1" } }))?.systemPrompt).toBe("new");
    await writer.client.close();
    for (const level of ["execute", "read"]) {
      const other = await as("g", base(), [grant(level)]);
      const refused = await other.client.callTool({
        name: "update_agent",
        arguments: { id: "a1", systemPrompt: "no" },
      });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/needs write access; you have/);
      await other.client.close();
    }
  });

  it("update_agent: a write-grantee can't set a repository or turn the agent into a coding one (a binding)", async () => {
    const coder = base({
      kind: "coding",
      codingProfile: {
        provider: "codex",
        repository: "o/r",
        baseRef: "main",
        defaultTask: null,
        timeoutSec: 1800,
        protectedPaths: ["CODEOWNERS"],
      },
    });
    const writer = await as("g", coder, [grant("write")]);
    const refused = await writer.client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "attacker/repo" } },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/owner/);
    // Other coding-profile fields are ordinary config at write.
    const ok = await writer.client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { baseRef: "develop" } },
    });
    expect(ok.isError).toBeFalsy();
    await writer.client.close();

    const nativeWriter = await as("g", base(), [grant("write")]);
    const toCoding = await nativeWriter.client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "attacker/repo" } },
    });
    expect(toCoding.isError).toBe(true);
    expect(text(toCoding)).toMatch(/owner/);
    await nativeWriter.client.close();
  });

  it("A7: get_agent hides non-owned tool code", async () => {
    const attachment = (id: string, ownerId: string | null) => ({
      agentId: "a1",
      toolId: id,
      allowedSecrets: ["KEY"],
      allowedDatastorePrefixes: [],
      allowedHosts: [],
      allowedSharedDatastorePrefixes: {},
      tool: {
        id,
        name: id,
        description: `${id} description`,
        paramsZod: `${id} schema`,
        jsonSchema: {},
        code: `${id} SECRET SOURCE`,
        ownerId,
      },
    });
    const seed = base({ tools: [attachment("owner-tool", "owner"), attachment("g-tool", "g")] });
    const reader = await as("g", seed, [grant("read")]);
    const body = JSON.parse(text(await reader.client.callTool({ name: "get_agent", arguments: { id: "a1" } }))) as {
      access: string;
      tools: { allowedSecrets: string[]; tool: Record<string, unknown> }[];
    };
    expect(body.access).toBe("read");
    const [ownerTool, ownTool] = body.tools;
    expect(ownerTool.tool).toEqual({
      id: "owner-tool",
      name: "owner-tool",
      description: "owner-tool description",
      public: false,
      ownerIsCaller: false,
    });
    expect(JSON.stringify(body)).not.toContain("owner-tool SECRET SOURCE");
    expect(JSON.stringify(body)).not.toContain("owner-tool schema");
    // The caller's own tool keeps its code; attachment capabilities stay visible (config).
    expect(ownTool.tool.code).toBe("g-tool SECRET SOURCE");
    expect(ownerTool.allowedSecrets).toEqual(["KEY"]);
    await reader.client.close();

    const owner = await as("owner", seed, []);
    const ownerView = JSON.parse(text(await owner.client.callTool({ name: "get_agent", arguments: { id: "a1" } })));
    expect(ownerView.access).toBe("owner");
    expect(JSON.stringify(ownerView)).toContain("owner-tool SECRET SOURCE");
    expect(JSON.stringify(ownerView)).not.toContain("g-tool SECRET SOURCE");
    await owner.client.close();
  });

  it("delete_agent is owner-only, and removes the agent's grants with it", async () => {
    const writer = await as("g", base(), [grant("write")]);
    const refused = await writer.client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/owner/);
    await writer.client.close();

    const owner = await as("owner", base(), [grant("write")]);
    const ok = await owner.client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(ok.isError).toBeFalsy();
    expect(await owner.db.resourceGrant.count({ where: { resourceId: "a1" } })).toBe(0);
    await owner.client.close();
  });
});

describe("coding repository authorization (H5-1/C3-2)", () => {
  const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
  const createCoding = (extra: Record<string, unknown> = {}) => ({
    name: "create_agent",
    arguments: {
      name: "coder",
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 0.25,
      kind: "coding",
      codingProfile: { repository: "OpenAI/Example" },
      ...extra,
    },
  });
  const seeded = (ownerId: string | null = "p1") =>
    fakeDb([
      {
        id: "a1",
        name: "coder",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId,
        tools: [],
        kind: "coding",
        codingProfile: {
          provider: "codex",
          repository: "openai/example",
          baseRef: "main",
          defaultTask: null,
          timeoutSec: 1800,
          protectedPaths: [".github/workflows/**"],
          repositoryAuthorizedVia: "grandfathered",
          repositoryAuthorizedById: null,
        } as never,
      },
    ]);
  async function connect(
    db: ReturnType<typeof fakeDb>,
    gate: RepoAccessGate,
    opts: { roles?: string[]; scopes?: string[] } = {},
  ) {
    const providers = { repoAccess: gate } as unknown as import("../context.js").McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", opts.scopes ?? ["agents:write"], opts.roles ?? [], providers));
    registerAgentTools(mcp);
    return connectClient(mcp);
  }

  it("create_agent checks the caller's GitHub access at write and stamps the profile", async () => {
    const { gate, authorizePrincipal } = gateAt("write");
    const client = await connect(fakeDb(), gate);
    const result = await client.callTool(createCoding());
    expect(result.isError).toBeFalsy();
    expect(authorizePrincipal).toHaveBeenCalledWith({
      principalId: "p1",
      provider: "github",
      repository: "openai/example",
      required: "write",
      fresh: true,
    });
    expect(JSON.parse(text(result)).codingProfile).toMatchObject({
      repository: "openai/example",
      repositoryAuthorizedVia: "host_permission",
      repositoryAuthorizedById: "p1",
    });
    await client.close();
  });

  it("create_agent refuses a caller without a linked account or with only read or triage", async () => {
    for (const level of ["unlinked", "read", "triage"] as const) {
      const db = fakeDb();
      const client = await connect(db, gateAt(level).gate);
      const result = await client.callTool(createCoding());
      expect(result.isError, level).toBe(true);
      expect(text(result)).toMatch(level === "unlinked" ? /link_host_account/ : /needs write/);
      expect((await db.agent.findMany({})).length).toBe(0);
      await client.close();
    }
  });

  it("repositoryAdminOverride records an admin approval, and is refused for a member", async () => {
    const admin = gateAt("none");
    const asAdmin = await connect(fakeDb(), admin.gate, {
      roles: ["admin"],
      scopes: ["agents:write", "agents:admin"],
    });
    const approved = await asAdmin.callTool(createCoding({ repositoryAdminOverride: true }));
    expect(approved.isError).toBeFalsy();
    expect(JSON.parse(text(approved)).codingProfile).toMatchObject({
      repositoryAuthorizedVia: "admin",
      repositoryAuthorizedById: "p1",
    });
    expect(admin.authorizePrincipal).not.toHaveBeenCalled();
    await asAdmin.close();

    const member = await connect(fakeDb(), gateAt("admin").gate, { scopes: ["agents:write", "agents:admin"] });
    const refused = await member.callTool(createCoding({ repositoryAdminOverride: true }));
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/requires a role/);
    await member.close();
  });

  it("update_agent without a repository change makes no GitHub call and keeps the stamp", async () => {
    const { gate, authorizePrincipal } = gateAt("none");
    const client = await connect(seeded(), gate);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", systemPrompt: "y", codingProfile: { timeoutSec: 900, repository: "OpenAI/Example" } },
    });
    expect(result.isError).toBeFalsy();
    expect(authorizePrincipal).not.toHaveBeenCalled();
    expect(JSON.parse(text(result)).codingProfile).toMatchObject({
      timeoutSec: 900,
      repositoryAuthorizedVia: "grandfathered",
    });
    await client.close();
  });

  it("update_agent re-authorizes a changed repository, and refuses it without access", async () => {
    const denied = gateAt("read");
    const db = seeded();
    const refusedClient = await connect(db, denied.gate);
    const refused = await refusedClient.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "openai/other" } },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/needs write/);
    expect(
      ((await db.agent.findUnique({ where: { id: "a1" } })) as { codingProfile?: unknown } | null)?.codingProfile,
    ).toMatchObject({
      repository: "openai/example",
    });
    await refusedClient.close();

    const allowed = gateAt("write");
    const client = await connect(db, allowed.gate);
    const changed = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "openai/other" } },
    });
    expect(changed.isError).toBeFalsy();
    expect(allowed.authorizePrincipal).toHaveBeenCalledWith(expect.objectContaining({ repository: "openai/other" }));
    expect(JSON.parse(text(changed)).codingProfile).toMatchObject({
      repository: "openai/other",
      repositoryAuthorizedVia: "host_permission",
      repositoryAuthorizedById: "p1",
    });
    await client.close();
  });

  it("update_agent refuses to give a public (owner-less) agent a repository", async () => {
    const { gate, authorizePrincipal } = gateAt("admin");
    const client = await connect(seeded(null), gate, { roles: ["admin"], scopes: ["agents:write", "agents:admin"] });
    for (const extra of [{}, { repositoryAdminOverride: true }]) {
      const result = await client.callTool({
        name: "update_agent",
        arguments: { id: "a1", codingProfile: { repository: "openai/other" }, ...extra },
      });
      expect(result.isError).toBe(true);
      // Hidden without a grant; with the admin override, refused for having no owner.
      expect(text(result)).toMatch(/without an owner|not found/);
    }
    expect(authorizePrincipal).not.toHaveBeenCalled();
    await client.close();
  });

  it("update_agent turning a native agent into a coding one checks its repository", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
      },
    ]);
    const client = await connect(db, gateAt("unlinked").gate);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "openai/example" } },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/link_host_account/);
    await client.close();
  });
});

describe("make_owner and repository approvals (I-1)", () => {
  const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
  const agent = (ownerId: string | null, via: string) => ({
    id: "a1",
    name: "coder",
    systemPrompt: "x",
    model: "gpt-5.6-luna",
    budgetUsd: 1,
    maxTurns: 10,
    schedule: null,
    timezone: "UTC",
    ownerId,
    tools: [],
    kind: "coding" as const,
    codingProfile: {
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: null,
      timeoutSec: 1800,
      protectedPaths: ["CODEOWNERS"],
      repositoryAuthorizedVia: via,
      repositoryAuthorizedById: "approver",
    } as never,
  });
  async function makeOwner(ownerId: string | null, newOwner: string | null, links: FakeLink[]) {
    const db = fakeDb([agent(ownerId, "admin")], [], ["new-owner", "owner-1"], links);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "admin-caller", ["agents:admin"], ["admin"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "make_owner", arguments: { agentId: "a1", ownerId: newOwner } });
    await client.close();
    const row = (await db.agent.findUnique({ where: { id: "a1" } })) as unknown as {
      codingProfile: Record<string, unknown>;
    };
    return { result, profile: row.codingProfile };
  }

  it("moving an agent to a different owner turns admin/grandfathered approvals into checks of the new owner's access", async () => {
    const links: FakeLink[] = [
      { agentId: "a1", repository: "bot/repo", authorizedVia: "admin", authorizedById: "approver" },
      { agentId: "a1", repository: "old/repo", authorizedVia: "grandfathered" },
      { agentId: "a1", repository: "mine/repo", authorizedVia: "host_permission", authorizedById: "owner-1" },
    ];
    const { result, profile } = await makeOwner("owner-1", "new-owner", links);
    expect(result.isError).toBeFalsy();
    expect(links.map((l) => l.authorizedVia)).toEqual(["host_permission", "host_permission", "host_permission"]);
    expect(links[0].authorizedById).toBeNull();
    expect(links[2].authorizedById).toBe("owner-1");
    expect(profile).toMatchObject({ repositoryAuthorizedVia: "host_permission", repositoryAuthorizedById: null });
    expect(JSON.parse(text(result)).repositoryApprovalsRevoked).toEqual(["bot/repo", "old/repo", "openai/example"]);
  });

  it("can't release an owned agent to owner-less at all, so approvals can't be laundered through one", async () => {
    const links: FakeLink[] = [{ agentId: "a1", repository: "bot/repo", authorizedVia: "admin" }];
    const { result } = await makeOwner("owner-1", null, links);
    expect(result.isError).toBe(true);
    expect(links[0].authorizedVia).toBe("admin");
  });

  it("keeps approvals when a public agent gets its first owner, and when the owner is unchanged", async () => {
    for (const [from, to] of [
      [null, "new-owner"],
      ["owner-1", "owner-1"],
    ] as const) {
      const links: FakeLink[] = [{ agentId: "a1", repository: "bot/repo", authorizedVia: "admin" }];
      const { result, profile } = await makeOwner(from, to, links);
      expect(result.isError).toBeFalsy();
      expect(links[0].authorizedVia).toBe("admin");
      expect(profile.repositoryAuthorizedVia).toBe("admin");
      expect(JSON.parse(text(result)).repositoryApprovalsRevoked).toEqual([]);
    }
  });
});

describe("update_agent admin override on someone else's agent (M-3) and override: false (M-6)", () => {
  const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;
  const seed = () =>
    fakeDb([
      {
        id: "a1",
        name: "coder",
        systemPrompt: "x",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "someone-else",
        tools: [],
        kind: "coding",
        codingProfile: {
          provider: "codex",
          repository: "openai/example",
          baseRef: "main",
          defaultTask: null,
          timeoutSec: 1800,
          protectedPaths: ["CODEOWNERS"],
          repositoryAuthorizedVia: "host_permission",
        } as never,
      },
    ]);
  async function as(principal: string, roles: string[], db = seed()) {
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, principal, ["agents:write", "agents:admin"], roles));
    registerAgentTools(mcp);
    return connectClient(mcp);
  }

  it("lets an admin change only the repository of an agent they don't own, recorded as their approval", async () => {
    const client = await as("admin-1", ["admin"]);
    const ok = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "bot/repo" }, repositoryAdminOverride: true },
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(text(ok)).codingProfile).toMatchObject({
      repository: "bot/repo",
      repositoryAuthorizedVia: "admin",
      repositoryAuthorizedById: "admin-1",
    });
    const more = await client.callTool({
      name: "update_agent",
      arguments: {
        id: "a1",
        systemPrompt: "y",
        codingProfile: { repository: "bot/other" },
        repositoryAdminOverride: true,
      },
    });
    expect(more.isError).toBe(true);
    expect(text(more)).toMatch(/only codingProfile.repository/);
    await client.close();
  });

  it("refuses a member using the override on someone else's agent", async () => {
    const client = await as("p1", []);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "bot/repo" }, repositoryAdminOverride: true },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires a role/);
    await client.close();
  });

  it("treats repositoryAdminOverride: false as absent (no 400) on update and create", async () => {
    const client = await as("someone-else", []);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", systemPrompt: "y", repositoryAdminOverride: false },
    });
    expect(result.isError).toBeFalsy();
    const created = await client.callTool({
      name: "create_agent",
      arguments: { name: "n", systemPrompt: "x", model: "gpt-4o", budgetUsd: 1, repositoryAdminOverride: false },
    });
    expect(created.isError).toBeFalsy();
    await client.close();
  });
});
