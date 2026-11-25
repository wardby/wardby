import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";

describe.skipIf(!process.env.DATABASE_URL)("agent grantee shape (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  let agentId: string;

  beforeAll(async () => {
    const owner = await db.principal.create({ data: { subject: `ag-${s}` } });
    agentId = (
      await db.agent.create({
        data: { name: `ag-${s}`, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
      })
    ).id;
  });

  afterAll(() => db.$disconnect());

  const row = (over: Record<string, unknown>) => ({
    resourceType: "document",
    resourceId: `d-${s}`,
    granteeKind: "agent",
    granteeAgentId: agentId,
    granteeKey: `agent:${agentId}`,
    level: "read",
    ...over,
  });

  it("accepts a document grant to an agent, refuses other shapes, cascades on agent delete", async () => {
    await db.resourceGrant.create({ data: row({}) });
    await expect(
      db.resourceGrant.create({ data: row({ resourceType: "agent", resourceId: `a-${s}` }) }),
    ).rejects.toThrow();
    await expect(
      db.resourceGrant.create({ data: row({ resourceId: `d2-${s}`, granteeKey: "agent:other" }) }),
    ).rejects.toThrow();
    await db.agent.delete({ where: { id: agentId } });
    expect(await db.resourceGrant.count({ where: { granteeKey: `agent:${agentId}` } })).toBe(0);
  });
});
