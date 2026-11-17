import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";

describe.skipIf(!process.env.DATABASE_URL)("plan set schema", () => {
  const db = createPrismaClient();
  afterAll(() => db.$disconnect());

  it("one plan set per agent, repository and number; documents point at it", async () => {
    const owner = await db.principal.create({ data: { subject: `ps-${Date.now()}` } });
    const agent = await db.agent.create({
      data: {
        name: `planner-${Date.now()}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId: owner.id,
        kind: "coding",
      },
    });
    const set = await db.planSet.create({
      data: { agentId: agent.id, repository: "o/r", number: 12, store: "wardby", createdByRunId: "run-x" },
    });
    await expect(
      db.planSet.create({
        data: { agentId: agent.id, repository: "o/r", number: 12, store: "wardby", createdByRunId: "y" },
      }),
    ).rejects.toThrow();
    const doc = await db.document.create({
      data: { title: "Plan", ownerId: owner.id, planSetId: set.id, planPath: "plan.md" },
    });
    expect(doc.removedFromPlan).toBe(false);
    expect(
      (await db.planSet.findUniqueOrThrow({ where: { id: set.id }, include: { documents: true } })).documents,
    ).toHaveLength(1);
  });
});
