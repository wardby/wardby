/**
 * Coding-run services on the Docker launcher (docs/coding-services.md): one hardened container per
 * resolved catalog entry, in the run's network keeper's namespace, so it answers on 127.0.0.1
 * exactly like a Kubernetes sidecar. Pure builders and attestation only: DockerJobLauncher runs
 * and checks them. The image and environment come from the admin-managed catalog snapshot on the
 * spec, never from repository content, and are re-validated here rather than trusted from dispatch.
 */
import { CODING_SERVICE_NAME } from "../../coding/protocol.js";
import {
  isSetupService,
  isToolchainService,
  runningServices,
  sidecarOnly,
  StoredCodingServicesSchema,
  withoutDockerServices,
  type NonDockerService,
  type ResolvedSetupService,
  type ResolvedToolchainService,
} from "../../coding/services/catalog.js";
import { TOOLCHAIN_AGENT } from "./claude-tool-setup.js";
import {
  CODING_WORKER_GID,
  CODING_WORKER_UID,
  DOCKER_ISOLATION_ERROR,
  hasIsolationLabels,
  isolationLabelArgs,
  isolationNames,
  isolationToken,
  assertExactMountSet,
  TOOLCHAIN_AGENT_PATH,
  WORKER_PATHS,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import {
  SERVICE_SCRATCH_MIB,
  serviceEphemeralStorageMib,
  TOOLCHAIN_FIXED_ENV,
  TOOLCHAIN_HOME,
} from "./kubernetes-isolation.js";
import type { JobSpec } from "./types.js";

/** Every Docker run container is PID-bounded; the catalog has no PID field. */
export const SERVICE_PIDS_LIMIT = 512;
/** /dev/shm for a service (PostgreSQL's dynamic shared memory): the Kubernetes default size. */
export const SERVICE_SHM_MIB = 64;

export interface DockerServiceContainer {
  service: NonDockerService;
  container: string;
  createArgs: string[];
}

function isolationError(): Error {
  return new Error(DOCKER_ISOLATION_ERROR);
}

export function dockerServiceContainerName(runId: string, serviceName: string): string {
  if (!CODING_SERVICE_NAME.test(serviceName)) throw isolationError();
  return `wardby-svc-${isolationToken(runId)}-${serviceName}`;
}

/** A setup job's container (#589): `wardby-setup-<token>-<name>`, apart from the service containers. */
export function dockerSetupContainerName(runId: string, jobName: string): string {
  if (!CODING_SERVICE_NAME.test(jobName)) throw isolationError();
  return `wardby-setup-${isolationToken(runId)}-${jobName}`;
}

/** The container names of a spec's setup jobs, for stop and cleanup: names only, never launch input. */
export function dockerSetupContainerNames(spec: JobSpec): string[] {
  return (spec.services ?? [])
    .filter((service) => service.kind === "setup" && CODING_SERVICE_NAME.test(service.name))
    .map((service) => dockerSetupContainerName(spec.runId, service.name));
}

/** Where a Docker setup job writes its result file: a small tmpfs of its own (the launcher reads its exit code). */
const SETUP_RESULT_DIR = "/run/wardby/setup";
const SETUP_RESULT_TMPFS_MIB = 1;

/** The container names of a spec's services, for stop and cleanup: names only, never launch input. */
export function dockerServiceContainerNames(spec: JobSpec): string[] {
  // A setup job (#589) is not a service container (its own container is named differently).
  return (spec.services ?? [])
    .filter((service) => service.kind !== "setup" && CODING_SERVICE_NAME.test(service.name))
    .map((service) => dockerServiceContainerName(spec.runId, service.name));
}

/**
 * Re-validated here, not trusted from dispatch, as the Kubernetes launcher does. Returns the
 * schema's parsed output (defaults such as `serviceEnv`/`writablePaths` filled in), never the raw
 * spec, so a caller never has to guard against a missing default field, and any shape the schema
 * rejects throws the isolation error rather than surfacing as a TypeError further down.
 */
export function validateDockerServices(spec: JobSpec): NonDockerService[] {
  if (spec.services === undefined) return [];
  const names = spec.services.map((service) => service.name);
  if (spec.services.length === 0 || new Set(names).size !== names.length) {
    throw isolationError();
  }
  const parsed = StoredCodingServicesSchema.safeParse(spec.services);
  if (!parsed.success) throw isolationError();
  // Dispatch refuses a docker service on this launcher (supportsServiceKind), so one here is a
  // bypassed check: throw the isolation error rather than start anything.
  return withoutDockerServices(parsed.data, DOCKER_ISOLATION_ERROR);
}

/** Its data path at its disk size, then SERVICE_SCRATCH_MIB for each writable path: the Kubernetes sizes. */
export function serviceTmpfsOptions(entry: NonDockerService): Record<string, string> {
  // A toolchain has no data path: its disk backs HOME instead (pip, Poetry and git write there). A
  // setup job (#589) has none either: only its result file's tmpfs and its writable paths.
  const mounts = [
    isSetupService(entry)
      ? { path: SETUP_RESULT_DIR, sizeMib: SETUP_RESULT_TMPFS_MIB }
      : isToolchainService(entry)
        ? { path: TOOLCHAIN_HOME, sizeMib: entry.resources.diskMib }
        : { path: sidecarOnly(entry).dataPath, sizeMib: entry.resources.diskMib },
    ...entry.writablePaths.map((path) => ({ path, sizeMib: SERVICE_SCRATCH_MIB })),
  ];
  return Object.fromEntries(
    mounts.map(({ path, sizeMib }) => [
      path,
      `rw,nosuid,nodev,size=${sizeMib}m,uid=${CODING_WORKER_UID},gid=${CODING_WORKER_GID},mode=0700`,
    ]),
  );
}

/** tmpfs pages count against the container's memory cgroup: catalog memory, its disk, and /dev/shm. */
export function serviceMemoryMib(service: NonDockerService): number {
  return service.resources.memoryMib + serviceEphemeralStorageMib(service) + SERVICE_SHM_MIB;
}

/** The container's environment: serviceEnv, and for a toolchain Wardby's fixed values over it. */
function containerEnvironment(service: NonDockerService): Record<string, string> {
  return isToolchainService(service) ? { ...service.serviceEnv, ...TOOLCHAIN_FIXED_ENV } : service.serviceEnv;
}

/** A toolchain's entrypoint is the command agent from storage `cmd`; the workspace is seeded already. */
const TOOLCHAIN_ENTRYPOINT = `${TOOLCHAIN_AGENT_PATH}/wardby-cmd`;

function toolchainCommand(spec: JobSpec, service: ResolvedToolchainService): string[] {
  const setup = service.setupCommand ?? [];
  return [
    "serve",
    "--listen",
    TOOLCHAIN_AGENT.address,
    "--token-file",
    TOOLCHAIN_AGENT.tokenFile,
    "--wait-timeout-sec",
    String(spec.timeoutSec),
    ...(setup.length > 0 ? ["--", ...setup] : []),
  ];
}

/** A setup job's command (#589): run once from the read-only checkout, its exit code its container's. */
function setupCommand(service: ResolvedSetupService): string[] {
  return [
    "once",
    "--result-file",
    `${SETUP_RESULT_DIR}/result`,
    "--timeout-sec",
    String(service.timeoutSeconds),
    "--",
    ...service.command,
  ];
}

/** What a setup job mounts of the run's storage volume: the checkout and the agent's directory, both read-only. */
function setupMounts(): Array<{ path: string; writable: boolean; subpath: string }> {
  return [
    { path: WORKER_PATHS.workspace, writable: false, subpath: "workspace" },
    // The agent alone (`cmd-bin`), never `cmd` and the toolchain's token.
    { path: TOOLCHAIN_AGENT_PATH, writable: false, subpath: "cmd-bin" },
  ];
}

/** What a toolchain mounts of the run's storage volume: the shared workspace and the agent's directory. */
function toolchainMounts(): Array<{ path: string; writable: boolean; subpath: string }> {
  return [
    { path: WORKER_PATHS.workspace, writable: true, subpath: "workspace" },
    { path: TOOLCHAIN_AGENT_PATH, writable: false, subpath: "cmd" },
  ];
}

export function buildServiceCreateArgs(spec: JobSpec, service: NonDockerService): string[] {
  const names = isolationNames(spec.runId);
  const memoryMib = serviceMemoryMib(service);
  const toolchain = isToolchainService(service) ? service : undefined;
  const setup = isSetupService(service) ? service : undefined;
  const mounts = toolchain ? toolchainMounts() : setup ? setupMounts() : [];
  const env = Object.entries(containerEnvironment(service))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return [
    "container",
    "create",
    "--name",
    setup ? dockerSetupContainerName(spec.runId, service.name) : dockerServiceContainerName(spec.runId, service.name),
    "--pull",
    "never",
    "--user",
    `${CODING_WORKER_UID}:${CODING_WORKER_GID}`,
    "--network",
    `container:${names.networkKeeperContainer}`,
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
    "private",
    "--shm-size",
    `${SERVICE_SHM_MIB}m`,
    "--cpus",
    String(service.resources.cpuMillicores / 1000),
    "--memory",
    `${memoryMib}m`,
    "--memory-swap",
    `${memoryMib}m`,
    "--memory-swappiness",
    "0",
    "--pids-limit",
    String(SERVICE_PIDS_LIMIT),
    ...Object.entries(serviceTmpfsOptions(service)).flatMap(([path, options]) => ["--tmpfs", `${path}:${options}`]),
    // A toolchain (#599) shares the run's workspace and reads the agent from `cmd`; a setup job (#589)
    // reads both read-only; a sidecar mounts nothing.
    ...mounts.flatMap(({ path, writable, subpath }) => [
      "--mount",
      `type=volume,src=${names.storageVolume},dst=${path},volume-subpath=${subpath},volume-nocopy${writable ? "" : ",readonly"}`,
    ]),
    ...env,
    "--restart",
    "no",
    "--log-driver",
    "local",
    "--log-opt",
    "max-size=1m",
    "--log-opt",
    "max-file=2",
    ...isolationLabelArgs(spec.runId),
    ...(toolchain || setup ? ["--entrypoint", TOOLCHAIN_ENTRYPOINT] : []),
    service.image,
    ...(toolchain ? toolchainCommand(spec, toolchain) : setup ? setupCommand(setup) : []),
  ];
}

export function buildDockerServicePlan(spec: JobSpec): DockerServiceContainer[] {
  // Setup jobs (#589) are not service containers: they run once, in containers of their own.
  return runningServices(validateDockerServices(spec)).map((service) => ({
    service,
    container: dockerServiceContainerName(spec.runId, service.name),
    createArgs: buildServiceCreateArgs(spec, service),
  }));
}

/**
 * Before a service starts: exactly the controls buildServiceCreateArgs asked for. No mounts at all,
 * so an image VOLUME outside the entry's dataPath/writablePaths (an anonymous, unbounded host
 * volume) fails here rather than run. Re-validates the spec and requires `service` to be one of its
 * validated entries (by name and version), rather than trusting the caller's pairing of the two.
 */
export function assertServiceContainerInspection(
  container: DockerContainerInspection,
  spec: JobSpec,
  service: NonDockerService,
  networkKeeperId?: string,
): void {
  const validated = validateDockerServices(spec);
  if (!validated.some((entry) => entry.name === service.name && entry.version === service.version)) {
    throw isolationError();
  }
  const names = isolationNames(spec.runId);
  const host = container.HostConfig;
  const security = host?.SecurityOpt ?? [];
  const env = container.Config?.Env ?? [];
  const memory = serviceMemoryMib(service) * 1024 * 1024;
  const networkModes = [
    `container:${names.networkKeeperContainer}`,
    ...(networkKeeperId ? [`container:${networkKeeperId}`] : []),
  ];
  const expectedTmpfs = serviceTmpfsOptions(service);
  const actualTmpfs = host?.Tmpfs ?? {};
  if (
    container.Config?.User !== `${CODING_WORKER_UID}:${CODING_WORKER_GID}` ||
    container.Config.Image !== service.image ||
    !hasIsolationLabels(container.Config.Labels, spec.runId) ||
    host?.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    (host.Binds?.length ?? 0) !== 0 ||
    (host.CapAdd?.length ?? 0) !== 0 ||
    !host.CapDrop?.includes("ALL") ||
    host.CgroupnsMode !== "private" ||
    host.IpcMode !== "private" ||
    host.ShmSize !== SERVICE_SHM_MIB * 1024 * 1024 ||
    host.Memory !== memory ||
    host.MemorySwap !== memory ||
    // cgroup v2 hosts may report this as null after accepting the explicit
    // no-swappiness request; MemorySwap still attests that swap is disabled.
    (host.MemorySwappiness !== 0 && host.MemorySwappiness !== null) ||
    host.PidsLimit !== SERVICE_PIDS_LIMIT ||
    host.NanoCpus !== service.resources.cpuMillicores * 1_000_000 ||
    !networkModes.includes(host.NetworkMode ?? "") ||
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
    (!isToolchainService(service) &&
      !isSetupService(service) &&
      ((host.Mounts?.length ?? 0) !== 0 || (container.Mounts?.length ?? 0) !== 0)) ||
    Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 0 ||
    Object.keys(container.NetworkSettings?.Ports ?? {}).length !== 0 ||
    Object.keys(actualTmpfs).length !== Object.keys(expectedTmpfs).length ||
    Object.entries(expectedTmpfs).some(([path, options]) => actualTmpfs[path] !== options) ||
    env.some((value) => value.startsWith("WARDBY_")) ||
    Object.entries(containerEnvironment(service)).some(([name, value]) => !env.includes(`${name}=${value}`))
  ) {
    throw isolationError();
  }
  if (isSetupService(service)) {
    // Exactly the read-only checkout and agent directory, and `wardby-cmd once` as its entrypoint.
    assertExactMountSet(container, names, setupMounts());
    if (
      JSON.stringify(container.Config?.Entrypoint ?? null) !== JSON.stringify([TOOLCHAIN_ENTRYPOINT]) ||
      JSON.stringify(container.Config?.Cmd ?? null) !== JSON.stringify(setupCommand(service))
    ) {
      throw isolationError();
    }
  }
  if (isToolchainService(service)) {
    // Exactly the workspace and the read-only agent directory, and the agent as its entrypoint.
    assertExactMountSet(container, names, toolchainMounts());
    if (
      JSON.stringify(container.Config?.Entrypoint ?? null) !== JSON.stringify([TOOLCHAIN_ENTRYPOINT]) ||
      JSON.stringify(container.Config?.Cmd ?? null) !== JSON.stringify(toolchainCommand(spec, service))
    ) {
      throw isolationError();
    }
  }
}
