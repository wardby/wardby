import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";

const db = createPrismaClient();
const agentIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("RunStep schema (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("keeps seq unique per run, starts stepsDropped at 0, and cascades with the run", async () => {
    const agent = await db.agent.create({
      data: { name: `steps-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "running" } });
    expect(run.stepsDropped).toBe(0);
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.runStep.create({
      data: { runId: run.id, seq: 1, kind: "tool", tool: "Bash", callId: "c1", summary: "npm test", expiresAt },
    });
    await expect(
      db.runStep.create({ data: { runId: run.id, seq: 1, kind: "said", summary: "dup", expiresAt } }),
    ).rejects.toThrow();
    await db.run.delete({ where: { id: run.id } });
    expect(await db.runStep.count({ where: { runId: run.id } })).toBe(0);
  });

  it("adds the detail-level columns, null by default", async () => {
    const agent = await db.agent.create({
      data: { name: `steps-level-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    expect(agent.runSteps).toBeNull();
    const run = await db.run.create({ data: { agentId: agent.id } });
    expect(run.runStepsLevel).toBeNull();
    const set = await db.agent.update({ where: { id: agent.id }, data: { runSteps: "detail" } });
    expect(set.runSteps).toBe("detail");
    const fixed = await db.run.update({ where: { id: run.id }, data: { runStepsLevel: "summary" } });
    expect(fixed.runStepsLevel).toBe("summary");
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'CodingProxySession' AND column_name = 'runStepsLevel'`;
    expect(columns).toHaveLength(1);
  });
});
