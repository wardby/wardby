/**
 * Canonical Kubernetes isolation policy for one Codex coding run, mirroring
 * docker-isolation.ts. Nothing else constructs run pods or policies; the
 * launcher reads every object back and attests it against these builders
 * before the worker is allowed to start (the seeded-marker gate).
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type {
  V1Container,
  V1EnvVar,
  V1NetworkPolicy,
  V1Pod,
  V1PodSpec,
  V1Secret,
  V1Toleration,
  V1Volume,
  V1VolumeMount,
} from "@kubernetes/client-node";
import {
  DOCKER_SOCKET_DIR,
  DOCKER_SOCKET_PATH,
  isDockerService,
  isToolchainService,
  runningServices,
  runSetupJobs,
  runToolchain,
  sidecarOnly,
  StoredCodingServicesSchema,
  type ResolvedCodingService,
  type ResolvedSetupService,
  type ResolvedDockerService,
  type ResolvedToolchainService,
} from "../../coding/services/catalog.js";
import { MCP_TOKEN_ENV } from "../../coding/mcp-token.js";
import {
  jobRepositoriesValid,
  REPOSITORY_MOUNT_ROOT,
  repositoryStorageDirectories,
  setupAgentScript,
  SETUP_AGENT_DIRECTORY,
  storageInitScript,
  TOOLCHAIN_AGENT_DIRECTORY,
  TOOLCHAIN_DOCKER_DIRECTORY,
  toolchainAgentScript,
  toolchainDockerScript,
} from "./storage-init.js";
import { TOOLCHAIN_AGENT } from "./claude-tool-setup.js";
import { tunnelNoProxy, tunnelProxyEnv } from "../../coding/tunnel-env.js";
import { deriveTunnelToken } from "../../coding/tunnel-token.js";
import type { JobSpec } from "./types.js";
import {
  CLAUDE_CONFIG_PATH,
  CLAUDE_CONFIG_SCRATCH_MIB,
  CLAUDE_TOOL_SETUP_ENV,
  CODING_PROXY_ALIAS,
  CODING_PROXY_DENY_PORT,
  CODING_PROXY_PORT,
  CODING_WORKER_GID,
  CODING_WORKER_UID,
  WORKER_STOP_GRACE_SECONDS,
  claudeToolLimits,
  isRepositoryDigest,
} from "./docker-isolation.js";
import {
  GVISOR_RUNTIME_CLASS,
  KubernetesPlatformError,
  STORAGE_INIT_EPHEMERAL_MIB,
  TOOL_RUNNER_EPHEMERAL_MIB,
  WORKER_EPHEMERAL_MIB,
  conformResources,
  describeMib,
  normalizePlatformMetadata,
  platformProfile,
  podEphemeralStorageMib,
  type KubernetesPlatform,
  type KubernetesPlatformProfile,
} from "./kubernetes-platform.js";

export const KUBERNETES_ISOLATION_ERROR = "kubernetes_isolation_unsupported";
/** Extra seconds past timeoutSec before Kubernetes kills the pod (keeper included). */
export const POD_DEADLINE_GRACE_SECONDS = 300;
export const KEEPER_CONTAINER = "keeper";
export const STORAGE_INIT_CONTAINER = "storage-init";
export const WORKER_CONTAINER = "worker";
/** Claude's credential-free command runner: a native sidecar in the run pod. */
export const TOOL_RUNNER_CONTAINER = "tool-runner";
/** The run Secret's key holding the tool runner's setup (claude-tool-setup.ts). */
export const TOOL_SETUP_SECRET_KEY = "tool-setup";
/** The run Secret's key for the MCP token (a run with MCP tools only); the agent container alone reads it. */
export const MCP_TOKEN_SECRET_KEY = "mcp-token";
/**
 * The run Secret's key for the docker daemon's proxy URL: the run's CONNECT tunnel with its tunnel-only
 * token (tunnelProxyEnv), the same value the agent's shells get. Only on a run with a docker service and
 * the tunnel on (dockerDaemonTunnel); the daemon alone reads it.
 */
export const DOCKER_TUNNEL_PROXY_SECRET_KEY = "docker-tunnel-proxy";
/** The run Secret's key for the tunnel's interception CA certificate (public), mounted for the docker daemon. */
export const DOCKER_TUNNEL_CA_SECRET_KEY = "docker-tunnel-ca";
/** Where the tool runner listens and the agent's relay connects (claude-tool-runner/main.mjs). */
export const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";
const CODEX_ENTRYPOINT = "/opt/wardby/coding-worker/main.js";
const CLAUDE_ENTRYPOINT = "/opt/wardby/claude-coding-worker/main.js";
/** Every service sidecar's container name starts with this (service-postgres, service-redis, ...). */
export const SERVICE_CONTAINER_PREFIX = "service-";
/** Disk-backed scratch for each of a service's writablePaths (a socket directory, /tmp). */
export const SERVICE_SCRATCH_MIB = 64;
/** A toolchain container's view of the command agent and its token (storage `cmd`, read-only). */
export const TOOLCHAIN_AGENT_MOUNT = "/opt/wardby-cmd";
/** A toolchain container's HOME: the run uid isn't in the team image's passwd file (#599). */
export const TOOLCHAIN_HOME = "/home/wardby";
/** The keeper's seeded marker as a toolchain container sees it (storage `input`, read-only). */
const TOOLCHAIN_SEEDED_MARKER = "/run/wardby/input/.seeded";
/** Where a setup job (#589) writes its result file and the worker reads the last one (storage `setup`). */
export const SETUP_RESULT_DIR = "/run/wardby/setup";
const SETUP_STORAGE_DIRECTORY = "setup";
/** A setup job's main container: `setup-<name>`. */
export function setupContainerName(name: string): string {
  return `setup-${name}`;
}
/**
 * Wardby's fixed values on a toolchain container, over its serviceEnv, so setupCommand sees them too;
 * the tool runner sends the same ones with every command (command.mjs toolchainEnvironment). Never a
 * secret.
 */
export const TOOLCHAIN_FIXED_ENV: Readonly<Record<string, string>> = {
  HOME: TOOLCHAIN_HOME,
  USER: "wardby",
  LOGNAME: "wardby",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "/workspace",
};
/**
 * Wardby's further fixed values on a toolchain container when the run also has a `docker` service:
 * DOCKER_HOST (the same socket the tool runner's commands use) and DOCKER_CONFIG, the folder in `cmd`
 * where storage-init put the docker CLI and its compose plugin (toolchainDockerScript). The tool
 * runner sends the same ones with every command, and puts that folder at the end of PATH
 * (command.mjs). Never a secret.
 */
export const TOOLCHAIN_DOCKER_ENV: Readonly<Record<string, string>> = {
  DOCKER_HOST: `unix://${DOCKER_SOCKET_PATH}`,
  DOCKER_CONFIG: `${TOOLCHAIN_AGENT_MOUNT}/${TOOLCHAIN_DOCKER_DIRECTORY}`,
};

export function serviceContainerName(name: string): string {
  return `${SERVICE_CONTAINER_PREFIX}${name}`;
}

/**
 * What a service sidecar reserves of the pod's ephemeral storage: its data volume plus its scratch
 * volumes. A docker service's only disk-backed volume is its home (images, layers, build cache).
 */
export function serviceEphemeralStorageMib(service: ResolvedCodingService): number {
  if (isDockerService(service)) return service.resources.diskMib;
  return service.resources.diskMib + SERVICE_SCRATCH_MIB * service.writablePaths.length;
}

/**
 * A docker service's volumes (dockerServiceSidecar). A run has at most one docker service
 * (StoredCodingServicesSchema), so the names are fixed. The socket, XDG runtime and /tmp volumes are
 * memory-backed: under gVisor a Unix socket is shared across containers only on a memory-backed
 * emptyDir (as TOOL_SOCKET_VOLUME), and rootlesskit keeps its runtime state there. Home is
 * disk-backed at the entry's diskMib: dockerd's data root (~/.local/share/docker) lives in it.
 */
