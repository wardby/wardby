import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "./builtins.js";
import {
  CodingServiceDefinitionSchema,
  catalogEntryFromRow,
  parseAllowedServiceNames,
  parseStoredServices,
  resolvedFromDefinition,
  storedServiceLabels,
  storedServiceNames,
  workerServices,
} from "./catalog.js";

const postgres16 = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!;

describe("built-in coding services", () => {
  it("ships postgres 15, 16 and 17, redis 7 and mysql 8", () => {
    expect(BUILTIN_CODING_SERVICES.map((s) => `${s.name} ${s.version}`)).toEqual([
      "postgres 15",
      "postgres 16",
      "postgres 17",
      "redis 7",
      "mysql 8",
    ]);
  });

  it("are valid catalog entries, pinned to an official image digest, probing and pointing at 127.0.0.1", () => {
    for (const service of BUILTIN_CODING_SERVICES) {
      expect(CodingServiceDefinitionSchema.parse(service)).toEqual(service);
      expect(service.image).toMatch(/^docker\.io\/(library\/(postgres|mysql)|valkey\/valkey)@sha256:[a-f0-9]{64}$/);
      expect(service.readiness.command).toContain("127.0.0.1");
      expect(Object.values(service.testEnv).join(" ")).not.toContain("localhost");
    }
  });

  it("keep Postgres's data in a subdirectory of its volume and give it its socket and /tmp directories", () => {
    expect(postgres16.serviceEnv.PGDATA).toBe("/var/lib/postgresql/data/pgdata");
    expect(postgres16.dataPath).toBe("/var/lib/postgresql/data");
    expect(postgres16.writablePaths).toEqual(["/var/run/postgresql", "/tmp"]);
    expect(postgres16.testEnv.DATABASE_URL).toBe("postgres://test:test@127.0.0.1:5432/test");
  });
});

describe("CodingServiceDefinitionSchema", () => {
  it.each([
    ["an image tag instead of a digest", { image: "postgres:16" }],
    ["the reserved external kind", { kind: "external" }],
    ["a reserved test variable", { testEnv: { PATH: "/tmp" } }],
    ["a relative data path", { dataPath: "var/lib/postgresql/data" }],
    ["a data path under /proc", { dataPath: "/proc/data" }],
    ["a traversal component", { dataPath: "/var/../etc" }],
    ["a writable path inside the data path", { writablePaths: ["/var/lib/postgresql/data/run"] }],
    ["five writable paths", { writablePaths: ["/a", "/b", "/c", "/d", "/e"] }],
    ["an unknown key", { command: ["postgres"] }],
    ["an empty readiness command", { readiness: { ...postgres16.readiness, command: [] } }],
    ["too much CPU", { resources: { ...postgres16.resources, cpuMillicores: 64_000 } }],
    ["a bad name", { name: "Postgres" }],
    ["a bad version", { version: "16 beta" }],
    ["a multi-line service variable", { serviceEnv: { POSTGRES_USER: "a\nb" } }],
  ])("rejects %s", (_label, patch) => {
    expect(CodingServiceDefinitionSchema.safeParse({ ...postgres16, ...patch }).success).toBe(false);
  });

  it("defaults kind, environments and writable paths", () => {
    const { kind: _kind, serviceEnv: _s, testEnv: _t, writablePaths: _w, ...minimal } = postgres16;
    expect(CodingServiceDefinitionSchema.parse(minimal)).toMatchObject({
      kind: "sidecar",
      serviceEnv: {},
      testEnv: {},
      writablePaths: [],
    });
  });
});

describe("stored services", () => {
  const resolved = resolvedFromDefinition(postgres16);

  it("snapshots an entry without its kind and parses it back", () => {
    expect(resolved).not.toHaveProperty("kind");
    expect(parseStoredServices([resolved])).toEqual([resolved]);
    expect(parseStoredServices(null)).toEqual([]);
    expect(parseStoredServices([])).toEqual([]);
    expect(() => parseStoredServices([{ ...resolved, image: "postgres:16" }])).toThrow();
  });

  it("reads names and labels leniently, for wording only", () => {
    expect(storedServiceNames([resolved, { name: "Bad Name" }, 3])).toEqual(["postgres"]);
    expect(storedServiceLabels([resolved, { name: "redis" }])).toEqual(["postgres 16"]);
    expect(storedServiceNames("nonsense")).toEqual([]);
  });

  it("hands the worker only name, version and test variables", () => {
    expect(workerServices([resolved])).toEqual([{ name: "postgres", version: "16", testEnv: postgres16.testEnv }]);
  });
});

describe("parseAllowedServiceNames", () => {
  it("dedupes names and treats a missing value as none", () => {
    expect(parseAllowedServiceNames(["postgres", "redis", "postgres"])).toEqual(["postgres", "redis"]);
    expect(parseAllowedServiceNames(undefined)).toEqual([]);
  });

  it("refuses a malformed name", () => {
    expect(() => parseAllowedServiceNames(["Postgres"])).toThrow();
  });
});

describe("catalogEntryFromRow", () => {
  it("maps a row to its definition", () => {
    expect(catalogEntryFromRow({ ...postgres16 })).toEqual(postgres16);
  });

  it("refuses a row edited out of shape, naming only the entry", () => {
    expect(() => catalogEntryFromRow({ ...postgres16, readiness: { command: "pg_isready" } })).toThrow(
      "coding_service_catalog_invalid:postgres 16",
    );
  });
});
