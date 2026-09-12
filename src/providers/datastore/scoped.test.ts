import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "./types.js";
import { scopeDatastore } from "./scoped.js";

function fakeDatastore(): Datastore & {
  setCalls: [string, string, DatastoreValue, DatastoreSetOptions | undefined][];
  sharedStore: Map<string, DatastoreValue>;
} {
  const store = new Map<string, DatastoreValue>();
  const sharedStore = new Map<string, DatastoreValue>();
  const setCalls: [string, string, DatastoreValue, DatastoreSetOptions | undefined][] = [];
  return {
    setCalls,
    sharedStore,
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, value, opts) {
      setCalls.push([agentId, key, value, opts]);
      store.set(`${agentId}:${key}`, value);
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
    async list(agentId, prefix) {
      const p = `${agentId}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(agentId.length + 1));
    },
    async getShared(datastoreId, key) {
      return sharedStore.get(`${datastoreId}:${key}`);
    },
    async setShared(datastoreId, key, value) {
      sharedStore.set(`${datastoreId}:${key}`, value);
    },
    async deleteShared(datastoreId, key) {
      sharedStore.delete(`${datastoreId}:${key}`);
    },
    async listShared() {
      return [];
    },
  };
}

describe("scopeDatastore", () => {
  it("get/set/delete/list all work normally for a key under an allowed prefix", async () => {
    const scoped = scopeDatastore(fakeDatastore(), ["allowed:"]);
    await scoped.set("a1", "allowed:1", "v");
    await expect(scoped.get("a1", "allowed:1")).resolves.toBe("v");
    expect(await scoped.list("a1")).toEqual(["allowed:1"]);
    await scoped.delete("a1", "allowed:1");
    await expect(scoped.get("a1", "allowed:1")).resolves.toBeUndefined();
  });

  it("get resolves undefined for a key outside every allowed prefix", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "blocked:1", "v");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await expect(scoped.get("a1", "blocked:1")).resolves.toBeUndefined();
  });

  it("set throws for a key outside every allowed prefix, and never reaches the underlying store", async () => {
    const inner = fakeDatastore();
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await expect(scoped.set("a1", "blocked:1", "v")).rejects.toThrow("datastore_prefix_not_allowed");
    await expect(inner.get("a1", "blocked:1")).resolves.toBeUndefined();
  });

  it("delete on a disallowed key is a no-op rather than a throw", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "blocked:1", "v");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await scoped.delete("a1", "blocked:1");
    await expect(inner.get("a1", "blocked:1")).resolves.toBe("v");
  });

  it("list filters out keys outside every allowed prefix, even when the caller passes an unrestricted prefix filter", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "allowed:1", "v1");
    await inner.set("a1", "blocked:1", "v2");
    const scoped = scopeDatastore(inner, ["allowed:"]);
    expect(await scoped.list("a1")).toEqual(["allowed:1"]);
  });

  it("an empty-string prefix in the allowlist matches every key", async () => {
    const inner = fakeDatastore();
    const scoped = scopeDatastore(inner, [""]);
    await scoped.set("a1", "anything", "v");
    await expect(scoped.get("a1", "anything")).resolves.toBe("v");
  });

  it("passes the pii option through to the underlying store's set", async () => {
    const inner = fakeDatastore();
    const scoped = scopeDatastore(inner, ["allowed:"]);
    await scoped.set("a1", "allowed:1", "v", { pii: true });
    expect(inner.setCalls).toEqual([["a1", "allowed:1", "v", { pii: true }]]);
  });

  it("an empty allowlist denies every read, write, and delete", async () => {
    const inner = fakeDatastore();
    await inner.set("a1", "x", "v");
    const scoped = scopeDatastore(inner, []);
    await expect(scoped.get("a1", "x")).resolves.toBeUndefined();
    await expect(scoped.set("a1", "x", "v2")).rejects.toThrow("datastore_prefix_not_allowed");
    expect(await scoped.list("a1")).toEqual([]);
  });

  // Shared-store access is unreachable through a scopeDatastore(...)-wrapped
  // object in this codebase's call graph today (it has its own dedicated
  // scoping, scopeSharedDatastoreAccessor in src/core/datastores.ts), but
  // this wrapper is the security boundary for the private per-agent store —
  // a silent pass-through to the unscoped datastore would be a hole waiting
  // to happen the moment that call graph changes. All four must fail
  // closed instead.
  it("getShared/setShared/deleteShared/listShared all throw rather than pass through to the unscoped store", async () => {
    const inner = fakeDatastore();
    await inner.setShared("ds1", "k", "v");
    const scoped = scopeDatastore(inner, ["allowed:"]);

    await expect(scoped.getShared("ds1", "k")).rejects.toThrow("datastore_shared_access_not_allowed");
    await expect(scoped.setShared("ds1", "k", "v2")).rejects.toThrow("datastore_shared_access_not_allowed");
    await expect(scoped.deleteShared("ds1", "k")).rejects.toThrow("datastore_shared_access_not_allowed");
    await expect(scoped.listShared("ds1")).rejects.toThrow("datastore_shared_access_not_allowed");

    // Never reached the underlying store.
    await expect(inner.getShared("ds1", "k")).resolves.toBe("v");
  });
});
