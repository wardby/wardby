import { createHash } from "node:crypto";
import type { JobSpec } from "./types.js";

export const CODING_WORKER_UID = 10001;
export const CODING_WORKER_GID = 10001;
export const CODING_PROXY_ALIAS = "reevo-proxy";
export const CODING_PROXY_PORT = 8787;
export const DOCKER_ISOLATION_ERROR = "docker_isolation_unsupported";
export const WORKER_STOP_GRACE_SECONDS = 10;

export const WORKER_PATHS = {
  workspace: "/workspace",
  git: "/workspace/.git",
  input: "/run/reevo/input",
  output: "/run/reevo/output",
  storage: "/run/reevo/storage",
} as const;

const LABEL_MANAGED = "io.reevo.managed=true";
const LABEL_COMPONENT = "io.reevo.component=coding-worker";
const IMMUTABLE_IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64})$/;
const DOCKER_OBJECT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface DockerIsolationNames {
  network: string;
  storageVolume: string;
  keeperContainer: string;
  workerContainer: string;
}

export interface DockerIsolationPlan {
  names: DockerIsolationNames;
  deadlineMs: number;
  stopGraceSeconds: number;
  networkCreateArgs: string[];
  storageVolumeCreateArgs: string[];
  keeperCreateArgs: string[];
  workerCreateArgs: string[];
  proxyNetworkConnectArgs: string[];
}

export interface DockerHostInfo {
  OSType?: string;
  CgroupVersion?: string;
  MemoryLimit?: boolean;
  SwapLimit?: boolean;
  CpuCfsQuota?: boolean;
  PidsLimit?: boolean;
  SecurityOptions?: string[];
  Plugins?: {
    Volume?: string[];
    Network?: string[];
  };
}

export interface DockerNetworkInspection {
  Name?: string;
  Driver?: string;
  Internal?: boolean;
  EnableIPv6?: boolean;
  Attachable?: boolean;
  Ingress?: boolean;
  Labels?: Record<string, string>;
  Options?: Record<string, string>;
  Containers?: Record<string, { Name?: string }>;
}

export interface DockerVolumeInspection {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string>;
  Options?: Record<string, string>;
}

export interface DockerContainerInspection {
  Config?: {
    Env?: string[];
    User?: string;
    Image?: string;
    Labels?: Record<string, string>;
  };
  HostConfig?: {
    AutoRemove?: boolean;
    Binds?: string[] | null;
    CapAdd?: string[] | null;
    CapDrop?: string[] | null;
    CgroupnsMode?: string;
    CpuQuota?: number;
    CpuPeriod?: number;
    Devices?: unknown[];
    DeviceRequests?: unknown[] | null;
    Dns?: string[] | null;
    DnsOptions?: string[] | null;
    DnsSearch?: string[] | null;
    ExtraHosts?: string[] | null;
    GroupAdd?: string[] | null;
    IpcMode?: string;
    Init?: boolean;
    LogConfig?: { Type?: string; Config?: Record<string, string> };
    Memory?: number;
    MemorySwap?: number;
    MemorySwappiness?: number | null;
    NetworkMode?: string;
    NanoCpus?: number;
    PidsLimit?: number | null;
    PortBindings?: Record<string, unknown>;
    PublishAllPorts?: boolean;
    PidMode?: string;
    Privileged?: boolean;
    ReadonlyRootfs?: boolean;
    RestartPolicy?: { Name?: string };
    SecurityOpt?: string[] | null;
    ShmSize?: number;
    Tmpfs?: Record<string, string>;
    Mounts?: Array<{
      Type?: string;
      Source?: string;
      Target?: string;
      ReadOnly?: boolean;
      VolumeOptions?: { NoCopy?: boolean; Subpath?: string };
    }>;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Destination?: string;
    RW?: boolean;
  }>;
  NetworkSettings?: {
    Networks?: Record<
      string,
      {
        Aliases?: string[] | null;
        DNSNames?: string[] | null;
        Gateway?: string;
      }
    >;
    Ports?: Record<string, unknown>;
  };
}

