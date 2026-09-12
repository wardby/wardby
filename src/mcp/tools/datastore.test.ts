import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerDatastoreTools } from "./datastore.js";
import type { McpRequestContext } from "../context.js";
import type { DatastoreValue } from "../../providers/index.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

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

function fakeDatastore() {
  const store = new Map<string, DatastoreValue>();
  const setOpts = new Map<string, { pii?: boolean }>();
  const sharedStore = new Map<string, DatastoreValue>();
  return {
    setOpts,
    get: async (agentId: string, key: string) => store.get(`${agentId}:${key}`),
    set: async (agentId: string, key: string, value: DatastoreValue, opts?: { pii?: boolean }) => {
      store.set(`${agentId}:${key}`, value);
      if (opts) setOpts.set(`${agentId}:${key}`, opts);
    },
    delete: async (agentId: string, key: string) => {
      store.delete(`${agentId}:${key}`);
    },
    list: async (agentId: string, prefix?: string) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`${agentId}:${prefix ?? ""}`))
        .map((k) => k.slice(`${agentId}:`.length)),
    getShared: async (datastoreId: string, key: string) => sharedStore.get(`${datastoreId}:${key}`),
    setShared: async (datastoreId: string, key: string, value: DatastoreValue) => {
      sharedStore.set(`${datastoreId}:${key}`, value);
    },
    deleteShared: async (datastoreId: string, key: string) => {
      sharedStore.delete(`${datastoreId}:${key}`);
    },
    listShared: async (datastoreId: string, prefix?: string) =>
      [...sharedStore.keys()]
        .filter((k) => k.startsWith(`${datastoreId}:${prefix ?? ""}`))
        .map((k) => k.slice(`${datastoreId}:`.length)),
  };
}

function fakeDb(agents: FakeAgentRow[]) {
  const rows = new Map(agents.map((a) => [a.id, a]));
  const datastores = new Map<string, FakeDatastoreRow>();
  const agentDatastores: FakeAgentDatastoreRow[] = [];
  let counter = 0;
  return {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
    },
    datastore: {
      create: async ({ data }: { data: Partial<FakeDatastoreRow> & { name: string } }) => {
        const now = new Date();
        const row: FakeDatastoreRow = {
          id: `ds_${++counter}`,
          createdAt: now,
          updatedAt: now,
          ownerId: null,
          ...data,
        };
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
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  datastore: ReturnType<typeof fakeDatastore>,
  principalId: string,
  scopes: string[],
): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    providers: { datastore } as unknown as import("../../providers/index.js").ProviderRegistry,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("datastore tools", () => {
  it("datastore_set (datastore:write) then datastore_get (agents:read) round-trip for the owner", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const setResult = await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1" },
    });
    expect(setResult.isError).toBeFalsy();

    const getResult = await client.callTool({ name: "datastore_get", arguments: { agentId: "a1", key: "k1" } });
    expect(getResult.isError).toBeFalsy();
    expect(parseText(getResult as never)).toEqual({ value: "v1" });
    await client.close();
  });

  it("datastore_set passes a pii:true flag through to the underlying store", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "datastore_set", arguments: { agentId: "a1", key: "k1", value: "v1", pii: true } });
    expect(datastore.setOpts.get("a1:k1")).toEqual({ pii: true });
    await client.close();
  });

  it("datastore_set requires datastore:write, not agents:read", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  it("datastore access to another owner's agent is not found (no cross-agent leakage)", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "owner-1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "not-the-owner", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const getResult = await client.callTool({ name: "datastore_get", arguments: { agentId: "a1", key: "k1" } });
    expect(getResult.isError).toBe(true);

    const setResult = await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1" },
    });
    expect(setResult.isError).toBe(true);
    await client.close();
  });

  it("a public (ownerId: null) agent's datastore is readable and writable by any principal", async () => {
    const db = fakeDb([{ id: "a1", ownerId: null }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "anyone", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const getResult = await client.callTool({ name: "datastore_get", arguments: { agentId: "a1", key: "k1" } });
    expect(getResult.isError).toBeFalsy();

    const listResult = await client.callTool({ name: "datastore_list", arguments: { agentId: "a1" } });
    expect(listResult.isError).toBeFalsy();

    const setResult = await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1" },
    });
    expect(setResult.isError).toBeFalsy();

    const deleteResult = await client.callTool({ name: "datastore_delete", arguments: { agentId: "a1", key: "k1" } });
    expect(deleteResult.isError).toBeFalsy();
    await client.close();
  });

  it("datastore_delete removes a key, and datastore_list reflects it", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "datastore_set", arguments: { agentId: "a1", key: "k1", value: "v1" } });
    const listed = await client.callTool({ name: "datastore_list", arguments: { agentId: "a1" } });
    expect(parseText(listed as never)).toEqual(["k1"]);

    await client.callTool({ name: "datastore_delete", arguments: { agentId: "a1", key: "k1" } });
    const listedAfter = await client.callTool({ name: "datastore_list", arguments: { agentId: "a1" } });
    expect(parseText(listedAfter as never)).toEqual([]);
    await client.close();
  });
});

