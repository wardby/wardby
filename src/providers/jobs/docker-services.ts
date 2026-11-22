/**
 * Coding-run services on the Docker launcher (docs/coding-services.md): one hardened container per
 * resolved catalog entry, in the run's network keeper's namespace, so it answers on 127.0.0.1
 * exactly like a Kubernetes sidecar. Pure builders and attestation only: DockerJobLauncher runs
 * and checks them. The image and environment come from the admin-managed catalog snapshot on the
 * spec, never from repository content, and are re-validated here rather than trusted from dispatch.
 */
import { CODING_SERVICE_NAME } from "../../coding/protocol.js";
import { sidecarOnly, StoredCodingServicesSchema, type ResolvedCodingService } from "../../coding/services/catalog.js";
import {
  CODING_WORKER_GID,
  CODING_WORKER_UID,
  DOCKER_ISOLATION_ERROR,
  hasIsolationLabels,
  isolationLabelArgs,
  isolationNames,
  isolationToken,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import { SERVICE_SCRATCH_MIB, serviceEphemeralStorageMib } from "./kubernetes-isolation.js";
import type { JobSpec } from "./types.js";

/** Every Docker run container is PID-bounded; the catalog has no PID field. */
export const SERVICE_PIDS_LIMIT = 512;
/** /dev/shm for a service (PostgreSQL's dynamic shared memory): the Kubernetes default size. */
export const SERVICE_SHM_MIB = 64;

export interface DockerServiceContainer {
  service: ResolvedCodingService;
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

/** The container names of a spec's services, for stop and cleanup: names only, never launch input. */
export function dockerServiceContainerNames(spec: JobSpec): string[] {
  return (spec.services ?? [])
    .filter((service) => CODING_SERVICE_NAME.test(service.name))
    .map((service) => dockerServiceContainerName(spec.runId, service.name));
}

/**
 * Re-validated here, not trusted from dispatch, as the Kubernetes launcher does. Returns the
 * schema's parsed output (defaults such as `serviceEnv`/`writablePaths` filled in), never the raw
 * spec, so a caller never has to guard against a missing default field, and any shape the schema
 * rejects throws the isolation error rather than surfacing as a TypeError further down.
 */
export function validateDockerServices(spec: JobSpec): ResolvedCodingService[] {
  if (spec.services === undefined) return [];
  const names = spec.services.map((service) => service.name);
  if (spec.services.length === 0 || new Set(names).size !== names.length) {
    throw isolationError();
  }
  const parsed = StoredCodingServicesSchema.safeParse(spec.services);
  if (!parsed.success) throw isolationError();
  return parsed.data;
}

/** Its data path at its disk size, then SERVICE_SCRATCH_MIB for each writable path: the Kubernetes sizes. */
export function serviceTmpfsOptions(entry: ResolvedCodingService): Record<string, string> {
  // Type-only change for the toolchain kind (#599): only a sidecar has a data path.
  const service = sidecarOnly(entry);
  const mounts = [
    { path: service.dataPath, sizeMib: service.resources.diskMib },
    ...service.writablePaths.map((path) => ({ path, sizeMib: SERVICE_SCRATCH_MIB })),
  ];
  return Object.fromEntries(
    mounts.map(({ path, sizeMib }) => [
      path,
      `rw,nosuid,nodev,size=${sizeMib}m,uid=${CODING_WORKER_UID},gid=${CODING_WORKER_GID},mode=0700`,
    ]),
  );
}

/** tmpfs pages count against the container's memory cgroup: catalog memory, its disk, and /dev/shm. */
export function serviceMemoryMib(service: ResolvedCodingService): number {
  return service.resources.memoryMib + serviceEphemeralStorageMib(service) + SERVICE_SHM_MIB;
}

export function buildServiceCreateArgs(spec: JobSpec, service: ResolvedCodingService): string[] {
  const names = isolationNames(spec.runId);
  const memoryMib = serviceMemoryMib(service);
  const env = Object.entries(service.serviceEnv)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([name, value]) => ["--env", `${name}=${value}`]);
  return [
    "container",
    "create",
    "--name",
    dockerServiceContainerName(spec.runId, service.name),
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
    service.image,
  ];
}

export function buildDockerServicePlan(spec: JobSpec): DockerServiceContainer[] {
  return validateDockerServices(spec).map((service) => ({
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
  service: ResolvedCodingService,
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
    (host.Mounts?.length ?? 0) !== 0 ||
    (container.Mounts?.length ?? 0) !== 0 ||
    Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 0 ||
    Object.keys(container.NetworkSettings?.Ports ?? {}).length !== 0 ||
    Object.keys(actualTmpfs).length !== Object.keys(expectedTmpfs).length ||
    Object.entries(expectedTmpfs).some(([path, options]) => actualTmpfs[path] !== options) ||
    env.some((value) => value.startsWith("WARDBY_")) ||
    Object.entries(service.serviceEnv).some(([name, value]) => !env.includes(`${name}=${value}`))
  ) {
    throw isolationError();
  }
}
