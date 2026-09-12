import { PrismaClient, Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * Real-Postgres coverage for AgentDatastore's @@unique([agentId, boundName])
 * constraint (finding #6) — every other AgentDatastore test in this repo
 * exercises the constraint only through a fake db's own hand-rolled
 * duplicate check, which proves the MCP handler maps P2002 correctly but
 * never proves the constraint actually exists in the deployed schema.
 */
describe.skipIf(!process.env.DATABASE_URL)("AgentDatastore unique constraint (database)", () => {
  const db = new PrismaClient();
  const agentId = "ads-agent-" + randomUUID();
  const dsA = "ads-ds-a-" + randomUUID();
  const dsB = "ads-ds-b-" + randomUUID();

  afterAll(async () => {
    await db.agentDatastore.deleteMany({ where: { agentId } });
    await db.datastore.deleteMany({ where: { id: { in: [dsA, dsB] } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("rejects a second attachment under the same (agentId, boundName) with a real P2002", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1 },
    });
    await db.datastore.create({ data: { id: dsA, name: dsA, ownerId: null } });
    await db.datastore.create({ data: { id: dsB, name: dsB, ownerId: null } });

    await db.agentDatastore.create({ data: { agentId, datastoreId: dsA, boundName: "kb" } });

    let caught: unknown;
    try {
      await db.agentDatastore.create({ data: { agentId, datastoreId: dsB, boundName: "kb" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

    // The first attachment is untouched.
    const row = await db.agentDatastore.findUnique({
      where: { agentId_datastoreId: { agentId, datastoreId: dsA } },
    });
    expect(row?.boundName).toBe("kb");
  });
});
