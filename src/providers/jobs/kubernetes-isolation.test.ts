import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { V1NetworkPolicy, V1Pod } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import type { JobSpec } from "./types.js";
import {
  KUBERNETES_ISOLATION_ERROR,
  KUBERNETES_PROVIDER_UNSUPPORTED,
  STORAGE_INIT_CONTAINER,
  STORAGE_ROOT,
  assertRunNetworkPolicyMatches,
  assertRunPodMatches,
  buildCapabilitySecret,
  buildRunNetworkPolicy,
  buildRunPod,
  enforcementProbeScript,
  isRegistryDigest,
  kubernetesRunNames,
  kubernetesRunNamesForToken,
  runLabels,
  validateKubernetesSpec,
} from "./kubernetes-isolation.js";
import { podEphemeralStorageMib } from "./kubernetes-platform.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-k8s-1",
  provider: "codex",
  image: IMAGE,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const options = { namespace: "wardby-coding", proxyIp: "10.96.0.50" };
const pod = () => buildRunPod(spec, options);
const worker = (p: V1Pod) => p.spec!.containers.find((c) => c.name === "worker")!;
const keeper = (p: V1Pod) => p.spec!.containers.find((c) => c.name === "keeper")!;
const storageInit = (p: V1Pod) => p.spec!.initContainers!.find((c) => c.name === "storage-init")!;

/** Rebuilds an object graph with every object's keys in reverse insertion order; array element order is untouched. */
function shuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, v]): [string, unknown] => [
      key,
      shuffleKeys(v),
    ]);
    entries.reverse();
    return Object.fromEntries(entries) as T;
  }
  return value;
}

/** Round-trips a value through ObjectSerializer the way a real API read-back would, including its key reordering. */
function apiRoundTrip<T>(value: T, type: string): T {
  const serialized = ObjectSerializer.serialize(value, type) as unknown;
  return ObjectSerializer.deserialize(JSON.parse(JSON.stringify(serialized)), type) as T;
}

describe("kubernetes run names and labels", () => {
  it("derives stable DNS-1123 names from the run ID hash", () => {
    const names = kubernetesRunNames(spec.runId);
    expect(names.token).toMatch(/^[a-f0-9]{20}$/);
    expect(names.pod).toBe(`wardby-run-${names.token}`);
    expect(names.secret).toBe(`wardby-run-${names.token}-cap`);
    expect(kubernetesRunNames(spec.runId)).toEqual(names);
    expect(runLabels(spec.runId)).toEqual({
      "app.kubernetes.io/managed-by": "wardby",
      "wardby.io/component": "coding-run",
      "wardby.io/run-sha256": names.runSha,
    });
    expect(names.runSha).toMatch(/^[a-f0-9]{40}$/);
  });
});

describe("isRegistryDigest", () => {
  const digest = `@sha256:${"c".repeat(64)}`;
  it.each([
    `localhost:5001/wardby-coding-worker${digest}`,
    `registry.example.com:443/a/b${digest}`,
    `registry.example/wardby-worker${digest}`,
  ])("accepts %s", (reference) => {
    expect(isRegistryDigest(reference)).toBe(true);
  });
  it.each([
    ["a bare local image ID", `sha256:${"c".repeat(64)}`],
    ["a tag before the digest", `wardby-worker:dev${digest}`],
    ["a tag after a registry port", `localhost:5001/wardby-coding-worker:dev${digest}`],
    ["a port on a later component", `registry.example/team:5001/worker${digest}`],
    ["a port-only first component", `:5001/wardby-worker${digest}`],
    ["an empty path component", `localhost:5001//wardby-worker${digest}`],
  ])("rejects %s", (_label, reference) => {
    expect(isRegistryDigest(reference)).toBe(false);
  });
});

