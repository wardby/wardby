/**
 * Platform profiles for the Kubernetes coding launcher.
 *
 * A profile is pure data plus two pure functions. It answers exactly two
 * questions, and a reviewer can read the full answer to both in this file:
 *
 *  1. What resource values must the builder emit so the platform's admission
 *     controller has nothing left to rewrite? (`conformResources`)
 *  2. What does the platform stamp on the pod anyway, and is it in a named,
 *     bounded list? (`normalizePlatformMetadata`)
 *
 * Profiles narrow what counts as an *expected* difference. They never disable
 * the comparison: `normalizePlatformMetadata` deletes named keys from both the
 * submitted and the read-back pod, symmetrically, and everything else is still
 * deep-compared by kubernetes-isolation.ts. The `generic` profile's lists are
 * empty, so it tolerates nothing beyond what shipped before profiles existed.
 *
 * The Autopilot numbers come from Google's autopilot-resource-requests,
 * sandbox-pods, and autopilot-security documentation (checked 2026-09-22) and
 * are confirmed against a real cluster by the dry-run capture in
 * src/tools/capture-autopilot-dry-run.ts.
 */
import type { V1PodSpec, V1Toleration } from "@kubernetes/client-node";

export type KubernetesPlatform = "generic" | "gke-autopilot";
export const KUBERNETES_PLATFORMS: readonly KubernetesPlatform[] = ["generic", "gke-autopilot"];

export const KUBERNETES_PLATFORM_ERROR = "kubernetes_platform_unconformable";

/** A request the platform cannot legally run, refused here instead of being silently adjusted by the platform. */
export class KubernetesPlatformError extends Error {
  constructor(detail: string) {
    super(`${KUBERNETES_PLATFORM_ERROR}: ${detail}`);
    this.name = "KubernetesPlatformError";
  }
}

export const GVISOR_RUNTIME_CLASS = "gvisor";
/** Ephemeral storage the init container needs to create the three subPath roots. */
export const STORAGE_INIT_EPHEMERAL_MIB = 64;
/** Ephemeral storage reserved for the worker's writable layer (/tmp and /home are memory-backed). */
export const WORKER_EPHEMERAL_MIB = 1024;

export interface PlatformResourceRules {
  /** Smallest CPU request the platform accepts, in millicores. */
  cpuFloorMillicores: number;
  /** Granularity the platform rounds CPU up to, in millicores. */
  cpuIncrementMillicores: number;
  /** Lower edge of the memory:CPU band, in MiB of memory per whole CPU. */
  memoryPerCpuMinMib: number;
  /** Upper edge of the memory:CPU band, in MiB of memory per whole CPU. */
  memoryPerCpuMaxMib: number;
  /** Ceiling on the pod's total ephemeral storage, in MiB; undefined means the platform imposes none. */
  ephemeralStorageCeilingMib?: number;
  /** Whether the builder must emit explicit ephemeral-storage requests/limits on every container. */
  explicitEphemeralStorage: boolean;
}

export interface PlatformMetadataAllowance {
  /** Annotation key prefixes the platform's admission controller adds. */
  podAnnotationKeyPrefixes: readonly string[];
  /**
   * Label key prefixes the platform adds. Note run-pod labels are also the run
   * NetworkPolicy's podSelector: forgiving an *added* label is safe because it
   * cannot remove wardby's own labels, which still match the policy. A changed
   * or missing wardby label is a mismatch and still fails.
   */
  podLabelKeyPrefixes: readonly string[];
  /** Tolerations the platform's admission controller adds, matched field for field. */
  tolerations: readonly V1Toleration[];
  /** nodeSelector entries the platform adds, matched key and value. */
  nodeSelector: Readonly<Record<string, string>>;
  /** True when the platform strips the pod-level seccompProfile (sandboxed pods are exempt from its default). */
  dropsPodSeccompProfile: boolean;
}

export interface KubernetesPlatformProfile {
  name: KubernetesPlatform;
  resources: PlatformResourceRules;
  metadata: PlatformMetadataAllowance;
  /** gVisor is mandatory: an unset or different runtime class is refused at startup, not warned about. */
  requiresGvisor: boolean;
}

const NO_METADATA: PlatformMetadataAllowance = {
  podAnnotationKeyPrefixes: [],
  podLabelKeyPrefixes: [],
  tolerations: [],
  nodeSelector: {},
  dropsPodSeccompProfile: false,
};

