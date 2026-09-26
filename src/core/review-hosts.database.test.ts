import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ReviewHostRegistry } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import { closeOrphanedHostChecks } from "./reconciler.js";

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

  it("the orphaned-check sweep completes only open checks of runs that ended past the grace period", async () => {
    const agent = await db.agent.create({
      data: { name: `review-host-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    // A provider key no other test uses, so the global sweep only ever sees this test's rows.
    const provider = `test-${randomUUID()}`;
    const now = new Date();
    const longAgo = new Date(now.getTime() - 5 * 60_000);
    const seed = async (status: "lost" | "failed" | "running", finishedAt: Date | null) => {
      const run = await db.run.create({ data: { agentId: agent.id, trigger: "host_event", status, finishedAt } });
      await db.runHostCheck.create({
        data: { runId: run.id, provider, repository: "o/n", checkId: run.id, headSha: "a".repeat(40) },
      });
      return run.id;
    };
    const lost = await seed("lost", longAgo);
    const recent = await seed("failed", new Date(now.getTime() - 10_000));
    const live = await seed("running", null);
    const completeCheck = vi.fn(async () => undefined);
    const hosts = { [provider]: { provider, completeCheck } } as unknown as ReviewHostRegistry;

    await closeOrphanedHostChecks(db, hosts, now);

    expect(completeCheck).toHaveBeenCalledTimes(1);
    expect(completeCheck).toHaveBeenCalledWith("o/n", expect.objectContaining({ checkId: lost }));
    const completed = await db.runHostCheck.findMany({
      where: { provider },
      select: { runId: true, completedAt: true },
    });
    expect(Object.fromEntries(completed.map((c) => [c.runId, c.completedAt !== null]))).toEqual({
      [lost]: true,
      [recent]: false,
      [live]: false,
    });
    await db.run.deleteMany({ where: { agentId: agent.id } });
  });

  it("rejects a duplicate delivery id for the same provider", async () => {
    const deliveryId = `test-${randomUUID()}`;
    await db.hostEventDelivery.create({ data: { provider: "github", deliveryId } });
    await expect(db.hostEventDelivery.create({ data: { provider: "github", deliveryId } })).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
