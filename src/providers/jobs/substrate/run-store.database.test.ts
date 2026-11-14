import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { createSubstrateRunFixture } from "../../coding-proxy/substrate/substrate-fixture.test-support.js";
import { PrismaSubstrateRunStore } from "./run-store.js";

const db = createPrismaClient();
const token = "wr-0000000000000000run1";
const runId = `substrate-run-${token}`;
const adopterToken = "wr-0000000000000000run2";
const adopterRunId = `substrate-run-${adopterToken}`;

describe.skipIf(!process.env.DATABASE_URL)("PrismaSubstrateRunStore (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: [runId, adopterRunId] } } });
    await db.run.deleteMany({ where: { id: adopterRunId } });
    await db.agent.deleteMany({ where: { id: `substrate-agent-${adopterToken}` } });
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

  it("parks with a deadline, adopts in one transaction, and lists parked runs (warm rounds)", async () => {
    await createSubstrateRunFixture(db, token, { phase: "running" });
    // The adopter's CodingRun (its SubstrateRun row comes from adopt()).
    await createSubstrateRunFixture(db, adopterToken);
    await db.substrateRun.delete({ where: { runId: adopterRunId } });
    const store = new PrismaSubstrateRunStore(db);
    const until = new Date(Date.now() + 3_600_000);
    expect(await store.setPhase(runId, "parked", ["running"], until)).toMatchObject({
      phase: "parked",
      deadlineAt: until,
    });
    expect((await store.listByPhase("parked")).map((r) => r.runId)).toContain(runId);
    const record = {
      runId: adopterRunId,
      token,
      specHash: "h2",
      phase: "provisioning" as const,
      deadlineAt: new Date(Date.now() + 60_000),
    };
    // A wrong token changes nothing.
    expect(await store.adopt(runId, "wa-retired0000000000001", { ...record, token: adopterToken })).toBeUndefined();
    expect(await store.get(adopterRunId)).toBeUndefined();
    const adopted = await store.adopt(runId, "wa-retired0000000000001", record);
    expect(adopted).toMatchObject({ runId: adopterRunId, token, phase: "provisioning" });
    expect(await store.get(runId)).toMatchObject({ phase: "adopted", token: "wa-retired0000000000001" });
    expect(await store.getByToken(token)).toMatchObject({ runId: adopterRunId });
    // Not parked any more: nothing changes, and no row appears.
    expect(await store.adopt(runId, "wa-retired0000000000002", { ...record, runId: "nope" })).toBeUndefined();
    expect(await store.get(runId)).toMatchObject({ token: "wa-retired0000000000001" });
  });
});
