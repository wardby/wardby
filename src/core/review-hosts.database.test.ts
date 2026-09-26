import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";

const db = createPrismaClient();
const agentIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("code-review host schema (PostgreSQL)", () => {
  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.hostEventDelivery.deleteMany({ where: { deliveryId: { startsWith: "test-" } } });
    await db.$disconnect();
  });

  it("stores repository links, a run's host check, and cascades both on agent delete", async () => {
    const agent = await db.agent.create({
      data: { name: `review-host-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const link = await db.agentRepository.create({
      data: {
        agentId: agent.id,
        provider: "github",
        repository: "chfields/knock-knock-jokes",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(link.triggers).toEqual(["pull_request"]);
    await expect(
      db.agentRepository.create({
        data: { agentId: agent.id, provider: "github", repository: "chfields/knock-knock-jokes", access: "read" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const run = await db.run.create({ data: { agentId: agent.id, trigger: "host_event" } });
    await db.runHostCheck.create({
      data: {
        runId: run.id,
        provider: "github",
        repository: "chfields/knock-knock-jokes",
        checkId: "123",
        headSha: "a".repeat(40),
      },
    });
    expect(
      (await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { hostCheck: true } })).hostCheck?.checkId,
    ).toBe("123");

    await db.run.deleteMany({ where: { agentId: agent.id } });
    await db.agent.delete({ where: { id: agent.id } });
    expect(await db.agentRepository.count({ where: { agentId: agent.id } })).toBe(0);
    expect(await db.runHostCheck.count({ where: { runId: run.id } })).toBe(0);
  });

  it("rejects a duplicate delivery id for the same provider", async () => {
    const deliveryId = `test-${randomUUID()}`;
    await db.hostEventDelivery.create({ data: { provider: "github", deliveryId } });
    await expect(db.hostEventDelivery.create({ data: { provider: "github", deliveryId } })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
