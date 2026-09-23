/**
 * The capture tool's decisions, unit-tested against FakeKubernetesApi.
 *
 * The centrepiece is `defaultedLikeAnApiServer`: a read-back carrying both the
 * defaulting every API server performs on every create AND the four mutations
 * Autopilot's admission chain is believed to add. A capture must record the
 * second set and none of the first, or the committed fixture stops being
 * reviewable — which is the only reason it is committed at all.
 */
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { assertRunPodMatches, buildRunPod } from "../providers/jobs/kubernetes-isolation.js";
import { applyMutations, diffMutations } from "../providers/jobs/kubernetes-dry-run-fixture.js";
import { CAPTURE_REFUSED, captureFixture, platformFingerprint, stripServerMetadata } from "./capture-fixture.js";
import type { JobSpec } from "../providers/jobs/types.js";

const NAMESPACE = "wardby-coding";
const SERVICE = "wardby-coding-proxy";
const CLUSTER_IP = "10.96.0.50";
const IMAGE = `us-central1-docker.pkg.dev/example/wardby/coding-worker@sha256:${"a".repeat(64)}`;
const ADJUSTMENT = '{"input":{"containers":[]},"output":{"containers":[]},"modified":false}';
const GVISOR_TOLERATION = {
  key: "sandbox.gke.io/runtime",
  operator: "Equal",
  value: "gvisor",
  effect: "NoSchedule",
};
const NODE_HEALTH_TOLERATIONS = [
  { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
  { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
];

const options = {
  namespace: NAMESPACE,
  proxyService: SERVICE,
  platform: "gke-autopilot" as const,
  runtimeClassName: "gvisor",
  workerImage: IMAGE,
  now: new Date("2026-09-23T11:22:33.000Z"),
};

/** The pod the capture tool itself builds, rebuilt here so the test never trusts the tool's copy. */
function submittedPod(): V1Pod {
  const spec: JobSpec = {
    kind: "coding-agent",
    runId: "capture-dry-run",
    provider: "codex",
    image: IMAGE,
    inputArtifact: "",
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  return buildRunPod(spec, {
    namespace: NAMESPACE,
    proxyIp: CLUSTER_IP,
    runtimeClassName: "gvisor",
    platform: "gke-autopilot",
  });
}

/** A quantity re-rendered in canonical binary form, as Go's resource.Quantity does after any mutation. */
function requantize(bag: Record<string, string> | undefined): void {
  if (!bag) return;
  if (bag.cpu === "1000m") bag.cpu = "1";
  for (const key of ["memory", "ephemeral-storage"]) {
    const value = bag[key];
    if (value === "2048Mi") bag[key] = "2Gi";
    if (value === "1024Mi") bag[key] = "1Gi";
  }
}

/**
 * What a real GKE Autopilot API server would hand back: every create-time default
 * it fills in, plus the platform's own four mutations. Deliberately verbose — the
 * point of the test is that all of the first list is noise the capture must drop.
 */
function defaultedLikeAnApiServer(pod: V1Pod): V1Pod {
  const out = structuredClone(pod);
  // --- bookkeeping every create gets ---
  out.metadata = {
    ...out.metadata,
    creationTimestamp: new Date("2026-09-23T11:22:33.000Z"),
    uid: "8f6f0c62-0f2e-4a1a-9d2e-2b4b4f7c1a11",
    resourceVersion: "123456",
    generation: 1,
    managedFields: [{ manager: "wardby", operation: "Update", apiVersion: "v1" }],
  };
  out.status = { phase: "Pending" };
  // --- spec-level defaulting ---
  const spec = out.spec!;
  spec.schedulerName = "default-scheduler";
  spec.priority = 0;
  spec.preemptionPolicy = "PreemptLowerPriority";
  spec.serviceAccount = spec.serviceAccountName;
  // Go's omitempty drops these three at `false`.
  delete spec.hostNetwork;
  delete spec.hostPID;
  delete spec.hostIPC;
  for (const container of [...(spec.initContainers ?? []), ...spec.containers]) {
    container.terminationMessagePath = "/dev/termination-log";
    container.terminationMessagePolicy = "File";
    container.imagePullPolicy = "IfNotPresent";
    requantize(container.resources?.requests);
    requantize(container.resources?.limits);
    if (container.readinessProbe) {
      container.readinessProbe.timeoutSeconds = 1;
      container.readinessProbe.successThreshold = 1;
      container.readinessProbe.failureThreshold = 3;
    }
  }
  for (const volume of spec.volumes ?? []) {
    if (volume.emptyDir?.sizeLimit === "2048Mi") volume.emptyDir.sizeLimit = "2Gi";
  }
  spec.tolerations = [...NODE_HEALTH_TOLERATIONS];
  // --- and now the four things the PLATFORM actually did ---
  out.metadata.annotations = {
    ...out.metadata.annotations,
    "autopilot.gke.io/resource-adjustment": ADJUSTMENT,
    "autopilot.gke.io/warden-version": "1.2.3",
  };
  spec.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
  spec.tolerations = [GVISOR_TOLERATION, ...NODE_HEALTH_TOLERATIONS];
  return out;
}

function api(options: { admit?: (pod: V1Pod) => V1Pod; version?: string } = {}): FakeKubernetesApi {
  const fake = new FakeKubernetesApi();
  fake.put("service", NAMESPACE, {
    metadata: { name: SERVICE },
    spec: {
      clusterIP: CLUSTER_IP,
      ports: [
        { port: 8787, protocol: "TCP" },
        { port: 8788, protocol: "TCP" },
      ],
    },
  });
  fake.put("endpoints", NAMESPACE, {
    metadata: { name: SERVICE },
    subsets: [
      {
        addresses: [{ ip: "10.244.0.5" }],
        ports: [
          { port: 8787, protocol: "TCP" },
          { port: 8788, protocol: "TCP" },
        ],
      },
    ],
  });
  fake.apiServerVersion = options.version ?? "v1.33.4-gke.1000";
  if (options.admit) {
    const admit = options.admit;
    fake.onDryRunCreatePod = async (_namespace, body) => admit(body);
  }
  return fake;
}

describe("captureFixture", () => {
  it("records only the platform's mutations, not the API server's defaulting", async () => {
    const fixture = await captureFixture(api({ admit: defaultedLikeAnApiServer }), options);
    expect(fixture.mutations).toEqual([
      { op: "add", path: "/metadata/annotations/autopilot.gke.io~1resource-adjustment", value: ADJUSTMENT },
      { op: "add", path: "/metadata/annotations/autopilot.gke.io~1warden-version", value: "1.2.3" },
      { op: "add", path: "/spec/nodeSelector", value: { "sandbox.gke.io/runtime": "gvisor" } },
      { op: "add", path: "/spec/tolerations", value: [GVISOR_TOLERATION] },
    ]);
  });

  it("without that pass the same read-back buries the platform in opaque array replacements", () => {
    // The regression this exists to prevent: a naive diff of the raw pair. Every container's
    // image, command, env, resources and securityContext collapses into one `replace` blob,
    // and a genuine Autopilot rewrite *inside* a container would be invisible in it.
    const naive = diffMutations(submittedPod(), defaultedLikeAnApiServer(submittedPod()));
    expect(naive.map((mutation) => mutation.path)).toEqual(
      expect.arrayContaining(["/spec/containers", "/spec/initContainers", "/spec/schedulerName"]),
    );
    expect(naive.length).toBeGreaterThan(4);
  });

  it("produces a mutation set the attestation comparator accepts", async () => {
    const fixture = await captureFixture(api({ admit: defaultedLikeAnApiServer }), options);
    const submitted = submittedPod();
    expect(() =>
      assertRunPodMatches(applyMutations(submitted, fixture.mutations), submitted, "gke-autopilot"),
    ).not.toThrow();
  });

  it("stamps the API server version and the fingerprint it actually saw", async () => {
    const fixture = await captureFixture(api({ admit: defaultedLikeAnApiServer }), options);
    expect(fixture.provisional).toBe(false);
    expect(fixture.source).not.toContain("PROVISIONAL");
    expect(fixture.source).toContain("v1.33.4-gke.1000");
    expect(fixture.source).toContain("autopilot.gke.io/resource-adjustment");
    expect(fixture.capturedAt).toBe("2026-09-23");
    expect(fixture.platform).toBe("gke-autopilot");
  });

  it("refuses to capture the generic platform, which forgives nothing", async () => {
    await expect(captureFixture(api(), { ...options, platform: "generic" })).rejects.toThrow(CAPTURE_REFUSED);
  });

  it("refuses to write when the cluster did not answer like the platform", async () => {
    // A cluster that is not Autopilot returns the pod essentially as submitted. Writing
    // `provisional: false` from that would machine-author an attestation of a fact never checked.
    await expect(captureFixture(api(), options)).rejects.toThrow(CAPTURE_REFUSED);
    await expect(captureFixture(api(), options)).rejects.toThrow(/did not answer like gke-autopilot/);
  });

  it("refuses before submitting anything when the proxy witness is unusable", async () => {
    const fake = new FakeKubernetesApi();
    let submitted = false;
    fake.onDryRunCreatePod = async (_namespace, body) => {
      submitted = true;
      return body;
    };
    await expect(captureFixture(fake, options)).rejects.toThrow("kubernetes_proxy_witness_unusable");
    expect(submitted).toBe(false);
  });

  it("never persists the pod it submits", async () => {
    const fake = api({ admit: defaultedLikeAnApiServer });
    await captureFixture(fake, options);
    expect([...fake.objects.keys()].filter((key) => key.startsWith("pod/"))).toEqual([]);
  });
});

describe("stripServerMetadata", () => {
  it("drops create-time bookkeeping and status without touching the rest", () => {
    const stripped = stripServerMetadata({
      metadata: {
        name: "wardby-run-x",
        namespace: NAMESPACE,
        creationTimestamp: new Date(0),
        uid: "u",
        resourceVersion: "1",
        generation: 1,
        managedFields: [{ manager: "kubelet" }],
        annotations: { "autopilot.gke.io/warden-version": "1.2.3" },
      },
      spec: { containers: [] },
      status: { phase: "Pending" },
    });
    expect(stripped.metadata).toEqual({
      name: "wardby-run-x",
      namespace: NAMESPACE,
      annotations: { "autopilot.gke.io/warden-version": "1.2.3" },
    });
    expect(stripped.status).toBeUndefined();
  });

  it("copies rather than mutating the pod it was given", () => {
    const pod: V1Pod = { metadata: { name: "p", uid: "u" }, spec: { containers: [] } };
    stripServerMetadata(pod);
    expect(pod.metadata?.uid).toBe("u");
  });
});

describe("platformFingerprint", () => {
  it("finds an annotation the profile names, and nothing else", () => {
    const withAnnotation: V1Pod = { metadata: { annotations: { "autopilot.gke.io/warden-version": "1" } } };
    expect(platformFingerprint("gke-autopilot", withAnnotation)).toBe("autopilot.gke.io/warden-version");
    expect(platformFingerprint("gke-autopilot", { metadata: { annotations: { "wardby.io/run-id": "r" } } })).toBe(
      undefined,
    );
    expect(platformFingerprint("gke-autopilot", {})).toBe(undefined);
    // generic names no prefixes, so it has no fingerprint to claim.
    expect(platformFingerprint("generic", withAnnotation)).toBe(undefined);
  });
});
