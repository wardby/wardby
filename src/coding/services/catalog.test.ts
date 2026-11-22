import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { BUILTIN_CODING_SERVICES, MYSQL_SUBSTRATE_SCRIPT, POSTGRES_SUBSTRATE_SCRIPT } from "./builtins.js";
import {
  CodingServiceDefinitionSchema,
  StoredCodingServicesSchema,
  catalogEntryFromRow,
  parseAllowedServiceNames,
  parseStoredServices,
  resolvedFromDefinition,
  storedServiceLabels,
  storedServiceNames,
  substrateServiceImage,
  workerServices,
} from "./catalog.js";

const postgres16 = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!;

/** A team's dev image as a toolchain entry. */
const PYTHON_DEV = {
  name: "python-dev",
  version: "3.13",
  kind: "toolchain" as const,
  image: `registry.example/team/python-dev@sha256:${"d".repeat(64)}`,
  serviceEnv: { APP_CONFIG: "/home/wardby/app.ini" },
  testEnv: { APP_ENV: "test" },
  resources: { cpuMillicores: 1000, memoryMib: 2048, diskMib: 1024 },
  writablePaths: ["/tmp"],
  setupCommand: ["/bin/sh", "-c", "render-config > /home/wardby/app.ini"],
};

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
      expect(service.kind).toBe("sidecar");
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

  it("run a non-root image on Substrate for postgres and mysql, each started by its own script", () => {
    const cnpg: Record<string, string> = {
      "15": "sha256:11274300143f02d369ea2ff6082b028b6b662915f06bf59f26b808b53823475a",
      "16": "sha256:34cd4159d07b3410a1b29da35072e2e927a0905e717a61afa3814624a2e8859a",
      "17": "sha256:70664ebcfa1100361b5bdc28bbf06fdbe08db2dc4ad7bd14de33c5e05fe8ea8e",
    };
    for (const service of BUILTIN_CODING_SERVICES) {
      if (service.name === "postgres") {
        expect(service.substrateImage).toBe(`ghcr.io/cloudnative-pg/postgresql@${cnpg[service.version]}`);
        expect(service.startCommand).toEqual(["/bin/sh", "-c", POSTGRES_SUBSTRATE_SCRIPT]);
      } else if (service.name === "mysql") {
        expect(service.substrateImage).toBe(
          "docker.io/percona/percona-server@sha256:e95917e6dc1242a773e35a1d93f2ede275c9b48eab4354c446d64cefe6bb79be",
        );
        expect(service.startCommand).toEqual(["/bin/sh", "-c", MYSQL_SUBSTRATE_SCRIPT]);
      } else {
        expect(service.substrateImage).toBeUndefined();
        expect(service.startCommand).toEqual(["redis-server", "--dir", "/data"]);
      }
    }
  });

  it("start scripts that are valid sh and read the service's variables by name only", () => {
    for (const service of BUILTIN_CODING_SERVICES) {
      const [shell, flag, script] = service.startCommand ?? [];
      if (shell !== "/bin/sh") continue;
      expect(flag).toBe("-c");
      const check = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
      // Every serviceEnv value is a fixed fixture; none is written into the script itself.
      for (const value of new Set(Object.values(service.serviceEnv))) {
        expect(script).not.toMatch(new RegExp(`['"=]${value}['"; ]`));
      }
      for (const name of Object.keys(service.serviceEnv).filter((key) => key.includes("PASSWORD"))) {
        expect(script).toContain(`"$${name}"`);
      }
    }
    expect(MYSQL_SUBSTRATE_SCRIPT.startsWith("export PERCONA_TELEMETRY_DISABLE=1;")).toBe(true);
    // Each marks its setup done (the Substrate start script's readiness waits for it) as its last step.
    for (const script of [POSTGRES_SUBSTRATE_SCRIPT, MYSQL_SUBSTRATE_SCRIPT]) {
      expect(script.endsWith(': > "$WARDBY_SERVICE_SETUP_DONE" || exit 1; wait "$pid"')).toBe(true);
    }
    // The password reaches initdb through a file, never an argument, and the file goes at once.
    expect(POSTGRES_SUBSTRATE_SCRIPT).toContain('--pwfile="$pw"');
    expect(POSTGRES_SUBSTRATE_SCRIPT).toContain('rm -f "$pw"');
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

  it("accepts a start command and leaves it out when absent", () => {
    const { startCommand: _startCommand, substrateImage: _substrateImage, ...withoutStart } = postgres16;
    const withStart = CodingServiceDefinitionSchema.parse({
      ...withoutStart,
      startCommand: ["docker-entrypoint.sh", "postgres"],
    });
    expect(withStart.startCommand).toEqual(["docker-entrypoint.sh", "postgres"]);
    const parsed = CodingServiceDefinitionSchema.parse(withoutStart);
    expect("startCommand" in parsed).toBe(false);
  });

  it("accepts a Substrate image with a start command, and refuses one without", () => {
    const substrateImage = `registry.example/fakedb-nonroot@sha256:${"c".repeat(64)}`;
    expect(CodingServiceDefinitionSchema.parse({ ...postgres16, substrateImage }).substrateImage).toBe(substrateImage);
    const { startCommand: _startCommand, ...withoutStart } = postgres16;
    const refused = CodingServiceDefinitionSchema.safeParse({ ...withoutStart, substrateImage });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["startCommand"],
        message: "is required with substrateImage (that image's own entrypoint is not used)",
      }),
    );
    const { substrateImage: _image, ...plain } = postgres16;
    expect("substrateImage" in CodingServiceDefinitionSchema.parse(plain)).toBe(false);
  });

  it.each([
    ["a tag", "postgres:16"],
    ["a short digest", `ghcr.io/cloudnative-pg/postgresql@sha256:${"a".repeat(63)}`],
    ["an empty string", ""],
  ])("refuses a Substrate image that is %s", (_label, substrateImage) => {
    const result = CodingServiceDefinitionSchema.safeParse({ ...postgres16, substrateImage });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["substrateImage"],
        message: "must be a registry digest (repo@sha256:<64 hex>)",
      }),
    );
  });

  it("accepts a start-script argument of up to 4096 bytes", () => {
    const startCommand = ["/bin/sh", "-c", "x".repeat(4096)];
    expect(CodingServiceDefinitionSchema.safeParse({ ...postgres16, startCommand }).success).toBe(true);
  });

  it.each([
    ["empty", []],
    ["17 arguments", Array.from({ length: 17 }, () => "a")],
    ["an empty argument", [""]],
    ["a multi-line argument", ["a\nb"]],
    ["an argument over 4096 bytes", ["x".repeat(4097)]],
    ["a string", "docker-entrypoint.sh"],
    ["not strings", [1]],
  ])("refuses a start command that is %s", (_label, startCommand) => {
    expect(CodingServiceDefinitionSchema.safeParse({ ...postgres16, startCommand }).success).toBe(false);
  });

  it("names the argument of a multi-line start command", () => {
    const result = CodingServiceDefinitionSchema.safeParse({ ...postgres16, startCommand: ["a\nb"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["startCommand", 0], message: "must be one line of at most 4096 bytes" }),
    );
  });
});

