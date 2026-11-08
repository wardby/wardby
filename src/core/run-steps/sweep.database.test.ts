import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { sweepExpiredRunSteps } from "./sweep.js";

const db = createPrismaClient();
const agentIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("sweepExpiredRunSteps (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("deletes expired steps only", async () => {
    const agent = await db.agent.create({
      data: { name: `sweep-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "succeeded" } });
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 86_400_000);
    await db.runStep.createMany({
      data: [1, 2, 3].map((seq) => ({
        runId: run.id,
        seq,
        kind: "said",
        summary: `s${seq}`,
        expiresAt: seq < 3 ? past : future,
      })),
    });
    expect(await sweepExpiredRunSteps(db, now, { batchSize: 1, maxBatches: 10 })).toBeGreaterThanOrEqual(2);
    expect((await db.runStep.findMany({ where: { runId: run.id } })).map((row) => row.seq)).toEqual([3]);
  });
});