describe("validateKubernetesSpec", () => {
  it("accepts a registry-digest Codex spec", () => {
    expect(() => validateKubernetesSpec(spec)).not.toThrow();
    expect(isRegistryDigest(IMAGE)).toBe(true);
  });
  it("rejects a bare local image ID, which a cluster cannot pull", () => {
    expect(() => validateKubernetesSpec({ ...spec, image: `sha256:${"b".repeat(64)}` })).toThrow(
      KUBERNETES_ISOLATION_ERROR,
    );
  });
  it("rejects Claude Code until Plan 2b", () => {
    expect(() => validateKubernetesSpec({ ...spec, provider: "claude-code", toolImage: IMAGE })).toThrow(
      KUBERNETES_PROVIDER_UNSUPPORTED,
    );
  });
  it("rejects a cpus value that isn't a whole number of millicores", () => {
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 0.0005 } })).toThrow(
      KUBERNETES_ISOLATION_ERROR,
    );
  });
  it("accepts cpus values that are already a whole number of millicores", () => {
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 16.1 } })).not.toThrow();
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 2.01 } })).not.toThrow();
  });
});

describe("buildRunPod", () => {
  it("never mounts a Kubernetes token, shares host namespaces, or restarts", () => {
    const s = pod().spec!;
    expect(s.automountServiceAccountToken).toBe(false);
    expect(s.serviceAccountName).toBe("wardby-coding-worker");
    expect(s.enableServiceLinks).toBe(false);
    expect([s.hostNetwork, s.hostPID, s.hostIPC, s.shareProcessNamespace]).toEqual([false, false, false, false]);
    expect(s.restartPolicy).toBe("Never");
    expect(s.activeDeadlineSeconds).toBe(1200);
  });

  it("runs every container non-root, read-only, with no privileges or capabilities", () => {
    expect(pod().spec!.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    for (const c of [...pod().spec!.containers, ...pod().spec!.initContainers!]) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        privileged: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        capabilities: { drop: ["ALL"] },
      });
    }
  });

  it("creates the storage subdirectories in a minimal init container before any subPath mount", () => {
    const s = pod().spec!;
    expect(s.initContainers).toHaveLength(1);
    const init = storageInit(pod());
    expect(init.name).toBe(STORAGE_INIT_CONTAINER);
    expect(init.image).toBe(IMAGE);
    expect(init.volumeMounts).toEqual([{ name: "storage", mountPath: STORAGE_ROOT }]);
    expect(init.env).toBeUndefined();
    expect(init.resources).toEqual(keeper(pod()).resources);
    // Exact match, not a substring check: any change to the script (a directory dropped, the
    // mode loosened, mkdirSync/chmodSync reordered) must fail this test, not just a loose one.
    const expectedScript = [
      'const fs = require("node:fs");',
      'for (const name of ["workspace", "input", "output"]) {',
      `  const path = ${JSON.stringify(STORAGE_ROOT)} + "/" + name;`,
      "  fs.mkdirSync(path, { recursive: true, mode: 0o700 });",
      "  fs.chmodSync(path, 0o700);",
      "}",
    ].join("\n");
    expect(init.command).toEqual(["node", "-e", expectedScript]);
  });

  it("derives every per-run object name through one naming source", () => {
    const names = kubernetesRunNames(spec.runId);
    const { runSha, ...fromRunId } = names;
    expect(runSha.startsWith(names.token)).toBe(true);
    expect(kubernetesRunNamesForToken(names.token)).toEqual(fromRunId);
    expect(fromRunId).toEqual({
      token: names.token,
      pod: `wardby-run-${names.token}`,
      policy: `wardby-run-${names.token}`,
      record: `wardby-run-${names.token}`,
      secret: `wardby-run-${names.token}-cap`,
    });
  });

  it("denies DNS and reaches the proxy only through a hostAlias", () => {
    const s = pod().spec!;
    expect(s.dnsPolicy).toBe("None");
    expect(s.dnsConfig).toEqual({ nameservers: ["127.0.0.1"] });
    expect(s.hostAliases).toEqual([{ ip: "10.96.0.50", hostnames: ["wardby-proxy"] }]);
    expect(worker(pod()).env).toEqual([
      { name: "WARDBY_PROXY_URL", value: "http://wardby-proxy:8787" },
      {
        name: "WARDBY_RUN_CAPABILITY",
        valueFrom: { secretKeyRef: { name: kubernetesRunNames(spec.runId).secret, key: "capability" } },
      },
    ]);
  });

  it("gives the worker the four storage areas and never Git metadata", () => {
    expect(worker(pod()).volumeMounts).toEqual([
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "home", mountPath: "/home/wardby" },
    ]);
    expect(keeper(pod()).volumeMounts).toEqual([{ name: "storage", mountPath: "/run/wardby/storage" }]);
  });

  it("uses a disk-backed workspace sized by limits.diskMb and fixed resources", () => {
    const volumes = pod().spec!.volumes!;
    expect(volumes.find((v) => v.name === "storage")?.emptyDir).toEqual({ sizeLimit: "2048Mi" });
    expect(worker(pod()).resources).toEqual({
      requests: { cpu: "1000m", memory: "2048Mi" },
      limits: { cpu: "1000m", memory: "2048Mi" },
    });
  });

  it("gates the worker on the seeded marker before loading the worker entrypoint", () => {
    const command = worker(pod()).command!;
    expect(command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(command[2]).toContain("/run/wardby/input/.seeded");
    expect(command[2]).toContain("/opt/wardby/coding-worker/main.js");
    expect(keeper(pod()).command).toEqual(["node", "/opt/wardby/coding-worker/keeper.js"]);
  });

  it("adds the runtime class only when configured", () => {
    expect(pod().spec!.runtimeClassName).toBeUndefined();
    expect(buildRunPod(spec, { ...options, runtimeClassName: "gvisor" }).spec!.runtimeClassName).toBe("gvisor");
  });
});