const GENERIC: KubernetesPlatformProfile = {
  name: "generic",
  resources: {
    cpuFloorMillicores: 0,
    cpuIncrementMillicores: 1,
    memoryPerCpuMinMib: 0,
    memoryPerCpuMaxMib: Number.POSITIVE_INFINITY,
    explicitEphemeralStorage: false,
  },
  metadata: NO_METADATA,
  requiresGvisor: false,
};

const GKE_AUTOPILOT: KubernetesPlatformProfile = {
  name: "gke-autopilot",
  resources: {
    // General-purpose compute class: 0.25 vCPU minimum, 0.25 vCPU increments,
    // memory between 1 GiB and 6.5 GiB per vCPU, 10 GiB of ephemeral storage per Pod.
    cpuFloorMillicores: 250,
    cpuIncrementMillicores: 250,
    memoryPerCpuMinMib: 1024,
    memoryPerCpuMaxMib: 6656,
    ephemeralStorageCeilingMib: 10 * 1024,
    explicitEphemeralStorage: true,
  },
  metadata: {
    // autopilot.gke.io/* carries the resource-adjustment record and the warden version.
    podAnnotationKeyPrefixes: ["autopilot.gke.io/"],
    podLabelKeyPrefixes: ["autopilot.gke.io/"],
    // GKE adds the gVisor toleration itself for a pod with runtimeClassName: gvisor.
    tolerations: [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: GVISOR_RUNTIME_CLASS, effect: "NoSchedule" },
    ],
    nodeSelector: { "sandbox.gke.io/runtime": GVISOR_RUNTIME_CLASS },
    // We set seccompProfile: RuntimeDefault ourselves, and the sandbox exemption only means Autopilot
    // does not *add* one — so there is nothing to forgive. If a capture ever shows the field stripped,
    // flip this to true rather than widening anything else.
    dropsPodSeccompProfile: false,
  },
  requiresGvisor: true,
};

const PROFILES: Record<KubernetesPlatform, KubernetesPlatformProfile> = {
  generic: GENERIC,
  "gke-autopilot": GKE_AUTOPILOT,
};

export function platformProfile(name: KubernetesPlatform): KubernetesPlatformProfile {
  const profile = PROFILES[name];
  if (!profile) throw new KubernetesPlatformError(`unknown platform ${String(name)}`);
  return profile;
}

export interface ContainerResourceRequest {
  cpuMillicores: number;
  memoryMib: number;
  /** Required when the profile sets explicitEphemeralStorage. */
  ephemeralStorageMib?: number;
}

export interface ContainerResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

/**
 * The resource block to emit for one container: the smallest values that both
 * satisfy the request and are already legal on the platform, so nothing is
 * rewritten after submission. Limits always equal requests (Autopilot sets them
 * equal anyway, and every wardby container has always been emitted that way).
 *
 * Conformance is monotone in one pass: CPU only ever rises (to the floor, to the
 * increment, and to whatever the memory:CPU ceiling demands), and raising CPU
 * only ever raises the ceiling and the floor it must satisfy.
 *
 * Per-container conformance is enough for the pod as a whole: multiples of the
 * CPU increment sum to a multiple of the increment, and the sum of several
 * ratios inside a band stays inside that band.
 */
export function conformResources(
  profile: KubernetesPlatformProfile,
  request: ContainerResourceRequest,
): ContainerResources {
  const rules = profile.resources;
  const increment = Math.max(1, rules.cpuIncrementMillicores);
  const cpuForMemory = Number.isFinite(rules.memoryPerCpuMaxMib)
    ? Math.ceil((request.memoryMib / rules.memoryPerCpuMaxMib) * 1000)
    : 0;
  const wanted = Math.max(request.cpuMillicores, cpuForMemory, rules.cpuFloorMillicores);
  const cpuMillicores = Math.ceil(wanted / increment) * increment;
  const memoryMib = Math.max(request.memoryMib, Math.ceil((cpuMillicores / 1000) * rules.memoryPerCpuMinMib));
  const requests: Record<string, string> = { cpu: `${cpuMillicores}m`, memory: `${memoryMib}Mi` };
  if (rules.explicitEphemeralStorage) {
    if (request.ephemeralStorageMib === undefined) {
      throw new KubernetesPlatformError(
        `platform ${profile.name} requires an explicit ephemeral-storage request on every container`,
      );
    }
    requests["ephemeral-storage"] = `${request.ephemeralStorageMib}Mi`;
  }
  return { requests, limits: { ...requests } };
}

