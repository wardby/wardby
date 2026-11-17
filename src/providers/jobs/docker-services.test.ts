import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition, type ResolvedCodingService } from "../../coding/services/catalog.js";
import { isolationNames, isolationToken, type DockerContainerInspection } from "./docker-isolation.js";
import {
  assertServiceContainerInspection,
  buildDockerServicePlan,
  buildServiceCreateArgs,
  dockerServiceContainerName,
  dockerServiceContainerNames,
  SERVICE_PIDS_LIMIT,
  serviceMemoryMib,
  serviceTmpfsOptions,
  validateDockerServices,
} from "./docker-services.js";
import type { JobSpec } from "./types.js";

const image = `registry.example/wardby-worker@sha256:${"a".repeat(64)}`;
const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((service) => service.name === "postgres" && service.version === "16")!,
);
const REDIS = resolvedFromDefinition(BUILTIN_CODING_SERVICES.find((service) => service.name === "redis")!);
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-with-services",
  image,
  inputArtifact: "/host/input.json",
  timeoutSec: 900,
  limits: { cpus: 1.5, memoryMb: 1024, pids: 64, diskMb: 512 },
  labels: {},
  services: [POSTGRES],
};
const KEEPER_ID = "f".repeat(64);
const runHash = createHash("sha256").update(spec.runId).digest("hex");

function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) => (value === flag ? [args[index + 1] ?? ""] : []));
}

function validServiceInspection(networkMode = `container:${KEEPER_ID}`): DockerContainerInspection {
  const memory = serviceMemoryMib(POSTGRES) * 1024 * 1024;
  return {
    Config: {
      User: "10001:10001",
      Image: POSTGRES.image,
      Env: ["PATH=/usr/bin:/bin", ...Object.entries(POSTGRES.serviceEnv).map(([name, value]) => `${name}=${value}`)],
      Labels: { "io.wardby.managed": "true", "io.wardby.component": "coding-worker", "io.wardby.run-sha256": runHash },
    },
    HostConfig: {
      NetworkMode: networkMode,
      ReadonlyRootfs: true,
      Privileged: false,
      Binds: null,
      CapAdd: null,
      CapDrop: ["ALL"],
      CgroupnsMode: "private",
      IpcMode: "private",
      ShmSize: 64 * 1024 * 1024,
      Memory: memory,
      MemorySwap: memory,
      MemorySwappiness: 0,
      PidsLimit: SERVICE_PIDS_LIMIT,
      NanoCpus: 500_000_000,
      PidMode: "",
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
      SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
      Devices: [],
      DeviceRequests: null,
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: null,
      GroupAdd: null,
      PortBindings: {},
      PublishAllPorts: false,
      Tmpfs: serviceTmpfsOptions(POSTGRES),
    },
    Mounts: [],
    NetworkSettings: { Networks: {}, Ports: {} },
  };
}

