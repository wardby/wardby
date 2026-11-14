import { describe, expect, it } from "vitest";
import { MemorySubstrateRunStore, type SubstrateRunRecord } from "./run-store.js";

const record: SubstrateRunRecord = {
  runId: "r1",
  token: "wr-00000000000000000001",
  specHash: "h1",
  phase: "provisioning",
  deadlineAt: new Date("2026-11-13T00:00:00Z"),
};

describe("MemorySubstrateRunStore", () => {
  it("fences a second claim and returns the first record", async () => {
    const store = new MemorySubstrateRunStore();
    expect(await store.claim(record)).toMatchObject({ created: true, record });
    const second = await store.claim({ ...record, specHash: "h2" });
    expect(second).toMatchObject({ created: false, record });
  });

  it("moves phase only from an allowed phase", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    await expect(store.setPhase("r1", "running", ["requeued"])).rejects.toThrow("substrate_phase_conflict");
    expect((await store.setPhase("r1", "running", ["provisioning"])).phase).toBe("running");
    expect((await store.get("r1"))?.phase).toBe("running");
    await expect(store.setPhase("missing", "running")).rejects.toThrow("substrate_phase_conflict");
  });

  it("finds a run by its token", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    expect(await store.getByToken(record.token)).toMatchObject(record);
    expect(await store.getByToken("wr-ffffffffffffffffffff")).toBeUndefined();
  });

  it("reclaims only a requeued run, with a fresh deadline", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    const later = new Date("2026-11-14T00:00:00Z");
    expect(await store.reclaim("r1", later)).toBeUndefined();
    await store.setPhase("r1", "requeued");
    expect(await store.reclaim("r1", later)).toMatchObject({ ...record, phase: "provisioning", deadlineAt: later });
    expect(await store.reclaim("r1", later)).toBeUndefined();
    expect(await store.reclaim("missing", later)).toBeUndefined();
  });

  it("records observed terminal phases", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    for (const phase of [
      "timed_out",
      "lost",
      "crashed",
      "tool_failed",
      "provisioning_failed",
      "collect_timeout",
      "startup_timeout",
    ] as const) {
      expect((await store.setPhase("r1", phase)).phase).toBe(phase);
    }
  });

  it("stamps updatedAt from its clock on every write, as Prisma's @updatedAt does", async () => {
    let now = 1_000;
    const store = new MemorySubstrateRunStore(() => now);
    expect((await store.claim(record)).record.updatedAt).toEqual(new Date(1_000));
    now = 2_000;
    expect((await store.setPhase("r1", "running")).updatedAt).toEqual(new Date(2_000));
    now = 3_000;
    expect((await store.get("r1"))?.updatedAt).toEqual(new Date(2_000));
    await store.setPhase("r1", "requeued");
    now = 4_000;
    expect((await store.reclaim("r1", new Date(9_000)))?.updatedAt).toEqual(new Date(4_000));
  });

  it("writes a park's deadline with its phase", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    const until = new Date("2026-11-14T00:00:00Z");
    expect(await store.setPhase("r1", "parked", ["provisioning"], until)).toMatchObject({
      phase: "parked",
      deadlineAt: until,
    });
  });

  it("adopts a parked run atomically, and only a parked one", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    const next = { ...record, runId: "r2", specHash: "h2" };
    expect(await store.adopt("r1", "wa-retired", next)).toBeUndefined();
    await store.setPhase("r1", "parked");
    expect(await store.adopt("r1", "wa-retired", { ...next, token: "wr-other" })).toBeUndefined();
    expect(await store.adopt("r1", "wa-retired", next)).toMatchObject({ runId: "r2", token: record.token });
    expect(await store.get("r1")).toMatchObject({ phase: "adopted", token: "wa-retired" });
    expect(await store.getByToken(record.token)).toMatchObject({ runId: "r2" });
    // Not parked any more: a second adopter gets nothing.
    expect(await store.adopt("r1", "wa-retired", { ...next, runId: "r3" })).toBeUndefined();
    expect(await store.get("r3")).toBeUndefined();
  });

  it("lists runs by phase", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    await store.claim({ ...record, runId: "r0", token: "wr-00000000000000000000" });
    await store.setPhase("r1", "parked");
    await store.setPhase("r0", "parked");
    expect((await store.listByPhase("parked")).map((r) => r.runId)).toEqual(["r0", "r1"]);
    expect(await store.listByPhase("running")).toEqual([]);
  });
});
