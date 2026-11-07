import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { RunStepWriter } from "./writer.js";
import { MAX_RUN_STEPS, type ExtractedStep, type StepStatus } from "./types.js";

const db = createPrismaClient();
const agentIds: string[] = [];
// Fake values only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T12:00:00.000Z");

async function newRun() {
  const agent = await db.agent.create({
    data: { name: `steps-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
  });
  agentIds.push(agent.id);
  return db.run.create({ data: { agentId: agent.id, status: "running" } });
}

function writer(opts: { maxSteps?: number; level?: "off" | "summary" | "detail" } = {}) {
  return new RunStepWriter({
    db,
    secretValues: async () => [FAKE_SECRET],
    level: opts.level ?? "summary",
    retentionDays: 30,
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    now: () => NOW,
  });
}

const tool = (callId: string, text: string): ExtractedStep => ({
  kind: "tool",
  callId,
  tool: "Bash",
  text,
  truncated: false,
});

const rowsOf = (runId: string) => db.runStep.findMany({ where: { runId }, orderBy: { seq: "asc" } });

describe.skipIf(!process.env.DATABASE_URL)("RunStepWriter (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("redacts a fake secret in a command and in model text before writing", async () => {
    const run = await newRun();
    await writer().record(run.id, {
      steps: [
        { kind: "said", callId: "said:turn:1", text: `Logging in with ${FAKE_SECRET}.`, truncated: false },
        tool("c1", `curl -H "Authorization: token ${FAKE_TOKEN}" https://example.test/${FAKE_SECRET}`),
      ],
      results: [],
    });
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => [r.seq, r.kind, r.tool, r.callId])).toEqual([
      [1, "said", null, "said:turn:1"],
      [2, "tool", "Bash", "c1"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(rows)).not.toContain(FAKE_TOKEN);
    expect(rows[0].summary).toBe("Logging in with [REDACTED].");
    expect(rows[1].summary.length).toBeLessThanOrEqual(100);
    expect(rows[1].at.toISOString()).toBe(NOW.toISOString());
    expect(rows[1].expiresAt.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(rows[1].detail).toBeNull();
  });

  it("keeps only fixed-shape statuses, so a secret in a tool result's status line never lands", async () => {
    const run = await newRun();
    const w = writer();
    await w.record(run.id, { steps: [tool("c1", "npm test")], results: [] });
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: `exit 1 ${FAKE_SECRET}` as StepStatus }] });
    expect((await rowsOf(run.id))[0].status).toBeNull();
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "exit 1" }] });
    const rows = await rowsOf(run.id);
    expect(rows[0].status).toBe("exit 1");
    expect(JSON.stringify(rows)).not.toContain(FAKE_SECRET);
  });

  it("dedupes steps and results that arrive again with resent history or a replay", async () => {
    const run = await newRun();
    const w = writer();
    const batch = { steps: [tool("c1", "ls"), tool("c2", "pwd")], results: [] };
    await w.record(run.id, batch);
    await w.record(run.id, batch);
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "ok" }] });
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "error" }] });
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => r.callId)).toEqual(["c1", "c2"]);
    expect(rows[0].status).toBe("ok");
  });

  it("writes one run's batches in the order they arrived", async () => {
    const run = await newRun();
    const w = writer();
    void w.record(run.id, { steps: [tool("c1", "npm test")], results: [] });
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "exit 2" }] });
    expect((await rowsOf(run.id))[0].status).toBe("exit 2");
  });

  it("stops at the cap and counts later steps in stepsDropped", async () => {
    expect(MAX_RUN_STEPS).toBe(2000);
    const run = await newRun();
    const w = writer({ maxSteps: 3 });
    await w.record(run.id, { steps: ["a", "b", "c", "d", "e"].map((id) => tool(id, id)), results: [] });
    expect((await rowsOf(run.id)).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).stepsDropped).toBe(2);
    await w.record(run.id, { steps: [tool("f", "f")], results: [] });
    expect(await db.runStep.count({ where: { runId: run.id } })).toBe(3);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).stepsDropped).toBe(3);
  });

  it("reads secret values fresh for every batch, so a rotated value is never stored", async () => {
    const run = await newRun();
    const OLD = "wbFake-Old-Value-1a2b3c4d";
    const ROTATED = "wbFake-Rotated-Value-9z8y7x6w";
    let current = OLD;
    const w = new RunStepWriter({
      db,
      secretValues: async () => [current],
      level: "summary",
      retentionDays: 30,
      now: () => NOW,
    });
    await w.record(run.id, { steps: [tool("c1", `use ${OLD}`)], results: [] });
    current = ROTATED;
    await w.record(run.id, { steps: [tool("c2", `use ${ROTATED}`)], results: [] });
    const rows = await rowsOf(run.id);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(OLD);
    expect(JSON.stringify(rows)).not.toContain(ROTATED);
  });

  it("records nothing when the ceiling is off", async () => {
    const run = await newRun();
    await writer({ level: "off" }).record(run.id, { steps: [tool("c1", "ls")], results: [] });
    expect(await db.runStep.count({ where: { runId: run.id } })).toBe(0);
  });
});
