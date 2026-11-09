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
const FAKE_CAPABILITY = `rrp_${"F".repeat(43)}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T12:00:00.000Z");

async function newRun(runStepsLevel: "off" | "summary" | "detail" | null = null) {
  const agent = await db.agent.create({
    data: { name: `steps-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
  });
  agentIds.push(agent.id);
  return db.run.create({ data: { agentId: agent.id, status: "running", runStepsLevel } });
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

const tool = (callId: string, text: string): Extract<ExtractedStep, { kind: "tool" }> => ({
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

  it("counts a step past the cap once, however often the history is resent", async () => {
    const run = await newRun();
    const w = writer({ maxSteps: 3 });
    const batch = { steps: ["a", "b", "c", "d", "e"].map((id) => tool(id, id)), results: [] };
    await w.record(run.id, batch);
    await w.record(run.id, batch);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).stepsDropped).toBe(2);
    await w.record(run.id, { steps: [...batch.steps, tool("f", "f")], results: [] });
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).stepsDropped).toBe(3);
  });

  it("does not store a step whose callId holds a secret value, nor count it as dropped", async () => {
    const run = await newRun();
    await writer().record(run.id, {
      steps: [tool(`call-${FAKE_SECRET}`, "ls"), tool("ok1", "pwd")],
      results: [{ callId: `call-${FAKE_SECRET}`, status: "ok" }],
    });
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => r.callId)).toEqual(["ok1"]);
    expect(JSON.stringify(rows)).not.toContain(FAKE_SECRET);
    expect((await db.run.findUniqueOrThrow({ where: { id: run.id } })).stepsDropped).toBe(0);
  });

  it("writes only tool and said steps", async () => {
    const run = await newRun();
    await writer().record(run.id, {
      steps: [
        { kind: "other", callId: "x1", text: "t", truncated: false } as unknown as ExtractedStep,
        tool("c1", "ls"),
      ],
      results: [],
    });
    expect((await rowsOf(run.id)).map((r) => r.callId)).toEqual(["c1"]);
  });

  it("bounds the remembered over-cap callIds in all, least recently used run first", async () => {
    const w = new RunStepWriter({
      db,
      secretValues: async () => [FAKE_SECRET],
      level: "summary",
      retentionDays: 30,
      maxSteps: 1,
      droppedLimits: { perRun: 2, total: 3 },
      now: () => NOW,
    });
    const over = (prefix: string) => ({
      steps: ["keep", `${prefix}1`, `${prefix}2`, `${prefix}3`].map((id) => tool(id, id)),
      results: [],
    });
    const [r1, r2, r3] = [await newRun(), await newRun(), await newRun()];
    await w.record(r1.id, over("a"));
    await w.record(r2.id, over("b"));
    // Two per run (the per-run limit); the oldest run was evicted to keep the total at 3 or fewer.
    expect(w.rememberedDroppedCount()).toBe(2);
    await w.record(r3.id, over("c"));
    expect(w.rememberedDroppedCount()).toBeLessThanOrEqual(3);
    // The evicted run's resent history may be counted again; the bound holds regardless.
    await w.record(r1.id, over("a"));
    expect(w.rememberedDroppedCount()).toBeLessThanOrEqual(3);
  });

  it("records nothing when the ceiling is off", async () => {
    const run = await newRun();
    await writer({ level: "off" }).record(run.id, { steps: [tool("c1", "ls")], results: [] });
    expect(await db.runStep.count({ where: { runId: run.id } })).toBe(0);
  });
  it("at detail stores the redacted input, then the redacted end of the output", async () => {
    const run = await newRun("detail");
    const w = writer({ level: "detail" });
    await w.record(
      run.id,
      {
        steps: [{ ...tool("c1", `echo ${FAKE_SECRET}`), input: `{"command":"echo ${FAKE_SECRET} ${FAKE_TOKEN}"}` }],
        results: [],
      },
      [FAKE_CAPABILITY],
    );
    await w.record(
      run.id,
      {
        steps: [],
        results: [
          { callId: "c1", status: "exit 1", output: `boom ${FAKE_SECRET}\n${FAKE_CAPABILITY}`, outputCut: false },
        ],
      },
      [FAKE_CAPABILITY],
    );
    const [row] = await rowsOf(run.id);
    expect(row.status).toBe("exit 1");
    expect(row.detail).toContain('"command":"echo [REDACTED]');
    expect(row.detail).toContain("--- output (end) ---\nboom [REDACTED]");
    for (const fake of [FAKE_SECRET, FAKE_TOKEN, FAKE_CAPABILITY]) expect(row.detail).not.toContain(fake);
    expect(row.detail!.length).toBeLessThanOrEqual(16 * 1024);
  });

  it("at detail redacts a said step's text and a result-only batch's output", async () => {
    const run = await newRun("detail");
    const w = writer({ level: "detail" });
    await w.record(run.id, {
      steps: [tool("c2", "ls"), { kind: "said", callId: "said:1", text: `key ${FAKE_SECRET}`, truncated: false }],
      results: [],
    });
    await w.record(run.id, { steps: [], results: [{ callId: "c2", status: "ok", output: FAKE_SECRET }] });
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => r.detail)).toEqual(["ls\n\n--- output (end) ---\n[REDACTED]", "key [REDACTED]"]);
  });

  it("removes terminal control sequences before redaction, so a secret split by colour codes is masked", async () => {
    const run = await newRun("detail");
    const w = writer({ level: "detail" });
    // Fake value split by a colour code; an OSC 52 clipboard write and an OSC 8 link around it.
    const coloured = `${FAKE_SECRET.slice(0, 9)}\u001b[31m${FAKE_SECRET.slice(9)}\u001b[0m`;
    const hostile = "\u001b]52;c;ZmFrZQ==\u0007\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007";
    await w.record(run.id, {
      steps: [
        { ...tool("c1", `echo ${coloured} ${hostile}`), input: `{"command":"echo ${coloured}"}\r\n` },
        { kind: "said", callId: "said:1", text: `key ${coloured}\r\n${hostile}`, truncated: false },
      ],
      results: [],
    });
    await w.record(run.id, {
      steps: [],
      results: [{ callId: "c1", status: "ok", output: `out ${coloured}\r\n${hostile}\rend` }],
    });
    const rows = await rowsOf(run.id);
    expect(rows.map((r) => r.summary)).toEqual(["echo [REDACTED] link", "key [REDACTED] link"]);
    expect(rows.map((r) => r.detail)).toEqual([
      '{"command":"echo [REDACTED]"}\n\n\n--- output (end) ---\nout [REDACTED]\nlinkend',
      "key [REDACTED]\nlink",
    ]);
    for (const row of rows) {
      for (const text of [row.summary, row.detail!]) {
        // eslint-disable-next-line no-control-regex -- asserting no control character survives
        expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
        expect(text).not.toContain(FAKE_SECRET.slice(0, 9));
        expect(text).not.toContain(FAKE_SECRET.slice(9));
      }
    }
  });

  it("below detail never stores detail, even when the batch carries it", async () => {
    for (const level of ["summary", null] as const) {
      const run = await newRun(level);
      const w = writer({ level: "detail" });
      await w.record(run.id, { steps: [{ ...tool("c1", "ls"), input: `{"command":"${FAKE_SECRET}"}` }], results: [] });
      await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "ok", output: FAKE_SECRET }] });
      const [row] = await rowsOf(run.id);
      expect(row.detail).toBeNull();
      expect(row.status).toBe("ok");
    }
  });

  it("a run fixed at off records nothing; a summary ceiling caps a run fixed at detail", async () => {
    const off = await newRun("off");
    await writer({ level: "detail" }).record(off.id, { steps: [tool("c1", "ls")], results: [] });
    expect(await rowsOf(off.id)).toHaveLength(0);
    const detail = await newRun("detail");
    await writer({ level: "summary" }).record(detail.id, {
      steps: [{ ...tool("c1", "ls"), input: "{}" }],
      results: [],
    });
    expect((await rowsOf(detail.id))[0].detail).toBeNull();
  });

  it("the first status wins: a replayed result appends no second output", async () => {
    const run = await newRun("detail");
    const w = writer({ level: "detail" });
    await w.record(run.id, { steps: [{ ...tool("c1", "ls"), input: "{}" }], results: [] });
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "ok", output: "one" }] });
    await w.record(run.id, { steps: [], results: [{ callId: "c1", status: "error", output: "two" }] });
    const [row] = await rowsOf(run.id);
    expect(row.status).toBe("ok");
    expect(row.detail).toBe("{}\n\n--- output (end) ---\none");
  });
});
