import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";

describe.skipIf(!process.env.DATABASE_URL)("review router schema (database)", () => {
  const db = createPrismaClient();
  afterAll(() => db.$disconnect());

  it("has the router fields with their defaults", async () => {
    const owner = await db.principal.create({ data: { subject: `rr-${randomUUID()}` } });
    const agent = await db.agent.create({
      data: { name: `rr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId: owner.id },
    });
    expect(agent.router).toBe(false);
    expect(agent.maxStartsPerDecision).toBe(20);
    expect(agent.description).toBeNull();
    expect(agent.reviewRouterId).toBeNull();
  });

  it("claims a review job once per review event", async () => {
    const eventId = randomUUID();
    const router = await db.agent.create({
      data: { name: `rr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    await db.reviewJob.create({ data: { reviewEventId: eventId, routerAgentId: router.id } });
    await expect(db.reviewJob.create({ data: { reviewEventId: eventId, routerAgentId: router.id } })).rejects.toThrow();
  });

  it("backfilled a shared set for every plan set", async () => {
    const missing = await db.planSet.count({ where: { setId: null } });
    expect(missing).toBe(0);
  });
});
