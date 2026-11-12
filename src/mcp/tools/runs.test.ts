import { beforeEach, describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRunTools } from "./runs.js";
import { refusalHint } from "../../coding/registry/refusal-hints.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";
const { loadAgentSecretValues } = vi.hoisted(() => ({ loadAgentSecretValues: vi.fn() }));
vi.mock("../../core/secret-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/secret-guard.js")>()),
  loadAgentSecretValues,
}));

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
  taskOverride?: string | null;
  nativeExecutionMode?: "control_plane" | "sandbox" | null;
  codingRun?: {
    result: unknown;
    jobHandle?: string;
    protectedPaths?: string[];
    queuedAt?: Date | null;
    resultBranch?: string | null;
    baseSha?: string | null;
    dependencyCacheResult?: unknown;
    prDescriptionOutcome?: string | null;
    failureCategory?: string | null;
    diagnosticId?: string | null;
    debugTrace?: boolean;
    debugTraceMaxMb?: number | null;
    services?: unknown;
    packageAuditMode?: "audit" | "full" | null;
    budgetBaseUsd?: string | null;
    budgetReservedUsd?: string | null;
    budgetLimitUsd?: string | null;
    repositories?: Array<Record<string, unknown>>;
  } | null;
  auditRecords?: Array<{
    ecosystem: string;
    name: string;
    version: string;
    relation: string;
    via: string | null;
    sizeBytes: number | null;
    advisories: unknown;
    createdAt: Date;
  }>;
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
  budgetEvents?: Array<{ kind: string; limit: string; at: Date; details: unknown }>;
  localPullRequest?: Record<string, unknown> | null;
  /** What a select of parentRunId + agent (name, budget, group) sees. */
  parentRunId?: string | null;
  budgetAgent?: { name: string; budgetUsd: number; budgetGroup: { name: string } | null } | null;
}

