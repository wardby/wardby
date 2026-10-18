import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { PARENT_LOST_REASON, stopChildrenOfLostRun } from "./lost-run-children.js";

const db = createPrismaClient();
const PREFIX = "lrc-";
const suffix = randomUUID();
const id = (name: string) => `${PREFIX}${name}-${suffix}`;
const principalId = id("principal");
const agentId = id("agent");

async function cleanup(): Promise<void> {
  await db.run.deleteMany({ where: { id: { startsWith: PREFIX }, parentRunId: { not: null } } });
  await db.run.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

async function seed(runId: string, status: "pending" | "running" | "succeeded" | "lost", parentRunId?: string) {
  await db.run.create({ data: { id: runId, agentId, status, ...(parentRunId ? { parentRunId } : {}) } });
}

beforeAll(async () => {
  await cleanup();
  await db.principal.create({ data: { id: principalId, subject: principalId } });
  await db.agent.create({
    data: { id: agentId, name: agentId, ownerId: principalId, systemPrompt: "x", model: "m", budgetUsd: 1 },
  });
});
afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("stopChildrenOfLostRun", () => {
  it("stops the pending and running children only, with the parent-lost reason", async () => {
    const parent = id("parent");
    await seed(parent, "lost");
    await seed(id("c-pending"), "pending", parent);
    await seed(id("c-running"), "running", parent);
    await seed(id("c-done"), "succeeded", parent);
    const stops: [string, string | undefined][] = [];
    const executor = {
      async stop(runId: string, reason?: string) {
        stops.push([runId, reason]);
      },
    };

    const count = await stopChildrenOfLostRun(db, executor, parent);

    expect(count).toBe(2);
    expect(stops.sort()).toEqual(
      [
        [id("c-pending"), PARENT_LOST_REASON],
        [id("c-running"), PARENT_LOST_REASON],
      ].sort(),
    );
  });

  it("returns 0 without throwing when there is no executor", async () => {
    expect(await stopChildrenOfLostRun(db, undefined, id("parent"))).toBe(0);
  });

  it("keeps going when one stop throws", async () => {
    const parent = id("parent2");
    await seed(parent, "lost");
    await seed(id("d-1"), "running", parent);
    await seed(id("d-2"), "running", parent);
    const seen: string[] = [];
    const executor = {
      async stop(runId: string) {
        seen.push(runId);
        if (seen.length === 1) throw new Error("boom");
      },
    };
    expect(await stopChildrenOfLostRun(db, executor, parent)).toBe(1);
    expect(seen).toHaveLength(2);
  });
});
