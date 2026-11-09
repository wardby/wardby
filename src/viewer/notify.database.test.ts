import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { ViewerEventSchema, type ViewerEvent } from "./api-schema.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `notify-agent-${suffix}`;
const runId = `notify-run-${suffix}`;
const mine = (e: ViewerEvent) => e.runId === runId;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DATABASE_URL)("viewer NOTIFY triggers (PostgreSQL)", () => {
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const got: ViewerEvent[] = [];
  const raw: string[] = [];
  const events = () => got.filter(mine);

  beforeAll(async () => {
    await listener.connect();
    listener.on("notification", (m) => {
      // Foreign processes share the channel on a shared DB: ignore what is not ours.
      const parsed = ViewerEventSchema.safeParse(JSON.parse(m.payload!));
      if (parsed.success) got.push(parsed.data);
      raw.push(m.payload!);
    });
    await listener.query("LISTEN wardby_viewer");
  });

  afterAll(async () => {
    await listener.end();
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("emits run, service and outcome events, and ignores heartbeat-only updates", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    await db.run.create({ data: { id: runId, agentId } });
    await waitFor(() => events().some((e) => e.kind === "run" && e.status === "pending"), 2000);

    await db.run.update({ where: { id: runId }, data: { turns: 3, costUsd: 0.25 } });
    await waitFor(() => events().some((e) => e.kind === "run" && e.turns === 3), 2000);
    const updated = events().find((e) => e.kind === "run" && e.turns === 3);
    expect(updated).toMatchObject({ kind: "run", agentId, costUsd: 0.25, finishedAt: null, parentRunId: null });
    expect(typeof (updated as { costUsd: unknown }).costUsd).toBe("number");

    await db.run.update({
      where: { id: runId },
      data: { status: "succeeded", finishedAt: new Date("2030-01-01T12:00:00.123Z") },
    });
    await waitFor(() => events().some((e) => e.kind === "run" && e.finishedAt !== null), 2000);
    expect(events().find((e) => e.kind === "run" && e.finishedAt !== null)).toMatchObject({
      status: "succeeded",
      finishedAt: "2030-01-01T12:00:00.123Z",
    });

    const before = events().length;
    await db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date() } });
    await sleep(300);
    expect(events().length).toBe(before);

    await db.codingRunServiceStatus.create({ data: { runId, name: "db", state: "probing", attempts: 2 } });
    await waitFor(() => events().some((e) => e.kind === "service"), 2000);
    expect(events().find((e) => e.kind === "service")).toMatchObject({ name: "db", state: "probing", attempts: 2 });

    await db.runIssueStatus.create({ data: { runId, provider: "jira", issueKey: "NTF-1" } });
    await waitFor(() => events().some((e) => e.kind === "outcome"), 2000);
    expect(events().find((e) => e.kind === "outcome")).toMatchObject({ source: "issue_status" });
  });

  it("keeps finishedAt in UTC under a non-UTC session time zone", async () => {
    const instant = new Date("2031-06-15T08:30:45.678Z");
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'America/New_York'");
      await tx.run.update({ where: { id: runId }, data: { finishedAt: instant } });
    });
    await waitFor(() => events().some((e) => e.kind === "run" && e.finishedAt === instant.toISOString()), 2000);
  });

  it("emits a step event when a step is recorded and when its status arrives, never its callId or detail", async () => {
    await db.runStep.create({
      data: {
        runId,
        seq: 1,
        kind: "tool",
        tool: "Bash",
        callId: "call_notify_only_db",
        summary: "npm test",
        detail: "detail_text_never_sent",
        at: new Date("2030-01-01T00:00:00.000Z"),
        expiresAt: new Date("2031-01-01T00:00:00.000Z"),
      },
    });
    await waitFor(() => events().some((e) => e.kind === "step" && e.seq === 1), 2000);
    expect(events().find((e) => e.kind === "step")).toEqual({
      kind: "step",
      runId,
      seq: 1,
      stepKind: "tool",
      tool: "Bash",
      summary: "npm test",
      status: null,
      at: "2030-01-01T00:00:00.000Z",
    });

    await db.runStep.updateMany({
      where: { runId, seq: 1 },
      data: { status: "exit 1", detail: "detail_text_never_sent_2" },
    });
    await waitFor(() => events().some((e) => e.kind === "step" && e.status === "exit 1"), 2000);

    // A change the viewer can't see (retention) sends nothing.
    const before = events().length;
    await db.runStep.updateMany({ where: { runId, seq: 1 }, data: { expiresAt: new Date("2032-01-01T00:00:00Z") } });
    await sleep(300);
    expect(events().length).toBe(before);

    const stepPayloads = raw.filter((p) => p.includes(runId) && p.includes('"step"'));
    expect(stepPayloads.length).toBe(2);
    for (const p of stepPayloads) {
      expect(p).not.toContain("call_notify_only_db");
      expect(p).not.toContain("detail_text_never_sent");
      expect(p).not.toContain("detail_text_never_sent_2");
    }
  });

  it("emits only schema-valid payloads for the fixture run", () => {
    const own = raw.map((p) => JSON.parse(p) as { runId?: string }).filter((p) => p.runId === runId);
    expect(own.length).toBeGreaterThan(0);
    for (const p of own) expect(ViewerEventSchema.safeParse(p).success).toBe(true);
  });
});
