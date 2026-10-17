import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client, fromJsonSchema } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerTriggerTool } from "./trigger.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {
  executor: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
  kind?: "native" | "coding";
  codingProfile?: Record<string, unknown> | null;
}
interface FakePullRequest {
  id: string;
  number: number;
  repository: string;
  branch: string;
  base: string;
  runId: string | null;
}
interface FakeRunRow {
  id: string;
  agentId: string;
  status: string;
  error?: string | null;
  triggeredById?: string | null;
  taskOverride?: string;
}
interface FakeTaskRow {
  id: string;
  kind: string;
  runId: string | null;
  principalId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  ttlAt: Date;
}

function fakeDb(
  agents: FakeAgentRow[],
  grants: FakeGrantSeed[] = [],
  budget: { group?: Record<string, unknown>; groupRuns?: Record<string, unknown>[] } = {},
  localLinks: Map<string, string[]> = new Map(),
) {
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const runs = new Map<string, FakeRunRow>();
  const tasks = new Map<string, FakeTaskRow>();
  let runCounter = 0;
  let taskCounter = 0;

  const pullRequests: FakePullRequest[] = [];
  const db: any = {
    resourceGrant: fakeResourceGrants(grants),
    runs,
    pullRequests,
    agentRepository: {
      findMany: async ({ where }: { where: { agentId: string; provider: string } }) =>
        (localLinks.get(where.agentId) ?? []).map((repository) => ({ repository, provider: where.provider })),
    },
    localPullRequest: {
      create: async ({ data }: { data: { repository: string; branch: string; base: string } }) => {
        const row = { id: `pr_${pullRequests.length + 1}`, number: pullRequests.length + 1, runId: null, ...data };
        pullRequests.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: { runId: string } }) => {
        const row = pullRequests.find((p) => p.id === where.id)!;
        row.runId = data.runId;
        return row;
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        const i = pullRequests.findIndex((p) => p.id === where.id);
        if (i >= 0) pullRequests.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
    agent: {
      // Prompt discovery runs during MCP connection setup; this stub keeps the
      // focused trigger tests from treating that optional path as a warning.
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const row = where.id ? agentsById.get(where.id) : agents.find((a) => a.name === where.name);
        if (row)
          return { kind: "native", codingProfile: null, budgetUsd: 1, allowedOverrunPercent: 0, model: "m", ...row };
        return null;
      },
    },
    run: {
      create: async ({
        data,
      }: {
        data: {
          agentId: string;
          trigger: string;
          triggeredById?: string | null;
          status?: string;
          error?: string;
          taskOverride?: string;
        };
      }) => {
        const row: FakeRunRow = {
          id: `run_${++runCounter}`,
          agentId: data.agentId,
          status: data.status ?? "pending",
          error: data.error ?? null,
          triggeredById: data.triggeredById,
          taskOverride: data.taskOverride,
        };
        runs.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = runs.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      updateMany: async () => ({ count: 1 }),
      findMany: async () => budget.groupRuns ?? [],
    },
    budgetGroup: { findUnique: async () => budget.group ?? null },
    $executeRawUnsafe: async () => 0,
    task: {
      create: async ({
        data,
      }: {
        data: { kind: string; runId: string; principalId: string | null; status: string };
      }) => {
        const now = new Date();
        const row: FakeTaskRow = {
          id: `task_${++taskCounter}`,
          kind: data.kind,
          runId: data.runId,
          principalId: data.principalId,
          status: data.status,
          createdAt: now,
          updatedAt: now,
          ttlAt: new Date(now.getTime() + 60_000),
        };
        tasks.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => tasks.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = tasks.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeTaskRow> }) => {
        const row = tasks.get(where.id);
        if (!row) throw new Error("not found");
        const updated = { ...row, ...data };
        tasks.set(where.id, updated);
        return updated;
      },
    },
    runBudgetEvent: { create: async ({ data }: { data: unknown }) => data },
    codingRun: { create: async ({ data }: { data: unknown }) => data },
    webhook: {},
    $queryRaw: async () => [],
  };
  db.$transaction = async (fn: (tx: any) => unknown) => fn(db);
  return db as import("#prisma").PrismaClient;
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  principalId: string,
  scopes: string[],
  clientSupportsTasks: boolean,
): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: fakeProviders,
    db,
    clientSupportsTasks,
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