describe("CodingServiceDefinitionSchema for a toolchain", () => {
  it("accepts an image, environments, resources, writable paths and a setup command", () => {
    expect(CodingServiceDefinitionSchema.parse(PYTHON_DEV)).toEqual(PYTHON_DEV);
    const { setupCommand: _setupCommand, serviceEnv: _s, testEnv: _t, writablePaths: _w, ...minimal } = PYTHON_DEV;
    expect(CodingServiceDefinitionSchema.parse(minimal)).toEqual({
      ...minimal,
      serviceEnv: {},
      testEnv: {},
      writablePaths: [],
    });
  });

  it.each([
    ["dataPath", { dataPath: "/data" }],
    ["readiness", { readiness: postgres16.readiness }],
    ["port", { port: 7071 }],
    ["startCommand", { startCommand: ["serve"] }],
  ])("refuses %s, naming the field", (field, patch) => {
    const result = CodingServiceDefinitionSchema.safeParse({ ...PYTHON_DEV, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: [field], message: "is not used by a toolchain" }),
    );
  });

  it("refuses a setup command on a sidecar, naming the field", () => {
    const result = CodingServiceDefinitionSchema.safeParse({ ...postgres16, setupCommand: ["true"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["setupCommand"], message: "is only for a toolchain" }),
    );
  });

  it("still requires a sidecar's data path and readiness command", () => {
    const { dataPath: _dataPath, ...noData } = postgres16;
    const { readiness: _readiness, ...noReadiness } = postgres16;
    expect(CodingServiceDefinitionSchema.safeParse(noData).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["dataPath"] }),
    );
    expect(CodingServiceDefinitionSchema.safeParse(noReadiness).error?.issues).toContainEqual(
      expect.objectContaining({ path: ["readiness"] }),
    );
  });

  it("accepts a setup-script argument of up to 4096 bytes", () => {
    const setupCommand = ["/bin/sh", "-c", "x".repeat(4096)];
    expect(CodingServiceDefinitionSchema.safeParse({ ...PYTHON_DEV, setupCommand }).success).toBe(true);
  });

  it.each([
    ["empty", []],
    ["17 arguments", Array.from({ length: 17 }, () => "a")],
    ["an empty argument", [""]],
    ["a multi-line argument", ["a\nb"]],
    ["an argument over 4096 bytes", ["x".repeat(4097)]],
    ["a string", "render-config"],
  ])("refuses a setup command that is %s", (_label, setupCommand) => {
    expect(CodingServiceDefinitionSchema.safeParse({ ...PYTHON_DEV, setupCommand }).success).toBe(false);
  });

  it.each([["/workspace"], ["/workspace/build"], ["/opt"], ["/opt/wardby-cmd"], ["/home/wardby"], ["/run/wardby/x"]])(
    "refuses writable path %s, which wardby mounts in a toolchain",
    (path) => {
      expect(CodingServiceDefinitionSchema.safeParse({ ...PYTHON_DEV, writablePaths: [path] }).success).toBe(false);
    },
  );

  it("refuses a tag instead of a digest", () => {
    expect(CodingServiceDefinitionSchema.safeParse({ ...PYTHON_DEV, image: "python:3.13" }).success).toBe(false);
  });
});