function fakeDb(agents: FakeAgentRow[], runs: FakeRunRow[], grants: FakeGrantSeed[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const runRows = new Map(runs.map((r) => [r.id, r]));
  const publicRun = (run: FakeRunRow | undefined) => {
    if (!run) return null;
    const {
      codingRun: _codingRun,
      localPullRequest: _lpr,
      registryFetches: _registryFetches,
      approvedVersions: _approved,
      budgetEvents: _budgetEvents,
      parentRunId: _parentRunId,
      budgetAgent: _budgetAgent,
      auditRecords: _audits,
      ...row
    } = run;
    return row;
  };
  return {
    resourceGrant: fakeResourceGrants(grants),
    // No run has steps here.
    $queryRaw: async () => [],
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    run: {
      findUnique: async ({ where, select }: { where: { id: string }; select?: { agent?: unknown } }) => {
        const run = runRows.get(where.id);
        if (select?.agent) return run ? { parentRunId: run.parentRunId ?? null, agent: run.budgetAgent ?? null } : null;
        return publicRun(run);
      },
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
    codingRunRepository: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        runRows.get(where.runId)?.codingRun?.repositories ?? [],
    },
    localPullRequest: {
      findUnique: async ({ where }: { where: { runId: string } }) => runRows.get(where.runId)?.localPullRequest ?? null,
    },
    runBudgetEvent: {
      findMany: async ({ where }: { where: { runId: string } }) => runRows.get(where.runId)?.budgetEvents ?? [],
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
    registryAuditRecord: {
      findMany: async ({ where }: { where: { runId: string } }) =>
        [...(runRows.get(where.runId)?.auditRecords ?? [])].sort(
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

  it("get_run and list_runs return the execution mode in its operator spelling", async () => {
    const now = new Date();
    const run = (id: string, nativeExecutionMode: FakeRunRow["nativeExecutionMode"]): FakeRunRow => ({
      id,
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
      nativeExecutionMode,
    });
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [run("r1", "control_plane"), run("r2", "sandbox"), run("r3", null)],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const mode = async (runId: string) =>
      (
        parseText((await client.callTool({ name: "get_run", arguments: { runId } })) as never) as {
          nativeExecutionMode: unknown;
        }
      ).nativeExecutionMode;
    expect(await mode("r1")).toBe("control-plane");
    expect(await mode("r2")).toBe("sandbox");
    expect(await mode("r3")).toBeNull();
    const listed = parseText((await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } })) as never) as {
      id: string;
      nativeExecutionMode: unknown;
    }[];
    expect(Object.fromEntries(listed.map((r) => [r.id, r.nativeExecutionMode]))).toEqual({
      r1: "control-plane",
      r2: "sandbox",
      r3: null,
    });
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

  it("get_run returns a coding run's base budget and enforced limit", async () => {
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
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 1.04,
          finalText: null,
          error: null,
          startedAt: now,
          finishedAt: now,
          codingRun: {
            result: null,
            budgetBaseUsd: "1.000000",
            budgetReservedUsd: "1.100000",
            budgetLimitUsd: "1.500000",
          },
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(parseText(result as never)).toMatchObject({ budgetBaseUsd: 1, budgetReservedUsd: 1.1, budgetLimitUsd: 1.5 });
    await client.close();
  });

  it("get_run lists a run's recorded budget refusals with names filled, and omits the key when there are none", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const row = {
      agentId: "a1",
      status: "budget_exhausted",
      trigger: "manual",
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      finalText: null,
      error: null,
      startedAt: now,
      finishedAt: now,
    };
    const proxy = {
      source: "proxy",
      budgetUsd: 3,
      spentUsd: 2.9,
      heldReservedUsd: 0,
      heldUncertainUsd: 0,
      refusedHoldUsd: 0.2,
      model: "gpt-6",
      turn: 7,
    };
    const dispatch = { source: "dispatch", capUsd: 5, spentUsd: 5, heldUsd: 0, heldRuns: 0 };
    const later = new Date(now.getTime() + 1000);
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          ...row,
          id: "r1",
          parentRunId: "lead-run",
          budgetAgent: { name: "child-agent", budgetUsd: 9, budgetGroup: { name: "mobile" } },
          budgetEvents: [
            { kind: "refused", limit: "run-tree", at: now, details: { ...proxy, groupName: "forged" } },
            { kind: "refused", limit: "week", at: later, details: dispatch },
          ],
        },
        { ...row, id: "lead-run", budgetAgent: { name: "lead-agent", budgetUsd: 20, budgetGroup: null } },
        { ...row, id: "r2" },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const withEvent = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r1" } })) as never);
    expect(withEvent).toMatchObject({
      budgetEvents: [
        {
          kind: "refused",
          limit: "run-tree",
          at: now.toISOString(),
          details: { ...proxy, agentBudgetUsd: 9, groupName: "mobile", leadAgentName: "lead-agent" },
        },
        { kind: "refused", limit: "week", at: later.toISOString(), details: { ...dispatch, groupName: "mobile" } },
      ],
    });
    const [, dispatched] = (withEvent as { budgetEvents: Array<{ details: Record<string, unknown> }> }).budgetEvents;
    expect(dispatched.details).not.toHaveProperty("agentBudgetUsd");
    expect(dispatched.details).not.toHaveProperty("leadAgentName");
    expect(dispatched.details).not.toHaveProperty("groupCapUsd");
    const without = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r2" } })) as never);
    expect(without).not.toHaveProperty("budgetEvents");
    await client.close();
  });

  it("get_run says a coding run was traced only when it was", async () => {
    const now = new Date();
    const row = (id: string, debugTrace: boolean, debugTraceMaxMb: number | null = null) => ({
      id,
      agentId: "a1",
      status: "failed",
      trigger: "manual" as const,
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      finalText: null,
      error: null,
      startedAt: now,
      finishedAt: now,
      codingRun: { result: null, debugTrace, debugTraceMaxMb },
    });
    const db = fakeDb([{ id: "a1", ownerId: "p1" }], [row("r1", true), row("r2", false), row("r3", true, 20)]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const traced = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r1" } })) as never);
    expect(traced).toMatchObject({ debugTrace: true });
    const plain = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r2" } })) as never);
    expect(plain).not.toHaveProperty("debugTrace");
    expect(traced).not.toHaveProperty("debugTraceMaxMb");
    const capped = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r3" } })) as never);
    expect(capped).toMatchObject({ debugTrace: true, debugTraceMaxMb: 20 });
    await client.close();
  });

  it("get_run lists every repository of a multi-repository run in order, and none for a single-repository run", async () => {
    const now = new Date();
    const base = {
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
    };
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          ...base,
          id: "multi",
          codingRun: {
            result: null,
            repositories: [
              {
                name: "app",
                access: "write",
                repository: "your-org/app",
                requestedRef: "main",
                resolvedSha: null,
                pullRequestNumber: 12,
                resultBranch: "wardby/run-multi",
                result: {
                  schemaVersion: 1,
                  outcome: "no_changes",
                  repository: "your-org/app",
                  baseRef: "main",
                  summary: "done",
                  tests: [],
                  usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
                },
              },
              {
                name: "upstream",
                access: "read",
                repository: "upstream-org/upstream",
                requestedRef: "v1",
                resolvedSha: "a".repeat(40),
                pullRequestNumber: null,
                resultBranch: null,
                result: null,
              },
            ],
          },
        },
        { ...base, id: "single", codingRun: { result: null } },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const multi = parseText((await client.callTool({ name: "get_run", arguments: { runId: "multi" } })) as never);
    expect((multi as { repositories: unknown }).repositories).toEqual([
      {
        name: "app",
        access: "write",
        repository: "your-org/app",
        requestedRef: "main",
        resolvedSha: null,
        pullRequestNumber: 12,
        pullRequestUrl: "https://github.com/your-org/app/pull/12",
        resultBranch: "wardby/run-multi",
        outcome: "no_changes",
      },
      {
        name: "upstream",
        access: "read",
        repository: "upstream-org/upstream",
        requestedRef: "v1",
        resolvedSha: "a".repeat(40),
        pullRequestNumber: null,
        pullRequestUrl: null,
        resultBranch: null,
        outcome: null,
      },
    ]);
    const single = parseText((await client.callTool({ name: "get_run", arguments: { runId: "single" } })) as never);
    expect(single).not.toHaveProperty("repositories");
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

  it("get_run returns packageRefusals with hint, deduplicated, and the served packages' count for a coding run", async () => {
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
      packageCount: number;
      packageRefusals: Array<{ ecosystem: string; name: string; reason: string; hint?: string }>;
      packagePlan: { approved: number; refused: number };
    };
    // The packages themselves page through get_run_packages; get_run counts them.
    expect(codingBody).not.toHaveProperty("packages");
    expect(codingBody.packageCount).toBe(2);
    const packagesPage = parseText(
      (await client.callTool({ name: "get_run_packages", arguments: { runId: "r1" } })) as never,
    ) as { packages: unknown[]; next: number | null; total: number };
    expect(packagesPage).toEqual({
      runId: "r1",
      packages: [
        { ecosystem: "npm", name: "@heroui/react", version: "3.2.6", size: 482_113 },
        { ecosystem: "pypi", name: "flask", version: "3.0.0", size: null },
      ],
      next: null,
      total: 2,
    });
    const hint = refusalHint("wardby_package_not_allowed");
    expect(hint).toBeDefined();
    expect(codingBody.packageRefusals).toEqual([
      { ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed", hint },
      { ecosystem: "npm", name: "evil", reason: "wardby_package_not_allowed", hint },
      { ecosystem: "npm", name: "stray", reason: "wardby_package_not_allowed", hint },
    ]);
    expect(codingBody.packagePlan).toEqual({ approved: 42, refused: 2 });

    const nonCodingResult = await client.callTool({ name: "get_run", arguments: { runId: "r2" } });
    const nonCodingBody = parseText(nonCodingResult as never) as Record<string, unknown>;
    expect(nonCodingBody).not.toHaveProperty("packages");
    expect(nonCodingBody).not.toHaveProperty("packageCount");
    expect(nonCodingBody).not.toHaveProperty("packageRefusals");
    expect(nonCodingBody).not.toHaveProperty("packagePlan");
    await client.close();
  });

  it("get_run reports packageAuditMode and packageAudit only for a run that had the mode", async () => {
    const now = new Date();
    const base = {
      agentId: "a1",
      status: "succeeded",
      trigger: "manual",
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      finalText: null,
      error: null,
      startedAt: now,
      finishedAt: now,
    };
    const record = (name: string, relation: string, extra: Record<string, unknown> = {}, offset = 0) => ({
      ecosystem: "npm",
      name,
      version: "1.0.0",
      relation,
      via: null,
      sizeBytes: 100,
      advisories: [],
      createdAt: new Date(now.getTime() + offset),
      ...extra,
    });
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        { ...base, id: "off", codingRun: { result: null } },
        { ...base, id: "quiet", codingRun: { result: null, packageAuditMode: "audit" } },
        {
          ...base,
          id: "full",
          codingRun: { result: null, packageAuditMode: "full" },
          auditRecords: [
            record("expo-dev-launcher", "transitive", { via: "expo-dev-client" }, 2),
            record("expo-dev-client", "top-level", {}, 1),
            record(
              "lodash",
              "allowed",
              { advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection" }] },
              3,
            ),
          ],
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    const get = async (runId: string) =>
      parseText((await client.callTool({ name: "get_run", arguments: { runId } })) as never) as Record<string, unknown>;

    const off = await get("off");
    expect(off).not.toHaveProperty("packageAuditMode");
    expect(off).not.toHaveProperty("packageAudit");
    expect(await get("quiet")).toMatchObject({ packageAuditMode: "audit", packageAudit: [] });
    const full = await get("full");
    expect(full.packageAuditMode).toBe("full");
    expect(full.packageAudit).toEqual([
      { ecosystem: "npm", name: "expo-dev-client", version: "1.0.0", size: 100, relation: "top-level" },
      {
        ecosystem: "npm",
        name: "expo-dev-launcher",
        version: "1.0.0",
        size: 100,
        relation: "transitive",
        via: "expo-dev-client",
      },
      {
        ecosystem: "npm",
        name: "lodash",
        version: "1.0.0",
        size: 100,
        relation: "allowed",
        advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection" }],
      },
    ]);
    await client.close();
  });

  it("get_run shows a coding run's dependency cache report, and nothing for a run without one", async () => {
    const now = new Date();
    const base = {
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
    };
    const report = { projects: [{ path: ".", result: "hit", key: "abc", sizeBytes: 5, rebuild: "skipped" }] };
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        { ...base, id: "r1", codingRun: { result: null, dependencyCacheResult: report } },
        { ...base, id: "r2", codingRun: { result: null, dependencyCacheResult: null } },
        { ...base, id: "r3", codingRun: { result: null, dependencyCacheResult: { projects: "bad" } } },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    const get = async (runId: string) =>
      parseText((await client.callTool({ name: "get_run", arguments: { runId } })) as never) as any;
    expect((await get("r1")).dependencyCache).toEqual(report);
    expect(await get("r2")).not.toHaveProperty("dependencyCache");
    expect((await get("r3")).dependencyCache).toEqual({ projects: [], reason: "report_invalid" });
    await client.close();
  });

  it("get_run returns coding.prDescriptionOutcome when set and omits it when null", async () => {
    const now = new Date();
    const base = {
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
    };
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        { ...base, id: "r1", codingRun: { result: null, prDescriptionOutcome: "refreshed:no_marker" } },
        { ...base, id: "r2", codingRun: { result: null, prDescriptionOutcome: null } },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    const get = async (runId: string) =>
      parseText((await client.callTool({ name: "get_run", arguments: { runId } })) as never) as any;
    expect((await get("r1")).prDescriptionOutcome).toBe("refreshed:no_marker");
    expect(await get("r2")).not.toHaveProperty("prDescriptionOutcome");
    await client.close();
  });

  it("get_run shows a local review's verdicts and a coding run's result branch", async () => {
    const now = new Date();
    const base = {
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
    };
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          ...base,
          id: "r1",
          localPullRequest: {
            number: 7,
            branch: "feature",
            base: "main",
            reviews: [{ verdict: "approve", summary: "ok", body: "fine", comments: [{ path: "a.ts", line: 1 }] }],
          },
        },
        { ...base, id: "r2", codingRun: { result: null, resultBranch: "wardby/run-r2", baseSha: "a".repeat(40) } },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    const r1 = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r1" } })) as never) as any;
    expect(r1.review).toEqual({
      number: 7,
      branch: "feature",
      base: "main",
      reviews: [{ verdict: "approve", summary: "ok", body: "fine", comments: [{ path: "a.ts", line: 1 }] }],
    });
    const r2 = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r2" } })) as never) as any;
    expect(r2).toMatchObject({ resultBranch: "wardby/run-r2", baseSha: "a".repeat(40) });
    expect(r2).not.toHaveProperty("review");
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

  it("get_run lists a coding run's services by name and version", async () => {
    const now = new Date();
    const row = (id: string, services: unknown) => ({
      id,
      agentId: "a1",
      status: "succeeded",
      trigger: "manual" as const,
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      finalText: null,
      error: null,
      startedAt: now,
      finishedAt: now,
      codingRun: { result: null, services },
    });
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [row("r1", [{ name: "postgres", version: "16", image: "x" }]), row("r2", [])],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const withServices = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r1" } })) as never);
    expect(withServices).toMatchObject({ services: ["postgres 16"] });
    expect(JSON.stringify(withServices)).not.toContain('"image"');
    const without = parseText((await client.callTool({ name: "get_run", arguments: { runId: "r2" } })) as never);
    expect(without).not.toHaveProperty("services");
    await client.close();
  });
});

describe("get_run: a coding run's request", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  const row = (codingRun: Record<string, unknown>) => ({
    id: "r1",
    agentId: "a1",
    status: "succeeded",
    trigger: "subagent",
    turns: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    finalText: "done",
    error: null,
    startedAt: now,
    finishedAt: now,
    codingRun: { result: null, ...codingRun },
  });
  const getRun = async (run: ReturnType<typeof row>) => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }], [run]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    return parseText((await client.callTool({ name: "get_run", arguments: { runId: "r1" } })) as never) as Record<
      string,
      unknown
    >;
  };

  beforeEach(() => {
    loadAgentSecretValues.mockReset();
    loadAgentSecretValues.mockResolvedValue([]);
  });

  it("returns the task the run received", async () => {
    const body = await getRun(row({ request: "Upgrade lodash in package.json" }));
    expect(body.request).toBe("Upgrade lodash in package.json");
    expect(body.requestUnavailable).toBeUndefined();
    expect(loadAgentSecretValues).toHaveBeenCalledWith(expect.anything(), undefined, "a1");
  });

  it("masks the agent's secret values and token-shaped values", async () => {
    loadAgentSecretValues.mockResolvedValue([{ name: "DB_PASSWORD", values: ["fake-attached-secret-value"] }]);
    const token = `ghp_${"a".repeat(36)}`;
    const body = await getRun(row({ request: `Use fake-attached-secret-value and ${token} to log in` }));
    const text = JSON.stringify(body);
    expect(text).not.toContain("fake-attached-secret-value");
    expect(text).not.toContain(token);
    expect(body.request).toContain("to log in");
  });

  it("withholds the request when the agent's secrets can't be read", async () => {
    loadAgentSecretValues.mockRejectedValue(new Error("fake-attached-secret-value unreadable"));
    const body = await getRun(row({ request: "Use fake-attached-secret-value" }));
    const text = JSON.stringify(body);
    expect(body.request).toBeUndefined();
    expect(body.requestUnavailable).toBe(true);
    expect(text).not.toContain("fake-attached-secret-value");
  });

  it("omits the field on a run with no stored request, without reading secrets", async () => {
    const body = await getRun(row({ request: null }));
    expect(body.request).toBeUndefined();
    expect(body.requestUnavailable).toBeUndefined();
    expect(loadAgentSecretValues).not.toHaveBeenCalled();
  });
});

describe("paging long run replies: get_run's first pages, get_run_text and get_run_packages", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  /** Plain words, so nothing in them looks like a token to the request's redaction. */
  const words = (n: number, seed = "the quick brown fox jumps over the lazy dog ") =>
    seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
  const EMOJI = "\u{1F600}"; // two UTF-16 code units: a surrogate pair
  const base = (over: Partial<FakeRunRow> = {}): FakeRunRow => ({
    id: "r1",
    agentId: "a1",
    status: "succeeded",
    trigger: "manual",
    turns: 1,
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    finalText: null,
    error: null,
    startedAt: now,
    finishedAt: now,
    ...over,
  });
  const connectAs = async (runs: FakeRunRow[], principalId = "p1") => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }], runs);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, principalId, ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const body = async (name: string, args: Record<string, unknown>) => {
      const result = await call(name, args);
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    };
    return { call, body, close: () => client.close() };
  };
  /** Every piece of one field, through get_run_text from `from`, joined. */
  const readRest = async (
    c: Awaited<ReturnType<typeof connectAs>>,
    field: string,
    from: number,
    limit?: number,
  ): Promise<{ text: string; pieces: Record<string, unknown>[] }> => {
    const pieces: Record<string, unknown>[] = [];
    let offset: number | null = from;
    while (offset !== null && pieces.length < 100) {
      const piece = await c.body("get_run_text", { runId: "r1", field, offset, ...(limit ? { limit } : {}) });
      pieces.push(piece);
      offset = piece.next as number | null;
    }
    return { text: pieces.map((piece) => piece.text as string).join(""), pieces };
  };

  beforeEach(() => {
    loadAgentSecretValues.mockReset();
    loadAgentSecretValues.mockResolvedValue([]);
  });

  it("a 40,000-character request: an 8,000 first page in get_run, then pieces that join back exactly, never splitting a pair", async () => {
    // Pairs straddle the 8,000 first-page end and the 32,000 piece end after it.
    const request = `${words(7_999)}${EMOJI}${words(31_997, "lorem ipsum dolor sit amet ")}${EMOJI}${words(500)}`;
    expect(request.length).toBe(40_500);
    expect(request.codePointAt(7_999)).toBe(0x1f600);
    expect(request.codePointAt(39_998)).toBe(0x1f600);
    const c = await connectAs([base({ codingRun: { result: null, request } as never })]);
    const run = await c.body("get_run", { runId: "r1" });
    // The first page stops one unit early rather than end inside the pair.
    expect(run.request).toBe(request.slice(0, 7_999));
    expect(run.requestMore).toEqual({ next: 7_999, total: 40_500 });
    const { text, pieces } = await readRest(c, "request", 7_999);
    expect(pieces.map((piece) => [piece.offset, (piece.text as string).length, piece.next, piece.total])).toEqual([
      [7_999, 31_999, 39_998, 40_500],
      [39_998, 502, null, 40_500],
    ]);
    expect(`${run.request as string}${text}`).toBe(request);
    // From the start, with the default limit, the same text in 32,000-unit pieces.
    expect((await readRest(c, "request", 0)).text).toBe(request);
    // A limit of 1 at a pair takes the whole pair, so a page always moves on; an offset inside a pair starts at it.
    expect(await c.body("get_run_text", { runId: "r1", field: "request", offset: 7_999, limit: 1 })).toMatchObject({
      offset: 7_999,
      text: EMOJI,
      next: 8_001,
    });
    expect(await c.body("get_run_text", { runId: "r1", field: "request", offset: 8_000, limit: 3 })).toMatchObject({
      offset: 7_999,
      text: `${EMOJI}${request[8_001]}`,
    });
    // Past the end: nothing more.
    expect(await c.body("get_run_text", { runId: "r1", field: "request", offset: 99_999 })).toMatchObject({
      text: "",
      next: null,
      total: 40_500,
    });
    // The limit is capped at 32,000.
    const capped = await c.body("get_run_text", { runId: "r1", field: "request", offset: 0, limit: 1_000_000 });
    expect((capped.text as string).length).toBe(32_000);
    await c.close();
  });

  it("get_run_text masks the request as get_run does, and withholds it when the agent's secrets can't be read", async () => {
    loadAgentSecretValues.mockResolvedValue([{ name: "DB_PASSWORD", values: ["fake-attached-secret-value"] }]);
    const request = `${words(9_000)} fake-attached-secret-value ${words(100)}`;
    const c = await connectAs([base({ codingRun: { result: null, request } as never })]);
    const run = await c.body("get_run", { runId: "r1" });
    const { text } = await readRest(c, "request", (run.requestMore as { next: number }).next);
    expect(`${run.request as string}${text}`).not.toContain("fake-attached-secret-value");
    expect(text).toContain("[REDACTED]");
    loadAgentSecretValues.mockRejectedValue(new Error("unreadable"));
    expect(await c.body("get_run_text", { runId: "r1", field: "request" })).toEqual({
      runId: "r1",
      field: "request",
      requestUnavailable: true,
    });
    await c.close();
  });

  it("get_run: fields up to 8,000 characters come whole and unchanged; longer ones as a first page with <field>More", async () => {
    const exact = words(8_000);
    const long = words(8_001);
    const c = await connectAs([
      base({ finalText: exact, error: "short error", taskOverride: "Review pull request #12" }),
      base({ id: "r2", finalText: long, error: long, taskOverride: long }),
    ]);
    const short = await c.body("get_run", { runId: "r1" });
    expect(short).toMatchObject({ finalText: exact, error: "short error", taskOverride: "Review pull request #12" });
    for (const key of ["finalTextMore", "errorMore", "taskOverrideMore", "requestMore"]) {
      expect(short).not.toHaveProperty(key);
    }
    const paged = await c.body("get_run", { runId: "r2" });
    for (const field of ["finalText", "error", "taskOverride"]) {
      expect(paged[field]).toBe(long.slice(0, 8_000));
      expect(paged[`${field}More`]).toEqual({ next: 8_000, total: 8_001 });
      const rest = await c.body("get_run_text", { runId: "r2", field, offset: 8_000 });
      expect(rest).toEqual({ runId: "r2", field, offset: 8_000, text: long.slice(8_000), next: null, total: 8_001 });
    }
    // A field the run doesn't have: no text, nothing to page.
    expect(await c.body("get_run_text", { runId: "r1", field: "request" })).toEqual({
      runId: "r1",
      field: "request",
      offset: 0,
      text: null,
      next: null,
      total: 0,
    });
    await c.close();
  });

  it("get_run_text reads only the four text fields", async () => {
    const c = await connectAs([base({ finalText: "x" })]);
    for (const field of ["pricingSnapshot", "systemPrompt", "codingResult", "__proto__", "status"]) {
      const result = await c.call("get_run_text", { runId: "r1", field });
      expect(result.isError, field).toBe(true);
      expect(result.content[0].text).not.toContain('"text"');
    }
    await c.close();
  });

  it("get_run_packages pages a long package list in a stable order, with total and next null at the end", async () => {
    const fetches = Array.from({ length: 450 }, (_, i) => ({
      ecosystem: i % 3 === 0 ? "pypi" : "npm",
      name: `pkg-${String(449 - i).padStart(3, "0")}`,
      version: "1.0.0",
      outcome: "served" as const,
      reason: null,
      sizeBytes: 1000 + i,
      createdAt: new Date(now.getTime() + i),
    }));
    // A retried fetch of an early package collapses into its first entry.
    fetches.push({ ...fetches[10], createdAt: new Date(now.getTime() + 10_000) });
    const c = await connectAs([base({ codingRun: { result: null }, registryFetches: fetches })]);
    const run = await c.body("get_run", { runId: "r1" });
    expect(run).not.toHaveProperty("packages");
    expect(run.packageCount).toBe(450);
    const pages: Record<string, unknown>[] = [];
    let after: number | null = 0;
    while (after !== null && pages.length < 10) {
      const page = await c.body("get_run_packages", { runId: "r1", ...(after ? { after } : {}) });
      pages.push(page);
      after = page.next as number | null;
    }
    expect(pages.map((page) => [(page.packages as unknown[]).length, page.next, page.total])).toEqual([
      [200, 200, 450],
      [200, 400, 450],
      [50, null, 450],
    ]);
    const names = pages.flatMap((page) => (page.packages as { name: string }[]).map((p) => p.name));
    // The order the run first fetched them, the same on every read.
    expect(names).toEqual(fetches.slice(0, 450).map((f) => f.name));
    expect((pages[0].packages as unknown[])[0]).toEqual({
      ecosystem: "pypi",
      name: "pkg-449",
      version: "1.0.0",
      size: 1000,
    });
    // limit is capped at 500; an after past the end gives an empty last page.
    const all = await c.body("get_run_packages", { runId: "r1", limit: 10_000 });
    expect([(all.packages as unknown[]).length, all.next]).toEqual([450, null]);
    expect(await c.body("get_run_packages", { runId: "r1", after: 9_999 })).toEqual({
      runId: "r1",
      packages: [],
      next: null,
      total: 450,
    });
    await c.close();
  });

  it("get_run_packages on a run that isn't a coding run: no packages", async () => {
    const c = await connectAs([base({ finalText: "x" })]);
    expect(await c.body("get_run_packages", { runId: "r1" })).toEqual({
      runId: "r1",
      packages: [],
      next: null,
      total: 0,
    });
    await c.close();
  });

  it("both tools keep get_run's visibility: a caller who can't read the run gets the same not-found", async () => {
    const run = base({
      finalText: "secret answer",
      codingRun: { result: null },
      registryFetches: [
        {
          ecosystem: "npm",
          name: "left-pad",
          version: "1.0.0",
          outcome: "served",
          reason: null,
          createdAt: now,
        },
      ],
    });
    const asStranger = await connectAs([run], "not-the-owner");
    const notFound = 'Run "r1" not found.';
    for (const [name, args] of [
      ["get_run", { runId: "r1" }],
      ["get_run_text", { runId: "r1", field: "finalText" }],
      ["get_run_packages", { runId: "r1" }],
    ] as const) {
      const result = await asStranger.call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.content[0].text, name).toContain(notFound);
      expect(result.content[0].text).not.toContain("secret answer");
      expect(result.content[0].text).not.toContain("left-pad");
      // A run that doesn't exist answers the same way.
      const missing = await asStranger.call(name, { ...args, runId: "nope" });
      expect(missing.content[0].text.replace("nope", "r1")).toBe(result.content[0].text);
    }
    await asStranger.close();
    // The run's starter still reads it, as with get_run.
    const asStarter = await connectAs([{ ...run, triggeredById: "starter" }], "starter");
    expect(await asStarter.body("get_run_text", { runId: "r1", field: "finalText" })).toMatchObject({
      text: "secret answer",
    });
    expect((await asStarter.body("get_run_packages", { runId: "r1" })).total).toBe(1);
    await asStarter.close();
  });
});