const DOCKER_SOCKET_VOLUME = "docker-socket";
const DOCKER_XDG_VOLUME = "docker-xdg";
const DOCKER_HOME_VOLUME = "docker-home";
const DOCKER_TMP_VOLUME = "docker-tmp";
/** The run Secret's CA key alone, as a file, for the daemon: a directory added to its SSL_CERT_DIR. */
const DOCKER_TUNNEL_CA_VOLUME = "docker-tunnel-ca";
const DOCKER_TUNNEL_CA_DIR = "/wardby/tunnel-ca";
const DOCKER_TUNNEL_CA_FILE = "tunnel-ca.crt";
/** Where the dind-rootless image (Alpine) keeps its system roots; SSL_CERT_DIR replaces the default list, so it is named too. */
const DOCKER_SYSTEM_CERT_DIR = "/etc/ssl/certs";
const DOCKER_XDG_PATH = "/wardby/xdg";
const DOCKER_HOME_PATH = "/home/wardby";
const DOCKER_SOCKET_VOLUME_MIB = 1;
const DOCKER_XDG_VOLUME_MIB = 16;
const DOCKER_TMP_VOLUME_MIB = 64;
/** Memory-backed volume pages count against memory, so the daemon's memory request carries them on top of its entry's. */
export const DOCKER_MEMORY_VOLUMES_MIB = DOCKER_SOCKET_VOLUME_MIB + DOCKER_XDG_VOLUME_MIB + DOCKER_TMP_VOLUME_MIB;
/**
 * dockerd's arguments. The leading `dockerd` makes the dind-rootless image's entrypoint exec
 * rootlesskit with exactly these (anything else and it adds a TLS TCP API on 0.0.0.0:2376).
 * gVisor has no nftables and dockerd cannot set ip_forward there, so no iptables and no bridge:
 * host networking only (Docker's bridge network is also very slow under gVisor). The socket is the
 * only API. No registry mirror and no insecure registry: the daemon pulls (and pushes) like any other
 * HTTPS client in the run, through the run's CONNECT tunnel (dockerDaemonEnv), so only the tunnel's
 * allowlisted hosts are reachable, and an intercepted host gets its credential from the proxy. With the
 * tunnel off, the run's network policy leaves the daemon no way out, and nothing can be pulled.
 */
export const DOCKERD_ARGS: readonly string[] = Object.freeze([
  "dockerd",
  "--iptables=false",
  "--ip6tables=false",
  "--bridge=none",
  `--host=unix://${DOCKER_SOCKET_PATH}`,
]);

/** How a run's docker daemon reaches registries: the run's tunnel, and whether it trusts the interception CA. */
export interface DockerDaemonTunnel {
  /** The run Secret holding DOCKER_TUNNEL_PROXY_SECRET_KEY (and DOCKER_TUNNEL_CA_SECRET_KEY with trustCa). */
  secretName: string;
  trustCa: boolean;
}

/**
 * Whether a run's docker daemon uses the run's tunnel: only with a docker service and the tunnel on, and
 * the interception CA only when the deployment set one. buildRunPod and buildCapabilitySecret both ask
 * this, so the daemon never references a Secret key the Secret lacks.
 */
export function dockerDaemonTunnel(spec: JobSpec): Omit<DockerDaemonTunnel, "secretName"> | undefined {
  if (!spec.tunnelPort || !(spec.services ?? []).some(isDockerService)) return undefined;
  return { trustCa: spec.tunnelCaCert !== undefined };
}

export const STORAGE_ROOT = "/run/wardby/storage";
export const KEEPER_SEEDED_MARKER = `${STORAGE_ROOT}/input/.seeded`;
export const PROXY_POD_LABEL = { "app.kubernetes.io/name": "wardby-coding-proxy" } as const;
/**
 * What every run pod carries and what the proxy's own ingress rule must admit on the deny port.
 * Single source: `runLabels` stamps it, `readProxyWitness` checks the proxy admits it.
 */
export const RUN_COMPONENT_LABEL = { "wardby.io/component": "coding-run" } as const;
/** Kubernetes managed-by label on every run pod. */
export const RUN_MANAGED_BY_LABEL = { "app.kubernetes.io/managed-by": "wardby" } as const;
/** Label on every coding-run pod/Job: the first 40 hex chars of sha256(runId). */
export const RUN_SHA_LABEL = "wardby.io/run-sha256";
export const RUN_SHA_CHARS = 40;
/** The probe proved enforcement: the proxy port connected and the deny port was blocked. */
export const ENFORCEMENT_PROBE_PROVEN = 0;
/** The deny port was reachable: no policy is blocking it, or the policy is not port-scoped. */
export const ENFORCEMENT_PROBE_DENY_REACHABLE = 3;
/** The proxy port itself was unreachable: nothing could be witnessed (proxy down, or only the namespace default-deny is programmed). */
export const ENFORCEMENT_PROBE_PROXY_UNREACHABLE = 4;
/**
 * The deny port answered with an RST: the SYN reached the destination host, so nothing is
 * blocking the path — the port is reachable-but-unserved and witnesses nothing.
 */
export const ENFORCEMENT_PROBE_DENY_REFUSED = 5;
const WORKER_SERVICE_ACCOUNT = "wardby-coding-worker";
export const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

/**
 * The worker waits for the launcher's seeded marker, then runs its provider's entrypoint. On a run
 * with setup jobs (#589) it also waits for the last job's result file, and starts only when it reads
 * 0: a failed job (its own code, or 125 passed down the chain) exits 3 without starting the agent.
 */
function workerGate(entrypoint: string, lastSetupJob?: string): string {
  if (lastSetupJob === undefined) {
    return [
      'const fs = require("node:fs");',
      'const marker = "/run/wardby/input/.seeded";',
      "(function wait() {",
      "  if (fs.existsSync(marker)) {",
      `    import(${JSON.stringify(entrypoint)}).catch(() => { process.exitCode = 1; });`,
      "  } else {",
      "    setTimeout(wait, 250);",
      "  }",
      "})();",
    ].join("\n");
  }
  return [
    'const fs = require("node:fs");',
    'const marker = "/run/wardby/input/.seeded";',
    `const setup = ${JSON.stringify(`${SETUP_RESULT_DIR}/${lastSetupJob}`)};`,
    "(function wait() {",
    "  if (fs.existsSync(marker) && fs.existsSync(setup)) {",
    '    if (fs.readFileSync(setup, "utf8").trim() !== "0") process.exit(3);',
    `    import(${JSON.stringify(entrypoint)}).catch(() => { process.exitCode = 1; });`,
    "  } else {",
    "    setTimeout(wait, 250);",
    "  }",
    "})();",
  ].join("\n");
}

/**
 * The worker's subPath mount sources, created by storage-init (storage-init.ts storageInitScript)
 * owned by the run uid before any regular container starts. Otherwise the kubelet creates them
 * root-owned while setting up the worker's subPath mounts, and the keeper (uid 10001, no
 * capabilities) can't chmod them. A run's extra repositories add their repos/<name> folders.
 */
const STORAGE_DIRECTORIES = ["workspace", "input", "output"] as const;
/**
 * Claude's socket volume: its own memory-backed emptyDir, mounted by the worker and the tool runner
 * only. Under gVisor a Unix socket bound on the disk-backed storage volume is invisible to another
 * container; a memory-backed emptyDir that two containers mount is one tmpfs shared across the
 * sandbox (GKE Autopilot annotates it `share: pod`), so the agent's relay can connect.
 */
const TOOL_SOCKET_VOLUME = "tool-socket";
/** Session resume only: the Claude worker's SDK config dir (docker-isolation.ts CLAUDE_CONFIG_SCRATCH_MIB). */
const CLAUDE_CONFIG_VOLUME = "claude-config";
export { CLAUDE_CONFIG_PATH, CLAUDE_CONFIG_SCRATCH_MIB };
const TOOL_SOCKET_VOLUME_MIB = 1;

/**
 * `reason` is a short, fixed code naming which check failed (never a value from the spec itself,
 * so nothing operator-supplied — an image reference, a limit — ever ends up in the message). It's
 * appended the same way kubernetes-preflight.ts's `failure(check, cause)` tags a canary failure:
 * callers that only match on the bare `KUBERNETES_ISOLATION_ERROR` prefix (a substring match, e.g.
 * `toThrow(KUBERNETES_ISOLATION_ERROR)` or `error.message.startsWith(...)`) are unaffected, while
 * an operator reading the message (or a `this.warn(...)` of it — see kubernetes.ts's `launch()`)
 * gets more than a bare code to go on.
 */
