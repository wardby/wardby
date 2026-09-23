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
 * PROVENANCE OF THE AUTOPILOT NUMBERS — read before trusting them. They are
 * DOCUMENTATION-SOURCED ONLY as of 2026-09-22, from Google's
 * autopilot-resource-requests, sandbox-pods, and autopilot-security pages.
 * They have NOT yet been confirmed against a real cluster. The dry-run capture
 * that will confirm them (src/tools/capture-autopilot-dry-run.ts, run with
 * `npm run capture:autopilot`) now exists, but it has not been run: no cluster
 * has been created yet, and its committed output —
 * fixtures/gke-autopilot-dry-run.json — is still marked `provisional: true`,
 * derived from the same documentation as the numbers here rather than from an
 * API server. Until that capture has run, treat every number and every injected
 * key below as an assumption. They fail closed if wrong — an unmodelled mutation
 * shows up as an unforgiven difference and fails attestation — but that is the
 * only reason it is safe to ship them unconfirmed, not a reason to stop
 * re-deriving them. Whoever runs the first real capture updates this paragraph
 * (kubernetes-autopilot-attestation.test.ts reports a named PENDING test until
 * they do).
 */
import type { V1PodSpec, V1Toleration } from "@kubernetes/client-node";

export type KubernetesPlatform = "generic" | "gke-autopilot";
export const KUBERNETES_PLATFORMS: readonly KubernetesPlatform[] = Object.freeze(["generic", "gke-autopilot"] as const);

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

/**
 * Deep-freezes a profile. An allowance list is the set of differences attestation
 * will forgive: nothing at runtime — a later module, a test helper, a mistaken
 * `push` — may widen it after this module is loaded. Frozen in place rather than
 * copied so `platformProfile` keeps returning the one canonical object.
 */
function freezeProfile(profile: KubernetesPlatformProfile): KubernetesPlatformProfile {
  Object.freeze(profile.resources);
  Object.freeze(profile.metadata.podAnnotationKeyPrefixes);
  Object.freeze(profile.metadata.podLabelKeyPrefixes);
  for (const toleration of profile.metadata.tolerations) Object.freeze(toleration);
  Object.freeze(profile.metadata.tolerations);
  Object.freeze(profile.metadata.nodeSelector);
  Object.freeze(profile.metadata);
  return Object.freeze(profile);
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
    // These are Autopilot's NON-bursting numbers, chosen deliberately: they are the
    // stricter set, so a pod conformed to them is legal on a bursting cluster too,
    // while the reverse would not hold.
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

const PROFILES: Readonly<Record<KubernetesPlatform, KubernetesPlatformProfile>> = Object.freeze({
  generic: freezeProfile(GENERIC),
  "gke-autopilot": freezeProfile(GKE_AUTOPILOT),
});

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

/** Refuses NaN, Infinity, 0 and negatives before they are stringified into a Kubernetes quantity. */
function requirePositiveMib(profile: KubernetesPlatformProfile, field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KubernetesPlatformError(
      `platform ${profile.name} was asked for ${field}=${String(value)}; it must be a finite positive number`,
    );
  }
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
 *
 * Every dimension asked for must be a finite positive number; a garbage value is
 * refused here rather than stringified into a quantity the API server would
 * reject (or, worse, accept). What can be range-checked for one container is:
 * its ephemeral storage cannot alone exceed the platform's whole-pod ceiling.
 * The *summed* pod total against that ceiling is the caller's check, since only
 * the caller sees every container.
 *
 * Note `generic` deliberately DROPS a supplied `ephemeralStorageMib`: it sets
 * `explicitEphemeralStorage: false`, and emitting an ephemeral-storage request
 * a generic cluster never asked for would change the pod that ships today. The
 * value is still validated before it is discarded.
 */
export function conformResources(
  profile: KubernetesPlatformProfile,
  request: ContainerResourceRequest,
): ContainerResources {
  const rules = profile.resources;
  requirePositiveMib(profile, "cpuMillicores", request.cpuMillicores);
  requirePositiveMib(profile, "memoryMib", request.memoryMib);
  if (request.ephemeralStorageMib !== undefined) {
    requirePositiveMib(profile, "ephemeralStorageMib", request.ephemeralStorageMib);
    const ceiling = rules.ephemeralStorageCeilingMib;
    if (ceiling !== undefined && request.ephemeralStorageMib > ceiling) {
      throw new KubernetesPlatformError(
        `platform ${profile.name} was asked for a container ephemeral-storage request of ${request.ephemeralStorageMib} MiB, over the ${ceiling} MiB ceiling for the whole pod`,
      );
    }
  }
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

/**
 * Renders a MiB figure with its GiB equivalent, e.g. `10240 MiB (10 GiB)`. Both
 * places that report the ephemeral-storage ceiling use this rather than writing
 * the GiB figure out by hand, so a profile with a different ceiling cannot end
 * up described by a parenthetical that was only ever true for Autopilot's.
 */
export function describeMib(mib: number): string {
  const gib = mib / 1024;
  // 3 decimals, not 2: a ceiling of 1025 MiB must not print as "(1 GiB)".
  const rendered = Number.isInteger(gib) ? String(gib) : gib.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${mib} MiB (${rendered} GiB)`;
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
 * empty allowance — `generic` — provably leaves the view's contents alone.
 *
 * SYMMETRY CAVEAT — deleting from both sides forgives an *addition* only while
 * the builder never emits an allowed key itself. If buildRunPod ever emitted,
 * say, the gVisor nodeSelector, the deletion would land on the submitted side
 * too and the platform *removing* it would become equally invisible. Anything
 * named in an allowance list must therefore stay something wardby never sets.
 *
 * OWNERSHIP — this matters at the call site. `view.labels` and `view.annotations`
 * are REPLACED with copies before anything is deleted, so a caller that built the
 * view straight out of a live `V1Pod` (`normalizePod` structuredClones only the
 * spec and hands back the pod's own `metadata.labels`/`metadata.annotations`
 * references) does not have keys deleted out from under its real pod objects.
 * Read the normalized bags back off `view` after the call, never off the pod.
 * `view.spec`, by contrast, is mutated in place and the caller MUST pass a spec
 * it already owns — `normalizePod`'s structuredClone is what makes that true.
 */
export function normalizePlatformMetadata(
  profile: KubernetesPlatformProfile,
  view: { labels: Record<string, string>; annotations: Record<string, string>; spec: V1PodSpec },
): void {
  const { metadata } = profile;
  view.labels = { ...view.labels };
  view.annotations = { ...view.annotations };
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
        `CODING_MAX_DISK_MB=${config.maxDiskMb} needs ${total} MiB of pod ephemeral storage, over the ${describeMib(ceiling)} ceiling of KUBERNETES_PLATFORM=${profile.name}; the worker container reserves ${WORKER_EPHEMERAL_MIB} MiB of that, so the largest workspace this platform can run is ${ceiling - WORKER_EPHEMERAL_MIB} MiB`,
      );
    }
  }
}
