import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import { SecretCheckUnavailableError, SecretInValueError, createSecretWriteGuard } from "./secret-guard.js";
import { guardAgentMemory, guardDatastore } from "./secret-guarded-stores.js";

const FAKE = "fake-secret-value-1234";
const guard = createSecretWriteGuard({
  load: async (agentId) => (agentId === "agent-1" ? [{ name: "API_KEY", values: [FAKE] }] : []),
});

function fakeDatastore() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    <T>(method: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const inner: Datastore = {
    get: rec<DatastoreValue | undefined>("get", "v"),
    set: rec("set", undefined),
    delete: rec("delete", undefined),
    list: rec("list", ["k"]),
    getShared: rec<DatastoreValue | undefined>("getShared", "sv"),
    setShared: rec("setShared", undefined),
    deleteShared: rec("deleteShared", undefined),
    listShared: rec("listShared", ["sk"]),
  };
  return { inner, calls };
}

function fakeMemory() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    <T>(method: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const inner: AgentMemoryStore = {
    get: rec<string | undefined>("get", "c"),
    set: rec("set", undefined),
    list: rec("list", ["k"]),
    search: rec("search", [{ key: "k", content: "c", rank: 1 }]),
    delete: rec("delete", undefined),
  };
  return { inner, calls };
}

describe("guardDatastore", () => {
  it("refuses a private value holding a secret and does not store it", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    await expect(ds.set("agent-1", "k", `token=${FAKE}`)).rejects.toBeInstanceOf(SecretInValueError);
    expect(calls).toEqual([]);
  });

  it("refuses a private key holding a secret and does not store it", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    const err = await ds.set("agent-1", `cache/${FAKE}`, "clean").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretInValueError);
    expect((err as Error).message).toContain("API_KEY");
    expect((err as Error).message).not.toContain(FAKE);
    expect(calls).toEqual([]);
  });

  it("refuses a shared key holding a secret and does not store it", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    const err = await ds
      .setShared("ds1", `cache/${FAKE}`, "clean", { writerAgentId: "agent-1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretInValueError);
    expect((err as Error).message).toContain("API_KEY");
    expect((err as Error).message).not.toContain(FAKE);
    expect(calls).toEqual([]);
  });

  it("passes a clean value through with the same arguments", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    await ds.set("agent-1", "k", { a: 1 }, { pii: false });
    expect(calls).toEqual([{ method: "set", args: ["agent-1", "k", { a: 1 }, { pii: false }] }]);
  });

  it("checks pii values the same way", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    await expect(ds.set("agent-1", "k", FAKE, { pii: true })).rejects.toBeInstanceOf(SecretInValueError);
    expect(calls).toEqual([]);
  });

  it("checks a shared write against writerAgentId and strips it before the inner store", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    await expect(ds.setShared("ds1", "k", FAKE, { writerAgentId: "agent-1" })).rejects.toBeInstanceOf(
      SecretInValueError,
    );
    expect(calls).toEqual([]);
    await ds.setShared("ds1", "k", "clean", { pii: true, writerAgentId: "agent-1" });
    expect(calls).toEqual([{ method: "setShared", args: ["ds1", "k", "clean", { pii: true }] }]);
    expect((calls[0].args[3] as DatastoreSetOptions).writerAgentId).toBeUndefined();
  });

  it("refuses a shared write with no writerAgentId (fail closed)", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    await expect(ds.setShared("ds1", "k", "clean")).rejects.toBeInstanceOf(SecretCheckUnavailableError);
    expect(calls).toEqual([]);
  });

  it("delegates reads, deletes and lists unchanged", async () => {
    const { inner, calls } = fakeDatastore();
    const ds = guardDatastore(inner, guard);
    expect(await ds.get("a", "k")).toBe("v");
    expect(await ds.list("a", "p")).toEqual(["k"]);
    await ds.delete("a", "k");
    expect(await ds.getShared("d", "k")).toBe("sv");
    expect(await ds.listShared("d", "p")).toEqual(["sk"]);
    await ds.deleteShared("d", "k");
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "delete", "getShared", "listShared", "deleteShared"]);
  });
});

describe("guardAgentMemory", () => {
  it("refuses content holding a secret and does not store it", async () => {
    const { inner, calls } = fakeMemory();
    const mem = guardAgentMemory(inner, guard);
    await expect(mem.set("agent-1", "k", `note ${FAKE}`)).rejects.toBeInstanceOf(SecretInValueError);
    expect(calls).toEqual([]);
  });

  it("refuses a key holding a secret and does not store it", async () => {
    const { inner, calls } = fakeMemory();
    const mem = guardAgentMemory(inner, guard);
    const err = await mem.set("agent-1", `note-${FAKE}`, "clean").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretInValueError);
    expect((err as Error).message).toContain("API_KEY");
    expect((err as Error).message).not.toContain(FAKE);
    expect(calls).toEqual([]);
  });

  it("passes clean content through and delegates every other method", async () => {
    const { inner, calls } = fakeMemory();
    const mem = guardAgentMemory(inner, guard);
    await mem.set("agent-1", "k", "clean");
    expect(await mem.get("agent-1", "k")).toBe("c");
    expect(await mem.list("agent-1")).toEqual(["k"]);
    expect(await mem.search("agent-1", "q", 3)).toHaveLength(1);
    await mem.delete("agent-1", "k");
    expect(calls).toEqual([
      { method: "set", args: ["agent-1", "k", "clean"] },
      { method: "get", args: ["agent-1", "k"] },
      { method: "list", args: ["agent-1"] },
      { method: "search", args: ["agent-1", "q", 3] },
      { method: "delete", args: ["agent-1", "k"] },
    ]);
  });
});