function isolationError(reason?: string): Error {
  return new Error(reason === undefined ? KUBERNETES_ISOLATION_ERROR : `${KUBERNETES_ISOLATION_ERROR}:${reason}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface KubernetesRunNames {
  token: string;
  runSha: string;
  pod: string;
  policy: string;
  record: string;
  secret: string;
}

/**
 * The per-run object names for a run token. The only place the naming scheme lives: the launcher
 * resolves a handle's token through this, so names can never drift between creation and cleanup.
 */
export function kubernetesRunNamesForToken(token: string): Omit<KubernetesRunNames, "runSha"> {
  const base = `wardby-run-${token}`;
  return { token, pod: base, policy: base, record: base, secret: `${base}-cap` };
}

export function kubernetesRunNames(runId: string): KubernetesRunNames {
  if (!RUN_ID.test(runId)) throw isolationError();
  const digest = sha256(runId);
  return { ...kubernetesRunNamesForToken(digest.slice(0, 20)), runSha: digest.slice(0, RUN_SHA_CHARS) };
}

export function runLabels(runId: string): Record<string, string> {
  return {
    ...RUN_MANAGED_BY_LABEL,
    ...RUN_COMPONENT_LABEL,
    [RUN_SHA_LABEL]: kubernetesRunNames(runId).runSha,
  };
}

/** Same grammar as Docker's repository digests; a cluster cannot pull a bare local image ID. */
export function isRegistryDigest(image: string): boolean {
  return isRepositoryDigest(image);
}

function inRange(value: number, min: number, max: number, integer: boolean): boolean {
  return Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
}

/** Whether `value` is within floating-point rounding error of an integer. */
function isNearInteger(value: number, tolerance = 1e-9): boolean {
  return Math.abs(Math.round(value) - value) < tolerance;
}

/** Kubernetes CPU requests/limits are always whole millicores; a fractional millicore can't be expressed. */
function isWholeMillicores(cpus: number): boolean {
  return isNearInteger(cpus * 1000);
}

export function validateKubernetesSpec(spec: JobSpec): void {
  if (spec.kind !== "coding-agent" || !RUN_ID.test(spec.runId)) throw isolationError("run-id");
  if (spec.provider !== undefined && spec.provider !== "codex" && spec.provider !== "claude-code") {
    throw isolationError("provider");
  }
  if (spec.provider === "claude-code") {
    if (spec.toolImage === undefined || !isRegistryDigest(spec.toolImage)) {
      throw isolationError("tool-image-not-registry-digest");
    }
    // Docker's floor for the same split (docker-isolation.ts validateSpec): the tool runner takes 0.25 CPU and ≥128 MiB.
    if (spec.limits.cpus < 0.35 || spec.limits.memoryMb < 256) throw isolationError("claude-limits-too-small");
  } else if (spec.toolImage !== undefined) {
    throw isolationError("tool-image-set");
  }
  if (spec.sessionResume !== undefined && (spec.sessionResume !== true || spec.provider !== "claude-code")) {
    throw isolationError("session-resume-not-claude");
  }
  if (spec.mcpTools !== undefined && spec.mcpTools !== true) throw isolationError("mcp-tools-invalid");
  if (!isRegistryDigest(spec.image)) throw isolationError("image-not-registry-digest");
  if (spec.services !== undefined) {
    // Re-validated here, not trusted from dispatch: every image a digest, every path and probe in bounds.
    const names = spec.services.map((service) => service.name);
    if (
      spec.services.length === 0 ||
      new Set(names).size !== names.length ||
      !StoredCodingServicesSchema.safeParse(spec.services).success
    ) {
      throw isolationError("services-invalid");
    }
    // A toolchain runs the commands only the Claude tool runner forwards today (#599); one per run.
    const toolchains = spec.services.filter(isToolchainService).length;
    if (toolchains > 1 || (toolchains === 1 && spec.provider !== "claude-code")) {
      throw isolationError("toolchain-invalid");
    }
    // An alias may never take over the name the worker reaches the coding proxy by.
    if (runToolchain(spec.services)?.hostAliases?.includes(CODING_PROXY_ALIAS)) {
      throw isolationError("toolchain-host-alias-reserved");
    }
  }
  // Names, access and count only; the launcher checks each hostPath against its workspace root.
  if (!jobRepositoriesValid(spec)) throw isolationError("repositories-invalid");
  const { cpus, memoryMb, pids, diskMb } = spec.limits;
  if (!inRange(cpus, 0.1, 32, false) || !isWholeMillicores(cpus)) throw isolationError("cpus-out-of-range");
  if (!inRange(memoryMb, 128, 65_536, true)) throw isolationError("memory-out-of-range");
  if (!inRange(pids, 16, 4_096, true)) throw isolationError("pids-out-of-range");
  if (!inRange(diskMb, 64, 32_768, true)) throw isolationError("disk-out-of-range");
  if (!inRange(spec.timeoutSec, 1, 86_400, true)) throw isolationError("timeout-out-of-range");
}

function containerSecurity() {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"] },
  };
}

/**
 * The docker service's container security context, and only its (dockerServiceSidecar): every other
 * container keeps containerSecurity(). rootlesskit runs newuidmap/newgidmap to map the daemon's user
 * namespace, which needs SETUID and SETGID, and they only work while privilege escalation is
 * possible: allowPrivilegeEscalation is left out (explicitly false breaks newuidmap; explicitly true
 * is refused by some platforms' admission). No runAsUser/runAsGroup: it runs as the pod's run uid
 * and gid, so root in its user namespace maps to the run uid outside, and the socket it creates is
 * owned by the run uid the worker and tool runner use. Not privileged, read-only root filesystem,
 * every other capability dropped, the pod's RuntimeDefault seccomp profile. gVisor remains the
 * boundary to the node (buildRunPod requires it with a docker service).
 */
function dockerServiceSecurity() {
  return {
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    capabilities: { drop: ["ALL"], add: ["SETUID", "SETGID"] },
  };
}

/**
 * The emptyDirs behind one service's mounts. A sidecar's: its data path, then each writable path,
 * disk-backed. A docker service's: its socket, XDG runtime, home and /tmp volumes. The only place
 * their names are built, so the sidecar's volumeMounts and the pod's volumes can never disagree.
 */
function serviceStorage(
  entry: ResolvedCodingService,
  index: number,
): Array<{ name: string; mountPath: string; sizeMib: number; memory?: true }> {
  if (isDockerService(entry)) {
    return [
      { name: DOCKER_SOCKET_VOLUME, mountPath: DOCKER_SOCKET_DIR, sizeMib: DOCKER_SOCKET_VOLUME_MIB, memory: true },
      { name: DOCKER_XDG_VOLUME, mountPath: DOCKER_XDG_PATH, sizeMib: DOCKER_XDG_VOLUME_MIB, memory: true },
      { name: DOCKER_HOME_VOLUME, mountPath: DOCKER_HOME_PATH, sizeMib: entry.resources.diskMib },
      { name: DOCKER_TMP_VOLUME, mountPath: "/tmp", sizeMib: DOCKER_TMP_VOLUME_MIB, memory: true },
    ];
  }
  const scratch = entry.writablePaths.map((path, n) => ({
    name: `service-${index}-scratch-${n}`,
    mountPath: path,
    sizeMib: SERVICE_SCRATCH_MIB,
  }));
  // A toolchain has no data path: its disk backs HOME instead (pip, Poetry and git write there).
  if (isToolchainService(entry)) {
    return [{ name: `service-${index}-home`, mountPath: TOOLCHAIN_HOME, sizeMib: entry.resources.diskMib }, ...scratch];
  }
  const service = sidecarOnly(entry);
  return [
    { name: `service-${index}-data`, mountPath: service.dataPath, sizeMib: service.resources.diskMib },
    ...scratch,
  ];
}

/**
 * A docker service as a native sidecar (docs/coding-services.md): rootless dockerd from the
 * catalog's image (wardby-docker-service, src/docker-service/Dockerfile: docker:*-dind-rootless with a
 * subuid/subgid range for the run uid). wardby sets everything but the image and resources: DOCKERD_ARGS, the
 * environment (iptables-legacy for gVisor; HOME and XDG_RUNTIME_DIR on its writable volumes; the
 * run's tunnel, dockerDaemonEnv), dockerServiceSecurity(), and a startup probe that holds the keeper
 * and worker until the socket exists. Its one secret value, only with the tunnel on, is the run's
 * tunnel-only token inside its proxy URL: never the capability, no WARDBY_* variable. The agent's
 * shells hold the same token and drive this daemon through its socket, so the daemon can reach nothing
 * the agent can't. Its output goes to the container's log only. The worker (Codex) or tool runner
 * (Claude Code) mounts the socket volume, and DOCKER_HOST (its testEnv) points the agent's docker CLI
 * at it.
 */
function dockerServiceSidecar(
  service: ResolvedDockerService,
  profile: KubernetesPlatformProfile,
  tunnel?: DockerDaemonTunnel,
  repositoryMounts: readonly V1VolumeMount[] = [],
): V1Container {
  return {
    name: serviceContainerName(service.name),
    image: service.image,
    restartPolicy: "Always",
    args: [...DOCKERD_ARGS],
    env: dockerDaemonEnv(tunnel),
    securityContext: dockerServiceSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: service.resources.cpuMillicores,
      memoryMib: service.resources.memoryMib + DOCKER_MEMORY_VOLUMES_MIB,
      ephemeralStorageMib: serviceEphemeralStorageMib(service),
    }),
    startupProbe: {
      exec: { command: ["test", "-S", DOCKER_SOCKET_PATH] },
      periodSeconds: 2,
      timeoutSeconds: 1,
      failureThreshold: 60,
      successThreshold: 1,
    },
    volumeMounts: [
      ...serviceStorage(service, 0).map(({ name, mountPath }) => ({ name, mountPath })),
      ...(tunnel?.trustCa ? [{ name: DOCKER_TUNNEL_CA_VOLUME, mountPath: DOCKER_TUNNEL_CA_DIR, readOnly: true }] : []),
      // The checkout at the same path as in the agent's shells, so a bind mount from the repository (a
      // compose file's `.:/app`) resolves to the run's files and not to an empty directory in the daemon.
      // The agent already writes /workspace and drives the daemon through its socket: nothing new reachable.
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      ...repositoryMounts,
    ],
  };
}

/**
 * The daemon's environment. With the tunnel: HTTP(S)_PROXY in both cases from the run Secret (the
 * value carries the tunnel token, so it never sits in the pod spec), and NO_PROXY as the agent's
 * shells have it. With the interception CA: SSL_CERT_DIR adds it beside the image's system roots, so a
 * blind tunnelled host still verifies against those. Go reads SSL_CERT_DIR for the daemon's registry
 * client; rootlesskit passes the environment through.
 */
function dockerDaemonEnv(tunnel?: DockerDaemonTunnel): V1EnvVar[] {
  const env: V1EnvVar[] = [
    { name: "DOCKER_IPTABLES_LEGACY", value: "1" },
    { name: "HOME", value: DOCKER_HOME_PATH },
    { name: "XDG_RUNTIME_DIR", value: DOCKER_XDG_PATH },
  ];
  if (!tunnel) return env;
  const proxy = { secretKeyRef: { name: tunnel.secretName, key: DOCKER_TUNNEL_PROXY_SECRET_KEY } };
  const noProxy = tunnelNoProxy(CODING_PROXY_ALIAS);
  return [
    ...env,
    { name: "HTTPS_PROXY", valueFrom: proxy },
    { name: "https_proxy", valueFrom: proxy },
    { name: "HTTP_PROXY", valueFrom: proxy },
    { name: "http_proxy", valueFrom: proxy },
    { name: "NO_PROXY", value: noProxy },
    { name: "no_proxy", value: noProxy },
    ...(tunnel.trustCa ? [{ name: "SSL_CERT_DIR", value: `${DOCKER_SYSTEM_CERT_DIR}:${DOCKER_TUNNEL_CA_DIR}` }] : []),
  ];
}

/** The docker service's socket volume, for the container that runs the agent's shell commands; none without one. */
function dockerSocketMounts(services: readonly ResolvedCodingService[]): Array<{ name: string; mountPath: string }> {
  return services.some(isDockerService) ? [{ name: DOCKER_SOCKET_VOLUME, mountPath: DOCKER_SOCKET_DIR }] : [];
}

/**
 * One coding-run service as a native sidecar (docs/coding-services.md): an init container with
 * restartPolicy Always, so the kubelet starts it before the keeper and worker and holds them until
 * its startup probe (the catalog's readiness command) passes. It runs the catalog's image with its
 * own entrypoint, under the same security context as every other container, with an emptyDir at its
 * data path and at each writable path. Same pod, same network namespace: the worker reaches it on
 * 127.0.0.1, and the run's NetworkPolicy needs no change. A docker service is dockerServiceSidecar.
 */
function serviceSidecar(
  entry: ResolvedCodingService,
  index: number,
  profile: KubernetesPlatformProfile,
  timeoutSec: number,
  withDocker: boolean,
  dockerTunnel?: DockerDaemonTunnel,
  repositoryMounts: readonly V1VolumeMount[] = [],
): V1Container {
  if (isToolchainService(entry)) return toolchainSidecar(entry, index, profile, timeoutSec, withDocker);
  if (isDockerService(entry)) return dockerServiceSidecar(entry, profile, dockerTunnel, repositoryMounts);
  const service = sidecarOnly(entry);
  const env = Object.entries(service.serviceEnv)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  return {
    name: serviceContainerName(service.name),
    image: service.image,
    restartPolicy: "Always",
    ...(env.length > 0 ? { env } : {}),
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: service.resources.cpuMillicores,
      memoryMib: service.resources.memoryMib,
      ephemeralStorageMib: serviceEphemeralStorageMib(service),
    }),
    startupProbe: {
      exec: { command: [...service.readiness.command] },
      periodSeconds: service.readiness.periodSeconds,
      timeoutSeconds: service.readiness.timeoutSeconds,
      failureThreshold: service.readiness.failureThreshold,
      successThreshold: 1,
    },
    volumeMounts: serviceStorage(service, index).map(({ name, mountPath }) => ({ name, mountPath })),
  };
}

/**
 * A run's toolchain (#599, docs/coding-services.md): the team's image, unchanged, as a
 * native sidecar whose entrypoint is Wardby's command agent from storage `cmd`. It shares /workspace
 * with the tool runner, which forwards every run_command to it over the pod's loopback (the token in
 * `cmd` keeps other service containers out: they never mount it). The agent waits for the keeper's
 * seeded marker before setupCommand, so its startup probe only checks that it listens: the keeper seeds
 * after every sidecar is ready, and a probe that waited for setup would deadlock the pod.
 * With a `docker` service in the run (`withDocker`), the run's commands run here, so it mounts the
 * daemon's socket volume like the tool runner and gets TOOLCHAIN_DOCKER_ENV.
 */
function toolchainSidecar(
  service: ResolvedToolchainService,
  index: number,
  profile: KubernetesPlatformProfile,
  timeoutSec: number,
  withDocker: boolean,
): V1Container {
  const agent = `${TOOLCHAIN_AGENT_MOUNT}/wardby-cmd`;
  const env = Object.entries({
    ...service.serviceEnv,
    ...TOOLCHAIN_FIXED_ENV,
    ...(withDocker ? TOOLCHAIN_DOCKER_ENV : {}),
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  const setup = service.setupCommand ?? [];
  return {
    name: serviceContainerName(service.name),
    image: service.image,
    restartPolicy: "Always",
    command: [
      agent,
      "serve",
      "--listen",
      TOOLCHAIN_AGENT.address,
      "--token-file",
      TOOLCHAIN_AGENT.tokenFile,
      "--wait-file",
      TOOLCHAIN_SEEDED_MARKER,
      "--wait-timeout-sec",
      String(timeoutSec),
      ...(setup.length > 0 ? ["--", ...setup] : []),
    ],
    env,
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: service.resources.cpuMillicores,
      memoryMib: service.resources.memoryMib,
      ephemeralStorageMib: serviceEphemeralStorageMib(service),
    }),
    startupProbe: {
      exec: { command: [agent, "ready", TOOLCHAIN_AGENT.address] },
      periodSeconds: 1,
      timeoutSeconds: 5,
      failureThreshold: 60,
      successThreshold: 1,
    },
    volumeMounts: [
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "storage", mountPath: TOOLCHAIN_AGENT_MOUNT, subPath: TOOLCHAIN_AGENT_DIRECTORY, readOnly: true },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      ...serviceStorage(service, index).map(({ name, mountPath }) => ({ name, mountPath })),
      // The run's commands run here, so it holds the docker service's socket too (none without one).
      ...(withDocker ? [{ name: DOCKER_SOCKET_VOLUME, mountPath: DOCKER_SOCKET_DIR }] : []),
    ],
  };
}

/** A setup job's scratch emptyDirs, one per writable path: `setup-<i>-scratch-<n>` (i counts from 1). */
function setupScratch(job: ResolvedSetupService, index: number): Array<{ name: string; mountPath: string }> {
  return job.writablePaths.map((path, n) => ({ name: `setup-${index + 1}-scratch-${n}`, mountPath: path }));
}

/**
 * One setup job (#589, docs/coding-services.md) as a main container: the catalog image with Wardby's
 * `wardby-cmd once` as its entrypoint, so the image needs no shell. It waits for the keeper's seeded
 * marker (the checkout is copied in only after every sidecar is ready, so a job can't be an init
 * container) and for the job before it, runs the entry's command from the checkout mounted read-only,
 * and writes its exit code to its result file. The launcher fails the run on a non-zero exit.
 */
function setupContainer(
  job: ResolvedSetupService,
  index: number,
  previous: ResolvedSetupService | undefined,
  profile: KubernetesPlatformProfile,
): V1Container {
  const env = Object.entries(job.serviceEnv)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  return {
    name: setupContainerName(job.name),
    image: job.image,
    command: [
      `${TOOLCHAIN_AGENT_MOUNT}/wardby-cmd`,
      "once",
      "--result-file",
      `${SETUP_RESULT_DIR}/${job.name}`,
      "--wait-file",
      TOOLCHAIN_SEEDED_MARKER,
      ...(previous ? ["--after-file", `${SETUP_RESULT_DIR}/${previous.name}`] : []),
      "--timeout-sec",
      String(job.timeoutSeconds),
      "--",
      ...job.command,
    ],
    ...(env.length > 0 ? { env } : {}),
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: job.resources.cpuMillicores,
      memoryMib: job.resources.memoryMib,
      ephemeralStorageMib: Math.max(SERVICE_SCRATCH_MIB, SERVICE_SCRATCH_MIB * job.writablePaths.length),
    }),
    volumeMounts: [
      { name: "storage", mountPath: "/workspace", subPath: "workspace", readOnly: true },
      // The agent alone (`cmd-bin`), never `cmd` and its token.
      { name: "storage", mountPath: TOOLCHAIN_AGENT_MOUNT, subPath: SETUP_AGENT_DIRECTORY, readOnly: true },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: SETUP_RESULT_DIR, subPath: SETUP_STORAGE_DIRECTORY },
      ...setupScratch(job, index),
    ],
  };
}

function serviceVolumes(services: readonly ResolvedCodingService[]): V1Volume[] {
  // Setup jobs (#589) are not sidecars: they get containers (and volumes) of their own.
  return runningServices(services).flatMap((service, index) =>
    serviceStorage(service, index).map(({ name, sizeMib, memory }) => ({
      name,
      emptyDir: { ...(memory ? { medium: "Memory" } : {}), sizeLimit: `${sizeMib}Mi` },
    })),
  );
}

export interface RunPodOptions {
  namespace: string;
  proxyIp: string;
  runtimeClassName?: string;
  /** Emitted only when set, so an unconfigured launcher submits exactly the pod it always has. */
  priorityClassName?: string;
  /** Which platform's admission rules the emitted resources must already satisfy. Default: "generic". */
  platform?: KubernetesPlatform;
}

export function buildRunPod(spec: JobSpec, options: RunPodOptions): V1Pod {
  validateKubernetesSpec(spec);
  const profile = platformProfile(options.platform ?? "generic");
  // Symmetric with the ceiling check below: the builder is the one place that actually emits the
  // pod, so a platform that requires gVisor must refuse to build one without it here too, not rely
  // solely on composition/preflight having already checked. Otherwise buildRunPod(spec, { platform:
  // "gke-autopilot" }) with no runtimeClassName would silently emit runtimeClassName: undefined.
  if (profile.requiresGvisor && options.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
    throw new KubernetesPlatformError(
      `platform ${profile.name} requires runtimeClassName=${GVISOR_RUNTIME_CLASS} (found ${options.runtimeClassName ?? "unset"})`,
    );
  }
  // conformResources range-checks one container at a time; only this function sees every container,
  // so the SUMMED pod total is checked here — before submission, so an over-large workspace fails
  // closed rather than being rewritten by the platform (which attestation would then reject anyway).
  const services = spec.services ?? [];
  // A docker service's daemon is kept from the node by gVisor alone (dockerServiceSecurity), so it is
  // never built without it, whatever the launcher's own check (supportsServiceKind) said.
  if (services.some(isDockerService) && options.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
    throw isolationError("docker-service-needs-gvisor");
  }
  const dockerSocket = dockerSocketMounts(services);
  const ceiling = profile.resources.ephemeralStorageCeilingMib;
  const podEphemeral = podEphemeralStorageMib(
    spec.limits.diskMb,
    services.reduce((total, service) => total + serviceEphemeralStorageMib(service), 0),
  );
  if (ceiling !== undefined && podEphemeral > ceiling) {
    throw new KubernetesPlatformError(
      `a ${spec.limits.diskMb} MiB workspace${services.length > 0 ? " and its services" : ""} need${services.length > 0 ? "" : "s"} ${podEphemeral} MiB of pod ephemeral storage, over the ${describeMib(ceiling)} ceiling of platform ${profile.name}`,
    );
  }
  const names = kubernetesRunNames(spec.runId);
  const daemonTunnel = dockerDaemonTunnel(spec);
  const dockerTunnel = daemonTunnel && { ...daemonTunnel, secretName: names.secret };
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  const sidecarCpuMillicores = 250;
  const sidecarMemoryMib = 128;
  const claude = spec.provider === "claude-code";
  const toolchain = runToolchain(services) !== undefined;
  const setupJobs = runSetupJobs(services);
  const toolchainAliases = [...(runToolchain(services)?.hostAliases ?? [])];
  const tool = claudeToolLimits(spec);
  const toolScratchMb = Math.max(16, Math.min(64, Math.floor(tool.memoryMb / 8)));
  // Each extra repository beside /workspace, in the containers that mount it (never Claude's agent).
  const repositoryMounts = (spec.repositories ?? []).map((r) => ({
    name: "storage",
    mountPath: `${REPOSITORY_MOUNT_ROOT}/${r.name}`,
    subPath: `repos/${r.name}`,
    ...(r.access === "read" ? { readOnly: true } : {}),
  }));
  const storageInit: V1Container = {
    name: STORAGE_INIT_CONTAINER,
    image: spec.image,
    command: [
      "node",
      "-e",
      [
        storageInitScript(STORAGE_ROOT, [
          ...STORAGE_DIRECTORIES,
          ...repositoryStorageDirectories(spec),
          ...(toolchain ? [TOOLCHAIN_AGENT_DIRECTORY] : []),
          ...(setupJobs.length > 0 ? [SETUP_AGENT_DIRECTORY, SETUP_STORAGE_DIRECTORY] : []),
        ]),
        // The command agent and the run's token for a toolchain (#599), in `cmd`.
        ...(toolchain ? [toolchainAgentScript(STORAGE_ROOT)] : []),
        // The agent alone for setup jobs (#589), in `cmd-bin`: never the token, which would let a job
        // command the toolchain (writable /workspace) over the shared loopback.
        ...(setupJobs.length > 0 ? [setupAgentScript(STORAGE_ROOT)] : []),
        // With a docker service too, the toolchain gets the docker CLI the same way.
        ...(toolchain && dockerSocket.length > 0 ? [toolchainDockerScript(STORAGE_ROOT)] : []),
      ].join("\n"),
    ],
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: sidecarCpuMillicores,
      memoryMib: sidecarMemoryMib,
      ephemeralStorageMib: STORAGE_INIT_EPHEMERAL_MIB,
    }),
    volumeMounts: [{ name: "storage", mountPath: STORAGE_ROOT }],
  };
  const keeper: V1Container = {
    name: KEEPER_CONTAINER,
    image: spec.image,
    command: ["node", "/opt/wardby/coding-worker/keeper.js"],
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: sidecarCpuMillicores,
      memoryMib: sidecarMemoryMib,
      // The keeper owns the storage volume: seeding and collection stream through it.
      ephemeralStorageMib: spec.limits.diskMb,
    }),
    volumeMounts: [{ name: "storage", mountPath: STORAGE_ROOT }],
    readinessProbe: { exec: { command: ["test", "-d", `${STORAGE_ROOT}/output`] }, periodSeconds: 1 },
  };
  const worker: V1Container = {
    name: WORKER_CONTAINER,
    image: spec.image,
    command: ["node", "-e", workerGate(claude ? CLAUDE_ENTRYPOINT : CODEX_ENTRYPOINT, setupJobs.at(-1)?.name)],
    env: [
      { name: "WARDBY_PROXY_URL", value: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}` },
      { name: "WARDBY_RUN_CAPABILITY", valueFrom: { secretKeyRef: { name: names.secret, key: "capability" } } },
      // A run with MCP tools only: the agent's bearer for the proxy's /mcp route. Never the tool runner's.
      ...(spec.mcpTools
        ? [{ name: MCP_TOKEN_ENV, valueFrom: { secretKeyRef: { name: names.secret, key: MCP_TOKEN_SECRET_KEY } } }]
        : []),
    ],
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: Math.round((claude ? spec.limits.cpus - tool.cpus : spec.limits.cpus) * 1000),
      memoryMib: claude ? spec.limits.memoryMb - tool.memoryMb : spec.limits.memoryMb,
      ephemeralStorageMib: claude ? WORKER_EPHEMERAL_MIB - TOOL_RUNNER_EPHEMERAL_MIB : WORKER_EPHEMERAL_MIB,
    }),
    // Claude's agent never sees the repository: the tool runner does, over the socket.
    volumeMounts: [
      ...(claude
        ? [
            { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
            { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
            { name: TOOL_SOCKET_VOLUME, mountPath: "/run/wardby/tool" },
            { name: "tmp", mountPath: "/tmp" },
            { name: "home", mountPath: "/home/wardby" },
            // Session resume: the SDK's config dir, where the session file grows, off /tmp's budget.
            ...(spec.sessionResume ? [{ name: CLAUDE_CONFIG_VOLUME, mountPath: CLAUDE_CONFIG_PATH }] : []),
          ]
        : [
            { name: "storage", mountPath: "/workspace", subPath: "workspace" },
            ...repositoryMounts,
            { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
            { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
            { name: "tmp", mountPath: "/tmp" },
            { name: "home", mountPath: "/home/wardby" },
            // Codex runs the agent's shell commands itself, so it holds the docker service's socket.
            ...dockerSocket,
          ]),
      // The setup jobs' result files (#589): the gate reads the last one before starting the agent.
      ...(setupJobs.length > 0
        ? [{ name: "storage", mountPath: SETUP_RESULT_DIR, subPath: SETUP_STORAGE_DIRECTORY, readOnly: true }]
        : []),
    ],
  };
  /**
   * Claude's tool runner (docs/coding-worker-isolation.md): a native sidecar, so the kubelet starts it
   * before the keeper and worker and holds them until its socket exists. It mounts the workspace and
   * the socket, gets its registry/service setup from the run's Secret, and never the capability. It
   * shares the pod's network namespace, so the run's single egress rule (the proxy) applies to it too.
   */
  const toolRunner: V1Container | undefined = claude
    ? {
        name: TOOL_RUNNER_CONTAINER,
        image: spec.toolImage,
        command: ["node", "/opt/wardby/claude-tool-runner/main.mjs"],
        restartPolicy: "Always",
        env: [
          {
            name: CLAUDE_TOOL_SETUP_ENV,
            valueFrom: { secretKeyRef: { name: names.secret, key: TOOL_SETUP_SECRET_KEY } },
          },
        ],
        securityContext: containerSecurity(),
        resources: conformResources(profile, {
          cpuMillicores: Math.round(tool.cpus * 1000),
          memoryMib: tool.memoryMb,
          ephemeralStorageMib: TOOL_RUNNER_EPHEMERAL_MIB,
        }),
        startupProbe: {
          exec: { command: ["test", "-S", TOOL_SOCKET_PATH] },
          periodSeconds: 1,
          timeoutSeconds: 1,
          failureThreshold: 60,
          successThreshold: 1,
        },
        volumeMounts: [
          { name: "storage", mountPath: "/workspace", subPath: "workspace" },
          ...repositoryMounts,
          { name: TOOL_SOCKET_VOLUME, mountPath: "/run/wardby/tool" },
          { name: "tool-tmp", mountPath: "/tmp" },
          { name: "tool-home", mountPath: "/home/wardby" },
          // The command agent's client runs here and reads the run's token (#599).
          ...(toolchain
            ? [
                {
                  name: "storage",
                  mountPath: TOOLCHAIN_AGENT_MOUNT,
                  subPath: TOOLCHAIN_AGENT_DIRECTORY,
                  readOnly: true,
                },
              ]
            : []),
          // Claude's shell commands run here, never in its agent, so only the tool runner holds the docker socket.
          ...dockerSocket,
        ],
      }
    : undefined;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: names.pod,
      namespace: options.namespace,
      labels: runLabels(spec.runId),
      annotations: { "wardby.io/run-id": spec.runId },
    },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      serviceAccountName: WORKER_SERVICE_ACCOUNT,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      // Backstop only: the launcher enforces the wall-clock deadline; the grace leaves a collection window.
      activeDeadlineSeconds: spec.timeoutSec + POD_DEADLINE_GRACE_SECONDS,
      terminationGracePeriodSeconds: WORKER_STOP_GRACE_SECONDS,
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      hostAliases: [
        { ip: options.proxyIp, hostnames: [CODING_PROXY_ALIAS] },
        // The toolchain's hard-coded service names (#599): every service listens on the pod's loopback.
        ...(toolchainAliases.length > 0 ? [{ ip: "127.0.0.1", hostnames: toolchainAliases }] : []),
      ],
      ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
      // Part of the submitted spec, so attestation compares it like any other field; the
      // `priority` and `preemptionPolicy` the API server resolves from it are normalized away.
      ...(options.priorityClassName ? { priorityClassName: options.priorityClassName } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: CODING_WORKER_UID,
        runAsGroup: CODING_WORKER_GID,
        fsGroup: CODING_WORKER_GID,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        { name: "storage", emptyDir: { sizeLimit: `${spec.limits.diskMb}Mi` } },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
        { name: "home", emptyDir: { medium: "Memory", sizeLimit: `${scratchMb}Mi` } },
        ...(claude
          ? [
              { name: TOOL_SOCKET_VOLUME, emptyDir: { medium: "Memory", sizeLimit: `${TOOL_SOCKET_VOLUME_MIB}Mi` } },
              { name: "tool-tmp", emptyDir: { medium: "Memory", sizeLimit: `${toolScratchMb}Mi` } },
              { name: "tool-home", emptyDir: { medium: "Memory", sizeLimit: `${toolScratchMb}Mi` } },
              ...(spec.sessionResume
                ? [
                    {
                      name: CLAUDE_CONFIG_VOLUME,
                      emptyDir: { medium: "Memory", sizeLimit: `${CLAUDE_CONFIG_SCRATCH_MIB}Mi` },
                    },
                  ]
                : []),
            ]
          : []),
        ...serviceVolumes(services),
        ...(dockerTunnel?.trustCa
          ? [
              {
                name: DOCKER_TUNNEL_CA_VOLUME,
                // defaultMode is set so the API server has nothing to default on read-back (attestation).
                secret: {
                  secretName: names.secret,
                  items: [{ key: DOCKER_TUNNEL_CA_SECRET_KEY, path: DOCKER_TUNNEL_CA_FILE }],
                  defaultMode: 0o444,
                },
              },
            ]
          : []),
        ...setupJobs.flatMap((job, index) =>
          setupScratch(job, index).map(({ name }) => ({ name, emptyDir: { sizeLimit: `${SERVICE_SCRATCH_MIB}Mi` } })),
        ),
      ],
      // storage-init first (it must finish before any subPath mount), then Claude's tool runner, then each
      // service sidecar in declaration order; the keeper and worker start only once every sidecar started.
      initContainers: [
        storageInit,
        ...(toolRunner ? [toolRunner] : []),
        // Setup jobs (#589) are not sidecars: they get containers of their own, so none is built here.
        ...runningServices(services).map((service, index) =>
          serviceSidecar(
            service,
            index,
            profile,
            spec.timeoutSec,
            dockerSocket.length > 0,
            dockerTunnel,
            repositoryMounts,
          ),
        ),
      ],
      // Setup jobs (#589) between the keeper and the worker: each waits for the checkout, then runs once.
      containers: [
        keeper,
        ...setupJobs.map((job, index) => setupContainer(job, index, setupJobs[index - 1], profile)),
        worker,
      ],
    },
  };
}

