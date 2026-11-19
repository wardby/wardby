import { describe, expect, it } from "vitest";
import type { PrismaClient } from "#prisma";
import { listSecrets } from "./secrets.js";
import { listDatastores } from "./datastores.js";

const SECRET_VALUE = "fake-secret-value-123";

function fakeDb() {
  const wheres: unknown[] = [];
  const secretRow = {
    id: "s1",
    name: "api",
    keyId: "k1",
    ownerId: "owner-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    // A real row carries these; a listing must never surface them.
    ciphertext: SECRET_VALUE,
    value: SECRET_VALUE,
    broker: null,
    oauth: null,
  };
  const db = {
    secret: {
      findMany: async ({ where }: { where: unknown }) => {
        wheres.push(where);
        return [secretRow];
      },
    },
    datastore: {
      findMany: async ({ where }: { where: unknown }) => {
        wheres.push(where);
        return [{ id: "d1", name: "ds", ownerId: "owner-1", createdAt: new Date(0), updatedAt: new Date(0) }];
      },
    },
  } as unknown as PrismaClient;
  return { db, wheres };
}

describe("owner-all listings", () => {
  it("lists every owner's secrets (metadata only, never a value) and datastores when all is set", async () => {
    const { db, wheres } = fakeDb();
    const secrets = await listSecrets("boss", db, { all: true });
    const stores = await listDatastores("boss", db, { all: true });
    expect(wheres).toEqual([{}, {}]);
    expect(secrets.map((s) => s.ownerId)).toEqual(["owner-1"]);
    expect(stores.map((s) => s.ownerId)).toEqual(["owner-1"]);
    expect(JSON.stringify(secrets)).not.toContain(SECRET_VALUE);
  });

  it("keeps the owner filter without all", async () => {
    const { db, wheres } = fakeDb();
    await listSecrets("boss", db);
    await listDatastores("boss", db);
    expect(wheres).toEqual([{ ownerId: "boss" }, { ownerId: "boss" }]);
  });
});