function isolationError(): Error {
  return new Error(DOCKER_ISOLATION_ERROR);
}

function runHash(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

function hasResourceLabels(labels: Record<string, string> | undefined, runId: string): boolean {
  return (
    labels?.["io.reevo.managed"] === "true" &&
    labels["io.reevo.component"] === "coding-worker" &&
    labels["io.reevo.run-sha256"] === runHash(runId)
  );
}

function assertFiniteRange(value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw isolationError();
}

function assertIntegerRange(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw isolationError();
}

function validateSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(spec.runId)) {
    throw isolationError();
  }
  if (!isImmutableDockerImage(spec.image)) throw isolationError();
  assertFiniteRange(spec.limits.cpus, 0.1, 32);
  assertIntegerRange(spec.limits.memoryMb, 128, 65_536);
  assertIntegerRange(spec.limits.pids, 16, 4_096);
  assertIntegerRange(spec.limits.diskMb, 64, 32_768);
  assertIntegerRange(spec.timeoutSec, 1, 86_400);
}

/** Accepts a registry digest or Docker's content-addressed local image ID. */
export function isImmutableDockerImage(image: string): boolean {
  return IMMUTABLE_IMAGE.test(image);
}

function validateDockerObject(value: string): void {
  if (!DOCKER_OBJECT.test(value)) throw isolationError();
}

export function isolationNames(runId: string): DockerIsolationNames {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(runId)) throw isolationError();
  const token = runHash(runId).slice(0, 20);
  return {
    network: `reevo-net-${token}`,
    storageVolume: `reevo-storage-${token}`,
    keeperContainer: `reevo-keeper-${token}`,
    workerContainer: `reevo-worker-${token}`,
  };
}

function labels(runId: string): string[] {
  return ["--label", LABEL_MANAGED, "--label", LABEL_COMPONENT, "--label", `io.reevo.run-sha256=${runHash(runId)}`];
}

function storageMountOptions(spec: JobSpec): string {
  const inodes = Math.max(4_096, Math.min(262_144, spec.limits.diskMb * 256));
  return `size=${spec.limits.diskMb}m,nr_inodes=${inodes},uid=${CODING_WORKER_UID},gid=${CODING_WORKER_GID},mode=0700,nosuid,nodev`;
}

export function buildIsolationNetworkCreateArgs(runId: string): string[] {
  const names = isolationNames(runId);
  return [
    "network",
    "create",
    "--driver",
    "bridge",
    "--internal",
    "--ipv6=false",
    "--opt",
    "com.docker.network.bridge.gateway_mode_ipv4=isolated",
    "--opt",
    "com.docker.network.bridge.gateway_mode_ipv6=isolated",
    ...labels(runId),
    names.network,
  ];
}

export function buildStorageVolumeCreateArgs(spec: JobSpec): string[] {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  return [
    "volume",
    "create",
    "--driver",
    "local",
    "--opt",
    "type=tmpfs",
    "--opt",
    "device=tmpfs",
    "--opt",
    `o=${storageMountOptions(spec)}`,
    ...labels(spec.runId),
    names.storageVolume,
  ];
}