export function buildRunNetworkPolicy(spec: JobSpec, namespace: string): V1NetworkPolicy {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: names.policy, namespace, labels: runLabels(spec.runId) },
    spec: {
      podSelector: { matchLabels: runLabels(spec.runId) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { ...PROXY_POD_LABEL } } }],
          // The tunnel port too, only when the tunnel is on. Still the one egress rule, still only the proxy pod.
          ports: [
            { protocol: "TCP", port: CODING_PROXY_PORT },
            ...(spec.tunnelPort ? [{ protocol: "TCP", port: spec.tunnelPort }] : []),
          ],
        },
      ],
    },
  };
}

export function buildCapabilitySecret(
  spec: JobSpec,
  namespace: string,
  capability: string,
  toolSetup?: string,
  mcpToken?: string,
): V1Secret {
  const names = kubernetesRunNames(spec.runId);
  const dockerTunnel = dockerDaemonTunnel(spec);
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: names.secret, namespace, labels: runLabels(spec.runId) },
    stringData: {
      capability,
      ...(toolSetup !== undefined ? { [TOOL_SETUP_SECRET_KEY]: toolSetup } : {}),
      ...(mcpToken !== undefined ? { [MCP_TOKEN_SECRET_KEY]: mcpToken } : {}),
      ...(dockerTunnel && spec.tunnelPort
        ? {
            [DOCKER_TUNNEL_PROXY_SECRET_KEY]: tunnelProxyEnv({
              proxyHost: CODING_PROXY_ALIAS,
              port: spec.tunnelPort,
              token: deriveTunnelToken(capability),
            }).HTTPS_PROXY,
          }
        : {}),
      ...(dockerTunnel?.trustCa && spec.tunnelCaCert !== undefined
        ? { [DOCKER_TUNNEL_CA_SECRET_KEY]: spec.tunnelCaCert }
        : {}),
    },
  };
}