describe("trigger_agent", () => {
  it("with a Tasks-capable client: creates a run, starts the executor, returns a CreateTaskResult", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], true));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { resultType: string; taskId: string; status: string };
    expect(body.resultType).toBe("task");
    expect(body.status).toBe("working");
    expect(body.taskId).toBeTruthy();
    await client.close();
  });

  it("without a Tasks-capable client: returns { runId } for get_run polling", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { runId: string };
    expect(body.runId).toBeTruthy();
    expect("resultType" in (body as object)).toBe(false);
    await client.close();
  });

  it("passes a validated issue through as explicit attribution", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]) as any;
    const created: unknown[] = [];
    db.agentIssueProject = { findUnique: vi.fn(async () => ({ agentId: "a1" })) };
    db.workItem = { findUnique: async () => null, upsert: async () => ({ id: "wi1", parentKey: null }) };
    db.runAttribution = { findUnique: async () => null, create: async (a: unknown) => created.push(a) };
    db.runIssueStatus = { findUnique: async () => null };
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", issue: { provider: "jira", key: "PAY-241" } },
    });
    expect(result.isError).toBeFalsy();
    expect(created).toEqual([
      { data: { runId: expect.any(String), workItemId: "wi1", parentKeyAtRun: null, source: "explicit" } },
    ]);
    await client.close();
  });

  it("refuses an issue in a project the agent is not linked to, without creating a run", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]) as any;
    db.agentIssueProject = { findUnique: async () => null };
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", issue: { provider: "jira", key: "PAY-241" } },
    });
    expect(result.isError).toBe(true);
    expect((result as { content: { text: string }[] }).content[0].text).toMatch(/not linked/);
    expect(db.runs.size).toBe(0);
    await client.close();
  });

  it("snapshots the issue within the response-path budget (2 s, no 429 retry)", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]) as any;
    db.agentIssueProject = { findUnique: async () => ({ agentId: "a1" }) };
    db.workItem = { findUnique: async () => null, upsert: async () => ({ id: "wi1", parentKey: null }) };
    db.runAttribution = { findUnique: async () => null, create: async () => ({}) };
    db.runIssueStatus = { findUnique: async () => null };
    const snapshotIssue = vi.fn(async (key: string) => ({ key, scopeKey: "PAY", url: `https://jira.example/${key}` }));
    const providers = { ...fakeProviders, issueTrackers: { jira: { snapshotIssue } } } as never;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext({ ...fakeCtx(db, "p1", ["runs:trigger"], false), providers });
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", issue: { provider: "jira", key: "PAY-241" } },
    });
    expect(result.isError).toBeFalsy();
    expect(snapshotIssue).toHaveBeenCalledWith("PAY-241", { timeoutMs: 2000, retryOn429: false });
    await client.close();
  });

  it("checks trigger access before the issue: a caller without access naming an unlinked issue gets the access error", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "owner-1" }]) as any;
    const linkLookup = vi.fn(async () => null);
    db.agentIssueProject = { findUnique: linkLookup };
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", issue: { provider: "jira", key: "PAY-241" } },
    });
    expect(result.isError).toBe(true);
    const text = (result as { content: { text: string }[] }).content[0].text;
    expect(text).not.toMatch(/not linked|issue/i);
    expect(linkLookup).not.toHaveBeenCalled();
    expect(db.runs.size).toBe(0);
    await client.close();
  });

  it("a non-owner cannot trigger the agent", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "owner-1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("rejects task and base-ref overrides for a native agent", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", task: "Do not run", baseRef: "main" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/only valid for coding agents/i);
    await client.close();
  });

  it("any principal can trigger an owner-less agent through its everyone-execute grant, and only through it", async () => {
    const granted = fakeDb(
      [{ id: "a1", name: "greeter", ownerId: null }],
      [{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db: granted, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(granted, "anyone", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(result.isError).toBeFalsy();
    await client.close();

    const ungranted = fakeDb([{ id: "a1", name: "greeter", ownerId: null }]);
    const mcp2 = buildMcpServer({ providers: fakeProviders, db: ungranted, config: { canonicalUri: CANONICAL_URI } });
    mcp2.setFixedContext(fakeCtx(ungranted, "anyone", ["runs:trigger"], false));
    registerTriggerTool(mcp2);
    const client2 = await connectClient(mcp2);
    const refused = await client2.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("not found");
    await client2.close();
  });

  describe("under grants", () => {
    const coding = (allowWebhookTaskOverride: boolean): FakeAgentRow => ({
      id: "a1",
      name: "coder",
      ownerId: "owner",
      kind: "coding",
      codingProfile: {
        provider: "codex",
        repository: "o/r",
        baseRef: "main",
        defaultTask: "the owner's task",
        allowWebhookTaskOverride,
        timeoutSec: 900,
        protectedPaths: [],
        collectExclude: [],
        packageAllowlist: {},
        packagePolicy: {},
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
        workspaceDiskMb: null,
      },
    });
    async function as(principalId: string, agent: FakeAgentRow, grants: FakeGrantSeed[]) {
      const db = fakeDb([{ ...agent, model: "gpt-5.6-luna" } as FakeAgentRow], grants);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, principalId, ["runs:trigger"], false));
      registerTriggerTool(mcp);
      return { db, client: await connectClient(mcp) };
    }
    const grant = (level: string): FakeGrantSeed => ({
      resourceType: "agent",
      resourceId: "a1",
      principalId: "g",
      level,
    });

    it("an execute-grantee triggers, and the run records it as the triggerer; a read-grantee gets 403", async () => {
      const runner = await as("g", { id: "a1", name: "greeter", ownerId: "owner" }, [grant("execute")]);
      const ok = await runner.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
      expect(ok.isError).toBeFalsy();
      const { runId } = parseText(ok as never) as { runId: string };
      expect((runner.db as any).runs.get(runId).triggeredById).toBe("g");
      await runner.client.close();

      const reader = await as("g", { id: "a1", name: "greeter", ownerId: "owner" }, [grant("read")]);
      const refused = await reader.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toMatch(/needs execute/);
      await reader.client.close();
    });

    it("E-01: a coding run refused at dispatch (group spent) is reported as refused, with its reason", async () => {
      const agent = { ...coding(false), model: "gpt-5.6-luna", budgetUsd: 2, budgetGroupId: "g1" } as FakeAgentRow;
      const db = fakeDb([agent], [], {
        group: {
          id: "g1",
          name: "team",
          dailyBudgetUsd: 5,
          weeklyBudgetUsd: null,
          monthlyBudgetUsd: null,
          warnThresholdRatio: 0.8,
          agents: [{ id: "a1", budgetUsd: 2 }],
        },
        groupRuns: [
          {
            id: "old",
            agentId: "a1",
            status: "succeeded",
            costUsd: 5,
            startedAt: new Date(),
            heartbeatAt: null,
            codingRun: null,
          },
        ],
      });
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, "owner", ["runs:trigger"], false));
      registerTriggerTool(mcp);
      const client = await connectClient(mcp);

      const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
      expect(result.isError).toBeFalsy();
      const body = parseText(result as never) as { runId: string; status: string; error: string };
      expect(body.status).toBe("refused");
      expect(body.error).toMatch(/^budget_group_exhausted:day\b/);
      await client.close();
    });

    it("a coding run failed at dispatch (model unavailable) is reported as failed, with its reason", async () => {
      const db = fakeDb([{ ...coding(false), model: "gpt-not-in-any-catalog", budgetUsd: 2 } as FakeAgentRow]);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, "owner", ["runs:trigger"], false));
      registerTriggerTool(mcp);
      const client = await connectClient(mcp);

      const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
      expect(result.isError).toBeFalsy();
      const body = parseText(result as never) as { runId: string; status: string; error: string };
      expect(body.status).toBe("failed");
      expect(body.error).toMatch(/^model_unavailable: .*reason: not_in_catalog/);
      await client.close();
    });

    it("M8: the stdio operator is not the owner for task overrides either", async () => {
      const db = fakeDb([{ ...coding(false), model: "gpt-5.6-luna" } as FakeAgentRow]);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext({ ...fakeCtx(db, "local", ["runs:trigger"], false), operator: true });
      registerTriggerTool(mcp);
      const client = await connectClient(mcp);
      const refused = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1", task: "x" } });
      expect(refused.isError).toBe(true);
      expect((await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } })).isError).toBeFalsy();
      await client.close();
    });

    it("a non-owner may pass a coding task or baseRef only when the owner opted in (allowWebhookTaskOverride)", async () => {
      const closed = await as("g", coding(false), [grant("execute")]);
      for (const extra of [{ task: "rewrite everything" }, { baseRef: "evil-branch" }]) {
        const refused = await closed.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1", ...extra } });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused)).toMatch(/allowWebhookTaskOverride/);
      }
      // The owner's default task still runs.
      expect(
        (await closed.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } })).isError,
      ).toBeFalsy();
      await closed.client.close();

      const open = await as("g", coding(true), [grant("execute")]);
      const ok = await open.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1", task: "do x" } });
      expect(ok.isError).toBeFalsy();
      await open.client.close();

      const owner = await as("owner", coding(false), []);
      const own = await owner.client.callTool({ name: "trigger_agent", arguments: { agentId: "a1", task: "do x" } });
      expect(own.isError).toBeFalsy();
      await owner.client.close();
    });
  });

  it("missing runs:trigger scope is rejected", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  it("cancel_run invokes the executor's cooperative stop path", async () => {
    vi.mocked(fakeProviders.executor.stop).mockClear();
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger", "agents:read"], true));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const triggerResult = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };

    // `resultType` is wire-only protocol machinery the SDK strips before
    // application code (including client.request()'s return value) ever
    // sees it — verify the cancel functionally instead, via a follow-up
    // tasks/get, the same way Task 8's own manager tests do.
    await client.request(
      { method: "tasks/cancel", params: { taskId } },
      fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
    );
    const getResult = await client.request(
      { method: "tasks/get", params: { taskId } },
      fromJsonSchema<{ status: string }>({ type: "object", additionalProperties: true }),
    );
    expect(getResult.status).toBe("cancelled");
    expect(fakeProviders.executor.stop).toHaveBeenCalledWith(expect.any(String), "cancelled by caller");

    await client.close();
  });

  it("tasks/get on another owner's task is rejected (not found, not leaked)", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "owner-1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    registerTriggerTool(mcp);

    // owner-1 triggers and gets a real task.
    mcp.setFixedContext(fakeCtx(db, "owner-1", ["runs:trigger"], true));
    const ownerClient = await connectClient(mcp);
    const triggerResult = await ownerClient.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };
    await ownerClient.close();

    // A different principal, even with agents:read, cannot read it.
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:read"], true));
    const intruderClient = await connectClient(mcp);
    await expect(
      intruderClient.request(
        { method: "tasks/get", params: { taskId } },
        fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
      ),
    ).rejects.toThrow();
    await intruderClient.close();
  });

  it("tasks/cancel on another owner's task is rejected", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "owner-1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    registerTriggerTool(mcp);

    mcp.setFixedContext(fakeCtx(db, "owner-1", ["runs:trigger"], true));
    const ownerClient = await connectClient(mcp);
    const triggerResult = await ownerClient.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };
    await ownerClient.close();

    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["runs:trigger"], true));
    const intruderClient = await connectClient(mcp);
    await expect(
      intruderClient.request(
        { method: "tasks/cancel", params: { taskId } },
        fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
      ),
    ).rejects.toThrow();
    await intruderClient.close();
  });

  it("tasks/get without agents:read scope is rejected", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    registerTriggerTool(mcp);

    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], true));
    const client = await connectClient(mcp);
    const triggerResult = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };

    // Same principal, but this connection's context lacks agents:read.
    mcp.setFixedContext(fakeCtx(db, "p1", [], true));
    await expect(
      client.request(
        { method: "tasks/get", params: { taskId } },
        fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
      ),
    ).rejects.toThrow(/scope/i);
    await client.close();
  });

  it("tasks/update is registered but rejects — a run-backed task never enters input_required", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "p1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], true));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);

    const triggerResult = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };

    await expect(
      client.request(
        { method: "tasks/update", params: { taskId, inputResponses: {} } },
        fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
      ),
    ).rejects.toThrow(/not awaiting input/i);
    await client.close();
  });

  it("tasks/update on another owner's task is rejected (ownership checked before the not-awaiting-input error)", async () => {
    const db = fakeDb([{ id: "a1", name: "greeter", ownerId: "owner-1" }]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    registerTriggerTool(mcp);

    mcp.setFixedContext(fakeCtx(db, "owner-1", ["runs:trigger"], true));
    const ownerClient = await connectClient(mcp);
    const triggerResult = await ownerClient.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    const { taskId } = parseText(triggerResult as never) as { taskId: string };
    await ownerClient.close();

    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["runs:trigger"], true));
    const intruderClient = await connectClient(mcp);
    await expect(
      intruderClient.request(
        { method: "tasks/update", params: { taskId, inputResponses: {} } },
        fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true }),
      ),
    ).rejects.toThrow();
    await intruderClient.close();
  });
});