describe("stored services", () => {
  const resolved = resolvedFromDefinition(postgres16);

  it("snapshots an entry with its kind and parses it back", () => {
    expect(resolved.kind).toBe("sidecar");
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

  it("parses a snapshot from before startCommand existed", () => {
    // An entry from then had no substrateImage either (it needs a startCommand).
    const { startCommand: _startCommand, substrateImage: _substrateImage, ...before } = resolved;
    const [parsed] = StoredCodingServicesSchema.parse([before]);
    expect(parsed).toBeDefined();
    expect("startCommand" in parsed).toBe(false);
    const fromRow = catalogEntryFromRow({ ...postgres16, substrateImage: null, startCommand: null });
    expect("startCommand" in fromRow).toBe(false);
  });

  it("carries the Substrate image into the snapshot, and the Substrate launcher runs it", () => {
    expect(resolved.substrateImage).toBe(postgres16.substrateImage);
    expect(parseStoredServices([resolved])[0]?.substrateImage).toBe(postgres16.substrateImage);
    expect(substrateServiceImage(resolved)).toBe(postgres16.substrateImage);
    const redis = resolvedFromDefinition(BUILTIN_CODING_SERVICES.find((s) => s.name === "redis")!);
    expect(substrateServiceImage(redis)).toBe(redis.image);
  });

  it("parses a snapshot from before substrateImage existed", () => {
    const { substrateImage: _substrateImage, ...before } = resolved;
    const [parsed] = StoredCodingServicesSchema.parse([before]);
    expect(parsed).toBeDefined();
    expect("substrateImage" in parsed).toBe(false);
    expect(substrateServiceImage(parsed)).toBe(postgres16.image);
    const fromRow = catalogEntryFromRow({ startCommand: null, ...postgres16, substrateImage: null });
    expect("substrateImage" in fromRow).toBe(false);
  });

  it("reads a snapshot from before kinds were stored as a sidecar", () => {
    const { kind: _kind, ...before } = resolved;
    expect(parseStoredServices([before])).toEqual([resolved]);
  });

  it("snapshots a toolchain with its kind and setup command", () => {
    const toolchain = resolvedFromDefinition(CodingServiceDefinitionSchema.parse(PYTHON_DEV), {
      id: "svc_1",
      updatedAt: new Date("2026-11-22T00:00:00.000Z"),
    });
    expect(toolchain).toMatchObject({ kind: "toolchain", setupCommand: PYTHON_DEV.setupCommand, catalogId: "svc_1" });
    expect(parseStoredServices([toolchain])).toEqual([toolchain]);
    expect(() => parseStoredServices([{ ...toolchain, dataPath: "/data" }])).toThrow();
  });

  it("hands the worker only name, version and test variables", () => {
    expect(workerServices([resolved])).toEqual([{ name: "postgres", version: "16", testEnv: postgres16.testEnv }]);
    expect(JSON.stringify(workerServices([resolved]))).not.toContain("cloudnative-pg");
  });

  it("gives the worker a toolchain's name and test variables only: the input format is unchanged (#599)", () => {
    const toolchain = resolvedFromDefinition(CodingServiceDefinitionSchema.parse(PYTHON_DEV));
    expect(workerServices([toolchain, resolved])).toEqual([
      { name: "python-dev", version: "3.13", testEnv: PYTHON_DEV.testEnv },
      { name: "postgres", version: "16", testEnv: postgres16.testEnv },
    ]);
    const text = JSON.stringify(workerServices([toolchain]));
    expect(text).not.toContain("registry.example");
    expect(text).not.toContain("render-config");
  });
});

describe("toolchain hostAliases (#599)", () => {
  const base = {
    name: "python-dev",
    version: "3.13",
    kind: "toolchain",
    image: `registry.example/team@sha256:${"a".repeat(64)}`,
    resources: { cpuMillicores: 500, memoryMib: 512, diskMib: 256 },
  };
  const parse = (extra: Record<string, unknown>) => CodingServiceDefinitionSchema.safeParse({ ...base, ...extra });

  it("accepts lower-case host names and keeps them in the run's snapshot", () => {
    const parsed = parse({ hostAliases: ["elastic", "mq.internal", "db-1"] });
    expect(parsed.success).toBe(true);
    const resolved = resolvedFromDefinition(CodingServiceDefinitionSchema.parse({ ...base, hostAliases: ["elastic"] }));
    expect(resolved).toMatchObject({ kind: "toolchain", hostAliases: ["elastic"] });
  });

  it.each([
    [["Elastic"]],
    [["elastic search"]],
    [["-elastic"]],
    [["localhost"]],
    [["elastic", "elastic"]],
    [[]],
    [Array.from({ length: 17 }, (_, i) => `h${i}`)],
  ])("refuses %j", (hostAliases) => {
    expect(parse({ hostAliases }).success).toBe(false);
  });

  it("is only for a toolchain", () => {
    const sidecar = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!;
    expect(CodingServiceDefinitionSchema.safeParse({ ...sidecar, hostAliases: ["elastic"] }).success).toBe(false);
  });

  it("reads a row's hostAliases column, and a row without it", () => {
    const row = {
      ...base,
      serviceEnv: {},
      testEnv: {},
      startCommand: null,
      writablePaths: [],
    };
    expect(catalogEntryFromRow({ ...row, hostAliases: ["elastic"] })).toMatchObject({ hostAliases: ["elastic"] });
    expect(catalogEntryFromRow({ ...row, hostAliases: null })).not.toHaveProperty("hostAliases");
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
    expect(catalogEntryFromRow({ startCommand: null, ...postgres16 })).toEqual(postgres16);
    expect(catalogEntryFromRow({ startCommand: null, setupCommand: null, ...postgres16 })).toEqual(postgres16);
  });

  it("maps a toolchain row, whose sidecar-only columns are null", () => {
    const row = {
      ...PYTHON_DEV,
      substrateImage: null,
      port: null,
      readiness: null,
      startCommand: null,
      dataPath: null,
    };
    expect(catalogEntryFromRow(row)).toEqual(CodingServiceDefinitionSchema.parse(PYTHON_DEV));
    const { setupCommand: _setupCommand, ...withoutSetup } = row;
    expect("setupCommand" in catalogEntryFromRow({ ...withoutSetup, setupCommand: null })).toBe(false);
  });

  it("refuses a toolchain row that has a sidecar's column", () => {
    expect(() => catalogEntryFromRow({ ...PYTHON_DEV, startCommand: null, dataPath: "/data" })).toThrow(
      "coding_service_catalog_invalid:python-dev 3.13",
    );
  });

  it("refuses a row edited out of shape, naming only the entry", () => {
    expect(() =>
      catalogEntryFromRow({ startCommand: null, ...postgres16, readiness: { command: "pg_isready" } }),
    ).toThrow("coding_service_catalog_invalid:postgres 16");
  });
});