/**
 * Deny-by-default attestation. Rather than allowlisting the fields we expect
 * to see (which silently accepts anything the allowlist forgot — lifecycle
 * hooks, probes that reach the node's link-local metadata endpoint,
 * seLinuxOptions/appArmorProfile/procMount escapes, extra tolerations,
 * stray annotations, ...), we deep-compare the *entire* spec, labels, and
 * annotations, and only normalize the exact fields the Kubernetes API
 * server itself is known to default or reorder on read-back. Every other
 * field — every security-relevant one included — must match exactly.
 */

/**
 * CPU quantities are always whole millicores; normalize "1", "1.0", and
 * "1000m" to the same string. Rounding only absorbs float noise (the
 * `isNearInteger` tolerance) — a value that's genuinely fractional at the
 * millicore scale (e.g. "1000.4m", "0.9996") is not a legitimate Kubernetes
 * quantity for something we build, so it's mapped to a sentinel that can
 * never equal a real builder value, making the comparison fail closed
 * instead of silently rounding two different resource requests together.
 */
function cpuMillicores(value: unknown): string {
  const text = String(value).trim();
  const milli = /^([0-9]*\.?[0-9]+)m$/.exec(text);
  if (milli) {
    const millis = Number(milli[1]);
    return isNearInteger(millis) ? `${Math.round(millis)}m` : `invalid:${text}`;
  }
  const plain = /^([0-9]*\.?[0-9]+)$/.exec(text);
  if (plain) {
    const millis = Number(plain[1]) * 1000;
    return isNearInteger(millis) ? `${Math.round(millis)}m` : `invalid:${text}`;
  }
  return text;
}