describe("Docker service containers", () => {
  it("names each service container from the run's opaque token", () => {
    const token = isolationToken(spec.runId);
    expect(dockerServiceContainerName(spec.runId, "postgres")).toBe(`wardby-svc-${token}-postgres`);
    expect(() => dockerServiceContainerName(spec.runId, "Bad Name")).toThrow("docker_isolation_unsupported");
    expect(dockerServiceContainerNames({ ...spec, services: [POSTGRES, REDIS] })).toEqual([
      `wardby-svc-${token}-postgres`,
      `wardby-svc-${token}-redis`,
    ]);
    expect(dockerServiceContainerNames({ ...spec, services: undefined })).toEqual([]);
  });

  it("runs the entry's image, never its Substrate-only image, with the image's own entrypoint", () => {
    expect(POSTGRES.substrateImage).toBeDefined();
    const args = buildServiceCreateArgs(spec, POSTGRES);
    expect(args.at(-1)).toBe(POSTGRES.image);
    expect(args).not.toContain(POSTGRES.substrateImage);
    expect(args.join(" ")).not.toContain("cloudnative-pg");
    expect(args).not.toContain("--entrypoint");
  });

  it("builds a hardened container in the network keeper's namespace", () => {
    const args = buildServiceCreateArgs(spec, POSTGRES);
    expect(args.slice(0, 4)).toEqual([
      "container",
      "create",
      "--name",
      dockerServiceContainerName(spec.runId, "postgres"),
    ]);
    expect(args.at(-1)).toBe(POSTGRES.image);
    expect(flagValues(args, "--pull")).toEqual(["never"]);
    expect(flagValues(args, "--user")).toEqual(["10001:10001"]);
    expect(flagValues(args, "--network")).toEqual([`container:${isolationNames(spec.runId).networkKeeperContainer}`]);
    expect(args).toContain("--read-only");
    expect(flagValues(args, "--cap-drop")).toEqual(["ALL"]);
    expect(flagValues(args, "--security-opt")).toEqual(["no-new-privileges=true", "seccomp=builtin"]);
    expect(flagValues(args, "--cgroupns")).toEqual(["private"]);
    expect(flagValues(args, "--ipc")).toEqual(["private"]);
    expect(flagValues(args, "--shm-size")).toEqual(["64m"]);
    expect(flagValues(args, "--cpus")).toEqual(["0.5"]);
    // 512 memory + 1024 data + 2 x 64 scratch + 64 shared memory, all RAM-backed.
    expect(flagValues(args, "--memory")).toEqual(["1728m"]);
    expect(flagValues(args, "--memory-swap")).toEqual(["1728m"]);
    expect(flagValues(args, "--pids-limit")).toEqual([String(SERVICE_PIDS_LIMIT)]);
    expect(flagValues(args, "--restart")).toEqual(["no"]);
    expect(flagValues(args, "--tmpfs")).toEqual([
      "/var/lib/postgresql/data:rw,nosuid,nodev,size=1024m,uid=10001,gid=10001,mode=0700",
      "/var/run/postgresql:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
      "/tmp:rw,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=0700",
    ]);
    expect(flagValues(args, "--env")).toEqual([
      "PGDATA=/var/lib/postgresql/data/pgdata",
      "POSTGRES_DB=test",
      "POSTGRES_PASSWORD=test",
      "POSTGRES_USER=test",
    ]);
    expect(flagValues(args, "--label")).toEqual([
      "io.wardby.managed=true",
      "io.wardby.component=coding-worker",
      `io.wardby.run-sha256=${runHash}`,
    ]);
    for (const forbidden of [
      "--publish",
      "-p",
      "--mount",
      "--volume",
      "-v",
      "--privileged",
      "--cap-add",
      "--device",
      "--add-host",
      "--dns",
      "--entrypoint",
    ]) {
      expect(args).not.toContain(forbidden);
    }
  });

  it("gives an entry without serviceEnv no --env and only its data mount", () => {
    const args = buildServiceCreateArgs({ ...spec, services: [REDIS] }, REDIS);
    expect(flagValues(args, "--env")).toEqual([]);
    expect(flagValues(args, "--tmpfs")).toEqual(["/data:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700"]);
    expect(flagValues(args, "--cpus")).toEqual(["0.25"]);
  });

  it("re-validates the services instead of trusting dispatch", () => {
    expect(buildDockerServicePlan({ ...spec, services: undefined })).toEqual([]);
    expect(buildDockerServicePlan(spec)).toEqual([
      {
        service: POSTGRES,
        container: dockerServiceContainerName(spec.runId, "postgres"),
        createArgs: buildServiceCreateArgs(spec, POSTGRES),
      },
    ]);
    for (const services of [
      [],
      [POSTGRES, POSTGRES],
      [{ ...POSTGRES, image: "postgres:16" }],
      [{ ...POSTGRES, dataPath: "/proc/data" }],
    ]) {
      expect(() => buildDockerServicePlan({ ...spec, services })).toThrow("docker_isolation_unsupported");
    }
    // A Claude Code run's services are planned exactly like a Codex run's.
    const claude: JobSpec = {
      ...spec,
      provider: "claude-code",
      toolImage: `registry.example/t@sha256:${"b".repeat(64)}`,
    };
    expect(buildDockerServicePlan(claude)).toEqual(buildDockerServicePlan(spec));
  });

  it("fills catalog defaults and never throws a raw TypeError on an invalid spec", () => {
    const { serviceEnv: _serviceEnv, writablePaths: _writablePaths, ...withoutDefaults } = POSTGRES;
    const filled = validateDockerServices({
      ...spec,
      services: [withoutDefaults as unknown as ResolvedCodingService],
    });
    expect(filled).toEqual([{ ...POSTGRES, serviceEnv: {}, writablePaths: [] }]);

    expect(() => validateDockerServices({ ...spec, services: [{ ...POSTGRES, port: 0 }] })).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => validateDockerServices({ ...spec, services: [{ ...POSTGRES, port: 0 }] })).not.toThrow(TypeError);
  });

  it("attests a service container before it starts", () => {
    expect(() => assertServiceContainerInspection(validServiceInspection(), spec, POSTGRES, KEEPER_ID)).not.toThrow();
    const byName = validServiceInspection(`container:${isolationNames(spec.runId).networkKeeperContainer}`);
    expect(() => assertServiceContainerInspection(byName, spec, POSTGRES)).not.toThrow();
    const valid = validServiceInspection();
    const drifts: DockerContainerInspection[] = [
      { ...valid, HostConfig: { ...valid.HostConfig, Privileged: true } },
      { ...valid, HostConfig: { ...valid.HostConfig, NetworkMode: isolationNames(spec.runId).network } },
      { ...valid, HostConfig: { ...valid.HostConfig, Memory: 512 * 1024 * 1024 } },
      { ...valid, HostConfig: { ...valid.HostConfig, Tmpfs: { "/var/lib/postgresql/data": "rw" } } },
      { ...valid, HostConfig: { ...valid.HostConfig, PortBindings: { "5432/tcp": [{}] } } },
      { ...valid, Mounts: [{ Type: "volume", Name: "anonymous", Destination: "/var/lib/other", RW: true }] },
      { ...valid, Config: { ...valid.Config, Env: ["PATH=/usr/bin:/bin"] } },
      { ...valid, Config: { ...valid.Config, Env: [...(valid.Config?.Env ?? []), "WARDBY_RUN_CAPABILITY=x"] } },
      { ...valid, Config: { ...valid.Config, User: "0:0" } },
      { ...valid, Config: { ...valid.Config, Image: "postgres:16" } },
      { ...valid, Config: { ...valid.Config, Labels: { ...valid.Config?.Labels, "io.wardby.managed": "false" } } },
      { ...valid, HostConfig: { ...valid.HostConfig, ReadonlyRootfs: false } },
      { ...valid, HostConfig: { ...valid.HostConfig, CapDrop: [] } },
      { ...valid, HostConfig: { ...valid.HostConfig, SecurityOpt: ["seccomp=builtin"] } },
      { ...valid, HostConfig: { ...valid.HostConfig, NanoCpus: 250_000_000 } },
      { ...valid, HostConfig: { ...valid.HostConfig, PidMode: "host" } },
      { ...valid, HostConfig: { ...valid.HostConfig, DnsOptions: ["ndots:1"] } },
      { ...valid, HostConfig: { ...valid.HostConfig, DnsSearch: ["example.com"] } },
      {
        ...valid,
        HostConfig: {
          ...valid.HostConfig,
          LogConfig: { Type: "local", Config: { "max-size": "10m", "max-file": "2" } },
        },
      },
      { ...valid, HostConfig: { ...valid.HostConfig, MemorySwappiness: 60 } },
      { ...valid, HostConfig: { ...valid.HostConfig, PublishAllPorts: undefined } },
      { ...valid, NetworkSettings: { Networks: {}, Ports: { "5432/tcp": [{}] } } },
    ];
    for (const drift of drifts) {
      expect(() => assertServiceContainerInspection(drift, spec, POSTGRES, KEEPER_ID)).toThrow(
        "docker_isolation_unsupported",
      );
    }
    expect(() => assertServiceContainerInspection(valid, spec, POSTGRES, "0".repeat(64))).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => assertServiceContainerInspection(valid, spec, REDIS, KEEPER_ID)).toThrow(
      "docker_isolation_unsupported",
    );
  });
});
