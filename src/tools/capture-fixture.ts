/**
 * Builds one platform's admission-mutation fixture from a server-side dry run.
 *
 * Submits the pod the launcher would really build with `dryRun=All`: the API
 * server runs its whole admission chain and returns the mutated object without
 * scheduling or persisting anything, so the exact mutation set can be read from
 * a real cluster for the price of one API call and no billable workload.
 *
 * This is a development tool, run deliberately and reviewed in a diff. Nothing
 * at runtime calls it: the admission chain that produces these mutations is the
 * same one an attacker with cluster access would subvert, so it can never be
 * allowed to bless itself at launch time.
 *
 * Separated from capture-autopilot-dry-run.ts — which is the environment, file
 * and terminal wiring — so every decision below is unit-testable against
 * FakeKubernetesApi. Two of those decisions carry the fixture's whole value:
 *
 *  1. Both pods go through `undoApiServerDefaults` before they are diffed.
 *     Otherwise the diff is dominated by what every API server fills in on
 *     every create, and since the differ replaces arrays wholesale, those
 *     collapse into opaque `replace /spec/containers` blobs that a genuine
 *     platform rewrite could hide inside.
 *  2. The capture refuses to write unless the cluster actually answered like
 *     the platform it claims. `KUBERNETES_PLATFORM` is just an environment
 *     variable; without this check the tool would machine-author
 *     `provisional: false` against any cluster at all, and that fixture would
 *     then pass the attestation suite's PENDING test as a real capture.
 */
import type { V1Pod } from "@kubernetes/client-node";
import type { KubernetesApi } from "../providers/jobs/kubernetes-api.js";
import { buildRunPod, undoApiServerDefaults } from "../providers/jobs/kubernetes-isolation.js";
import { readProxyWitness } from "../providers/jobs/kubernetes-witness.js";
import { diffMutations, type DryRunFixture } from "../providers/jobs/kubernetes-dry-run-fixture.js";
import { platformProfile, type KubernetesPlatform } from "../providers/jobs/kubernetes-platform.js";
import type { JobSpec } from "../providers/jobs/types.js";

export const CAPTURE_REFUSED = "capture_refused";

/** A capture that must not be written to the committed fixture. */
export class CaptureRefusedError extends Error {
  constructor(detail: string) {
    super(`${CAPTURE_REFUSED}: ${detail}`);
    this.name = "CaptureRefusedError";
  }
}

export interface CaptureOptions {
  namespace: string;
  proxyService: string;
  platform: KubernetesPlatform;
  runtimeClassName?: string;
  /** The worker image the launcher would run; must be a registry digest. */
  workerImage: string;
  /** Injected so a capture's `capturedAt` is deterministic under test. */
  now?: Date;
}

/**
 * Fields every API server fills in on any create. They are metadata bookkeeping,
 * not admission decisions, and are stripped before the diff for the same reason
 * `undoApiServerDefaults` exists: so the fixture lists only what the platform did.
 */
const SERVER_METADATA_KEYS = [
  "creationTimestamp",
  "uid",
  "resourceVersion",
  "generation",
  "managedFields",
  "selfLink",
] as const;

export function stripServerMetadata(pod: V1Pod): V1Pod {
  const copy = structuredClone(pod);
  const metadata = copy.metadata as Record<string, unknown> | undefined;
  if (metadata) for (const key of SERVER_METADATA_KEYS) delete metadata[key];
  delete copy.status;
  return copy;
}

/**
 * Whether the cluster's answer actually looks like this platform's admission
 * chain: it must have stamped at least one annotation the profile names. A
 * platform with no annotation allowance (today only `generic`, which is refused
 * earlier) has no fingerprint to check, and this returns undefined rather than
 * inventing one.
 */
export function platformFingerprint(platform: KubernetesPlatform, returned: V1Pod): string | undefined {
  const prefixes = platformProfile(platform).metadata.podAnnotationKeyPrefixes;
  if (prefixes.length === 0) return undefined;
  const annotations = Object.keys(returned.metadata?.annotations ?? {});
  return annotations.find((key) => prefixes.some((prefix) => key.startsWith(prefix)));
}

export async function captureFixture(api: KubernetesApi, options: CaptureOptions): Promise<DryRunFixture> {
  const { platform } = options;
  if (platform === "generic") {
    throw new CaptureRefusedError(
      'set KUBERNETES_PLATFORM to the platform you are capturing (e.g. gke-autopilot); "generic" forgives nothing, so it has no admission mutations to record',
    );
  }
  const witness = await readProxyWitness(api, options.namespace, options.proxyService);
  const spec: JobSpec = {
    kind: "coding-agent",
    runId: "capture-dry-run",
    provider: "codex",
    image: options.workerImage,
    inputArtifact: "",
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  const submitted = buildRunPod(spec, {
    namespace: options.namespace,
    proxyIp: witness.clusterIp,
    runtimeClassName: options.runtimeClassName,
    platform,
  });
  const returned = await api.dryRunCreatePod(options.namespace, submitted);

  const fingerprint = platformFingerprint(platform, returned);
  if (fingerprint === undefined) {
    const prefixes = platformProfile(platform).metadata.podAnnotationKeyPrefixes.join(", ");
    throw new CaptureRefusedError(
      `the cluster did not answer like ${platform}: the dry-run response carries no annotation matching ${prefixes}. ` +
        `KUBERNETES_PLATFORM says what to capture, not what the cluster is — refusing to write a capture that would attest a platform this cluster may not be.`,
    );
  }

  // Both sides, symmetrically, and only the API server's own defaulting: what survives is
  // what the platform's admission chain did, which is the only thing this fixture may claim.
  const mutations = diffMutations(
    undoApiServerDefaults(submitted),
    undoApiServerDefaults(stripServerMetadata(returned)),
  );
  const apiServerVersion = await api.readApiServerVersion();
  return {
    capturedAt: (options.now ?? new Date()).toISOString().slice(0, 10),
    platform,
    provisional: false,
    source: `server-side dry run against a ${platform} cluster, API server ${apiServerVersion}; the cluster answered with ${fingerprint}`,
    notes: [
      "Captured by src/tools/capture-fixture.ts via `npm run capture:autopilot`. Every entry must have a matching allowance in kubernetes-platform.ts, or the attestation test fails.",
      "Both the submitted and the returned pod were passed through kubernetes-isolation.ts's undoApiServerDefaults before being diffed, so what is listed here is what the PLATFORM changed, not what any API server defaults on any create.",
    ],
    mutations,
  };
}