const MEMORY_BINARY_UNITS: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};
const MEMORY_DECIMAL_UNITS: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/**
 * Byte-denominated quantities (memory and ephemeral-storage) can use binary or
 * decimal suffixes; normalize every form to a byte count, failing closed on a
 * non-integer byte count (see `cpuMillicores`).
 */
function memoryBytes(value: unknown): string {
  const text = String(value).trim();
  const match = /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(text);
  if (!match) return text;
  const amount = Number(match[1]);
  const unit = match[2];
  let bytes: number;
  if (unit && unit in MEMORY_BINARY_UNITS) bytes = amount * MEMORY_BINARY_UNITS[unit];
  else if (unit && unit in MEMORY_DECIMAL_UNITS) bytes = amount * MEMORY_DECIMAL_UNITS[unit];
  else bytes = amount;
  return isNearInteger(bytes) ? String(Math.round(bytes)) : `invalid:${text}`;
}

interface DefaultToleration {
  key: string;
  operator: string;
  effect: string;
  tolerationSeconds: number;
}

/** The two node-health tolerations every pod gets by admission-time default; anything else must match exactly. */
const DEFAULT_TOLERATIONS: readonly DefaultToleration[] = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
];

function isDefaultToleration(t: V1Toleration): boolean {
  return DEFAULT_TOLERATIONS.some(
    (d) =>
      t.key === d.key &&
      t.operator === d.operator &&
      t.effect === d.effect &&
      t.tolerationSeconds === d.tolerationSeconds,
  );
}

