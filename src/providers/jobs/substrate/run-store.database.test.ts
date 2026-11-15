import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { createSubstrateRunFixture } from "../../coding-proxy/substrate/substrate-fixture.test-support.js";
import { describeSubstrateRunStoreContract } from "./run-store.contract.test-support.js";
import { PrismaSubstrateRunStore } from "./run-store.js";

const db = createPrismaClient();
const token = "wr-0000000000000000run1";
const runId = `substrate-run-${token}`;
/** The contract's runs: one agent, and a Run and CodingRun per run id, all under this prefix. */
const prefix = `substrate-contract-${randomUUID().slice(0, 8)}`;
const contractAgentId = `${prefix}-agent`;

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await db.codingRun.deleteMany({ where: { runId: { startsWith: prefix } } });
  await db.run.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.agent.deleteMany({ where: { id: contractAgentId } });
  await db.codingRun.deleteMany({ where: { runId } });
  await db.run.deleteMany({ where: { id: runId } });
  await db.agent.deleteMany({ where: { id: `substrate-agent-${token}` } });
  await db.$disconnect();
});

describe.skipIf(!process.env.DATABASE_URL)("PrismaSubstrateRunStore (PostgreSQL)", () => {
  it("fences claims, guards phase moves, and cascades with the CodingRun", async () => {
    await createSubstrateRunFixture(db, token);
    // The fixture inserts the SubstrateRun row itself; drop it so claim() can create it.
    await db.substrateRun.delete({ where: { runId } });
    const store = new PrismaSubstrateRunStore(db);
    const record = {
      runId,
      token,
      specHash: "h1",
      phase: "provisioning" as const,
      deadlineAt: new Date(Date.now() + 60_000),
      repositories: [{ name: "extra-alpha", access: "write" as const }],
    };
    const first = await store.claim(record);
    expect(first.created).toBe(true);
    expect(
      (await db.substrateRun.findUnique({ where: { runId }, select: { repositories: true } }))?.repositories,
    ).toEqual([{ name: "extra-alpha", access: "write" }]);
    const second = await store.claim({ ...record, specHash: "other" });
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(await store.get(runId)).toEqual(first.record);

    await expect(store.setPhase(runId, "running", ["requeued"])).rejects.toThrow("substrate_phase_conflict");
    const before = Date.now();
    const running = await store.setPhase(runId, "running", ["provisioning"]);
    expect(running.phase).toBe("running");
    // The row's @updatedAt: when it last changed (here, when it became running).
    expect(running.updatedAt?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect((await store.setPhase(runId, "stopped")).phase).toBe("stopped");
    expect(await store.getByToken(token)).toMatchObject({ runId, phase: "stopped" });
    expect(await store.getByToken("wr-ffffffffffffffffffff")).toBeUndefined();

    const later = new Date(Date.now() + 120_000);
    expect(await store.reclaim(runId, later)).toBeUndefined();
    await store.setPhase(runId, "requeued");
    expect(await store.reclaim(runId, later)).toMatchObject({ phase: "provisioning", deadlineAt: later });
    expect(await store.reclaim(runId, later)).toBeUndefined();
    expect((await store.setPhase(runId, "timed_out", ["provisioning"])).phase).toBe("timed_out");

    await db.codingRun.delete({ where: { runId } });
    expect(await store.get(runId)).toBeUndefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("PrismaSubstrateRunStore contract (PostgreSQL)", () => {
  describeSubstrateRunStoreContract("PrismaSubstrateRunStore", {
    store: (now) => new PrismaSubstrateRunStore(db, now),
    runs: async (...runIds) => {
      await db.agent.upsert({
        where: { id: contractAgentId },
        create: { id: contractAgentId, name: contractAgentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
        update: {},
      });
      for (const id of runIds) {
        await db.run.create({ data: { id, agentId: contractAgentId, executionManaged: true } });
        await db.codingRun.create({
          data: {
            runId: id,
            task: "test",
            repository: "example/repo",
            baseRef: "main",
            headRef: `wardby/run-${id}`,
            provider: "claude-code",
            model: "claude-sonnet-5",
            timeoutSec: 60,
            allowedEgress: [],
            protectedPaths: [],
            budgetReservedUsd: 0.0002,
          },
        });
      }
    },
    id: (name) => `${prefix}-${name}`,
  });
});