describe("buildRunPod under the gke-autopilot platform", () => {
  const autopilotOptions = { ...options, platform: "gke-autopilot" as const, runtimeClassName: "gvisor" };
  const autopilotPod = () => buildRunPod(spec, autopilotOptions);

  it("emits Autopilot-legal resources for every container", () => {
    const p = autopilotPod();
    expect(worker(p).resources).toEqual({
      requests: { cpu: "1000m", memory: "2048Mi", "ephemeral-storage": "1024Mi" },
      limits: { cpu: "1000m", memory: "2048Mi", "ephemeral-storage": "1024Mi" },
    });
    // 250m with 128Mi is below Autopilot's 1 GiB-per-vCPU floor; memory rises rather than being rewritten.
    expect(keeper(p).resources).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "2048Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "2048Mi" },
    });
    expect(storageInit(p).resources).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
    });
  });

  it("changes nothing but the resource blocks", () => {
    const strip = (p: V1Pod) => {
      const copy = structuredClone(p);
      for (const c of [...copy.spec!.containers, ...(copy.spec!.initContainers ?? [])]) delete c.resources;
      return copy;
    };
    expect(strip(autopilotPod())).toEqual(strip(buildRunPod(spec, { ...options, runtimeClassName: "gvisor" })));
  });

  it("still emits nothing extra under generic", () => {
    expect(keeper(pod()).resources).toEqual({
      requests: { cpu: "250m", memory: "128Mi" },
      limits: { cpu: "250m", memory: "128Mi" },
    });
    expect(storageInit(pod()).resources).toEqual({
      requests: { cpu: "250m", memory: "128Mi" },
      limits: { cpu: "250m", memory: "128Mi" },
    });
  });

  it("refuses to build a pod on gke-autopilot without runtimeClassName=gvisor", () => {
    expect(() => buildRunPod(spec, { ...options, platform: "gke-autopilot" })).toThrow(
      "kubernetes_platform_unconformable: platform gke-autopilot requires runtimeClassName=gvisor (found unset)",
    );
    expect(() => buildRunPod(spec, { ...options, platform: "gke-autopilot", runtimeClassName: "other" })).toThrow(
      "kubernetes_platform_unconformable: platform gke-autopilot requires runtimeClassName=gvisor (found other)",
    );
  });

  it("refuses a workspace that cannot fit the 10 GiB pod ephemeral-storage ceiling", () => {
    const big: JobSpec = { ...spec, limits: { ...spec.limits, diskMb: 16_384 } };
    expect(() => buildRunPod(big, autopilotOptions)).toThrow(
      /kubernetes_platform_unconformable: a 16384 MiB workspace needs 17408 MiB of pod ephemeral storage, over the 10240 MiB \(10 GiB\) ceiling/,
    );
    expect(() => buildRunPod({ ...spec, limits: { ...spec.limits, diskMb: 9216 } }, autopilotOptions)).not.toThrow();
  });

  it("builds the same pod under generic regardless of the ceiling", () => {
    const big: JobSpec = { ...spec, limits: { ...spec.limits, diskMb: 16_384 } };
    expect(() => buildRunPod(big, options)).not.toThrow();
  });

  it("does not require gvisor under generic", () => {
    expect(() => buildRunPod(spec, { ...options, platform: "generic" })).not.toThrow();
    expect(buildRunPod(spec, { ...options, platform: "generic" }).spec!.runtimeClassName).toBeUndefined();
  });

  // The ceiling guard trusts podEphemeralStorageMib to predict what the pod will actually
  // reserve. Recompute Kubernetes' own rule — max(sum(regular), max(init)) — from the built
  // pod, so a fourth container or a changed constant makes the guard's under-count fail here
  // rather than on a live cluster.
  it.each([64, 512, 2048, 9216])("predicts the pod ephemeral total it actually emits (diskMb=%i)", (diskMb) => {
    const p = buildRunPod({ ...spec, limits: { ...spec.limits, diskMb } }, autopilotOptions);
    const mib = (c: { resources?: { requests?: Record<string, string> } }) => {
      const value = c.resources!.requests!["ephemeral-storage"];
      expect(value).toMatch(/^\d+Mi$/);
      return Number.parseInt(value, 10);
    };
    const regular = p.spec!.containers.reduce((sum, c) => sum + mib(c), 0);
    const init = (p.spec!.initContainers ?? []).reduce((max, c) => Math.max(max, mib(c)), 0);
    expect(Math.max(regular, init)).toBe(podEphemeralStorageMib(diskMb));
  });
});