describe("trigger_agent on a local repository", () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-trigger-")));
    repo = root;
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    vi.stubEnv("LOCAL_REPO_ROOTS", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function trigger(db: ReturnType<typeof fakeDb>) {
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1" } });
    await client.close();
    return result;
  }
  const codingAgent = (): FakeAgentRow => ({
    id: "a1",
    name: "coder",
    ownerId: "p1",
    kind: "coding",
    codingProfile: { provider: "codex", repository: `local:${repo}`, baseRef: "main", allowWebhookTaskOverride: false },
  });

  it("is refused with local_repo_not_allowed after the roots were narrowed", async () => {
    vi.stubEnv("LOCAL_REPO_ROOTS", join(tmpdir(), "somewhere-else-entirely"));
    const db = fakeDb([codingAgent()]);
    const result = await trigger(db);
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("local_repo_not_allowed");
    expect((db as any).runs.size).toBe(0);
  });

  it("warns about uncommitted files in the result", async () => {
    writeFileSync(join(repo, "dirty.txt"), "x");
    const result = await trigger(fakeDb([codingAgent()]));
    expect(result.isError).toBeFalsy();
    expect(parseText(result as never)).toMatchObject({ warnings: ["1 uncommitted file is not included"] });
  });
});

describe("trigger_agent review (local repositories)", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "local-review-")));
    const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
    git("branch", "feature");
    vi.stubEnv("LOCAL_REPO_ROOTS", root);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const head = () => execFileSync("git", ["-C", root, "rev-parse", "feature"], { encoding: "utf8" }).trim();
  async function review(principal: string, reviewArgs: unknown, links = [`local:${root}`], kind = "native") {
    const db = fakeDb(
      [{ id: "a1", name: "reviewer", ownerId: "p1", kind: kind as "native" }],
      [],
      {},
      new Map([["a1", links]]),
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, principal, ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "trigger_agent", arguments: { agentId: "a1", review: reviewArgs } });
    await client.close();
    return { db: db as any, result };
  }
  const text = (r: { content: unknown }) => (r.content as { text: string }[])[0].text;

  it("creates a pull request linked to the dispatched run, with the exact task text", async () => {
    const { db, result } = await review("p1", { branch: "feature" });
    expect(result.isError).toBeFalsy();
    const { runId } = parseText(result as never) as { runId: string };
    expect(db.pullRequests).toEqual([
      expect.objectContaining({ number: 1, repository: `local:${root}`, branch: "feature", base: "main", runId }),
    ]);
    expect(db.runs.get(runId).taskOverride).toBe(`Review pull request #1 in local:${root} (head ${head()}).`);
  });

  it("refuses an unknown branch without leaving a row", async () => {
    const { db, result } = await review("p1", { branch: "nope" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("local_ref_not_found");
    expect(db.pullRequests).toHaveLength(0);
    expect(db.runs.size).toBe(0);
  });

  it("rejects an option-shaped ref", async () => {
    const { result } = await review("p1", { branch: "--output=x" });
    expect(text(result)).toContain("local_ref_invalid");
  });

  it("refuses a non-owner with 403", async () => {
    const { db, result } = await review("p2", { branch: "feature" });
    expect(result.isError).toBe(true);
    expect(db.pullRequests).toHaveLength(0);
  });

  it("needs review.repository when the agent has no single local link", async () => {
    const { result } = await review("p1", { branch: "feature" }, []);
    expect(text(result)).toContain("pass review.repository");
  });

  it("re-checks the roots before creating anything", async () => {
    vi.stubEnv("LOCAL_REPO_ROOTS", join(tmpdir(), "elsewhere-entirely"));
    const { db, result } = await review("p1", { branch: "feature" });
    expect(text(result)).toContain("local_repo_not_allowed");
    expect(db.pullRequests).toHaveLength(0);
  });

  it("removes the pull request when dispatch fails", async () => {
    const db = fakeDb([{ id: "a1", name: "r", ownerId: "p1" }], [], {}, new Map([["a1", [`local:${root}`]]])) as any;
    db.run.create = async () => {
      throw new Error("boom");
    };
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["runs:trigger"], false));
    registerTriggerTool(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "trigger_agent",
      arguments: { agentId: "a1", review: { branch: "feature" } },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(db.pullRequests).toHaveLength(0);
  });

  it("is refused for a coding agent", async () => {
    const { result } = await review("p1", { branch: "feature" }, [`local:${root}`], "coding");
    expect(result.isError).toBe(true);
  });
});
