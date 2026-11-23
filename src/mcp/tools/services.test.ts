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
      substrateImage: BUILTIN_CODING_SERVICES[1].substrateImage,
      port: 5432,
      builtin: true,
    });
    expect(listed.find((entry: { name: string }) => entry.name === "redis")).not.toHaveProperty("substrateImage");
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

  it("creates a docker entry from its image and resources alone, and refuses a sidecar's fields on it", async () => {
    const DOCKER = {
      name: "docker",
      version: "29",
      kind: "docker",
      image: `registry.example/wardby-docker-service@sha256:${"d".repeat(64)}`,
      resources: { cpuMillicores: 1000, memoryMib: 2048, diskMib: 4096 },
    };
    const { client, rows } = await connect(ADMIN);
    const refused = await client.callTool({ name: "create_service", arguments: { ...DOCKER, port: 2375 } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("port");

    const created = await client.callTool({ name: "create_service", arguments: DOCKER });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({
      ...DOCKER,
      testEnv: { DOCKER_HOST: "unix:///wardby/docker/docker.sock" },
      builtin: false,
    });
    // Only the entry's own fields are written: the other columns keep the table's defaults.
    expect(Object.keys(rows.get("docker 29")!).sort()).toEqual(
      [
        "builtin",
        "createdAt",
        "createdById",
        "id",
        "image",
        "kind",
        "name",
        "resources",
        "updatedAt",
        "version",
      ].sort(),
    );

    const got = JSON.parse(
      text(await client.callTool({ name: "get_service", arguments: { name: "docker", version: "29" } })),
    );
    expect(got).not.toHaveProperty("port");
    expect(got).not.toHaveProperty("readiness");
    const listed = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} }))) as Array<
      Record<string, unknown>
    >;
    const entry = listed.find((row) => row.name === "docker")!;
    expect(entry).toMatchObject({ kind: "docker", image: DOCKER.image });
    expect(entry).not.toHaveProperty("port");

    const resized = await client.callTool({
      name: "update_service",
      arguments: { name: "docker", version: "29", resources: { cpuMillicores: 2000, memoryMib: 4096, diskMib: 8192 } },
    });
    expect(resized.isError).toBeFalsy();
    expect(rows.get("docker 29")).toMatchObject({ resources: { cpuMillicores: 2000, memoryMib: 4096, diskMib: 8192 } });
    const withEnv = await client.callTool({
      name: "update_service",
      arguments: { name: "docker", version: "29", serviceEnv: { DOCKER_TLS_CERTDIR: "" } },
    });
    expect(withEnv.isError).toBe(true);
    expect(rows.get("docker 29")).not.toHaveProperty("serviceEnv");
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
    expect(text(refused)).toContain("startCommand.0: must be one line of at most 4096 bytes");
    expect(rows.get("postgres-postgis 16")?.startCommand).toEqual(["serve", "--port", "1"]);
    await client.close();
  });

  const TOOLCHAIN = {
    name: "python-dev",
    version: "3.13",
    kind: "toolchain",
    image: `registry.example/team/python-dev@sha256:${"d".repeat(64)}`,
    serviceEnv: { APP_CONFIG: "/home/wardby/app.ini" },
    testEnv: { APP_ENV: "test" },
    resources: { cpuMillicores: 1000, memoryMib: 2048, diskMib: 1024 },
    setupCommand: ["/bin/sh", "-c", "render-config > /home/wardby/app.ini"],
  };

  it("creates a toolchain without a sidecar's fields, lists it with its note and changes its setup command", async () => {
    const { client, rows } = await connect(ADMIN);
    const created = await client.callTool({ name: "create_service", arguments: TOOLCHAIN });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({
      kind: "toolchain",
      setupCommand: TOOLCHAIN.setupCommand,
      note: "Packages already in this image did not pass the proxy's checks.",
    });
    expect(rows.get("python-dev 3.13")).toMatchObject({ kind: "toolchain", builtin: false });
    expect(rows.get("python-dev 3.13")).not.toHaveProperty("port");

    const listed = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    const entry = listed.find((candidate: { name: string }) => candidate.name === "python-dev");
    expect(entry).toEqual({
      name: "python-dev",
      version: "3.13",
      kind: "toolchain",
      image: TOOLCHAIN.image,
      note: "Packages already in this image did not pass the proxy's checks.",
      builtin: false,
    });
    expect(listed.find((candidate: { name: string }) => candidate.name === "redis")).not.toHaveProperty("note");
    const shown = JSON.parse(
      text(await client.callTool({ name: "get_service", arguments: { name: "python-dev", version: "3.13" } })),
    );
    expect(shown.note).toBe("Packages already in this image did not pass the proxy's checks.");

    const updated = await client.callTool({
      name: "update_service",
      arguments: { name: "python-dev", version: "3.13", setupCommand: ["true"] },
    });
    expect(updated.isError).toBeFalsy();
    expect(rows.get("python-dev 3.13")?.setupCommand).toEqual(["true"]);
    await client.close();
  });

  it.each([
    ["dataPath", { dataPath: "/data" }],
    ["readiness", { readiness: CUSTOM.readiness }],
    ["port", { port: 8000 }],
    ["startCommand", { startCommand: ["serve"] }],
  ])("refuses a toolchain with %s, naming the field", async (field, patch) => {
    const { client, rows } = await connect(ADMIN);
    const refused = await client.callTool({ name: "create_service", arguments: { ...TOOLCHAIN, ...patch } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(`${field}: is not used by a toolchain`);
    expect(rows.has("python-dev 3.13")).toBe(false);
    await client.close();
  });

  it("refuses a setup command on a sidecar, and a change of kind", async () => {
    const { client } = await connect(ADMIN);
    const refused = await client.callTool({
      name: "create_service",
      arguments: { ...CUSTOM, setupCommand: ["true"] },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("setupCommand: is only for a toolchain");
    expect((await client.callTool({ name: "create_service", arguments: TOOLCHAIN })).isError).toBeFalsy();
    const kindChange = await client.callTool({
      name: "update_service",
      arguments: { name: "python-dev", version: "3.13", kind: "sidecar" },
    });
    expect(kindChange.isError).toBe(true);
    await client.close();
  });

  const SETUP = {
    name: "app-migrations",
    version: "1",
    kind: "setup",
    image: `registry.example/team/liquibase@sha256:${"e".repeat(64)}`,
    command: ["liquibase", "--changelog-file=db/changelog.xml", "update"],
    waitFor: ["mysql"],
    serviceEnv: { LIQUIBASE_COMMAND_PASSWORD: "throwaway-admin" },
    resources: { cpuMillicores: 1000, memoryMib: 1024, diskMib: 256 },
    writablePaths: ["/tmp"],
  };

  it("creates a setup job (#589) with its default timeout, lists and shows it, and changes its fields", async () => {
    const { client, rows } = await connect(ADMIN);
    const created = await client.callTool({ name: "create_service", arguments: SETUP });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({
      kind: "setup",
      command: SETUP.command,
      waitFor: ["mysql"],
      timeoutSeconds: 600,
      builtin: false,
    });
    expect(rows.get("app-migrations 1")).toMatchObject({ kind: "setup", timeoutSeconds: 600, testEnv: {} });
    expect(rows.get("app-migrations 1")).not.toHaveProperty("port");

    const listed = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    expect(listed.find((candidate: { name: string }) => candidate.name === "app-migrations")).toEqual({
      name: "app-migrations",
      version: "1",
      kind: "setup",
      image: SETUP.image,
      waitFor: ["mysql"],
      builtin: false,
    });
    expect(listed.find((candidate: { name: string }) => candidate.name === "redis")).not.toHaveProperty("waitFor");
    const shown = JSON.parse(
      text(await client.callTool({ name: "get_service", arguments: { name: "app-migrations", version: "1" } })),
    );
    expect(shown).toMatchObject({ command: SETUP.command, waitFor: ["mysql"], timeoutSeconds: 600 });
    expect(shown).not.toHaveProperty("note");

    const updated = await client.callTool({
      name: "update_service",
      arguments: {
        name: "app-migrations",
        version: "1",
        command: ["migrate"],
        waitFor: ["mysql", "redis"],
        timeoutSeconds: 1200,
      },
    });
    expect(updated.isError).toBeFalsy();
    expect(rows.get("app-migrations 1")).toMatchObject({
      command: ["migrate"],
      waitFor: ["mysql", "redis"],
      timeoutSeconds: 1200,
    });
    const tooLong = await client.callTool({
      name: "update_service",
      arguments: { name: "app-migrations", version: "1", timeoutSeconds: 3601 },
    });
    expect(tooLong.isError).toBe(true);
    expect(text(tooLong)).toContain("timeoutSeconds");
    expect(rows.get("app-migrations 1")?.timeoutSeconds).toBe(1200);
    await client.close();
  });

  it.each([
    ["dataPath", { dataPath: "/data" }],
    ["readiness", { readiness: CUSTOM.readiness }],
    ["port", { port: 8000 }],
    ["startCommand", { startCommand: ["serve"] }],
    ["setupCommand", { setupCommand: ["true"] }],
    ["hostAliases", { hostAliases: ["db"] }],
    ["testEnv", { testEnv: { DATABASE_URL: "mysql://127.0.0.1/test" } }],
  ])("refuses a setup job with %s, naming the field", async (field, patch) => {
    const { client, rows } = await connect(ADMIN);
    const refused = await client.callTool({ name: "create_service", arguments: { ...SETUP, ...patch } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain(`${field}: is not used by a setup job`);
    expect(rows.has("app-migrations 1")).toBe(false);
    await client.close();
  });

  it("requires a setup job's command and waitFor, and refuses them on a sidecar", async () => {
    const { client } = await connect(ADMIN);
    const { command: _command, ...withoutCommand } = SETUP;
    expect(text(await client.callTool({ name: "create_service", arguments: withoutCommand }))).toContain("command");
    const { waitFor: _waitFor, ...withoutWaitFor } = SETUP;
    expect(text(await client.callTool({ name: "create_service", arguments: withoutWaitFor }))).toContain("waitFor");
    const onSidecar = await client.callTool({ name: "create_service", arguments: { ...CUSTOM, command: ["x"] } });
    expect(onSidecar.isError).toBe(true);
    expect(text(onSidecar)).toContain("command: is only for a setup job");
    await client.close();
  });

  it("refuses setup fields from a member without services:manage", async () => {
    const { client, rows } = await connect(MEMBER);
    const refused = await client.callTool({ name: "create_service", arguments: SETUP });
    expect(refused.isError).toBe(true);
    expect(rows.has("app-migrations 1")).toBe(false);
    await client.close();
  });

  it("still requires a sidecar's port, readiness and data path", async () => {
    const { client } = await connect(ADMIN);
    const { dataPath: _dataPath, ...withoutData } = CUSTOM;
    const refused = await client.callTool({ name: "create_service", arguments: withoutData });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("dataPath");
    await client.close();
  });

  it("describes startCommand and substrateImage in both input schemas", async () => {
    const { client } = await connect(ADMIN);
    const { tools } = await client.listTools();
    for (const name of ["create_service", "update_service"]) {
      const tool = tools.find((candidate) => candidate.name === name);
      const properties = tool?.inputSchema.properties as Record<string, { description?: string }> | undefined;
      expect(properties?.startCommand?.description).toContain("Substrate");
      expect(properties?.substrateImage?.description).toContain("Substrate");
      expect(properties?.substrateImage?.description).toContain("startCommand");
    }
    await client.close();
  });

  const SUBSTRATE_IMAGE = `registry.example/postgis-nonroot@sha256:${"c".repeat(64)}`;

  it("round-trips a Substrate image through create, get, list and update, auditing it", async () => {
    logged.length = 0;
    const { client, rows } = await connect(ADMIN);
    const created = await client.callTool({
      name: "create_service",
      arguments: { ...CUSTOM, substrateImage: SUBSTRATE_IMAGE, startCommand: ["/bin/sh", "-c", "exec fakedb-serve"] },
    });
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(text(created))).toMatchObject({ substrateImage: SUBSTRATE_IMAGE, image: CUSTOM.image });
    expect(rows.get("postgres-postgis 16")?.substrateImage).toBe(SUBSTRATE_IMAGE);

    const shown = JSON.parse(
      text(await client.callTool({ name: "get_service", arguments: { name: "postgres-postgis", version: "16" } })),
    );
    expect(shown.substrateImage).toBe(SUBSTRATE_IMAGE);
    const listed = JSON.parse(text(await client.callTool({ name: "list_services", arguments: {} })));
    expect(listed.find((entry: { name: string }) => entry.name === "postgres-postgis")).toMatchObject({
      substrateImage: SUBSTRATE_IMAGE,
    });

    const next = `registry.example/postgis-nonroot@sha256:${"e".repeat(64)}`;
    const updated = await client.callTool({
      name: "update_service",
      arguments: { name: "postgres-postgis", version: "16", substrateImage: next },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse(text(updated))).toMatchObject({ substrateImage: next });
    expect(rows.get("postgres-postgis 16")?.substrateImage).toBe(next);
    expect(
      logged
        .filter((entry) => String(entry.payload.event).startsWith("coding.service_catalog."))
        .map((entry) => entry.payload.substrateImage),
    ).toEqual([SUBSTRATE_IMAGE, next]);
    await client.close();
  });

  it.each([
    ["a tag", { substrateImage: "postgis:16", startCommand: ["serve"] }, "substrateImage: must be a registry digest"],
    [
      "no start command",
      { substrateImage: `registry.example/postgis-nonroot@sha256:${"c".repeat(64)}` },
      "startCommand: is required with substrateImage",
    ],
  ])("refuses a Substrate image with %s on create and update", async (_label, patch, message) => {
    const { client, rows } = await connect(ADMIN);
    const refusedCreate = await client.callTool({ name: "create_service", arguments: { ...CUSTOM, ...patch } });
    expect(refusedCreate.isError).toBe(true);
    expect(text(refusedCreate)).toContain(message);
    expect(rows.has("postgres-postgis 16")).toBe(false);

    expect((await client.callTool({ name: "create_service", arguments: CUSTOM })).isError).toBeFalsy();
    const refusedUpdate = await client.callTool({
      name: "update_service",
      arguments: { name: "postgres-postgis", version: "16", ...patch },
    });
    expect(refusedUpdate.isError).toBe(true);
    expect(text(refusedUpdate)).toContain(message);
    expect(rows.get("postgres-postgis 16")).not.toHaveProperty("substrateImage");
    await client.close();
  });

  it("refuses a Substrate image from a member without services:manage", async () => {
    const { client, rows } = await connect(MEMBER);
    const result = await client.callTool({
      name: "update_service",
      arguments: { name: "postgres", version: "16", substrateImage: SUBSTRATE_IMAGE },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Insufficient scope; this operation requires: services:manage/);
    expect(rows.get("postgres 16")?.substrateImage).toBe(BUILTIN_CODING_SERVICES[1].substrateImage);
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