/**
 * Normalizes only the *rendering* of a quantity, never its value: two spellings
 * of the same number compare equal, two different numbers never do.
 *
 * `ephemeral-storage` is canonicalized for the same reason memory is, and the
 * reason is not cosmetic. Go's `resource.Quantity` keeps the string it was
 * parsed from and re-serializes it verbatim — but only while that cached string
 * survives. Any mutation of the resource block drops it, and the value is then
 * re-rendered in canonical binary form, so the `1024Mi` we submit comes back as
 * `1Gi`. A platform whose admission controller rewrites resources by design
 * (Autopilot's warden) would therefore fail attestation on a quantity that never
 * actually changed, with nothing but `kubernetes_isolation_unsupported` to go on.
 * Comparing byte counts removes that failure mode without losing any strictness:
 * a genuinely different reservation is still a different number.
 */
function normalizeResources(r?: V1Container["resources"]): void {
  if (!r) return;
  for (const bag of [r.requests, r.limits]) {
    if (!bag) continue;
    if (bag.cpu !== undefined) bag.cpu = cpuMillicores(bag.cpu);
    if (bag.memory !== undefined) bag.memory = memoryBytes(bag.memory);
    if (bag["ephemeral-storage"] !== undefined) bag["ephemeral-storage"] = memoryBytes(bag["ephemeral-storage"]);
  }
}

/** A copy of a container's resources with every quantity in one rendering ("1" and "1000m" alike); see normalizeResources. */
export function canonicalResources(r?: V1Container["resources"]): V1Container["resources"] {
  const copy = r ? (JSON.parse(JSON.stringify(r)) as V1Container["resources"]) : undefined;
  normalizeResources(copy);
  return copy;
}

function normalizeProbe(p?: V1Container["readinessProbe"]): void {
  if (!p) return;
  p.timeoutSeconds ??= 1;
  p.successThreshold ??= 1;
  p.failureThreshold ??= 3;
  p.periodSeconds ??= 10;
}

function normalizeContainer(c: V1Container): void {
  delete c.terminationMessagePath;
  delete c.terminationMessagePolicy;
  delete c.imagePullPolicy;
  normalizeResources(c.resources);
  normalizeProbe(c.readinessProbe);
  normalizeProbe(c.livenessProbe);
  normalizeProbe(c.startupProbe);
  for (const mount of c.volumeMounts ?? []) {
    if (mount.mountPropagation === "None") delete mount.mountPropagation;
  }
}

function normalizeVolume(v: V1Volume): void {
  if (v.emptyDir) {
    if (v.emptyDir.medium === "") delete v.emptyDir.medium;
    if (v.emptyDir.sizeLimit !== undefined) v.emptyDir.sizeLimit = memoryBytes(v.emptyDir.sizeLimit);
  }
}

/**
 * Applies only the normalizations the Kubernetes API server itself performs
 * (defaulting or aliasing fields on write/read). Everything else in the
 * spec — including every security-relevant field — is left untouched so
 * the caller's deep-equality check sees it.
 */
function normalizeSpec(spec: V1PodSpec): void {
  if (!Array.isArray(spec.containers)) throw isolationError();
  delete spec.schedulerName;
  delete spec.nodeName;
  delete spec.priority;
  delete spec.preemptionPolicy;
  // Go's `omitempty` drops a plain bool at its zero value (false) on serialization, so a
  // genuine API read-back never has these fields when they're false — only when true.
  if (spec.hostNetwork === false) delete spec.hostNetwork;
  if (spec.hostPID === false) delete spec.hostPID;
  if (spec.hostIPC === false) delete spec.hostIPC;
  if (spec.serviceAccount !== undefined) {
    if (spec.serviceAccount !== spec.serviceAccountName) throw isolationError();
    delete spec.serviceAccount;
  }
  if (spec.tolerations) {
    const remaining = spec.tolerations.filter((t) => !isDefaultToleration(t));
    if (remaining.length === 0) delete spec.tolerations;
    else spec.tolerations = remaining;
  }
  for (const container of spec.containers) normalizeContainer(container);
  for (const container of spec.initContainers ?? []) normalizeContainer(container);
  for (const volume of spec.volumes ?? []) normalizeVolume(volume);
}

/**
 * A copy of `pod` with ONLY the API server's own defaulting and aliasing undone
 * — the same `normalizeSpec` pass `assertRunPodMatches` runs, and nothing else.
 *
 * Exported for src/tools/capture-fixture.ts, which runs it over both the
 * submitted and the returned pod before diffing them. Without it the diff is
 * dominated by fields every API server fills in on every create
 * (schedulerName, priority, terminationMessagePath on each container, probe
 * defaults, `2048Mi` requantized to `2Gi`, ...); because the differ replaces
 * arrays wholesale those collapse into opaque `replace /spec/containers`
 * blobs, and a genuine platform rewrite *inside* a container would be
 * indistinguishable from the noise.
 *
 * It deliberately does NOT apply `normalizePlatformMetadata`: that deletes
 * exactly the platform-injected keys a capture exists to record. Fails closed
 * (throws) on a spec the normalizer cannot make sense of.
 */
export function undoApiServerDefaults(pod: V1Pod): V1Pod {
  if (!pod.spec) throw isolationError();
  const spec = structuredClone(pod.spec);
  normalizeSpec(spec);
  return { ...structuredClone(pod), spec };
}

function normalizePod(
  pod: V1Pod,
  profile: KubernetesPlatformProfile,
): {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  spec: V1PodSpec;
} {
  if (!pod.spec) throw isolationError();
  // Every field the normalizer may touch must already be a copy: normalizePlatformMetadata
  // mutates `view.spec` in place, and replaces the two bags with copies of its own.
  const spec = structuredClone(pod.spec);
  normalizeSpec(spec);
  const view = {
    labels: structuredClone(pod.metadata?.labels ?? {}),
    annotations: structuredClone(pod.metadata?.annotations ?? {}),
    spec,
  };
  // Applied to BOTH operands, symmetrically: deletes only the keys the profile names,
  // and the profile for "generic" names none. It never skips a field the comparison
  // would otherwise see, so everything left is still deep-compared below.
  normalizePlatformMetadata(profile, view);
  return view;
}

