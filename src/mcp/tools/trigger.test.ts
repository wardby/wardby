import { describe, it, expect, vi } from "vitest";
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
interface FakeRunRow {
  id: string;
  agentId: string;
  status: string;
  error?: string | null;
  triggeredById?: string | null;
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
) {
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const runs = new Map<string, FakeRunRow>();
  const tasks = new Map<string, FakeTaskRow>();
  let runCounter = 0;
  let taskCounter = 0;

  const db: any = {
    resourceGrant: fakeResourceGrants(grants),
    runs,
    agent: {
      // Prompt discovery runs during MCP connection setup; this stub keeps the
      // focused trigger tests from treating that optional path as a warning.
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const row = where.id ? agentsById.get(where.id) : agents.find((a) => a.name === where.name);
        if (row) return { kind: "native", codingProfile: null, budgetUsd: 1, model: "m", ...row };
        return null;
      },
    },
    run: {
      create: async ({
        data,
      }: {
        data: { agentId: string; trigger: string; triggeredById?: string | null; status?: string; error?: string };
      }) => {
        const row: FakeRunRow = {
          id: `run_${++runCounter}`,
          agentId: data.agentId,
          status: data.status ?? "pending",
          error: data.error ?? null,
          triggeredById: data.triggeredById,
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
