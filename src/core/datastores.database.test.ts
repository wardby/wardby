import { Prisma } from "#prisma";
import { createPrismaClient } from "./db.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildSharedDatastoreAccessor } from "./datastores.js";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";

/**
 * Real-Postgres coverage for AgentDatastore's @@unique([agentId, boundName])
 * constraint (finding #6) — every other AgentDatastore test in this repo
 * exercises the constraint only through a fake db's own hand-rolled
 * duplicate check, which proves the MCP handler maps P2002 correctly but
 * never proves the constraint actually exists in the deployed schema.
 */
describe.skipIf(!process.env.DATABASE_URL)("AgentDatastore unique constraint (database)", () => {
  const db = createPrismaClient();
  const agentId = "ads-agent-" + randomUUID();
  const dsA = "ads-ds-a-" + randomUUID();
  const dsB = "ads-ds-b-" + randomUUID();

  afterAll(async () => {
    await db.agentDatastore.deleteMany({ where: { agentId } });
    await db.datastore.deleteMany({ where: { id: { in: [dsA, dsB] } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  it("rejects a second attachment under the same (agentId, boundName) with a real P2002", async () => {
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1 },
    });
    await db.datastore.create({ data: { id: dsA, name: dsA, ownerId: null } });
    await db.datastore.create({ data: { id: dsB, name: dsB, ownerId: null } });

    await db.agentDatastore.create({ data: { agentId, datastoreId: dsA, boundName: "kb" } });

    let caught: unknown;
    try {
      await db.agentDatastore.create({ data: { agentId, datastoreId: dsB, boundName: "kb" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

    // The first attachment is untouched.
    const row = await db.agentDatastore.findUnique({
      where: { agentId_datastoreId: { agentId, datastoreId: dsA } },
    });
    expect(row?.boundName).toBe("kb");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("shared datastore owner rule (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID();
  const owner = `dso-owner-${tag}`;
  const other = `dso-other-${tag}`;
  const agent = `dso-agent-${tag}`;
  const ownerless = `dso-ownerless-${tag}`;
  const own = `dso-own-${tag}`;
  const foreign = `dso-foreign-${tag}`;
  const store = new Map<string, DatastoreValue>();
  const provider = {
    getShared: async (id: string, key: string) => store.get(`${id}:${key}`),
    setShared: async (id: string, key: string, value: DatastoreValue) => void store.set(`${id}:${key}`, value),
    deleteShared: async (id: string, key: string) => void store.delete(`${id}:${key}`),
    listShared: async (id: string) =>
      [...store.keys()].filter((k) => k.startsWith(`${id}:`)).map((k) => k.slice(id.length + 1)),
  } as unknown as Datastore;

  afterAll(async () => {
    await db.agentDatastore.deleteMany({ where: { agentId: { in: [agent, ownerless] } } });
    await db.datastore.deleteMany({ where: { id: { in: [own, foreign] } } });
    await db.agent.deleteMany({ where: { id: { in: [agent, ownerless] } } });
    await db.principal.deleteMany({ where: { id: { in: [owner, other] } } });
    await db.$disconnect();
  });

  it("A2/S2-2: cross-owner binding is inert at run time; the owner's own binding works", async () => {
    await db.principal.createMany({
      data: [
        { id: owner, subject: owner },
        { id: other, subject: other },
      ],
    });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await db.agent.create({ data: { id: ownerless, name: ownerless, systemPrompt: "t", model: "t", budgetUsd: 1 } });
    await db.datastore.create({ data: { id: own, name: own, ownerId: owner } });
    await db.datastore.create({ data: { id: foreign, name: foreign, ownerId: other } });
    await db.agentDatastore.createMany({
      data: [
        { agentId: agent, datastoreId: own, boundName: "own" },
        { agentId: agent, datastoreId: foreign, boundName: "foreign" },
        { agentId: ownerless, datastoreId: own, boundName: "own" },
      ],
    });
    store.set(`${foreign}:k`, "other's data");

    const accessor = buildSharedDatastoreAccessor(agent, provider, db);
    await accessor.set("own", "k", "mine");
    expect(await accessor.get("own", "k")).toBe("mine");
    expect(await accessor.get("foreign", "k")).toBeUndefined();
    expect(await accessor.list("foreign")).toEqual([]);
    await expect(accessor.set("foreign", "k", "x")).rejects.toThrow("datastore_not_bound");
    await accessor.delete("foreign", "k");
    expect(store.get(`${foreign}:k`)).toBe("other's data");

    const orphan = buildSharedDatastoreAccessor(ownerless, provider, db);
    expect(await orphan.get("own", "k")).toBeUndefined();
  });
});