/**
 * Recursively sorts object keys and drops `undefined` values so key order and API-omitted
 * fields never matter; array order is preserved.
 *
 * Exported for kubernetes-dry-run-fixture.ts's `diffMutations`: a captured pod's nested objects
 * (container resource requests, volume definitions, host aliases, ...) come back from a real
 * cluster with different key insertion order than `buildRunPod`'s own object literals, even when
 * every value is identical. Without canonicalizing first, `diffMutations`' array branch treats
 * that key-order difference as a genuine change and replaces the WHOLE array (every container,
 * every volume) with an opaque blob — exactly the failure mode its own doc comment warns a real
 * platform rewrite could hide inside. `assertRunPodMatches` below is unaffected by this (it
 * already canonicalizes before comparing); only the capture tool's mutation list was at risk.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([key, v]): [string, unknown] => [key, canonical(v)])
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Deep-compares the pod the API server read back against the pod wardby built.
 * ANY surviving difference fails the run closed.
 *
 * `platform` defaults to "generic" on purpose: a caller that forgets it gets the
 * strictest behaviour, never the most permissive. A profile can only narrow what
 * counts as an expected difference (by deleting named keys from both operands);
 * it can never disable or short-circuit the comparison.
 */
export function assertRunPodMatches(actual: V1Pod, expected: V1Pod, platform: KubernetesPlatform = "generic"): void {
  const profile = platformProfile(platform);
  const a = canonical(normalizePod(actual, profile));
  const e = canonical(normalizePod(expected, profile));
  if (JSON.stringify(a) !== JSON.stringify(e)) throw isolationError();
}

/** Go's `omitempty` drops an empty slice on serialization, so a genuine API read-back omits `ingress` when it's `[]` — only a populated ingress rule list survives. */
function normalizeNetworkPolicySpec(spec: NonNullable<V1NetworkPolicy["spec"]>): void {
  if (Array.isArray(spec.ingress) && spec.ingress.length === 0) delete spec.ingress;
}

export function assertRunNetworkPolicyMatches(actual: V1NetworkPolicy, expected: V1NetworkPolicy): void {
  const view = (p: V1NetworkPolicy) => {
    const spec = structuredClone(p.spec ?? {});
    normalizeNetworkPolicySpec(spec);
    return { labels: p.metadata?.labels ?? {}, spec };
  };
  if (JSON.stringify(canonical(view(actual))) !== JSON.stringify(canonical(view(expected)))) throw isolationError();
}

/**
 * A `node -e` script (argv only, never a shell) that measures BOTH of the proxy's
 * ports in one pass, with a 3 s connect timeout each (above Linux's 1 s initial
 * SYN retransmission, so one dropped SYN on an allowed path still connects).
 *
 * Measuring both is what makes the result decisive. A NetworkPolicy denial drops
 * the packet rather than rejecting it — GKE Dataplane V2, which Autopilot runs,
 * always drops — so "the deny port did not answer" is equally consistent with
 * "the proxy is gone and no policy exists at all". Requiring the proxy port to
 * connect in the *same* probe turns "something is listening" from a control-plane
 * inference into a fact this pod just observed.
 *
 * That pairing alone is still not enough, and this was reproduced on a live
 * cluster: in a namespace with NO NetworkPolicy at all, against a pod listening
 * on 8787 and serving nothing on 8788, a probe that collapsed `error` and
 * `timeout` into one "not reachable" exited PROVEN while it had full internet
 * egress. The pairing only rules out "the whole proxy pod is dead"; whenever the
 * deny *listener specifically* is unserved, "blocked" and "nothing there" are
 * the same observation. No control-plane read fixes this — Endpoints subset
 * ports come from the Service's numeric targetPort, not from anything actually
 * binding — so the distinction has to be made in the dataplane, here:
 *
 * - deny port **times out** → the packet was dropped somewhere on the path → the only outcome
 *   that can prove a policy. Note what it does NOT prove on its own: *which* hop dropped it. That
 *   it was the run pod's own egress policy follows from the proxy admitting run pods on the deny
 *   port at its own ingress, leaving no other hop that would drop it — a precondition the
 *   preflight's `proxy-service` check now verifies (readProxyWitness), after a live cluster
 *   falsified the assumption: with the drop moved to the destination, a prober holding no policy
 *   at all and with full internet egress read PROVEN.
 * - deny port **refused** (RST / ECONNREFUSED) → the SYN reached the destination host, so
 *   nothing blocked the path. This holds on every dataplane, drop-based ones included, because
 *   a drop cannot produce an RST. Reported as ENFORCEMENT_PROBE_DENY_REFUSED, never as proven.
 * - proxy port must still CONNECT for anything to count at all.
 *
 * Consequence, intended: on a **reject-style** CNI a genuine policy denial also arrives as an
 * RST, so such a cluster now fails closed here rather than passing vacuously. Failing closed on
 * a cluster whose refusals are ambiguous is the correct direction — a witness that cannot tell
 * "denied" from "unserved" is not a witness — and such a cluster needs a different one.
 *
 * Exit codes are ENFORCEMENT_PROBE_PROVEN / _DENY_REACHABLE / _PROXY_UNREACHABLE / _DENY_REFUSED.
 * The IP is validated and embedded as a JSON string literal.
 */
export function enforcementProbeScript(proxyIp: string): string {
  return [...enforcementProbeBody(proxyIp), "(async () => {", "  process.exit(await probe());", "})();"].join("\n");
}

/**
 * The one measurement both enforcement scripts make, as script lines defining `probe()`: connect to
 * CODING_PROXY_PORT, then to CODING_PROXY_DENY_PORT (both with a 3 s connect timeout, always both,
 * in that order), and resolve to the exit code classifying that pair. Its first statement presets
 * `process.exitCode = 1` so that a natural exit is never mistaken for PROVEN. Shared verbatim so the
 * single probe and the streak can never disagree about what "proven" means.
 */
function enforcementProbeBody(proxyIp: string): string[] {
  if (isIP(proxyIp) === 0) throw isolationError();
  return [
    // Preset a code no probe produces (it reads as "did not run"), so the only way to exit 0 is
    // the explicit proven exit. Without it, a process that drains its event loop without ever
    // calling process.exit — a probe promise that never settles, or a rejection under a
    // non-throwing --unhandled-rejections mode — would exit 0 and read as PROVEN.
    "process.exitCode = 1;",
    'const net = require("node:net");',
    "const tcp = (port) =>",
    "  new Promise((done) => {",
    "    const socket = net.connect({ host: " + JSON.stringify(proxyIp) + ", port, timeout: 3000 });",
    '    socket.once("connect", () => { socket.destroy(); done("connect"); });',
    '    socket.once("timeout", () => { socket.destroy(); done("timeout"); });',
    '    socket.once("error", () => done("error"));',
    "  });",
    "const probe = async () => {",
    `  const allowed = await tcp(${CODING_PROXY_PORT});`,
    `  const denied = await tcp(${CODING_PROXY_DENY_PORT});`,
    `  if (allowed !== "connect") return ${ENFORCEMENT_PROBE_PROXY_UNREACHABLE};`,
    `  if (denied === "connect") return ${ENFORCEMENT_PROBE_DENY_REACHABLE};`,
    `  if (denied === "error") return ${ENFORCEMENT_PROBE_DENY_REFUSED};`,
    `  return ${ENFORCEMENT_PROBE_PROVEN};`,
    "};",
  ];
}

/**
 * A whole enforcement streak in one process: up to `streak` probes, each exactly
 * `enforcementProbeScript`'s measurement and classification (the body is shared), `intervalMs`
 * apart. Exits ENFORCEMENT_PROBE_PROVEN only after `streak` consecutive proven probes; at the
 * first probe that is not proven it exits at once with that probe's own code, so the caller's
 * verdict is still the last probe's. Running the streak in one exec (rather than one exec per
 * probe) pays the keeper's exec + interpreter start-up once per streak instead of once per probe;
 * the evidence required is unchanged.
 *
 * The IP is validated and embedded as a JSON string literal; `streak` and `intervalMs` must be
 * positive safe integers and are embedded as numeric literals.
 */
export function enforcementStreakScript(proxyIp: string, streak: number, intervalMs: number): string {
  const body = enforcementProbeBody(proxyIp);
  if (!isPositiveSafeInteger(streak) || !isPositiveSafeInteger(intervalMs)) throw isolationError();
  return [
    ...body,
    "const pause = (ms) => new Promise((done) => setTimeout(done, ms));",
    "(async () => {",
    `  for (let index = 0; index < ${JSON.stringify(streak)}; index += 1) {`,
    `    if (index > 0) await pause(${JSON.stringify(intervalMs)});`,
    "    const code = await probe();",
    `    if (code !== ${ENFORCEMENT_PROBE_PROVEN}) return process.exit(code);`,
    "  }",
    `  return process.exit(${ENFORCEMENT_PROBE_PROVEN});`,
    "})();",
  ].join("\n");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
