import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { PrismaClient } from "#prisma";
import { buildMcpServer } from "../server.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import type { RunStepsLevel } from "../../core/run-steps/config.js";
import { fakeCtx } from "./run-transcript.test-support.js";
import { registerRunStepsTool, RUN_STEPS_MAX_LIMIT } from "./run-steps.js";

const DAY = 24 * 60 * 60 * 1000;

interface FakeStep {
  seq: number;
  at: Date;
  kind: string;
  tool: string | null;
  callId: string | null;
  summary: string;
  status: string | null;
  detail: string | null;
}
interface FakeRun {
  id: string;
  agentId: string;
  triggeredById: string | null;
  finishedAt: Date | null;
  stepsDropped: number;
  runStepsLevel?: "off" | "summary" | "detail" | null;
  steps: FakeStep[];
}

const step = (seq: number): FakeStep => ({
  seq,
  at: new Date(Date.UTC(2026, 10, 7, 12, 0, seq)),
  kind: "tool",
  tool: "Bash",
  callId: `c${seq}`,
  summary: `step ${seq}`,
  status: "ok",
  detail: null,
});
const run = (overrides: Partial<FakeRun> = {}): FakeRun => ({
  id: "r1",
  agentId: "a1",
  triggeredById: "trig",
  finishedAt: null,
  stepsDropped: 0,
  steps: [1, 2, 3, 4, 5].map(step),
  ...overrides,
});

function fakeStepsDb(runs: FakeRun[], grants: FakeGrantSeed[] = []): PrismaClient {
  const agents = new Map([["a1", { id: "a1", ownerId: "owner" }]]);
  return {
    resourceGrant: fakeResourceGrants(grants),
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agents.get(where.id) ?? null,
      findMany: async () => [],
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = runs.find((r) => r.id === where.id);
        if (!found) return null;
        const { steps: _steps, ...row } = found;
        return { ...row, status: "succeeded" };
      },
    },
    runStep: {
      findMany: async (q: {
        where: { runId: string; seq: { gt: number } };
        take: number;
        select: Record<string, true>;
      }) =>
        (runs.find((r) => r.id === q.where.runId)?.steps ?? [])
          .filter((s) => s.seq > q.where.seq.gt)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, q.take)
          .map((s) => Object.fromEntries(Object.keys(q.select).map((key) => [key, s[key as keyof FakeStep]]))),
    },
  } as unknown as PrismaClient;
}

async function setup(db: PrismaClient, principalId: string, opts: { level?: RunStepsLevel; now?: Date } = {}) {
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: "https://host/mcp" } });
  mcp.setFixedContext(fakeCtx(db, principalId));
  const now = opts.now;
  registerRunStepsTool(mcp, { level: opts.level ?? "summary", retentionDays: 30, ...(now ? { now: () => now } : {}) });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: "get_run_steps", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0].text };
  };
}

describe("get_run_steps", () => {
  it("gives the triggerer and the owner the steps, and another reader the not-found get_run gives", async () => {
    const db = fakeStepsDb(
      [run()],
      [{ resourceType: "agent", resourceId: "a1", level: "execute", principalId: "reader" }],
    );
    const asTriggerer = await (await setup(db, "trig"))({ runId: "r1" });
    expect(asTriggerer.isError).toBe(false);
    const body = JSON.parse(asTriggerer.text) as {
      level: string;
      steps: Record<string, unknown>[];
      next: unknown;
      dropped: number;
    };
    expect(body).toMatchObject({ level: "summary", next: null, dropped: 0 });
    expect(body.steps).toHaveLength(5);
    expect(Object.keys(body.steps[0]).sort()).toEqual(["at", "kind", "seq", "status", "summary", "tool"]);
    expect(asTriggerer.text).not.toContain("callId");
    expect(asTriggerer.text).not.toContain("detail");
    expect((await (await setup(db, "owner"))({ runId: "r1" })).isError).toBe(false);
    const other = await (await setup(db, "reader"))({ runId: "r1" });
    expect(other.isError).toBe(true);
    expect(other.text).toContain('Run "r1" not found');
  });

  it("pages with after and limit, and caps limit at 200", async () => {
    const call = await setup(fakeStepsDb([run()]), "trig");
    const page = async (args: Record<string, unknown>) =>
      JSON.parse((await call({ runId: "r1", ...args })).text) as { steps: { seq: number }[]; next: number | null };
    expect(await page({ limit: 2 })).toMatchObject({ steps: [{ seq: 1 }, { seq: 2 }], next: 2 });
    expect(await page({ after: 2, limit: 2 })).toMatchObject({ steps: [{ seq: 3 }, { seq: 4 }], next: 4 });
    expect(await page({ after: 4, limit: 2 })).toMatchObject({ steps: [{ seq: 5 }], next: null });
    expect((await page({ limit: 5000 })).steps).toHaveLength(5);
    expect(RUN_STEPS_MAX_LIMIT).toBe(200);
  });

  it("reports dropped steps, and expired once a finished run's steps are past retention", async () => {
    const now = new Date("2026-11-07T12:00:00.000Z");
    const db = fakeStepsDb([
      run({ id: "r1", stepsDropped: 7 }),
      run({ id: "old", steps: [], finishedAt: new Date(now.getTime() - 40 * DAY) }),
      run({ id: "recent", steps: [], finishedAt: new Date(now.getTime() - 10 * DAY) }),
      run({ id: "edge", steps: [], finishedAt: new Date(now.getTime() - 30 * DAY) }),
    ]);
    const call = await setup(db, "trig", { now });
    expect(JSON.parse((await call({ runId: "r1" })).text)).toMatchObject({ dropped: 7 });
    expect(JSON.parse((await call({ runId: "old" })).text)).toMatchObject({
      steps: [],
      expired: true,
      meaning: "No steps are kept for this run: steps are deleted RUN_STEP_RETENTION_DAYS after they are recorded.",
    });
    expect(JSON.parse((await call({ runId: "edge" })).text)).not.toHaveProperty("expired");
    expect(JSON.parse((await call({ runId: "recent" })).text)).not.toHaveProperty("expired");
  });

  it("a run with no recorded level reports summary at most, capped by the ceiling", async () => {
    const db = fakeStepsDb([run()]);
    const level = async (ceiling: "off" | "summary" | "detail") =>
      JSON.parse((await (await setup(db, "trig", { level: ceiling }))({ runId: "r1" })).text).level;
    expect(await level("detail")).toBe("summary");
    expect(await level("summary")).toBe("summary");
    expect(await level("off")).toBe("off");
  });

  it("reports a run's own detail level, capped by the process ceiling", async () => {
    const db = fakeStepsDb([run({ runStepsLevel: "detail" })]);
    const level = async (ceiling: "off" | "summary" | "detail") =>
      JSON.parse((await (await setup(db, "trig", { level: ceiling }))({ runId: "r1" })).text).level;
    expect(await level("detail")).toBe("detail");
    expect(await level("summary")).toBe("summary");
    expect(await level("off")).toBe("off");
  });
});
