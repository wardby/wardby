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
    expect(await store.claim(record)).toEqual({ created: true, record });
    const second = await store.claim({ ...record, specHash: "h2" });
    expect(second).toEqual({ created: false, record });
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
    expect(await store.getByToken(record.token)).toEqual(record);
    expect(await store.getByToken("wr-ffffffffffffffffffff")).toBeUndefined();
  });

  it("reclaims only a requeued run, with a fresh deadline", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    const later = new Date("2026-11-14T00:00:00Z");
    expect(await store.reclaim("r1", later)).toBeUndefined();
    await store.setPhase("r1", "requeued");
    expect(await store.reclaim("r1", later)).toEqual({ ...record, phase: "provisioning", deadlineAt: later });
    expect(await store.reclaim("r1", later)).toBeUndefined();
    expect(await store.reclaim("missing", later)).toBeUndefined();
  });

  it("records observed terminal phases", async () => {
    const store = new MemorySubstrateRunStore();
    await store.claim(record);
    for (const phase of ["timed_out", "lost", "crashed", "tool_failed", "provisioning_failed"] as const) {
      expect((await store.setPhase("r1", phase)).phase).toBe(phase);
    }
  });
});
