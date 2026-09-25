import { describe, it, expect } from "vitest";
import {
  createDatastore,
  listDatastores,
  deleteDatastore,
  attachDatastore,
  detachDatastore,
  buildSharedDatastoreAccessor,
  scopeSharedDatastoreAccessor,
} from "./datastores.js";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";

interface FakeDatastoreRow {
  id: string;
  name: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeAgentDatastoreRow {
  agentId: string;
  datastoreId: string;
  boundName: string;
}

function fakeDb() {
  const datastores = new Map<string, FakeDatastoreRow>();
  const agentDatastores: FakeAgentDatastoreRow[] = [];
  let counter = 0;

  return {
    datastore: {
      create: async ({ data }: { data: Partial<FakeDatastoreRow> & { name: string } }) => {
        const now = new Date();
        const row: FakeDatastoreRow = { id: `ds_${++counter}`, createdAt: now, updatedAt: now, ownerId: null, ...data };
        datastores.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: { where: { ownerId: string } }) =>
        [...datastores.values()].filter((d) => d.ownerId === where.ownerId),
      findUnique: async ({ where }: { where: { id: string } }) => datastores.get(where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        const row = datastores.get(where.id);
        datastores.delete(where.id);
        return row;
      },
    },
    agentDatastore: {
      create: async ({ data }: { data: FakeAgentDatastoreRow }) => {
        if (agentDatastores.some((a) => a.agentId === data.agentId && a.boundName === data.boundName)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        agentDatastores.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const before = agentDatastores.length;
        const kept = agentDatastores.filter((a) => !(a.agentId === where.agentId && a.boundName === where.boundName));
        agentDatastores.length = 0;
        agentDatastores.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { agentId: string; boundName: string } }) =>
        agentDatastores.find((a) => a.agentId === where.agentId && a.boundName === where.boundName) ?? null,
    },
  } as unknown as import("#prisma").PrismaClient;
}

function fakeDatastoreProvider(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    async get() {
      return undefined;
    },
    async set() {},
    async delete() {},
    async list() {
      return [];
    },
    async getShared(datastoreId, key) {
      return store.get(`${datastoreId}:${key}`);
    },
    async setShared(datastoreId, key, value) {
      store.set(`${datastoreId}:${key}`, value);
    },
    async deleteShared(datastoreId, key) {
      store.delete(`${datastoreId}:${key}`);
    },
    async listShared(datastoreId, prefix) {
      const p = `${datastoreId}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(datastoreId.length + 1));
    },
  };
}

describe("core/datastores", () => {
  it("createDatastore + listDatastores round-trip", async () => {
    const db = fakeDb();
    const ds = await createDatastore("shared-kb", "p1", db);
    expect(ds.name).toBe("shared-kb");
    const list = await listDatastores("p1", db);
    expect(list.map((d) => d.name)).toEqual(["shared-kb"]);
  });

  it("two agents attached to the same datastore both see writes the other made", async () => {
    const db = fakeDb();
    const provider = fakeDatastoreProvider();
    const ds = await createDatastore("shared-kb", "p1", db);
    await attachDatastore("agent-A", ds.id, db, "shared-kb");
    await attachDatastore("agent-B", ds.id, db, "shared-kb");

    const accessorA = buildSharedDatastoreAccessor("agent-A", provider, db);
    const accessorB = buildSharedDatastoreAccessor("agent-B", provider, db);

    await accessorA.set("shared-kb", "k1", "from-a");
    expect(await accessorB.get("shared-kb", "k1")).toBe("from-a");
  });

  it("attachDatastore twice under the same boundName for one agent rejects the second (P2002)", async () => {
    const db = fakeDb();
    const dsA = await createDatastore("store-a", "p1", db);
    const dsB = await createDatastore("store-b", "p1", db);
    await attachDatastore("agent-1", dsA.id, db, "kb");
    await expect(attachDatastore("agent-1", dsB.id, db, "kb")).rejects.toMatchObject({ code: "P2002" });
  });

  it("detachDatastore removes access — buildSharedDatastoreAccessor().get() resolves undefined after", async () => {
    const db = fakeDb();
    const provider = fakeDatastoreProvider();
    const ds = await createDatastore("shared-kb", "p1", db);
    await attachDatastore("agent-1", ds.id, db, "shared-kb");
    await detachDatastore("agent-1", "shared-kb", db);

    const accessor = buildSharedDatastoreAccessor("agent-1", provider, db);
    expect(await accessor.get("shared-kb", "k1")).toBeUndefined();
  });

  it("buildSharedDatastoreAccessor().set() throws datastore_not_bound for an unattached boundName", async () => {
    const db = fakeDb();
    const provider = fakeDatastoreProvider();
    const accessor = buildSharedDatastoreAccessor("agent-1", provider, db);
    await expect(accessor.set("never-bound", "k1", "v")).rejects.toThrow("datastore_not_bound");
  });

  it("deleteDatastore removes it from listDatastores", async () => {
    const db = fakeDb();
    const ds = await createDatastore("shared-kb", "p1", db);
    await deleteDatastore(ds.id, db);
    expect(await listDatastores("p1", db)).toEqual([]);
  });
});

describe("scopeSharedDatastoreAccessor", () => {
  function fakeAccessor() {
    const store = new Map<string, string>();
    return {
      async get(boundName: string, key: string) {
        return store.get(`${boundName}:${key}`);
      },
      async set(boundName: string, key: string, value: string) {
        store.set(`${boundName}:${key}`, value);
      },
      async delete(boundName: string, key: string) {
        store.delete(`${boundName}:${key}`);
      },
      async list(boundName: string, prefix?: string) {
        const p = `${boundName}:${prefix ?? ""}`;
        return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(boundName.length + 1));
      },
    };
  }

  it("get/set/delete/list all work for a key under an allowed prefix, for a granted boundName", async () => {
    const scoped = scopeSharedDatastoreAccessor(fakeAccessor(), { kb: ["allowed:"] });
    await scoped.set("kb", "allowed:1", "v");
    await expect(scoped.get("kb", "allowed:1")).resolves.toBe("v");
    expect(await scoped.list("kb")).toEqual(["allowed:1"]);
    await scoped.delete("kb", "allowed:1");
    await expect(scoped.get("kb", "allowed:1")).resolves.toBeUndefined();
  });

  it("a boundName with no entry in the allow-map denies every read, write, and delete", async () => {
    const inner = fakeAccessor();
    await inner.set("kb", "x", "v");
    const scoped = scopeSharedDatastoreAccessor(inner, {});
    await expect(scoped.get("kb", "x")).resolves.toBeUndefined();
    await expect(scoped.set("kb", "x", "v2")).rejects.toThrow("datastore_prefix_not_allowed");
    expect(await scoped.list("kb")).toEqual([]);
  });

  it("a key outside every prefix for a granted boundName is denied the same way", async () => {
    const scoped = scopeSharedDatastoreAccessor(fakeAccessor(), { kb: ["allowed:"] });
    await expect(scoped.get("kb", "blocked:1")).resolves.toBeUndefined();
    await expect(scoped.set("kb", "blocked:1", "v")).rejects.toThrow("datastore_prefix_not_allowed");
  });
});
