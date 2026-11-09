import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { RunDetailSchema } from "./api-schema.js";
import { loadRunDetail } from "./run-detail.js";

const db = createPrismaClient();
const suffix = randomUUID();
const now = new Date("2030-01-01T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;
const id = (name: string) => `detail-${name}-${suffix}`;
const ids = { A: id("agent-a"), C: id("agent-c"), R1: id("r1"), R2: id("r2"), R3: id("r3"), R4: id("r4") };

describe.skipIf(!process.env.DATABASE_URL)("loadRunDetail (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.agent.create({
      data: { id: ids.A, name: ids.A, systemPrompt: "x", model: "agent-model", budgetUsd: 2 },
    });
    await db.agent.create({
      data: { id: ids.C, name: ids.C, systemPrompt: "x", model: "agent-model", budgetUsd: 1, kind: "coding" },
    });
    await db.run.create({
      data: {
        id: ids.R1,
        agentId: ids.A,
        status: "failed",
        startedAt: ago(10 * MIN),
        error: "boom",
        finalText: "final words",
      },
    });
    // Created out of order: childRunIds must follow startedAt.
    await db.run.create({
      data: {
        id: ids.R3,
        agentId: ids.A,
        parentRunId: ids.R1,
        status: "running",
        startedAt: ago(2 * MIN),
        nativeExecutionMode: "sandbox",
      },
    });
    await db.run.create({
      data: {
        id: ids.R2,
        agentId: ids.C,
        trigger: "subagent",
        parentRunId: ids.R1,
        status: "succeeded",
        startedAt: ago(5 * MIN),
        finishedAt: ago(1 * MIN),
        codingRun: {
          create: {
            task: "t",
            repository: "your-org/app",
            baseRef: "main",
            headRef: "wardby/x",
            provider: "codex",
            model: "coding-model",
            timeoutSec: 60,
            protectedPaths: [],
            budgetReservedUsd: 0.5,
            failureCategory: "tests_failed",
            services: [
              {
                name: "postgres",
                version: "16",
                image: "postgres@sha256:abc",
                port: 5432,
                testEnv: { PGHOST: "localhost", DATABASE_URL: "postgres://x" },
                serviceEnv: { POSTGRES_PASSWORD: "pw" },
              },
            ],
          },
        },
      },
    });
    await db.run.create({
      data: { id: ids.R4, agentId: ids.C, status: "succeeded", startedAt: ago(1 * MIN) },
    });
    // R1 recorded 203 steps (one with a call id and detail text that must never be sent), 4 more dropped.
    await db.run.update({ where: { id: ids.R1 }, data: { stepsDropped: 4 } });
    await db.runStep.createMany({
      data: Array.from({ length: 203 }, (_, i) => ({
        runId: ids.R1,
        seq: i + 1,
        kind: i % 2 === 0 ? "tool" : "said",
        tool: i % 2 === 0 ? "Bash" : null,
        callId: `call_detail_${i + 1}`,
        summary: `step ${i + 1}`,
        status: i === 202 ? "exit 1" : i % 2 === 0 ? "ok" : null,
        detail: i === 202 ? "detail_text_never_sent" : null,
        at: ago(10 * MIN - i * 1000),
        expiresAt: ago(-30 * 24 * 60 * MIN),
      })),
    });
  });

  afterAll(async () => {
    for (const r of [ids.R4, ids.R3, ids.R2, ids.R1]) await db.run.deleteMany({ where: { id: r } });
    await db.agent.deleteMany({ where: { id: { in: [ids.A, ids.C] } } });
    await db.$disconnect();
  });

  it("returns a coding run's detail with env names only", async () => {
    const detail = await loadRunDetail(db, ids.R2);
    expect(detail).not.toBeNull();
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail!.model).toBe("coding-model");
    expect(detail!.codingProvider).toBe("codex");
    expect(detail!.declaredServices).toEqual([{ name: "postgres", version: "16" }]);
    expect(detail!.coding).toMatchObject({
      provider: "codex",
      repository: "your-org/app",
      baseRef: "main",
      headRef: "wardby/x",
      queuedAt: null,
      failureCategory: "tests_failed",
    });
    expect(detail!.coding!.services).toEqual([
      { name: "postgres", version: "16", image: "postgres@sha256:abc", envNames: ["DATABASE_URL", "PGHOST"] },
    ]);
    const json = JSON.stringify(detail);
    expect(json).not.toContain("postgres://x");
    expect(json).not.toContain('"pw"');
    expect(json).not.toContain("POSTGRES_PASSWORD");
  });

  it("returns a native run's detail with ordered child ids and null coding", async () => {
    const detail = await loadRunDetail(db, ids.R1);
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      model: "agent-model",
      codingProvider: null,
      nativeExecutionMode: null,
      declaredServices: [],
      error: "boom",
      finalText: "final words",
      coding: null,
    });
    expect(detail!.childRunIds).toEqual([ids.R2, ids.R3]);
  });

  it("lists the newest 200 steps oldest first, counts the rest, never a call id or detail", async () => {
    const detail = await loadRunDetail(db, ids.R1);
    expect(RunDetailSchema.parse(detail)).toEqual(detail);
    expect(detail!.steps).toHaveLength(200);
    expect(detail!.steps[0]).toMatchObject({ seq: 4, summary: "step 4" });
    expect(detail!.steps.at(-1)).toEqual({
      seq: 203,
      at: ago(10 * MIN - 202 * 1000).toISOString(),
      kind: "tool",
      tool: "Bash",
      summary: "step 203",
      status: "exit 1",
    });
    expect(detail!.stepsOmitted).toBe(3);
    expect(detail!.stepsDropped).toBe(4);
    for (const step of detail!.steps) {
      expect(Object.keys(step).sort()).toEqual(["at", "kind", "seq", "status", "summary", "tool"]);
    }
    const json = JSON.stringify(detail);
    expect(json).not.toContain("call_detail_");
    expect(json).not.toContain("detail_text_never_sent");
    expect(json).not.toContain("callId");
    expect(json).not.toContain('"detail"');
  });

  it("a run without steps has none, and nothing omitted or dropped", async () => {
    const detail = await loadRunDetail(db, ids.R3);
    expect(detail).toMatchObject({ steps: [], stepsOmitted: 0, stepsDropped: 0 });
  });

  it("exposes the run's native execution mode snapshot, null when none was recorded", async () => {
    const sandboxed = await loadRunDetail(db, ids.R3);
    expect(RunDetailSchema.parse(sandboxed)).toEqual(sandboxed);
    expect(sandboxed!.nativeExecutionMode).toBe("sandbox");
    expect((await loadRunDetail(db, ids.R1))!.nativeExecutionMode).toBeNull();
    expect((await loadRunDetail(db, ids.R2))!.nativeExecutionMode).toBeNull();
  });

  it("returns a coding-agent run without a CodingRun row as native detail", async () => {
    const detail = await loadRunDetail(db, ids.R4);
    expect(detail!.coding).toBeNull();
    expect(detail!.model).toBe("agent-model");
    expect(detail!.codingProvider).toBeNull();
  });

  it("returns null for an unknown run", async () => {
    expect(await loadRunDetail(db, id("missing"))).toBeNull();
  });
});
