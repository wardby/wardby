import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { createSubstrateRunFixture } from "../../coding-proxy/substrate/substrate-fixture.js";
import { PrismaSubstrateRunStore } from "./run-store.js";

const db = createPrismaClient();
const token = "wr-0000000000000000run1";
const runId = `substrate-run-${token}`;

describe.skipIf(!process.env.DATABASE_URL)("PrismaSubstrateRunStore (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agent.deleteMany({ where: { id: `substrate-agent-${token}` } });
    await db.$disconnect();
  });

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
    };
    const first = await store.claim(record);
    expect(first.created).toBe(true);
    const second = await store.claim({ ...record, specHash: "other" });
    expect(second.created).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(await store.get(runId)).toEqual(first.record);

    await expect(store.setPhase(runId, "running", ["requeued"])).rejects.toThrow("substrate_phase_conflict");
    expect((await store.setPhase(runId, "running", ["provisioning"])).phase).toBe("running");
    expect((await store.setPhase(runId, "stopped")).phase).toBe("stopped");

    await db.codingRun.delete({ where: { runId } });
    expect(await store.get(runId)).toBeUndefined();
  });
});