describe("shared datastore tools", () => {
  it("create_datastore then attach_datastore then datastore_set/datastore_get with boundName round-trip", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_datastore", arguments: { name: "shared-kb" } });
    const { id: datastoreId } = parseText(created as never) as { id: string };

    const attached = await client.callTool({
      name: "attach_datastore",
      arguments: { agentId: "a1", datastoreId },
    });
    expect(attached.isError).toBeFalsy();

    const setResult = await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1", boundName: "shared-kb" },
    });
    expect(setResult.isError).toBeFalsy();

    const getResult = await client.callTool({
      name: "datastore_get",
      arguments: { agentId: "a1", key: "k1", boundName: "shared-kb" },
    });
    expect(parseText(getResult as never)).toEqual({ value: "v1" });
    await client.close();
  });

  it("attach_datastore requires owning both the datastore and the agent", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_datastore", arguments: { name: "shared-kb" } });
    const { id: datastoreId } = parseText(created as never) as { id: string };

    mcp.setFixedContext(fakeCtx(db, datastore, "not-the-owner", ["agents:read", "datastore:write"]));
    const attached = await client.callTool({ name: "attach_datastore", arguments: { agentId: "a1", datastoreId } });
    expect(attached.isError).toBe(true);
    await client.close();
  });

  it("detach_datastore removes access, then datastore_get with boundName returns null", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_datastore", arguments: { name: "shared-kb" } });
    const { id: datastoreId } = parseText(created as never) as { id: string };
    await client.callTool({ name: "attach_datastore", arguments: { agentId: "a1", datastoreId } });
    await client.callTool({
      name: "datastore_set",
      arguments: { agentId: "a1", key: "k1", value: "v1", boundName: "shared-kb" },
    });

    await client.callTool({ name: "detach_datastore", arguments: { agentId: "a1", boundName: "shared-kb" } });
    const getResult = await client.callTool({
      name: "datastore_get",
      arguments: { agentId: "a1", key: "k1", boundName: "shared-kb" },
    });
    expect(parseText(getResult as never)).toEqual({ value: null });
    await client.close();
  });

  it("list_datastores then delete_datastore", async () => {
    const db = fakeDb([]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    const created = await client.callTool({ name: "create_datastore", arguments: { name: "shared-kb" } });
    const { id } = parseText(created as never) as { id: string };

    const listed = await client.callTool({ name: "list_datastores", arguments: {} });
    expect((parseText(listed as never) as { name: string }[]).map((d) => d.name)).toEqual(["shared-kb"]);

    await client.callTool({ name: "delete_datastore", arguments: { id } });
    const listedAfter = await client.callTool({ name: "list_datastores", arguments: {} });
    expect(parseText(listedAfter as never)).toEqual([]);
    await client.close();
  });

  it("datastore_get/datastore_set without boundName are unaffected (still private, per-agent)", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const datastore = fakeDatastore();
    const mcp = buildMcpServer({ providers: { datastore } as never, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, datastore, "p1", ["agents:read", "datastore:write"]));
    registerDatastoreTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "datastore_set", arguments: { agentId: "a1", key: "k1", value: "private-v" } });
    const getResult = await client.callTool({ name: "datastore_get", arguments: { agentId: "a1", key: "k1" } });
    expect(parseText(getResult as never)).toEqual({ value: "private-v" });
    await client.close();
  });
});
