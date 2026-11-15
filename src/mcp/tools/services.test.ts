import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { registerServiceTools } from "./services.js";

const logged = vi.hoisted(() => [] as { level: string; payload: Record<string, unknown>; message: string }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (payload: Record<string, unknown>, message?: string): void => {
        logged.push({ level, payload, message: message ?? "" });
      };
    return {
      child: () => make(),
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      fatal: at("fatal"),
    };
  };
  return { logger: make() };
});

const CANONICAL_URI = "https://host/mcp";
const ADMIN = { scopes: ["agents:read", "agents:write", "services:manage"], roles: ["admin"] };
const SERVICE_MANAGER = { scopes: ["agents:read", "services:manage"], roles: ["service-manager"] };
const MEMBER = { scopes: ["agents:read", "agents:write"], roles: [] as string[] };
const READER = { scopes: ["agents:read"], roles: [] as string[] };
/** Holds the scope on its token but no role granting it: scopes only delegate. */
const UNROLED = { scopes: ["agents:read", "services:manage"], roles: [] as string[] };
const CUSTOM = {
  name: "postgres-postgis",
  version: "16",
  image: `registry.example/postgis@sha256:${"b".repeat(64)}`,
  port: 5432,
  serviceEnv: {
    POSTGRES_USER: "test",
    POSTGRES_PASSWORD: "test",
    POSTGRES_DB: "test",
    PGDATA: "/var/lib/postgresql/data/pgdata",
  },
  testEnv: { DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test" },
  readiness: { command: ["pg_isready", "-h", "127.0.0.1"], periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 },
  resources: { cpuMillicores: 500, memoryMib: 512, diskMib: 1024 },
  dataPath: "/var/lib/postgresql/data",
  writablePaths: ["/var/run/postgresql", "/tmp"],
};

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>(
    BUILTIN_CODING_SERVICES.map((service) => [
      `${service.name} ${service.version}`,
      {
        id: `builtin-${service.name}-${service.version}`,
        ...service,
        builtin: true,
        createdById: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]),
  );
  const keyOf = (where: { name_version: { name: string; version: string } }) =>
    `${where.name_version.name} ${where.name_version.version}`;
  const codingService = {
    findMany: async () => [...rows.values()],
    findUnique: async ({ where }: { where: { name_version: { name: string; version: string } } }) =>
      rows.get(keyOf(where)) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `svc_${rows.size + 1}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.set(`${String(data.name)} ${String(data.version)}`, row);
      return row;
    },
    update: async ({
      where,
      data,
    }: {
      where: { name_version: { name: string; version: string } };
      data: Record<string, unknown>;
    }) => {
      const row = { ...rows.get(keyOf(where))!, ...data, updatedAt: new Date() };
      rows.set(keyOf(where), row);
      return row;
    },
    delete: async ({ where }: { where: { name_version: { name: string; version: string } } }) => {
      const row = rows.get(keyOf(where));
      rows.delete(keyOf(where));
      return row;
    },
  };
  return { db: { codingService } as unknown as import("#prisma").PrismaClient, rows };
}

async function connect(who: { scopes: string[]; roles: string[] }) {
  const { db, rows } = fakeDb();
  const mcp = buildMcpServer({
    providers: {} as McpRequestContext["providers"],
    db,
    config: { canonicalUri: CANONICAL_URI },
  });
  mcp.setFixedContext({
    principal: { id: "p-admin", subject: "p-admin", createdAt: new Date() },
    scopes: new Set(who.scopes),
    roles: who.roles,
    canonicalUri: CANONICAL_URI,
    providers: {} as McpRequestContext["providers"],
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerServiceTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, rows };
}

const text = (result: { content: unknown }) => (result.content as { text: string }[])[0].text;

describe("coding service catalog tools", () => {
  const KEY = { name: "postgres", version: "16" };
  it("lets anyone with agents:read list the catalog and read an entry, so owners see what they may allow", async () => {
    const { client } = await connect(READER);
    const listed = await client.callTool({ name: "list_services", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(JSON.parse(text(listed))).toHaveLength(BUILTIN_CODING_SERVICES.length);
    const shown = await client.callTool({ name: "get_service", arguments: KEY });
    expect(shown.isError).toBeFalsy();
    expect(JSON.parse(text(shown))).toMatchObject({
      name: "postgres",
      version: "16",
      testEnv: { PGHOST: "127.0.0.1" },
    });
    await client.close();
  });

  it("reading needs at least agents:read", async () => {
    const { client } = await connect({ scopes: [], roles: [] });
    const result = await client.callTool({ name: "list_services", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Insufficient scope/);
    await client.close();
  });

  const WRITES: Array<[string, Record<string, unknown>]> = [
    ["create_service", CUSTOM],
    ["update_service", { ...KEY, port: 5433 }],
    ["delete_service", KEY],
  ];

  it.each(WRITES)("%s needs the services:manage scope: readers and members are refused", async (name, args) => {
    for (const who of [READER, MEMBER]) {
      const { client, rows } = await connect(who);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/Insufficient scope; this operation requires: services:manage/);
      expect(rows.get("postgres 16")).toMatchObject({ port: 5432 });
      expect(rows.has("postgres-postgis 16")).toBe(false);
      await client.close();
    }
  });

  it.each(WRITES)("%s needs a role granting services:manage, not just the scope", async (name, args) => {
    const { client } = await connect(UNROLED);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/requires a role that grants it/);
    await client.close();
  });

  it("lets a service-manager, not only an admin, change the catalog", async () => {
    const { client, rows } = await connect(SERVICE_MANAGER);
    const created = await client.callTool({ name: "create_service", arguments: CUSTOM });
    expect(created.isError).toBeFalsy();
    expect(rows.get("postgres-postgis 16")).toMatchObject({ builtin: false, createdById: "p-admin" });
    await client.close();
  });

  it("lists the catalog, built-ins included, and shows an entry's test variables", async () => {
    const { client } = await connect(ADMIN);
    const listed = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    expect(listed).toContainEqual({
      name: "postgres",
      version: "16",
      kind: "sidecar",
      image: BUILTIN_CODING_SERVICES[1].image,
      port: 5432,
      builtin: true,
    });
    const shown = JSON.parse(
      text(await client.callTool({ name: "get_service", arguments: { name: "postgres", version: "16" } })),
    );
    expect(shown).toMatchObject({
      builtin: true,
      testEnv: { DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test" },
    });
    await client.close();
  });

  it("creates, updates and deletes an entry, auditing each change", async () => {
    logged.length = 0;
    const { client, rows } = await connect(ADMIN);
    const created = await client.callTool({
      name: "create_service",
      arguments: { ...CUSTOM, startCommand: ["fakedb-serve"] },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({ startCommand: ["fakedb-serve"] });
    expect(rows.get("postgres-postgis 16")).toMatchObject({ builtin: false, createdById: "p-admin", kind: "sidecar" });

    const updated = await client.callTool({
      name: "update_service",
      arguments: {
        name: "postgres-postgis",
        version: "16",
        resources: { cpuMillicores: 1000, memoryMib: 1024, diskMib: 2048 },
      },
    });
    expect(updated.isError).toBeFalsy();
    expect(rows.get("postgres-postgis 16")).toMatchObject({
      resources: { cpuMillicores: 1000, memoryMib: 1024, diskMib: 2048 },
      image: CUSTOM.image,
    });

    const deleted = await client.callTool({
      name: "delete_service",
      arguments: { name: "postgres-postgis", version: "16" },
    });
    expect(deleted.isError).toBeFalsy();
    expect(rows.has("postgres-postgis 16")).toBe(false);

    expect(
      logged
        .filter((entry) => String(entry.payload.event).startsWith("coding.service_catalog."))
        .map((entry) => entry.payload),
    ).toEqual([
      {
        event: "coding.service_catalog.create",
        name: "postgres-postgis",
        version: "16",
        image: CUSTOM.image,
        by: "p-admin",
      },
      {
        event: "coding.service_catalog.update",
        name: "postgres-postgis",
        version: "16",
        image: CUSTOM.image,
        by: "p-admin",
      },
      { event: "coding.service_catalog.delete", name: "postgres-postgis", version: "16", by: "p-admin" },
    ]);
    await client.close();
  });

  it("sets and changes a start command with update_service, and validates it", async () => {
    const { client, rows } = await connect(ADMIN);
    const created = await client.callTool({ name: "create_service", arguments: CUSTOM });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).not.toHaveProperty("startCommand");

    const updated = await client.callTool({
      name: "update_service",
      arguments: { name: "postgres-postgis", version: "16", startCommand: ["serve", "--port", "1"] },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse(text(updated))).toMatchObject({ startCommand: ["serve", "--port", "1"] });
    expect(rows.get("postgres-postgis 16")?.startCommand).toEqual(["serve", "--port", "1"]);

    const refused = await client.callTool({
      name: "update_service",
      arguments: { name: "postgres-postgis", version: "16", startCommand: ["a\nb"] },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("startCommand.0: must be one line of at most 256 bytes");
    expect(rows.get("postgres-postgis 16")?.startCommand).toEqual(["serve", "--port", "1"]);
    await client.close();
  });

  it("describes startCommand in both input schemas", async () => {
    const { client } = await connect(ADMIN);
    const { tools } = await client.listTools();
    for (const name of ["create_service", "update_service"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      const properties = tool?.inputSchema.properties as Record<string, { description?: string }> | undefined;
      expect(properties?.startCommand?.description).toContain("Substrate");
    }
    await client.close();
  });

  it.each([
    ["an image tag", { ...CUSTOM, image: "postgres:16" }, /image/],
    ["the reserved external kind", { ...CUSTOM, kind: "external" }, /kind/],
    ["a reserved test variable", { ...CUSTOM, testEnv: { PATH: "/tmp" } }, /testEnv/],
    ["an entry that already exists", { ...CUSTOM, name: "postgres", version: "16" }, /already has "postgres 16"/],
  ])("refuses to create one with %s", async (_label, args, message) => {
    const { client } = await connect(ADMIN);
    const result = await client.callTool({ name: "create_service", arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    await client.close();
  });

  it.each([
    ["update_service", { name: "postgres", version: "16", port: 5433 }],
    ["delete_service", { name: "postgres", version: "16" }],
  ])("%s leaves a built-in alone", async (name, args) => {
    const { client, rows } = await connect(ADMIN);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/built in/);
    expect(rows.get("postgres 16")).toMatchObject({ port: 5432 });
    await client.close();
  });

  it("says which entry is missing", async () => {
    const { client } = await connect(ADMIN);
    const result = await client.callTool({ name: "get_service", arguments: { name: "postgres", version: "99" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No coding service "postgres 99"/);
    await client.close();
  });
});
