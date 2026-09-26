import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRunTools } from "./runs.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}
interface FakeRunRow {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  finalText: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  triggeredById?: string | null;
  codingRun?: {
    result: unknown;
    jobHandle?: string;
    protectedPaths?: string[];
    queuedAt?: Date | null;
    failureCategory?: string | null;
    diagnosticId?: string | null;
  } | null;
  registryFetches?: Array<{
    ecosystem: string;
    name: string;
    version: string | null;
    outcome: "served" | "refused";
    reason: string | null;
    sizeBytes?: number | null;
    filename?: string | null;
    createdAt: Date;
  }>;
  approvedVersions?: number;
}

function fakeDb(agents: FakeAgentRow[], runs: FakeRunRow[], grants: FakeGrantSeed[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const runRows = new Map(runs.map((r) => [r.id, r]));
  const publicRun = (run: FakeRunRow | undefined) => {
    if (!run) return null;
    const { codingRun: _codingRun, registryFetches: _registryFetches, approvedVersions: _approved, ...row } = run;
    return row;
  };
  return {
    resourceGrant: fakeResourceGrants(grants),
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => publicRun(runRows.get(where.id)),
      findMany: async ({ where }: { where: { agentId: string; status?: string; triggeredById?: string } }) =>
        [...runRows.values()]
          .filter(
            (r) =>
              r.agentId === where.agentId &&
              (!where.status || r.status === where.status) &&
              (where.triggeredById === undefined || (r.triggeredById ?? null) === where.triggeredById),
          )
          .map((r) => publicRun(r)),
    },
    codingRun: {
      findUnique: async ({ where }: { where: { runId: string } }) => runRows.get(where.runId)?.codingRun ?? null,
      findMany: async ({ where }: { where: { runId: { in: string[] }; queuedAt: { not: null } } }) =>
        where.runId.in
          .map((runId) => ({ runId, queuedAt: runRows.get(runId)?.codingRun?.queuedAt ?? null }))
          .filter((row) => row.queuedAt !== null),
    },
    registryApprovedVersion: {
      count: async ({ where }: { where: { runId: string } }) => runRows.get(where.runId)?.approvedVersions ?? 0,
    },
    registryFetch: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        [...(runRows.get(where.runId)?.registryFetches ?? [])].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        ),
    },
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: fakeProviders,
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

