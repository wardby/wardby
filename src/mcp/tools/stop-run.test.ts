import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerStopRunTool } from "./stop-run.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";

interface Row {
  id: string;
  agentId: string;
  status: string;
  triggeredById?: string | null;
  parentRunId?: string | null;
  error?: string | null;
  stopRequestReason?: string | null;
}

const DRIVABLE = ["pending", "running"];

/** Applies the where shapes stop_run uses: id, status (equality or in), parentRunId, stopRequestReason. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, cond]) => {
    const value = (row as unknown as Record<string, unknown>)[field] ?? null;
    if (cond !== null && typeof cond === "object" && "in" in cond)
      return (cond as { in: unknown[] }).in.includes(value);
    return value === cond;
  });
}

function fakeDb(agents: { id: string; ownerId: string | null }[], runs: Row[], grants: FakeGrantSeed[] = []) {
  const runRows = new Map(runs.map((r) => [r.id, { ...r }]));
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const db = {
    resourceGrant: fakeResourceGrants(grants),
    agent: { findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => runRows.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = runRows.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        [...runRows.values()].filter((row) => matches(row, where)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hits = [...runRows.values()].filter((row) => matches(row, where));
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
    },
  };
  return { db: db as unknown as import("#prisma").PrismaClient, runRows };
}

/** An executor that, like every real one, makes a drivable run terminal itself. */
function fakeExecutor(runRows: Map<string, Row>, opts: { noop?: boolean } = {}) {
  const stops: { runId: string; reason?: string }[] = [];
  return {
    stops,
    executor: {
      start: async () => {},
      stop: async (runId: string, reason?: string) => {
        stops.push({ runId, reason });
        const row = runRows.get(runId);
        if (!opts.noop && row && DRIVABLE.includes(row.status)) {
          row.status = "cancelled";
          row.error = reason ?? null;
        }
      },
    },
  };
}

async function setup(
  principalId: string,
  runs: Row[],
  opts: { grants?: FakeGrantSeed[]; scopes?: string[]; noop?: boolean; ownerId?: string | null } = {},
) {
  const { db, runRows } = fakeDb(
    [{ id: "a1", ownerId: opts.ownerId === undefined ? "owner" : opts.ownerId }],
    runs,
    opts.grants,
  );
  const { executor, stops } = fakeExecutor(runRows, { noop: opts.noop });
  const providers = { executor } as unknown as import("../../providers/index.js").ProviderRegistry;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
  const ctx: McpRequestContext = {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(opts.scopes ?? ["runs:trigger"]),
    canonicalUri: CANONICAL_URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerStopRunTool(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: "stop_run", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0].text };
  };
  return { call, runRows, stops, client };
}

