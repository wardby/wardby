import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDockerHostSupportsIsolation,
  assertIsolationNetworkInspection,
  assertWorkerContainerInspection,
  buildDockerIsolationPlan,
  buildWorkerCreateArgs,
  isolationNames,
  WORKER_PATHS,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

const image = `registry.example/reevo-worker@sha256:${"a".repeat(64)}`;
const runHash = createHash("sha256").update("run-sensitive-name").digest("hex");
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-sensitive-name",
  image,
  inputArtifact: "/host/secret/input.json",
  timeoutSec: 900,
  limits: { cpus: 1.5, memoryMb: 1024, pids: 64, diskMb: 512 },
  labels: { untrusted: "do-not-expand" },
};

describe("Docker isolation policy", () => {
  it("builds opaque names and fixed arguments without expanding untrusted values", () => {
    const plan = buildDockerIsolationPlan(spec, "trusted-proxy");
    const args = JSON.stringify(plan);
    expect(plan.names).toEqual(isolationNames(spec.runId));
    expect(plan.deadlineMs).toBe(900_000);
    expect(args).not.toContain(spec.runId);
    expect(args).not.toContain(spec.inputArtifact);
    expect(args).not.toContain("do-not-expand");
    expect(plan.workerCreateArgs).toContain("REEVO_RUN_CAPABILITY");
    expect(args).not.toContain("rrp_");
  });

  it("requires immutable images and bounded resources", () => {
    expect(() => buildWorkerCreateArgs({ ...spec, image: "reevo-worker:latest" })).toThrow(
      "docker_isolation_unsupported",
    );
    expect(() => buildWorkerCreateArgs({ ...spec, limits: { ...spec.limits, pids: 0 } })).toThrow(
      "docker_isolation_unsupported",
    );
  });

  it("uses only the four fixed volume mounts with explicit access modes", () => {
    const args = buildWorkerCreateArgs(spec);
    const mounts = args.filter((value) => value.startsWith("type=volume"));
    expect(mounts).toHaveLength(4);
    expect(mounts).toEqual([
      expect.stringContaining(`dst=${WORKER_PATHS.workspace},volume-subpath=workspace`),
      expect.stringContaining(`dst=${WORKER_PATHS.git},volume-subpath=git`),
      expect.stringContaining(`dst=${WORKER_PATHS.input},volume-subpath=input`),
      expect.stringContaining(`dst=${WORKER_PATHS.output},volume-subpath=output`),
    ]);
    expect(mounts[0]).not.toContain("readonly");
    expect(mounts[1]).toContain("readonly");
    expect(mounts[2]).toContain("readonly");
    expect(mounts[3]).not.toContain("readonly");
    expect(args).not.toContain("--volume");
  });

  it("fails closed when mandatory host features are absent", () => {
    const supported = {
      OSType: "linux",
      CgroupVersion: "2",
      MemoryLimit: true,
      SwapLimit: true,
      CpuCfsQuota: true,
      PidsLimit: true,
      SecurityOptions: ["name=seccomp,profile=builtin"],
      Plugins: { Volume: ["local"], Network: ["bridge"] },
    };
    expect(() => assertDockerHostSupportsIsolation(supported)).not.toThrow();
    for (const change of [
      { OSType: "windows" },
      { CgroupVersion: "1" },
      { PidsLimit: false },
      { SecurityOptions: [] },
    ]) {
      expect(() => assertDockerHostSupportsIsolation({ ...supported, ...change })).toThrow(
        "docker_isolation_unsupported",
      );
    }
  });

  it("attests isolated network settings", () => {
    const network = {
      Name: isolationNames(spec.runId).network,
      Driver: "bridge",
      Internal: true,
      EnableIPv6: false,
      Attachable: false,
      Ingress: false,
      Labels: {
        "io.reevo.managed": "true",
        "io.reevo.component": "coding-worker",
        "io.reevo.run-sha256": runHash,
      },
      Options: {
        "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
        "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
      },
    };
    expect(() => assertIsolationNetworkInspection(network, spec.runId)).not.toThrow();
    expect(() => assertIsolationNetworkInspection({ ...network, Internal: false }, spec.runId)).toThrow(
      "docker_isolation_unsupported",
    );
  });

  it("rejects inspection drift before a worker starts", () => {
    const names = isolationNames(spec.runId);
    const container: DockerContainerInspection = {
      Config: {
        User: "10001:10001",
        Image: image,
        Env: ["REEVO_PROXY_URL=http://reevo-proxy:8787", "REEVO_RUN_CAPABILITY=test-capability"],
        Labels: {
          "io.reevo.managed": "true",
          "io.reevo.component": "coding-worker",
          "io.reevo.run-sha256": runHash,
        },
      },
      HostConfig: {
        Binds: null,
        CapAdd: null,
        CapDrop: ["ALL"],
        CgroupnsMode: "private",
        CpuPeriod: 100_000,
        CpuQuota: 150_000,
        Devices: [],
        DeviceRequests: null,
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        Init: true,
        IpcMode: "none",
        LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
        Memory: 1024 * 1024 * 1024,
        MemorySwap: 1024 * 1024 * 1024,
        MemorySwappiness: 0,
        NetworkMode: names.network,
        NanoCpus: 1_500_000_000,
        PidsLimit: 64,
        PidMode: "",
        PortBindings: {},
        Privileged: false,
        PublishAllPorts: false,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges=true", "seccomp=builtin"],
        ShmSize: 16 * 1024 * 1024,
        Tmpfs: { "/tmp": "rw,noexec", "/home/reevo": "rw,noexec" },
        Mounts: [
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.workspace,
            VolumeOptions: { NoCopy: true, Subpath: "workspace" },
          },
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.git,
            ReadOnly: true,
            VolumeOptions: { NoCopy: true, Subpath: "git" },
          },
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.input,
            ReadOnly: true,
            VolumeOptions: { NoCopy: true, Subpath: "input" },
          },
          {
            Type: "volume",
            Source: names.storageVolume,
            Target: WORKER_PATHS.output,
            VolumeOptions: { NoCopy: true, Subpath: "output" },
          },
        ],
      },
      Mounts: [
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.workspace, RW: true },
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.git, RW: false },
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.input, RW: false },
        { Type: "volume", Name: names.storageVolume, Destination: WORKER_PATHS.output, RW: true },
      ],
      NetworkSettings: { Networks: { [names.network]: {} }, Ports: {} },
    };
    expect(() => assertWorkerContainerInspection(container, spec, "test-capability")).not.toThrow();
    expect(() =>
      assertWorkerContainerInspection(
        { ...container, HostConfig: { ...container.HostConfig, Privileged: true } },
        spec,
        "test-capability",
      ),
    ).toThrow("docker_isolation_unsupported");
  });
});