export function buildKeeperCreateArgs(spec: JobSpec): string[] {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  const memoryMb = Math.min(65_536, spec.limits.diskMb + 128);
  return [
    "container",
    "create",
    "--name",
    names.keeperContainer,
    "--pull",
    "never",
    "--user",
    `${CODING_WORKER_UID}:${CODING_WORKER_GID}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    "seccomp=builtin",
    "--cgroupns",
    "private",
    "--ipc",
    "none",
    "--cpus",
    "0.25",
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--memory-swappiness",
    "0",
    "--pids-limit",
    "16",
    "--restart",
    "no",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    "--mount",
    `type=volume,src=${names.storageVolume},dst=${WORKER_PATHS.storage},volume-nocopy`,
    ...labels(spec.runId),
    "--entrypoint",
    "node",
    spec.image,
    "/opt/reevo/coding-worker/keeper.js",
  ];
}

export function buildWorkerCreateArgs(spec: JobSpec, proxyPort = CODING_PROXY_PORT): string[] {
  validateSpec(spec);
  assertIntegerRange(proxyPort, 1, 65_535);
  const names = isolationNames(spec.runId);
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  return [
    "container",
    "create",
    "--name",
    names.workerContainer,
    "--pull",
    "never",
    "--user",
    `${CODING_WORKER_UID}:${CODING_WORKER_GID}`,
    "--network",
    names.network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--security-opt",
    "seccomp=builtin",
    "--init",
    "--cgroupns",
    "private",
    "--ipc",
    "none",
    "--cpus",
    String(spec.limits.cpus),
    "--memory",
    `${spec.limits.memoryMb}m`,
    "--memory-swap",
    `${spec.limits.memoryMb}m`,
    "--memory-swappiness",
    "0",
    "--pids-limit",
    String(spec.limits.pids),
    "--shm-size",
    "16m",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${scratchMb}m,mode=1777`,
    "--tmpfs",
    `/home/reevo:rw,noexec,nosuid,nodev,size=${scratchMb}m,uid=${CODING_WORKER_UID},gid=${CODING_WORKER_GID},mode=0700`,
    "--mount",
    `type=volume,src=${names.storageVolume},dst=${WORKER_PATHS.workspace},volume-subpath=workspace,volume-nocopy`,
    "--mount",
    `type=volume,src=${names.storageVolume},dst=${WORKER_PATHS.input},volume-subpath=input,volume-nocopy,readonly`,
    "--mount",
    `type=volume,src=${names.storageVolume},dst=${WORKER_PATHS.output},volume-subpath=output,volume-nocopy`,
    "--env",
    `REEVO_PROXY_URL=http://${CODING_PROXY_ALIAS}:${proxyPort}`,
    "--env",
    "REEVO_RUN_CAPABILITY",
    "--restart",
    "no",
    "--stop-signal",
    "SIGTERM",
    "--stop-timeout",
    String(WORKER_STOP_GRACE_SECONDS),
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    ...labels(spec.runId),
    spec.image,
  ];
}

export function buildProxyNetworkConnectArgs(runId: string, proxyContainer: string): string[] {
  validateDockerObject(proxyContainer);
  return ["network", "connect", "--alias", CODING_PROXY_ALIAS, isolationNames(runId).network, proxyContainer];
}

export function buildDockerIsolationPlan(spec: JobSpec, proxyContainer: string): DockerIsolationPlan {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  return {
    names,
    deadlineMs: spec.timeoutSec * 1_000,
    stopGraceSeconds: WORKER_STOP_GRACE_SECONDS,
    networkCreateArgs: buildIsolationNetworkCreateArgs(spec.runId),
    storageVolumeCreateArgs: buildStorageVolumeCreateArgs(spec),
    keeperCreateArgs: buildKeeperCreateArgs(spec),
    workerCreateArgs: buildWorkerCreateArgs(spec),
    proxyNetworkConnectArgs: buildProxyNetworkConnectArgs(spec.runId, proxyContainer),
  };
}

export function assertDockerHostSupportsIsolation(info: DockerHostInfo): void {
  const securityOptions = info.SecurityOptions ?? [];
  if (
    info.OSType !== "linux" ||
    info.CgroupVersion !== "2" ||
    info.MemoryLimit !== true ||
    info.SwapLimit !== true ||
    info.CpuCfsQuota !== true ||
    info.PidsLimit !== true ||
    !securityOptions.some((option) => option.includes("seccomp")) ||
    !(info.Plugins?.Volume ?? []).includes("local") ||
    !(info.Plugins?.Network ?? []).includes("bridge")
  ) {
    throw isolationError();
  }
}

export function assertIsolationNetworkInspection(network: DockerNetworkInspection, runId: string): void {
  const names = isolationNames(runId);
  if (
    network.Name !== names.network ||
    network.Driver !== "bridge" ||
    network.Internal !== true ||
    network.EnableIPv6 !== false ||
    network.Attachable !== false ||
    network.Ingress !== false ||
    !hasResourceLabels(network.Labels, runId) ||
    network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] !== "isolated" ||
    network.Options?.["com.docker.network.bridge.gateway_mode_ipv6"] !== "isolated"
  ) {
    throw isolationError();
  }
}