const body = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("stop_run", () => {
  it("stops a running run for the agent's owner, recording who stopped it and why", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "running" }]);
    const result = await t.call({ runId: "r1", reason: "  unwanted schedule  " });
    expect(result.isError).toBe(false);
    expect(body(result.text)).toMatchObject({
      runId: "r1",
      previousStatus: "running",
      status: "cancelled",
      stopRequested: true,
      stoppedChildRunIds: [],
      message: "Run stopped.",
    });
    expect(t.stops).toEqual([{ runId: "r1", reason: "Stopped by owner with stop_run: unwanted schedule" }]);
    expect(t.runRows.get("r1")).toMatchObject({
      status: "cancelled",
      stopRequestReason: "Stopped by owner with stop_run: unwanted schedule",
    });
    await t.client.close();
  });

  it("cancels a pending run that no executor ended (never started): it can never start afterwards", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "pending" }], { noop: true });
    const result = await t.call({ runId: "r1" });
    expect(body(result.text)).toMatchObject({ previousStatus: "pending", status: "cancelled" });
    expect(t.runRows.get("r1")).toMatchObject({
      status: "cancelled",
      error: "Stopped by owner with stop_run.",
      stopRequestReason: "Stopped by owner with stop_run.",
    });
    await t.client.close();
  });

  it("reports a running run whose stop has not landed yet as still running", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "running" }], { noop: true });
    const result = await t.call({ runId: "r1" });
    expect(body(result.text)).toMatchObject({ status: "running", stopRequested: true });
    expect(body(result.text).message).toMatch(/still running/);
    expect(t.runRows.get("r1")?.stopRequestReason ?? null).toBeNull();
    await t.client.close();
  });

  it("returns a finished run unchanged, and is idempotent", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "running" }]);
    await t.call({ runId: "r1" });
    const again = await t.call({ runId: "r1", reason: "second" });
    expect(body(again.text)).toMatchObject({ status: "cancelled", stopRequested: false });
    expect(body(again.text).message).toMatch(/already finished as cancelled/);
    expect(t.stops).toHaveLength(1);
    expect(t.runRows.get("r1")?.stopRequestReason).toBe("Stopped by owner with stop_run.");

    const done = await setup("owner", [{ id: "r2", agentId: "a1", status: "succeeded" }]);
    const result = await done.call({ runId: "r2" });
    expect(body(result.text)).toMatchObject({ previousStatus: "succeeded", status: "succeeded", stopRequested: false });
    expect(done.stops).toEqual([]);
    expect(done.runRows.get("r2")).toMatchObject({ status: "succeeded" });
    await t.client.close();
    await done.client.close();
  });

  it("stops the run's in-flight delegated child runs, depth-first, and leaves finished ones alone", async () => {
    const t = await setup("owner", [
      { id: "parent", agentId: "a1", status: "running" },
      { id: "child", agentId: "a1", status: "running", parentRunId: "parent" },
      { id: "queued", agentId: "a1", status: "pending", parentRunId: "parent" },
      { id: "grandchild", agentId: "a1", status: "running", parentRunId: "child" },
      { id: "done", agentId: "a1", status: "succeeded", parentRunId: "parent" },
    ]);
    const result = await t.call({ runId: "parent" });
    expect(body(result.text).stoppedChildRunIds).toEqual(["child", "grandchild", "queued"]);
    for (const id of ["parent", "child", "queued", "grandchild"]) expect(t.runRows.get(id)?.status).toBe("cancelled");
    expect(t.runRows.get("done")?.status).toBe("succeeded");
    expect(t.runRows.get("child")?.stopRequestReason).toBe(
      "Parent run parent was stopped. Stopped by owner with stop_run.",
    );
    await t.client.close();
  });

  it("lets the run's triggerer stop it with execute access to the agent", async () => {
    const t = await setup("p2", [{ id: "r1", agentId: "a1", status: "running", triggeredById: "p2" }], {
      grants: [{ resourceType: "agent", resourceId: "a1", level: "execute", principalId: "p2" }],
    });
    const result = await t.call({ runId: "r1" });
    expect(result.isError).toBe(false);
    expect(t.runRows.get("r1")?.status).toBe("cancelled");
    await t.client.close();
  });

  it("refuses the run's triggerer with less than execute access (403), changing nothing", async () => {
    const t = await setup("p2", [{ id: "r1", agentId: "a1", status: "running", triggeredById: "p2" }], {
      grants: [{ resourceType: "agent", resourceId: "a1", level: "read", principalId: "p2" }],
    });
    const result = await t.call({ runId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/needs execute access/);
    expect(t.runRows.get("r1")?.status).toBe("running");
    expect(t.stops).toEqual([]);
    await t.client.close();
  });

  it("answers someone else's run exactly like a missing one, even with execute access to the agent", async () => {
    const t = await setup("p2", [{ id: "r1", agentId: "a1", status: "running", triggeredById: "p3" }], {
      grants: [{ resourceType: "agent", resourceId: "a1", level: "execute", principalId: "p2" }],
    });
    const hidden = await t.call({ runId: "r1" });
    const missing = await t.call({ runId: "nope" });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toBe(missing.text.replace("nope", "r1"));
    expect(hidden.text).toMatch(/not found/);
    expect(t.runRows.get("r1")?.status).toBe("running");
    expect(t.stops).toEqual([]);
    await t.client.close();
  });

  it("needs the runs:trigger scope", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "running" }], { scopes: ["agents:read"] });
    const result = await t.call({ runId: "r1" });
    expect(result.isError).toBe(true);
    expect(t.runRows.get("r1")?.status).toBe("running");
    await t.client.close();
  });

  it("rejects unknown arguments", async () => {
    const t = await setup("owner", [{ id: "r1", agentId: "a1", status: "running" }]);
    const result = await t.call({ runId: "r1", force: true });
    expect(result.isError).toBe(true);
    expect(t.runRows.get("r1")?.status).toBe("running");
    await t.client.close();
  });
});
