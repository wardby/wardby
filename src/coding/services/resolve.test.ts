import { describe, expect, it, vi } from "vitest";
import { MAX_CODING_TASK_BYTES } from "../protocol.js";
import { SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE, TOO_MANY_DOCKER_SERVICES_SENTENCE } from "./wording.js";
import { BUILTIN_CODING_SERVICES } from "./builtins.js";
import { resolvedFromDefinition } from "./catalog.js";
import { resolveRunServices } from "./resolve.js";

const rows = BUILTIN_CODING_SERVICES.map((service) => ({ startCommand: null, ...service }));
function catalog(entries: Array<(typeof rows)[number] | Record<string, unknown>> = rows) {
  const findMany = vi.fn(async ({ where }: { where: { OR: Array<{ name: string; version: string }> } }) =>
    (entries as typeof rows).filter((row) =>
      where.OR.some((key) => key.name === row.name && key.version === row.version),
    ),
  );
  return { findMany };
}
const byKey = (name: string, version: string) =>
  resolvedFromDefinition(BUILTIN_CODING_SERVICES.find((s) => s.name === name && s.version === version)!);

describe("resolveRunServices", () => {
  it("resolves each declared service in declaration order, as a snapshot with its kind", async () => {
    const result = await resolveRunServices(
      catalog(),
      {
        services: [
          { name: "redis", version: "7" },
          { name: "postgres", version: "16" },
        ],
      },
      ["postgres", "redis"],
      "Add a joke.",
    );
    expect(result).toEqual({ services: [byKey("redis", "7"), byKey("postgres", "16")] });
  });

  it("snapshots the start command when the catalog has one", async () => {
    const custom = { ...rows[1], name: "fakedb", startCommand: ["serve"] };
    const result = await resolveRunServices(
      catalog([custom]),
      { services: [{ name: "fakedb", version: "16" }] },
      ["fakedb"],
      "Add a joke.",
    );
    expect(result).toMatchObject({ services: [{ name: "fakedb", startCommand: ["serve"] }] });
  });

  it("asks the catalog nothing when the repository declares nothing", async () => {
    const reader = catalog();
    expect(await resolveRunServices(reader, { services: [] }, [], "Add a joke.")).toEqual({ services: [] });
    expect(reader.findMany).not.toHaveBeenCalled();
  });

  it("refuses a name and version the catalog doesn't have, before checking the agent", async () => {
    expect(
      await resolveRunServices(catalog(), { services: [{ name: "postgres", version: "18" }] }, [], "Add a joke."),
    ).toEqual({
      refusal: "service_unknown: This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
    });
  });

  it("refuses a service the agent isn't allowed", async () => {
    expect(
      await resolveRunServices(
        catalog(),
        {
          services: [
            { name: "postgres", version: "16" },
            { name: "redis", version: "7" },
          ],
        },
        ["postgres"],
        "Add a joke.",
      ),
    ).toEqual({
      refusal:
        "service_not_allowed: This repository asks for `redis`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
    });
  });

  it("fails closed on a catalog row whose kind it doesn't know", async () => {
    const external = [{ ...rows[1], kind: "external" }];
    await expect(
      resolveRunServices(
        catalog(external),
        { services: [{ name: "postgres", version: "16" }] },
        ["postgres"],
        "Add a joke.",
      ),
    ).rejects.toThrow("coding_service_catalog_invalid:postgres 16");
  });

  it("snapshots a docker row with its kind, and refuses a second docker service", async () => {
    const docker = {
      name: "docker",
      version: "29",
      kind: "docker" as const,
      image: `registry.example/wardby-docker-service@sha256:${"d".repeat(64)}`,
      resources: { cpuMillicores: 1000, memoryMib: 2048, diskMib: 4096 },
    };
    // A docker row's other columns hold the table's defaults, never read.
    const dockerRow = { ...docker, startCommand: null, serviceEnv: {}, testEnv: {}, writablePaths: [] };
    const dockerRows = [...rows, dockerRow, { ...dockerRow, name: "docker-old", version: "28" }];
    expect(
      await resolveRunServices(
        catalog(dockerRows),
        { services: [{ name: "docker", version: "29" }] },
        ["docker"],
        "Build it.",
      ),
    ).toEqual({ services: [docker] });
    expect(
      await resolveRunServices(
        catalog(dockerRows),
        {
          services: [
            { name: "docker", version: "29" },
            { name: "docker-old", version: "28" },
          ],
        },
        ["docker", "docker-old"],
        "Build it.",
      ),
    ).toEqual({ refusal: `service_declaration_invalid: ${TOO_MANY_DOCKER_SERVICES_SENTENCE}` });
    // A docker service is declared under services:, never as the toolchain.
    expect(
      await resolveRunServices(
        catalog(dockerRows),
        { services: [], toolchain: { name: "docker", version: "29" } },
        ["docker"],
        "Build it.",
      ),
    ).toEqual({ refusal: expect.stringMatching(/^service_declaration_invalid: .*declare it under `services:`/) });
  });

  it("refuses when the task text plus the services note would exceed the coding task size limit", async () => {
    const hugeTask = "x".repeat(MAX_CODING_TASK_BYTES);
    expect(
      await resolveRunServices(catalog(), { services: [{ name: "postgres", version: "16" }] }, ["postgres"], hugeTask),
    ).toEqual({
      refusal: `service_declaration_invalid: ${SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE}`,
    });
  });

  it("counts the agent's own instructions with the note and the task", async () => {
    const declared = { services: [{ name: "postgres", version: "16" }] };
    const instructions = "x".repeat(MAX_CODING_TASK_BYTES - 200);
    expect(await resolveRunServices(catalog(), declared, ["postgres"], "Add a joke.", instructions)).toEqual({
      refusal: `service_declaration_invalid: ${SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE}`,
    });
    expect(await resolveRunServices(catalog(), declared, ["postgres"], "Add a joke.", "Run pytest.")).toHaveProperty(
      "services",
    );
  });

  describe("a toolchain", () => {
    const toolchainRow = {
      name: "python-dev",
      version: "3.13",
      kind: "toolchain",
      image: `registry.example/team/python-dev@sha256:${"d".repeat(64)}`,
      substrateImage: null,
      port: null,
      serviceEnv: {},
      testEnv: { APP_ENV: "test" },
      readiness: null,
      startCommand: null,
      setupCommand: ["render-config"],
      resources: { cpuMillicores: 1000, memoryMib: 2048, diskMib: 1024 },
      dataPath: null,
      writablePaths: [],
    };
    const both = () => catalog([...rows, toolchainRow]);
    const toolchain = { name: "python-dev", version: "3.13" };

    it("resolves it first, with its kind and setup command, then the services", async () => {
      const result = await resolveRunServices(
        both(),
        { toolchain, services: [{ name: "postgres", version: "16" }] },
        ["postgres", "python-dev"],
        "Add a joke.",
      );
      expect(result).toMatchObject({
        services: [
          { name: "python-dev", kind: "toolchain", setupCommand: ["render-config"] },
          { name: "postgres", kind: "sidecar" },
        ],
      });
    });

    it("resolves a toolchain declared alone", async () => {
      const result = await resolveRunServices(both(), { toolchain, services: [] }, ["python-dev"], "Add a joke.");
      expect(result).toMatchObject({ services: [{ name: "python-dev", kind: "toolchain" }] });
    });

    it("refuses a toolchain declared under services:, naming the right key", async () => {
      expect(await resolveRunServices(both(), { services: [toolchain] }, ["python-dev"], "Add a joke.")).toEqual({
        refusal:
          "service_declaration_invalid: `.wardby/services.yaml` is invalid: `python-dev` is a toolchain; declare it under `toolchain:`.",
      });
    });

    it("refuses a sidecar declared under toolchain:, naming the right key", async () => {
      const result = await resolveRunServices(
        both(),
        { toolchain: { name: "postgres", version: "16" }, services: [] },
        ["postgres"],
        "Add a joke.",
      );
      expect(result).toEqual({
        refusal:
          "service_declaration_invalid: `.wardby/services.yaml` is invalid: `postgres` is a service, not a toolchain; declare it under `services:`.",
      });
    });

    it("refuses a toolchain the agent isn't allowed", async () => {
      expect(await resolveRunServices(both(), { toolchain, services: [] }, ["postgres"], "Add a joke.")).toEqual({
        refusal:
          "service_not_allowed: This repository asks for `python-dev`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
      });
    });

    it("refuses a toolchain the catalog doesn't have", async () => {
      expect(await resolveRunServices(catalog(), { toolchain, services: [] }, ["python-dev"], "Add a joke.")).toEqual({
        refusal:
          "service_unknown: This repository asks for `python-dev 3.13`, which wardby's service catalog doesn't have.",
      });
    });
  });
});