export function assertIsolationNetworkParticipants(
  network: DockerNetworkInspection,
  expectedContainerNames: string[],
): void {
  const actual = Object.values(network.Containers ?? {})
    .map((container) => container.Name)
    .filter((name): name is string => Boolean(name))
    .sort();
  const expected = [...expectedContainerNames].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw isolationError();
}

export function assertStorageVolumeInspection(volume: DockerVolumeInspection, spec: JobSpec): void {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  if (
    volume.Name !== names.storageVolume ||
    volume.Driver !== "local" ||
    volume.Options?.type !== "tmpfs" ||
    volume.Options?.device !== "tmpfs" ||
    volume.Options?.o !== storageMountOptions(spec) ||
    !hasResourceLabels(volume.Labels, spec.runId)
  ) {
    throw isolationError();
  }
}

export function assertKeeperContainerInspection(container: DockerContainerInspection, spec: JobSpec): void {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  const host = container.HostConfig;
  const security = host?.SecurityOpt ?? [];
  const mount = container.Mounts?.[0];
  const requestedMount = host?.Mounts?.[0];
  if (
    container.Config?.User !== `${CODING_WORKER_UID}:${CODING_WORKER_GID}` ||
    container.Config?.Image !== spec.image ||
    !hasResourceLabels(container.Config.Labels, spec.runId) ||
    host?.NetworkMode !== "none" ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    (host.Binds?.length ?? 0) !== 0 ||
    (host.CapAdd?.length ?? 0) !== 0 ||
    !host.CapDrop?.includes("ALL") ||
    !security.includes("no-new-privileges=true") ||
    !security.includes("seccomp=builtin") ||
    host.PidsLimit !== 16 ||
    host.RestartPolicy?.Name !== "no" ||
    (container.Mounts?.length ?? 0) !== 1 ||
    mount?.Type !== "volume" ||
    mount.Name !== names.storageVolume ||
    mount.Destination !== WORKER_PATHS.storage ||
    mount.RW !== true ||
    (host.Mounts?.length ?? 0) !== 1 ||
    requestedMount?.Type !== "volume" ||
    requestedMount.Source !== names.storageVolume ||
    requestedMount.Target !== WORKER_PATHS.storage ||
    requestedMount.VolumeOptions?.NoCopy !== true ||
    Object.keys(container.NetworkSettings?.Networks ?? {}).join(",") !== "none"
  ) {
    throw isolationError();
  }
}

export function assertProxyContainerInspection(container: DockerContainerInspection, runId: string): void {
  const internalNetwork = isolationNames(runId).network;
  const networks = container.NetworkSettings?.Networks ?? {};
  const internal = networks[internalNetwork];
  const internalNames = [...(internal?.Aliases ?? []), ...(internal?.DNSNames ?? [])];
  const external = Object.entries(networks).filter(([name]) => name !== internalNetwork);
  if (
    !internal ||
    !internalNames.includes(CODING_PROXY_ALIAS) ||
    internal.Gateway !== "" ||
    external.length < 1 ||
    !external.some(([, network]) => Boolean(network.Gateway))
  ) {
    throw isolationError();
  }
}

