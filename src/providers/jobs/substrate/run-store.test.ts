import { describe, expect, it } from "vitest";
import { describeSubstrateRunStoreContract } from "./run-store.contract.test-support.js";
import {
  MemorySubstrateRunStore,
  parseRunRepositories,
  parseRunServices,
  type SubstrateRunRecord,
} from "./run-store.js";

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
});

describeSubstrateRunStoreContract("MemorySubstrateRunStore", {
  store: (now) => new MemorySubstrateRunStore(now),
  runs: async () => undefined,
  id: (name) => `run-${name}`,
});

describe("parseRunRepositories", () => {
  it("reads nothing for null or undefined", () => {
    expect(parseRunRepositories(null)).toBeUndefined();
    expect(parseRunRepositories(undefined)).toBeUndefined();
  });

  it("returns a valid list as it is", () => {
    const list = [
      { name: "extra-alpha", access: "write" },
      { name: "extra-beta", access: "read" },
    ];
    expect(parseRunRepositories(list)).toEqual(list);
  });

  it.each([
    ["an empty list", []],
    ["a string", "x"],
    ["an unknown access", [{ name: "extra-alpha", access: "admin" }]],
    ["the reserved name", [{ name: "workspace", access: "read" }]],
    ["an invalid name", [{ name: "Extra", access: "read" }]],
    [
      "a name twice",
      [
        { name: "extra-alpha", access: "read" },
        { name: "extra-alpha", access: "write" },
      ],
    ],
    ["an extra key", [{ name: "extra-alpha", access: "read", hostPath: "/x" }]],
    ["17 entries", Array.from({ length: 17 }, (_, i) => ({ name: `extra-${i}`, access: "read" }))],
  ])("reads nothing for %s", (_label, value) => {
    expect(parseRunRepositories(value)).toBeUndefined();
  });
});

describe("parseRunServices", () => {
  it("reads nothing for null or undefined", () => {
    expect(parseRunServices(null)).toBeUndefined();
    expect(parseRunServices(undefined)).toBeUndefined();
  });

  it("returns the names sorted", () => {
    expect(parseRunServices(["redis", "postgres"])).toEqual(["postgres", "redis"]);
  });

  it.each([
    ["an empty list", []],
    ["a string", "postgres"],
    ["an invalid name", ["Postgres"]],
    ["a name twice", ["postgres", "postgres"]],
    ["an object entry", [{ name: "postgres" }]],
    ["six names", ["a", "b", "c", "d", "e", "f"]],
  ])("reads nothing for %s", (_label, value) => {
    expect(parseRunServices(value)).toBeUndefined();
  });
});
