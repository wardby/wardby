import { describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client, fromJsonSchema } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerTriggerTool } from "./trigger.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {
  executor: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
}
interface FakeRunRow {
  id: string;
  agentId: string;
  status: string;
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

function fakeDb(agents: FakeAgentRow[]) {
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const runs = new Map<string, FakeRunRow>();
  const tasks = new Map<string, FakeTaskRow>();
  let runCounter = 0;
  let taskCounter = 0;

  const db: any = {
    agent: {
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) => {
        const row = where.id ? agentsById.get(where.id) : agents.find((a) => a.name === where.name);
        if (row) return { kind: "native", codingProfile: null, budgetUsd: 1, model: "m", ...row };
        return null;
      },
    },
    run: {
      create: async ({ data }: { data: { agentId: string; trigger: string } }) => {
        const row: FakeRunRow = { id: `run_${++runCounter}`, agentId: data.agentId, status: "pending" };
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
    },
    task: {
      create: async ({ data }: { data: { kind: string; runId: string; principalId: string | null; status: string } }) => {
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
  return db as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[], clientSupportsTasks: boolean): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    providers: fakeProviders,
    db,
    clientSupportsTasks,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
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
    const getResult = (await client.request(
      { method: "tasks/get", params: { taskId } },
      fromJsonSchema<{ status: string }>({ type: "object", additionalProperties: true }),
    ));
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