describe("run observability tools", () => {
  it("get_run returns full state incl. turns, cost, final text", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 3,
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.01,
          finalText: "the answer",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { turns: number; costUsd: number; finalText: string };
    expect(body.turns).toBe(3);
    expect(body.costUsd).toBe(0.01);
    expect(body.finalText).toBe("the answer");
    await client.close();
  });

  it("get_run on a run belonging to another owner's agent is not found", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "owner-1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          finalText: "x",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("get_run marks a coding run waiting for a concurrency slot with codingQueuedAt", async () => {
    const queuedAt = new Date("2026-09-22T12:00:00.000Z");
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "pending",
          trigger: "manual",
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          finalText: null,
          error: null,
          startedAt: queuedAt,
          finishedAt: null,
          codingRun: { result: null, queuedAt },
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    const body = parseText(result as never) as { status: string; codingQueuedAt?: string };
    expect(body.status).toBe("pending");
    expect(body.codingQueuedAt).toBe("2026-09-22T12:00:00.000Z");
    await client.close();
  });

  it("get_run returns a failed coding run's failureCategory and diagnosticId", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "failed",
          trigger: "manual",
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          finalText: null,
          error: "coding_failure_github:coding_diag_1234",
          startedAt: now,
          finishedAt: now,
          codingRun: { result: null, failureCategory: "github", diagnosticId: "coding_diag_1234" },
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    const body = parseText(result as never) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "failed", failureCategory: "github", diagnosticId: "coding_diag_1234" });
    await client.close();
  });

  it("get_run projects only the validated coding result", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 0,
          tokensIn: 1,
          tokensOut: 2,
          costUsd: 0.01,
          finalText: null,
          error: null,
          startedAt: now,
          finishedAt: now,
          codingRun: {
            jobHandle: "container-secret",
            protectedPaths: [".github/workflows/**"],
            result: {
              schemaVersion: 1,
              outcome: "no_changes",
              repository: "openai/wardby",
              baseRef: "main",
              summary: "No changes; sk-abcdefghijklmnopqrstuvwxyz0123456789",
              tests: [{ command: "npm test", outcome: "passed" }],
              usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
            },
          },
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    const body = parseText(result as never) as Record<string, unknown>;
    expect(body).not.toHaveProperty("codingRun");
    expect(body).not.toHaveProperty("jobHandle");
    expect(body).not.toHaveProperty("protectedPaths");
    // A successful run has no failure diagnostics to report.
    expect(body).not.toHaveProperty("failureCategory");
    expect(body).not.toHaveProperty("diagnosticId");
    expect(body).toMatchObject({ codingResult: { outcome: "no_changes", summary: "No changes; [REDACTED]" } });
    await client.close();
  });

  it("get_run returns deduplicated served packages and refusals for a coding run", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 0,
          tokensIn: 1,
          tokensOut: 2,
          costUsd: 0.01,
          finalText: null,
          error: null,
          startedAt: now,
          finishedAt: now,
          codingRun: { result: null },
          registryFetches: [
            {
              ecosystem: "npm",
              name: "@heroui/react",
              version: "3.2.6",
              outcome: "served",
              reason: null,
              sizeBytes: 482_113,
              createdAt: new Date(now.getTime()),
            },
            // A retried fetch of the same served package/version — collapses into one entry.
            {
              ecosystem: "npm",
              name: "@heroui/react",
              version: "3.2.6",
              outcome: "served",
              reason: null,
              sizeBytes: 482_113,
              createdAt: new Date(now.getTime() + 1000),
            },
            // A served row with no recorded size reports size null.
            {
              ecosystem: "pypi",
              name: "flask",
              version: "3.0.0",
              outcome: "served",
              reason: null,
              sizeBytes: null,
              createdAt: new Date(now.getTime() + 1500),
            },
            {
              ecosystem: "npm",
              name: "left-pad",
              version: null,
              outcome: "refused",
              reason: "wardby_package_not_allowed",
              sizeBytes: null,
              createdAt: new Date(now.getTime() + 2000),
            },
            // Lockfile plan refusals, one recorded twice: counted once.
            ...[3000, 3500, 4000].map((offset, index) => ({
              ecosystem: "npm",
              name: index === 2 ? "stray" : "evil",
              version: "1.0.0",
              filename: "-/plan",
              outcome: "refused" as const,
              reason: "wardby_package_not_allowed",
              sizeBytes: null,
              createdAt: new Date(now.getTime() + offset),
            })),
          ],
          approvedVersions: 42,
        },
        // A non-coding run has no registry fetches at all.
        {
          id: "r2",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          finalText: "x",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const codingResult = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    const codingBody = parseText(codingResult as never) as {
      packages: Array<{ ecosystem: string; name: string; version: string; size: number | null }>;
      packageRefusals: Array<{ ecosystem: string; name: string; reason: string }>;
      packagePlan: { approved: number; refused: number };
    };
    expect(codingBody.packages).toEqual([
      { ecosystem: "npm", name: "@heroui/react", version: "3.2.6", size: 482_113 },
      { ecosystem: "pypi", name: "flask", version: "3.0.0", size: null },
    ]);
    expect(codingBody.packageRefusals).toEqual([
      { ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" },
      { ecosystem: "npm", name: "evil", reason: "wardby_package_not_allowed" },
      { ecosystem: "npm", name: "stray", reason: "wardby_package_not_allowed" },
    ]);
    expect(codingBody.packagePlan).toEqual({ approved: 42, refused: 2 });

    const nonCodingResult = await client.callTool({ name: "get_run", arguments: { runId: "r2" } });
    const nonCodingBody = parseText(nonCodingResult as never) as Record<string, unknown>;
    expect(nonCodingBody).not.toHaveProperty("packages");
    expect(nonCodingBody).not.toHaveProperty("packageRefusals");
    expect(nonCodingBody).not.toHaveProperty("packagePlan");
    await client.close();
  });

  it("list_runs filters by agent and status", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          finalText: "x",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
        {
          id: "r2",
          agentId: "a1",
          status: "failed",
          trigger: "manual",
          turns: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          finalText: null,
          error: "boom",
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_runs", arguments: { agentId: "a1", status: "failed" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { id: string }[];
    expect(body.map((r) => r.id)).toEqual(["r2"]);
    await client.close();
  });

  it("list_runs marks coding runs waiting for a concurrency slot with codingQueuedAt", async () => {
    const queuedAt = new Date("2026-09-22T12:00:00.000Z");
    const base = {
      agentId: "a1",
      trigger: "manual",
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      finalText: null,
      error: null,
      startedAt: queuedAt,
      finishedAt: null,
    };
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        { ...base, id: "queued", status: "pending", codingRun: { result: null, queuedAt } },
        { ...base, id: "unqueued", status: "pending", codingRun: { result: null, queuedAt: null } },
        // A stale queuedAt on a run that already left pending is not shown.
        { ...base, id: "failed", status: "failed", codingRun: { result: null, queuedAt } },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } });
    const body = parseText(result as never) as Array<{ id: string; codingQueuedAt?: string; codingRun?: unknown }>;
    const byId = new Map(body.map((r) => [r.id, r]));
    expect(byId.get("queued")?.codingQueuedAt).toBe("2026-09-22T12:00:00.000Z");
    expect(byId.get("unqueued")).not.toHaveProperty("codingQueuedAt");
    expect(byId.get("failed")).not.toHaveProperty("codingQueuedAt");
    for (const row of body) expect(row).not.toHaveProperty("codingRun");
    await client.close();
  });

  it("list_runs on another owner's agent is not found", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "owner-1" }], []);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  describe("A6: others' runs hidden", () => {
    const now = new Date();
    const run = (id: string, triggeredById: string | null): FakeRunRow => ({
      id,
      agentId: "a1",
      status: "succeeded",
      trigger: "manual",
      turns: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      finalText: `answer for ${triggeredById ?? "schedule"}`,
      error: null,
      startedAt: now,
      finishedAt: now,
      triggeredById,
    });
    const runs = [run("r-alice", "alice"), run("r-bob", "bob"), run("r-sched", null)];

    async function as(principalId: string, agent: FakeAgentRow, grants: FakeGrantSeed[], operator = false) {
      const db = fakeDb([agent], runs, grants);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext({ ...fakeCtx(db, principalId, ["agents:read"]), operator });
      registerRunTools(mcp);
      return connectClient(mcp);
    }
    const listIds = async (client: Awaited<ReturnType<typeof as>>) =>
      (
        parseText((await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } })) as never) as {
          id: string;
        }[]
      )
        .map((r) => r.id)
        .sort();

    it("A6: others' runs hidden -- an execute-grantee sees only the runs it triggered", async () => {
      const client = await as("alice", { id: "a1", ownerId: "owner" }, [
        { resourceType: "agent", resourceId: "a1", principalId: "alice", level: "execute" },
      ]);
      expect(await listIds(client)).toEqual(["r-alice"]);
      expect((await client.callTool({ name: "get_run", arguments: { runId: "r-alice" } })).isError).toBeFalsy();
      for (const runId of ["r-bob", "r-sched"]) {
        const hidden = await client.callTool({ name: "get_run", arguments: { runId } });
        expect(hidden.isError).toBe(true);
        expect(JSON.stringify(hidden)).toContain("not found");
        expect(JSON.stringify(hidden)).not.toContain("answer for");
      }
      await client.close();
    });

    it("A6: others' runs hidden on a formerly public agent (everyone-execute)", async () => {
      const client = await as("alice", { id: "a1", ownerId: null }, [
        { resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" },
      ]);
      expect(await listIds(client)).toEqual(["r-alice"]);
      expect((await client.callTool({ name: "get_run", arguments: { runId: "r-bob" } })).isError).toBe(true);
      await client.close();
    });

    it("the agent owner and the stdio operator see every run", async () => {
      const owner = await as("owner", { id: "a1", ownerId: "owner" }, []);
      expect(await listIds(owner)).toEqual(["r-alice", "r-bob", "r-sched"]);
      expect((await owner.callTool({ name: "get_run", arguments: { runId: "r-bob" } })).isError).toBeFalsy();
      await owner.close();
      const operator = await as("local", { id: "a1", ownerId: "owner" }, [], true);
      expect(await listIds(operator)).toEqual(["r-alice", "r-bob", "r-sched"]);
      await operator.close();
    });

    it("a triggerer whose grant was revoked can still get its own run, but not list", async () => {
      const client = await as("alice", { id: "a1", ownerId: "owner" }, []);
      expect((await client.callTool({ name: "get_run", arguments: { runId: "r-alice" } })).isError).toBeFalsy();
      expect((await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } })).isError).toBe(true);
      await client.close();
    });
  });
});