function assertExactWorkerMounts(container: DockerContainerInspection, names: DockerIsolationNames): void {
  const expected = new Map<string, boolean>([
    [WORKER_PATHS.workspace, true],
    [WORKER_PATHS.input, false],
    [WORKER_PATHS.output, true],
  ]);
  const mounts = container.Mounts ?? [];
  if (mounts.length !== expected.size) throw isolationError();
  for (const mount of mounts) {
    if (
      mount.Type !== "volume" ||
      mount.Name !== names.storageVolume ||
      !mount.Destination ||
      expected.get(mount.Destination) !== mount.RW
    ) {
      throw isolationError();
    }
  }
  const requested = container.HostConfig?.Mounts ?? [];
  const expectedRequested = new Map<string, { readOnly: boolean; subpath: string }>([
    [WORKER_PATHS.workspace, { readOnly: false, subpath: "workspace" }],
    [WORKER_PATHS.input, { readOnly: true, subpath: "input" }],
    [WORKER_PATHS.output, { readOnly: false, subpath: "output" }],
  ]);
  if (requested.length !== expectedRequested.size) throw isolationError();
  for (const mount of requested) {
    const expectedMount = mount.Target ? expectedRequested.get(mount.Target) : undefined;
    if (
      mount.Type !== "volume" ||
      mount.Source !== names.storageVolume ||
      !expectedMount ||
      Boolean(mount.ReadOnly) !== expectedMount.readOnly ||
      mount.VolumeOptions?.NoCopy !== true ||
      mount.VolumeOptions.Subpath !== expectedMount.subpath
    ) {
      throw isolationError();
    }
  }
}

export function assertWorkerContainerInspection(
  container: DockerContainerInspection,
  spec: JobSpec,
  expectedCapability: string,
): void {
  validateSpec(spec);
  const names = isolationNames(spec.runId);
  const host = container.HostConfig;
  const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
  const security = host?.SecurityOpt ?? [];
  const reevoEnvironment = (container.Config?.Env ?? []).filter((value) => value.startsWith("REEVO_"));
  if (
    container.Config?.User !== `${CODING_WORKER_UID}:${CODING_WORKER_GID}` ||
    container.Config?.Image !== spec.image ||
    !hasResourceLabels(container.Config.Labels, spec.runId) ||
    host?.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    (host.Binds?.length ?? 0) !== 0 ||
    (host.CapAdd?.length ?? 0) !== 0 ||
    !host.CapDrop?.includes("ALL") ||
    host.CgroupnsMode !== "private" ||
    host.IpcMode !== "none" ||
    host.Init !== true ||
    host.Memory !== spec.limits.memoryMb * 1024 * 1024 ||
    host.MemorySwap !== host.Memory ||
    host.PidsLimit !== spec.limits.pids ||
    host.NanoCpus !== Math.round(spec.limits.cpus * 1_000_000_000) ||
    host.ShmSize !== 16 * 1024 * 1024 ||
    host.NetworkMode !== names.network ||
    host.PidMode !== "" ||
    host.RestartPolicy?.Name !== "no" ||
    host.LogConfig?.Type !== "local" ||
    host.LogConfig.Config?.["max-size"] !== "1m" ||
    host.LogConfig.Config?.["max-file"] !== "2" ||
    !security.includes("no-new-privileges=true") ||
    !security.includes("seccomp=builtin") ||
    (host.Devices?.length ?? 0) !== 0 ||
    (host.DeviceRequests?.length ?? 0) !== 0 ||
    (host.Dns?.length ?? 0) !== 0 ||
    (host.DnsOptions?.length ?? 0) !== 0 ||
    (host.DnsSearch?.length ?? 0) !== 0 ||
    (host.ExtraHosts?.length ?? 0) !== 0 ||
    (host.GroupAdd?.length ?? 0) !== 0 ||
    Object.keys(host.PortBindings ?? {}).length !== 0 ||
    host.PublishAllPorts !== false ||
    Object.keys(container.NetworkSettings?.Ports ?? {}).length !== 0 ||
    networks.length !== 1 ||
    networks[0] !== names.network
  ) {
    throw isolationError();
  }
  if (
    reevoEnvironment.length !== 2 ||
    !reevoEnvironment.includes(`REEVO_PROXY_URL=http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`) ||
    !reevoEnvironment.includes(`REEVO_RUN_CAPABILITY=${expectedCapability}`)
  ) {
    throw isolationError();
  }
  const tmpfs = host.Tmpfs ?? {};
  if (!tmpfs["/tmp"]?.includes("noexec") || !tmpfs["/home/reevo"]?.includes("noexec")) throw isolationError();
  assertExactWorkerMounts(container, names);
}