describe("resolveRunServices with setup jobs (#589)", () => {
  const job = (name: string, waitFor: string[]) => ({
    name,
    version: "1",
    kind: "setup",
    image: `registry.example/team/migrate@sha256:${"e".repeat(64)}`,
    command: ["migrate", "up"],
    waitFor,
    timeoutSeconds: 600,
    serviceEnv: {},
    testEnv: {},
    resources: { cpuMillicores: 500, memoryMib: 1024, diskMib: 128 },
    writablePaths: ["/tmp"],
    startCommand: null,
  });
  const setupRows = [...rows, job("app-migrations", ["mysql"]), job("search-mappings", ["mysql", "redis"])];
  const mysql = { name: "mysql", version: "8" };
  const redis = { name: "redis", version: "7" };
  const migrations = { name: "app-migrations", version: "1" };
  const mappings = { name: "search-mappings", version: "1" };
  const everything = ["mysql", "redis", "app-migrations", "search-mappings"];

  it("snapshots the services, then the setup jobs in declaration order", async () => {
    const result = await resolveRunServices(
      catalog(setupRows),
      { services: [mysql, redis], setup: [mappings, migrations] },
      everything,
      "Add a joke.",
    );
    expect("services" in result && result.services.map((s) => `${s.kind} ${s.name}`)).toEqual([
      "sidecar mysql",
      "sidecar redis",
      "setup search-mappings",
      "setup app-migrations",
    ]);
    expect("services" in result && result.services[2]).toMatchObject({
      command: ["migrate", "up"],
      waitFor: ["mysql", "redis"],
      timeoutSeconds: 600,
    });
  });

  it("refuses a setup job waiting for a service the run doesn't declare under services:", async () => {
    expect(
      await resolveRunServices(
        catalog(setupRows),
        { services: [mysql], setup: [migrations, mappings] },
        everything,
        "Add a joke.",
      ),
    ).toEqual({
      refusal:
        "service_declaration_invalid: `.wardby/services.yaml` is invalid: `search-mappings` needs `redis`; declare it under `services:`.",
    });
  });

  it("refuses a setup job declared under services:, naming the right key", async () => {
    expect(
      await resolveRunServices(catalog(setupRows), { services: [mysql, migrations] }, everything, "Add a joke."),
    ).toEqual({
      refusal:
        "service_declaration_invalid: `.wardby/services.yaml` is invalid: `app-migrations` is a setup job; declare it under `setup:`.",
    });
  });

  it("refuses a setup job declared under toolchain:, naming the right key", async () => {
    expect(
      await resolveRunServices(
        catalog(setupRows),
        { toolchain: migrations, services: [mysql] },
        everything,
        "Add a joke.",
      ),
    ).toEqual({
      refusal:
        "service_declaration_invalid: `.wardby/services.yaml` is invalid: `app-migrations` is a setup job; declare it under `setup:`.",
    });
  });

  it("refuses a sidecar declared under setup:, naming the right key", async () => {
    expect(
      await resolveRunServices(catalog(setupRows), { services: [], setup: [mysql] }, everything, "Add a joke."),
    ).toEqual({
      refusal:
        "service_declaration_invalid: `.wardby/services.yaml` is invalid: `mysql` is a service, not a setup job; declare it under `services:`.",
    });
  });

  it("refuses a setup job the agent isn't allowed, through the same codingProfile.services list", async () => {
    expect(
      await resolveRunServices(
        catalog(setupRows),
        { services: [mysql], setup: [migrations] },
        ["mysql"],
        "Add a joke.",
      ),
    ).toEqual({
      refusal:
        "service_not_allowed: This repository asks for `app-migrations`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
    });
  });

  it("refuses a setup job the catalog doesn't have", async () => {
    expect(
      await resolveRunServices(
        catalog(setupRows),
        { services: [mysql], setup: [{ name: "app-migrations", version: "2" }] },
        everything,
        "Add a joke.",
      ),
    ).toEqual({
      refusal:
        "service_unknown: This repository asks for `app-migrations 2`, which wardby's service catalog doesn't have.",
    });
  });
});
