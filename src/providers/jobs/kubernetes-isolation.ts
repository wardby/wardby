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
  V1NetworkPolicy,
  V1Pod,
  V1PodSpec,
  V1Secret,
  V1Toleration,
  V1Volume,
} from "@kubernetes/client-node";
import { StoredCodingServicesSchema, type ResolvedCodingService } from "../../coding/services/catalog.js";
import type { JobSpec } from "./types.js";
import {
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
/** Where the tool runner listens and the agent's relay connects (claude-tool-runner/main.mjs). */
export const TOOL_SOCKET_PATH = "/run/wardby/tool/runner.sock";
const CODEX_ENTRYPOINT = "/opt/wardby/coding-worker/main.js";
const CLAUDE_ENTRYPOINT = "/opt/wardby/claude-coding-worker/main.js";
/** Every service sidecar's container name starts with this (service-postgres, service-redis, ...). */
export const SERVICE_CONTAINER_PREFIX = "service-";
/** Disk-backed scratch for each of a service's writablePaths (a socket directory, /tmp). */
export const SERVICE_SCRATCH_MIB = 64;

export function serviceContainerName(name: string): string {
  return `${SERVICE_CONTAINER_PREFIX}${name}`;
}

/** What a service sidecar reserves of the pod's ephemeral storage: its data volume plus its scratch volumes. */
export function serviceEphemeralStorageMib(service: ResolvedCodingService): number {
  return service.resources.diskMib + SERVICE_SCRATCH_MIB * service.writablePaths.length;
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
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;

/** The worker waits for the launcher's seeded marker, then runs its provider's entrypoint. */
function workerGate(entrypoint: string): string {
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

/**
 * Creates the worker's subPath mount sources, owned by the run uid, before any regular container
 * starts. Otherwise the kubelet creates them root-owned while setting up the worker's subPath mounts,
 * and the keeper (uid 10001, no capabilities) can't chmod them. Idempotent; no shell.
 */
function storageInitScript(directories: readonly string[]): string {
  return [
    'const fs = require("node:fs");',
    `for (const name of ${JSON.stringify(directories).replaceAll(",", ", ")}) {`,
    `  const path = ${JSON.stringify(STORAGE_ROOT)} + "/" + name;`,
    "  fs.mkdirSync(path, { recursive: true, mode: 0o700 });",
    "  fs.chmodSync(path, 0o700);",
    "}",
  ].join("\n");
}
const STORAGE_DIRECTORIES = ["workspace", "input", "output"] as const;
/**
 * Claude's socket volume: its own memory-backed emptyDir, mounted by the worker and the tool runner
 * only. Under gVisor a Unix socket bound on the disk-backed storage volume is invisible to another
 * container; a memory-backed emptyDir that two containers mount is one tmpfs shared across the
 * sandbox (GKE Autopilot annotates it `share: pod`), so the agent's relay can connect.
 */
const TOOL_SOCKET_VOLUME = "tool-socket";
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
  }
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
 * The emptyDirs behind one service's mounts: its data path, then each writable path. The only place
 * their names are built, so the sidecar's volumeMounts and the pod's volumes can never disagree.
 */
function serviceStorage(
  service: ResolvedCodingService,
  index: number,
): Array<{ name: string; mountPath: string; sizeMib: number }> {
  return [
    { name: `service-${index}-data`, mountPath: service.dataPath, sizeMib: service.resources.diskMib },
    ...service.writablePaths.map((path, scratch) => ({
      name: `service-${index}-scratch-${scratch}`,
      mountPath: path,
      sizeMib: SERVICE_SCRATCH_MIB,
    })),
  ];
}

/**
 * One coding-run service as a native sidecar (docs/coding-services.md): an init container with
 * restartPolicy Always, so the kubelet starts it before the keeper and worker and holds them until
 * its startup probe (the catalog's readiness command) passes. It runs the catalog's image with its
 * own entrypoint, under the same security context as every other container, with an emptyDir at its
 * data path and at each writable path. Same pod, same network namespace: the worker reaches it on
 * 127.0.0.1, and the run's NetworkPolicy needs no change.
 */
function serviceSidecar(
  service: ResolvedCodingService,
  index: number,
  profile: KubernetesPlatformProfile,
): V1Container {
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

function serviceVolumes(services: readonly ResolvedCodingService[]): V1Volume[] {
  return services.flatMap((service, index) =>
    serviceStorage(service, index).map(({ name, sizeMib }) => ({ name, emptyDir: { sizeLimit: `${sizeMib}Mi` } })),
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
  const scratchMb = Math.max(16, Math.min(64, Math.floor(spec.limits.memoryMb / 8)));
  const sidecarCpuMillicores = 250;
  const sidecarMemoryMib = 128;
  const claude = spec.provider === "claude-code";
  const tool = claudeToolLimits(spec);
  const toolScratchMb = Math.max(16, Math.min(64, Math.floor(tool.memoryMb / 8)));
  const storageInit: V1Container = {
    name: STORAGE_INIT_CONTAINER,
    image: spec.image,
    command: ["node", "-e", storageInitScript(STORAGE_DIRECTORIES)],
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
    command: ["node", "-e", workerGate(claude ? CLAUDE_ENTRYPOINT : CODEX_ENTRYPOINT)],
    env: [
      { name: "WARDBY_PROXY_URL", value: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}` },
      { name: "WARDBY_RUN_CAPABILITY", valueFrom: { secretKeyRef: { name: names.secret, key: "capability" } } },
    ],
    securityContext: containerSecurity(),
    resources: conformResources(profile, {
      cpuMillicores: Math.round((claude ? spec.limits.cpus - tool.cpus : spec.limits.cpus) * 1000),
      memoryMib: claude ? spec.limits.memoryMb - tool.memoryMb : spec.limits.memoryMb,
      ephemeralStorageMib: claude ? WORKER_EPHEMERAL_MIB - TOOL_RUNNER_EPHEMERAL_MIB : WORKER_EPHEMERAL_MIB,
    }),
    // Claude's agent never sees the repository: the tool runner does, over the socket.
    volumeMounts: claude
      ? [
          { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
          { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
          { name: TOOL_SOCKET_VOLUME, mountPath: "/run/wardby/tool" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "home", mountPath: "/home/wardby" },
        ]
      : [
          { name: "storage", mountPath: "/workspace", subPath: "workspace" },
          { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
          { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "home", mountPath: "/home/wardby" },
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
          { name: TOOL_SOCKET_VOLUME, mountPath: "/run/wardby/tool" },
          { name: "tool-tmp", mountPath: "/tmp" },
          { name: "tool-home", mountPath: "/home/wardby" },
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
      hostAliases: [{ ip: options.proxyIp, hostnames: [CODING_PROXY_ALIAS] }],
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
            ]
          : []),
        ...serviceVolumes(services),
      ],
      // storage-init first (it must finish before any subPath mount), then Claude's tool runner, then each
      // service sidecar in declaration order; the keeper and worker start only once every sidecar started.
      initContainers: [
        storageInit,
        ...(toolRunner ? [toolRunner] : []),
        ...services.map((service, index) => serviceSidecar(service, index, profile)),
      ],
      containers: [keeper, worker],
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
          ports: [{ protocol: "TCP", port: CODING_PROXY_PORT }],
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
): V1Secret {
  const names = kubernetesRunNames(spec.runId);
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name: names.secret, namespace, labels: runLabels(spec.runId) },
    stringData: { capability, ...(toolSetup !== undefined ? { [TOOL_SETUP_SECRET_KEY]: toolSetup } : {}) },
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