describe("assertRunPodMatches with a platform profile", () => {
  const autopilotOptions = { ...options, platform: "gke-autopilot" as const, runtimeClassName: "gvisor" };

  it("forgives the Autopilot annotations, nodeSelector and toleration under gke-autopilot", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
    actual.spec!.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
    actual.spec!.tolerations = [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" },
    ];
    expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).not.toThrow();
  });

  it("leaves both operands untouched, so the caller's pods keep their own metadata", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
    actual.spec!.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
    const actualBefore = structuredClone(actual);
    const expectedBefore = structuredClone(expected);
    assertRunPodMatches(actual, expected, "gke-autopilot");
    expect(actual).toEqual(actualBefore);
    expect(expected).toEqual(expectedBefore);
  });

  it("rejects those same additions under generic, including by default", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.spec!.nodeSelector = { "sandbox.gke.io/runtime": "gvisor" };
    expect(() => assertRunPodMatches(actual, expected, "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  // Each case is layered on top of a forgiven Autopilot annotation, so it proves the
  // allowance does not become a hiding place rather than merely that tampering fails.
  it.each([
    ["hostNetwork enabled", (p: V1Pod) => void (p.spec!.hostNetwork = true)],
    ["service account token mounted", (p: V1Pod) => void (p.spec!.automountServiceAccountToken = true)],
    ["writable root filesystem", (p: V1Pod) => void (worker(p).securityContext!.readOnlyRootFilesystem = false)],
    ["worker command replaced", (p: V1Pod) => void (worker(p).command = ["node", "-e", "evil"])],
    ["unrelated annotation added", (p: V1Pod) => void (p.metadata!.annotations!["example.com/x"] = "1")],
    [
      "worker ephemeral-storage limit raised",
      (p: V1Pod) => void (worker(p).resources!.limits!["ephemeral-storage"] = "8192Mi"),
    ],
    ["runtime class removed", (p: V1Pod) => void (p.spec!.runtimeClassName = undefined)],
    ["pod seccomp profile removed", (p: V1Pod) => void (p.spec!.securityContext!.seccompProfile = undefined)],
    ["wardby component label changed", (p: V1Pod) => void (p.metadata!.labels!["wardby.io/component"] = "x")],
    [
      "allowed nodeSelector key with a different value",
      (p: V1Pod) => void (p.spec!.nodeSelector = { "sandbox.gke.io/runtime": "runc" }),
    ],
    [
      "unrelated toleration added",
      (p: V1Pod) =>
        void (p.spec!.tolerations = [{ key: "example.com/taint", operator: "Exists", effect: "NoSchedule" }]),
    ],
  ])("still rejects a security-relevant change under gke-autopilot: %s", (_name, tamper) => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
    tamper(actual);
    expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  // Go's resource.Quantity re-renders in canonical binary form once the string it was
  // parsed from is dropped, which is exactly what a resource-rewriting admission
  // controller does. Same number, different spelling, must not fail the run.
  it("accepts a re-rendered ephemeral-storage quantity but not a different one", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const respell = (value: string) => {
      const actual = structuredClone(expected);
      actual.metadata!.annotations!["autopilot.gke.io/resource-adjustment"] = "{}";
      for (const bag of [worker(actual).resources!.requests!, worker(actual).resources!.limits!]) {
        bag["ephemeral-storage"] = value;
      }
      return actual;
    };
    expect(worker(expected).resources!.limits!["ephemeral-storage"]).toBe("1024Mi");
    expect(() => assertRunPodMatches(respell("1Gi"), expected, "gke-autopilot")).not.toThrow();
    expect(() => assertRunPodMatches(respell("1073741824"), expected, "gke-autopilot")).not.toThrow();
    expect(() => assertRunPodMatches(respell("8192Mi"), expected, "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(respell("1025Mi"), expected, "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});

describe("buildRunNetworkPolicy", () => {
  it("allows no ingress and egress only to the proxy pods on the proxy port", () => {
    const policy = buildRunNetworkPolicy(spec, "wardby-coding");
    expect(policy.spec?.podSelector).toEqual({ matchLabels: runLabels(spec.runId) });
    expect(policy.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.spec?.ingress).toEqual([]);
    expect(policy.spec?.egress).toEqual([
      {
        to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-coding-proxy" } } }],
        ports: [{ protocol: "TCP", port: 8787 }],
      },
    ]);
  });
});

describe("buildCapabilitySecret", () => {
  it("holds only the capability, labeled for the run", () => {
    const secret = buildCapabilitySecret(spec, "wardby-coding", "rrp_capability_value_123456");
    expect(secret.metadata?.name).toBe(kubernetesRunNames(spec.runId).secret);
    expect(secret.metadata?.labels).toEqual(runLabels(spec.runId));
    expect(secret.stringData).toEqual({ capability: "rrp_capability_value_123456" });
  });
});

describe("assertRunPodMatches", () => {
  const expected = pod();
  const DEFAULT_TOLERATION_1 = {
    key: "node.kubernetes.io/not-ready",
    operator: "Exists",
    effect: "NoExecute",
    tolerationSeconds: 300,
  };
  const DEFAULT_TOLERATION_2 = {
    key: "node.kubernetes.io/unreachable",
    operator: "Exists",
    effect: "NoExecute",
    tolerationSeconds: 300,
  };
  // Simulates everything the Kubernetes API server itself defaults or reorders on a real read-back.
  const withApiDefaults = (p: V1Pod): V1Pod => {
    const c = structuredClone(p);
    const s = c.spec!;
    s.schedulerName = "default-scheduler";
    s.nodeName = "node-1";
    s.priority = 0;
    s.preemptionPolicy = "PreemptLowerPriority";
    s.serviceAccount = s.serviceAccountName;
    s.tolerations = [DEFAULT_TOLERATION_1, DEFAULT_TOLERATION_2];
    const apiContainerDefaults = (x: NonNullable<typeof s.initContainers>[number]) => ({
      ...x,
      terminationMessagePath: "/dev/termination-log",
      terminationMessagePolicy: "File",
      imagePullPolicy: "IfNotPresent",
    });
    s.containers = s.containers.map(apiContainerDefaults);
    s.initContainers = s.initContainers!.map(apiContainerDefaults);
    keeper(c).readinessProbe = {
      ...keeper(c).readinessProbe,
      timeoutSeconds: 1,
      successThreshold: 1,
      failureThreshold: 3,
    };
    keeper(c).volumeMounts = keeper(c).volumeMounts!.map((m) => ({ ...m, mountPropagation: "None" }));
    worker(c).resources = {
      requests: { cpu: "1000m", memory: "2Gi" },
      limits: { cpu: "1000m", memory: "2Gi" },
    };
    return c;
  };

  it("accepts the expected pod and API defaults / normalized quantities", () => {
    expect(() => assertRunPodMatches(withApiDefaults(expected), expected)).not.toThrow();
  });

  it("accepts a real API round trip through ObjectSerializer", () => {
    const roundTripped = apiRoundTrip(withApiDefaults(expected), "V1Pod");
    expect(() => assertRunPodMatches(roundTripped, expected)).not.toThrow();
  });

  it("accepts a copy with every object's keys in a different order", () => {
    expect(() => assertRunPodMatches(shuffleKeys(withApiDefaults(expected)), expected)).not.toThrow();
  });

  it("matches a read-back pod whose worker CPU is already normalized to millicores", () => {
    const cpuSpec: JobSpec = { ...spec, limits: { ...spec.limits, cpus: 16.1 } };
    const expectedCpuPod = buildRunPod(cpuSpec, options);
    const actual = structuredClone(expectedCpuPod);
    worker(actual).resources!.requests!.cpu = "16100m";
    worker(actual).resources!.limits!.cpu = "16100m";
    expect(() => assertRunPodMatches(actual, expectedCpuPod)).not.toThrow();
  });

  it("accepts a pod with omitempty-dropped hostNetwork/hostPID/hostIPC", () => {
    const actual = withApiDefaults(expected);
    delete actual.spec!.hostNetwork;
    delete actual.spec!.hostPID;
    delete actual.spec!.hostIPC;
    expect(() => assertRunPodMatches(actual, expected)).not.toThrow();
  });

  it("rejects a read-back pod whose spec.containers isn't an array", () => {
    const actual = structuredClone(expected);
    (actual.spec as unknown as Record<string, unknown>).containers = "not-an-array";
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  const mutations: Array<[string, (p: V1Pod) => void]> = [
    ["token mounted", (p) => void (p.spec!.automountServiceAccountToken = true)],
    ["host network", (p) => void (p.spec!.hostNetwork = true)],
    ["host PID", (p) => void (p.spec!.hostPID = true)],
    ["host IPC", (p) => void (p.spec!.hostIPC = true)],
    ["privileged worker", (p) => void (worker(p).securityContext!.privileged = true)],
    ["added capability", (p) => void (worker(p).securityContext!.capabilities = { drop: ["ALL"], add: ["NET_RAW"] })],
    ["writable root", (p) => void (worker(p).securityContext!.readOnlyRootFilesystem = false)],
    [
      "injected sidecar",
      (p) => void p.spec!.containers.push({ name: "mesh-proxy", image: "mesh@sha256:" + "c".repeat(64) }),
    ],
    ["init container", (p) => void (p.spec!.initContainers = [{ name: "init", image: IMAGE }])],
    ["extra init container", (p) => void p.spec!.initContainers!.push({ name: "init", image: IMAGE })],
    ["storage init removed", (p) => void delete p.spec!.initContainers],
    [
      "storage init as root",
      (p) => void (storageInit(p).securityContext = { ...storageInit(p).securityContext, runAsUser: 0 }),
    ],
    [
      "storage init with an extra mount",
      (p) => void storageInit(p).volumeMounts!.push({ name: "tmp", mountPath: "/tmp" }),
    ],
    ["storage init with a different command", (p) => void (storageInit(p).command = ["sh", "-c", "id"])],
    ["storage init with a different image", (p) => void (storageInit(p).image = `other@sha256:${"d".repeat(64)}`)],
    [
      "storage init with an added capability",
      (p) => void (storageInit(p).securityContext!.capabilities = { drop: ["ALL"], add: ["CHOWN"] }),
    ],
    ["hostPath volume", (p) => void p.spec!.volumes!.push({ name: "host", hostPath: { path: "/" } })],
    ["extra env", (p) => void worker(p).env!.push({ name: "EXTRA", value: "1" })],
    ["different image", (p) => void (worker(p).image = `other@sha256:${"d".repeat(64)}`)],
    ["dns re-enabled", (p) => void (p.spec!.dnsPolicy = "ClusterFirst")],
    ["higher memory limit", (p) => void (worker(p).resources!.limits!.memory = "4096Mi")],
    [
      "worker CPU request off by a fractional millicore (1000.4m)",
      (p) => void (worker(p).resources!.requests!.cpu = "1000.4m"),
    ],
    [
      "worker CPU request off by a fractional millicore (0.9996)",
      (p) => void (worker(p).resources!.requests!.cpu = "0.9996"),
    ],
    [
      "worker memory limit off by a fractional byte (2048.0000001Mi)",
      (p) => void (worker(p).resources!.limits!.memory = "2048.0000001Mi"),
    ],
    [
      "lifecycle postStart exec hook",
      (p) => void (worker(p).lifecycle = { postStart: { exec: { command: ["sh", "-c", "id"] } } }),
    ],
    ["livenessProbe added", (p) => void (worker(p).livenessProbe = { exec: { command: ["true"] } })],
    ["startupProbe added", (p) => void (worker(p).startupProbe = { exec: { command: ["true"] } })],
    [
      "keeper readinessProbe swapped to link-local httpGet",
      (p) =>
        void (keeper(p).readinessProbe = {
          httpGet: { path: "/", port: 80, host: "169.254.169.254" },
          periodSeconds: 1,
        }),
    ],
    ["pod appArmorProfile Unconfined", (p) => void (p.spec!.securityContext!.appArmorProfile = { type: "Unconfined" })],
    [
      "container appArmorProfile Unconfined",
      (p) => void (worker(p).securityContext!.appArmorProfile = { type: "Unconfined" }),
    ],
    ["pod seLinuxOptions spc_t", (p) => void (p.spec!.securityContext!.seLinuxOptions = { type: "spc_t" })],
    ["container seLinuxOptions spc_t", (p) => void (worker(p).securityContext!.seLinuxOptions = { type: "spc_t" })],
    ["container procMount Unmasked", (p) => void (worker(p).securityContext!.procMount = "Unmasked")],
    ["container runAsGroup 0", (p) => void (worker(p).securityContext!.runAsGroup = 0)],
    ["pod supplementalGroups [0]", (p) => void (p.spec!.securityContext!.supplementalGroups = [0])],
    ["tolerations non-default entry", (p) => void (p.spec!.tolerations = [{ operator: "Exists" }])],
    ["nodeSelector added", (p) => void (p.spec!.nodeSelector = { disktype: "ssd" })],
    ["affinity added", (p) => void (p.spec!.affinity = { nodeAffinity: {} })],
    ["container resources.claims added", (p) => void (worker(p).resources!.claims = [{ name: "gpu" }])],
    [
      "volumeMount mountPropagation Bidirectional",
      (p) => void (worker(p).volumeMounts![0].mountPropagation = "Bidirectional"),
    ],
    ["volumeMount subPathExpr added", (p) => void (worker(p).volumeMounts![0].subPathExpr = "$(POD_NAME)")],
    ["terminationGracePeriodSeconds changed", (p) => void (p.spec!.terminationGracePeriodSeconds = 999)],
    [
      "container windowsOptions.hostProcess",
      (p) => void (worker(p).securityContext!.windowsOptions = { hostProcess: true }),
    ],
    ["extra annotation added", (p) => void (p.metadata!.annotations = { ...p.metadata!.annotations, foo: "bar" })],
    [
      "legacy AppArmor annotation added",
      (p) =>
        void (p.metadata!.annotations = {
          ...p.metadata!.annotations,
          "container.apparmor.security.beta.kubernetes.io/worker": "unconfined",
        }),
    ],
    [
      "extra toleration beyond defaults",
      (p) =>
        void (p.spec!.tolerations = [
          DEFAULT_TOLERATION_1,
          DEFAULT_TOLERATION_2,
          { key: "custom", operator: "Exists" },
        ]),
    ],
    ["serviceAccount differs from serviceAccountName", (p) => void (p.spec!.serviceAccount = "attacker-sa")],
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const actual = withApiDefaults(expected);
    mutate(actual);
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("rejects a different runtime class", () => {
    const gv = buildRunPod(spec, { ...options, runtimeClassName: "gvisor" });
    const actual = withApiDefaults(gv);
    actual.spec!.runtimeClassName = "runc";
    expect(() => assertRunPodMatches(actual, gv)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("rejects a missing runtime class", () => {
    const gv = buildRunPod(spec, { ...options, runtimeClassName: "gvisor" });
    const actual = withApiDefaults(gv);
    delete actual.spec!.runtimeClassName;
    expect(() => assertRunPodMatches(actual, gv)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});

describe("assertRunNetworkPolicyMatches", () => {
  it("rejects a policy that gained an egress rule", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    const actual = structuredClone(expected);
    actual.spec!.egress!.push({ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] });
    expect(() => assertRunNetworkPolicyMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunNetworkPolicyMatches(structuredClone(expected), expected)).not.toThrow();
  });

  it("accepts a real API round trip through ObjectSerializer", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    const roundTripped = apiRoundTrip<V1NetworkPolicy>(expected, "V1NetworkPolicy");
    expect(() => assertRunNetworkPolicyMatches(roundTripped, expected)).not.toThrow();
  });

  it("accepts a copy with every object's keys in a different order", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    expect(() => assertRunNetworkPolicyMatches(shuffleKeys(structuredClone(expected)), expected)).not.toThrow();
  });

  it("accepts a policy with omitempty-dropped ingress", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    const actual = structuredClone(expected);
    delete actual.spec!.ingress;
    expect(() => assertRunNetworkPolicyMatches(actual, expected)).not.toThrow();
  });

  it("rejects a policy that gained a non-empty ingress rule", () => {
    const expected = buildRunNetworkPolicy(spec, "wardby-coding");
    const actual = structuredClone(expected);
    actual.spec!.ingress = [{ ports: [{ protocol: "TCP", port: 9999 }] }];
    expect(() => assertRunNetworkPolicyMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});

describe("enforcementProbeScript", () => {
  /** Drives the real script in a VM with a fake net, one outcome per port. */
  async function runProbe(script: string, outcome: Record<number, "connect" | "timeout" | "error">): Promise<number> {
    return new Promise((resolve) => {
      runInNewContext(script, {
        require: () => ({
          connect: ({ port }: { port: number }) => {
            const handlers: Record<string, () => void> = {};
            setTimeout(() => handlers[outcome[port]]?.(), 0);
            return {
              once: (event: string, handler: () => void) => void (handlers[event] = handler),
              destroy: () => {},
            };
          },
        }),
        process: { exit: (code: number) => resolve(code) },
        setTimeout,
      });
    });
  }

  it("measures both proxy ports with a SYN-safe 3 s connect timeout", () => {
    const script = enforcementProbeScript("10.96.0.50");
    expect(script).toContain('host: "10.96.0.50"');
    expect(script).toContain("timeout: 3000");
    expect(script).toContain("await tcp(8787)");
    expect(script).toContain("await tcp(8788)");
    expect(script).not.toContain("port: 53");
  });

  it("rejects an address that is not an IP", () => {
    expect(() => enforcementProbeScript("wardby-proxy")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => enforcementProbeScript('10.0.0.1"; require("child_process")')).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("exits 0 only when the proxy port connected and the deny port was blocked", async () => {
    const script = enforcementProbeScript("10.96.0.50");
    expect(await runProbe(script, { 8787: "connect", 8788: "timeout" })).toBe(0);
    expect(await runProbe(script, { 8787: "connect", 8788: "connect" })).toBe(3);
    // Nothing listening / no policy programmed at all: not evidence of anything.
    expect(await runProbe(script, { 8787: "timeout", 8788: "timeout" })).toBe(4);
    expect(await runProbe(script, { 8787: "error", 8788: "timeout" })).toBe(4);
  });
});