/**
 * The pod's total ephemeral storage: max(init containers) + sum(regular containers).
 * storage-init's 64 MiB never exceeds keeper + worker, so the total is the keeper's
 * storage volume plus the worker's reservation.
 */
export function podEphemeralStorageMib(diskMb: number): number {
  return diskMb + WORKER_EPHEMERAL_MIB;
}

function tolerationMatches(actual: V1Toleration, allowed: V1Toleration): boolean {
  return (
    actual.key === allowed.key &&
    actual.operator === allowed.operator &&
    actual.value === allowed.value &&
    actual.effect === allowed.effect &&
    actual.tolerationSeconds === allowed.tolerationSeconds
  );
}

function stripPrefixed(bag: Record<string, string>, prefixes: readonly string[]): void {
  if (prefixes.length === 0) return;
  for (const key of Object.keys(bag)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) delete bag[key];
  }
}

/**
 * Deletes exactly the metadata this platform is known to add. Called on BOTH
 * sides of the comparison: the submitted pod never carries any of it, so the
 * deletion is a no-op there, and the read-back pod loses only what is named
 * here. Nothing else is touched, so any other difference still fails the run.
 *
 * Every branch is gated on the profile naming something, so a profile with an
 * empty allowance — `generic` — provably leaves the view byte-for-byte alone.
 */
export function normalizePlatformMetadata(
  profile: KubernetesPlatformProfile,
  view: { labels: Record<string, string>; annotations: Record<string, string>; spec: V1PodSpec },
): void {
  const { metadata } = profile;
  stripPrefixed(view.annotations, metadata.podAnnotationKeyPrefixes);
  stripPrefixed(view.labels, metadata.podLabelKeyPrefixes);
  if (metadata.tolerations.length > 0 && view.spec.tolerations) {
    const remaining = view.spec.tolerations.filter(
      (toleration) => !metadata.tolerations.some((allowed) => tolerationMatches(toleration, allowed)),
    );
    if (remaining.length === 0) delete view.spec.tolerations;
    else view.spec.tolerations = remaining;
  }
  const selector = view.spec.nodeSelector;
  if (selector && Object.keys(metadata.nodeSelector).length > 0) {
    for (const [key, value] of Object.entries(metadata.nodeSelector)) {
      if (selector[key] === value) delete selector[key];
    }
    if (Object.keys(selector).length === 0) delete view.spec.nodeSelector;
  }
  if (metadata.dropsPodSeccompProfile && view.spec.securityContext) delete view.spec.securityContext.seccompProfile;
}

export interface PlatformConfigCheck {
  runtimeClassName?: string;
  /** The effective CODING_MAX_DISK_MB: the largest workspace an agents:write caller may request. */
  maxDiskMb: number;
}

/**
 * Refuses a configuration that cannot work on this platform, at startup rather
 * than at the first coding run. Each message names the setting and the limit.
 */
export function assertPlatformConfig(profile: KubernetesPlatformProfile, config: PlatformConfigCheck): void {
  if (profile.requiresGvisor && config.runtimeClassName !== GVISOR_RUNTIME_CLASS) {
    throw new KubernetesPlatformError(
      `KUBERNETES_PLATFORM=${profile.name} requires KUBERNETES_RUNTIME_CLASS=${GVISOR_RUNTIME_CLASS} (found ${config.runtimeClassName ?? "unset"})`,
    );
  }
  const ceiling = profile.resources.ephemeralStorageCeilingMib;
  if (ceiling !== undefined) {
    const total = podEphemeralStorageMib(config.maxDiskMb);
    if (total > ceiling) {
      throw new KubernetesPlatformError(
        `CODING_MAX_DISK_MB=${config.maxDiskMb} needs ${total} MiB of pod ephemeral storage, over the ${ceiling} MiB (10 GiB) ceiling of KUBERNETES_PLATFORM=${profile.name}; the worker container reserves ${WORKER_EPHEMERAL_MIB} MiB of that, so the largest workspace this platform can run is ${ceiling - WORKER_EPHEMERAL_MIB} MiB`,
      );
    }
  }
}
