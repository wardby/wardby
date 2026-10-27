import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { V1NetworkPolicy, V1Pod } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import type { JobSpec } from "./types.js";
import {
  CLAUDE_CONFIG_PATH,
  CLAUDE_CONFIG_SCRATCH_MIB,
  KUBERNETES_ISOLATION_ERROR,
  STORAGE_INIT_CONTAINER,
  STORAGE_ROOT,
  assertRunNetworkPolicyMatches,
  assertRunPodMatches,
  buildCapabilitySecret,
  buildRunNetworkPolicy,
  buildRunPod,
  enforcementProbeScript,
  enforcementStreakScript,
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
  it("rejects a cpus value that isn't a whole number of millicores", () => {
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 0.0005 } })).toThrow(
      KUBERNETES_ISOLATION_ERROR,
    );
  });
  it("accepts cpus values that are already a whole number of millicores", () => {
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 16.1 } })).not.toThrow();
    expect(() => validateKubernetesSpec({ ...spec, limits: { ...spec.limits, cpus: 2.01 } })).not.toThrow();
  });

  // Each rejection tags a short, fixed reason naming which check failed (never a value from the
  // spec itself), so an operator reading the thrown message — or a `this.warn(...)` of it, see
  // kubernetes.ts's launch() — gets more than a bare "kubernetes_isolation_unsupported" to go on.
  it.each([
    ["run-id", { ...spec, runId: "" }],
    ["provider", { ...spec, provider: "unknown-provider" as unknown as JobSpec["provider"] }],
    ["tool-image-set", { ...spec, toolImage: IMAGE }],
    ["tool-image-not-registry-digest", { ...spec, provider: "claude-code" as const }],
    [
      "tool-image-not-registry-digest",
      { ...spec, provider: "claude-code" as const, toolImage: `sha256:${"b".repeat(64)}` },
    ],
    [
      "claude-limits-too-small",
      { ...spec, provider: "claude-code" as const, toolImage: IMAGE, limits: { ...spec.limits, cpus: 0.25 } },
    ],
    [
      "claude-limits-too-small",
      { ...spec, provider: "claude-code" as const, toolImage: IMAGE, limits: { ...spec.limits, memoryMb: 200 } },
    ],
    ["image-not-registry-digest", { ...spec, image: `sha256:${"b".repeat(64)}` }],
    ["cpus-out-of-range", { ...spec, limits: { ...spec.limits, cpus: 0.0005 } }],
    ["memory-out-of-range", { ...spec, limits: { ...spec.limits, memoryMb: 1 } }],
    ["pids-out-of-range", { ...spec, limits: { ...spec.limits, pids: 1 } }],
    ["disk-out-of-range", { ...spec, limits: { ...spec.limits, diskMb: 1 } }],
    ["timeout-out-of-range", { ...spec, timeoutSec: 0 }],
  ] satisfies Array<[string, JobSpec]>)("tags a %s rejection with its reason", (reason, invalid) => {
    expect(() => validateKubernetesSpec(invalid)).toThrow(`${KUBERNETES_ISOLATION_ERROR}:${reason}`);
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

  it("adds the priority class only when configured", () => {
    expect(pod().spec).not.toHaveProperty("priorityClassName");
    const prioritized = buildRunPod(spec, { ...options, priorityClassName: "wardby-coding-run" });
    expect(prioritized.spec!.priorityClassName).toBe("wardby-coding-run");
    // Nothing else moves: the class is the only difference from the default pod.
    delete prioritized.spec!.priorityClassName;
    expect(prioritized).toEqual(pod());
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

  // GKE stamps these from the node the pod bound to, so they appear only AFTER scheduling —
  // a server-side dry run never sees them and no captured fixture can list them. A real
  // Autopilot launch failed attestation on exactly this (2026-09-23) while every dry-run-based
  // check passed, which is why this case is pinned by a test rather than by the fixture.
  it("forgives the topology labels GKE adds after binding, which no dry run can capture", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.labels!["topology.kubernetes.io/region"] = "us-central1";
    actual.metadata!.labels!["topology.kubernetes.io/zone"] = "us-central1-f";
    expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).not.toThrow();
    expect(() => assertRunPodMatches(actual, expected, "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("still rejects a wardby label dropped behind the forgiven topology labels", () => {
    const expected = buildRunPod(spec, autopilotOptions);
    const actual = structuredClone(expected);
    actual.metadata!.labels!["topology.kubernetes.io/zone"] = "us-central1-f";
    delete actual.metadata!.labels!["wardby.io/component"];
    expect(() => assertRunPodMatches(actual, expected, "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
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

  describe("with a priority class", () => {
    const prioritized = buildRunPod(spec, { ...options, priorityClassName: "wardby-coding-run" });
    // The Priority admission plugin resolves the class into these two fields on create.
    const fromClass = (p: V1Pod): V1Pod => {
      const c = withApiDefaults(p);
      c.spec!.priority = 1000;
      c.spec!.preemptionPolicy = "Never";
      return c;
    };

    it("accepts the read-back pod with the priority and preemption policy the class resolves to", () => {
      expect(() => assertRunPodMatches(fromClass(prioritized), prioritized)).not.toThrow();
      expect(() => assertRunPodMatches(apiRoundTrip(fromClass(prioritized), "V1Pod"), prioritized)).not.toThrow();
    });

    it("rejects a different priority class", () => {
      const actual = fromClass(prioritized);
      actual.spec!.priorityClassName = "system-cluster-critical";
      expect(() => assertRunPodMatches(actual, prioritized)).toThrow(KUBERNETES_ISOLATION_ERROR);
    });

    it("rejects a missing priority class", () => {
      const actual = fromClass(prioritized);
      delete actual.spec!.priorityClassName;
      expect(() => assertRunPodMatches(actual, prioritized)).toThrow(KUBERNETES_ISOLATION_ERROR);
    });

    it("rejects a priority class the launcher did not ask for", () => {
      const actual = withApiDefaults(expected);
      actual.spec!.priorityClassName = "wardby-coding-run";
      expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
    });
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

  it("never reads a refused deny port as blocked: an RST proves the packet arrived", async () => {
    const script = enforcementProbeScript("10.96.0.50");
    // Reproduced on a live cluster: a pod listening on 8787, nothing serving 8788, and NO
    // NetworkPolicy anywhere. Collapsing "error" and "timeout" into one false made that exit 0
    // while the prober had full internet egress. A prompt RST proves the SYN reached the
    // destination host, on every dataplane — so only a timeout can be evidence of a policy.
    // (A timeout says the packet was dropped on the path; that the run pod's OWN egress dropped it
    // follows from the proxy admitting run pods on 8788, which readProxyWitness now verifies.)
    expect(await runProbe(script, { 8787: "connect", 8788: "error" })).toBe(5);
    // Whatever 8788 did, an unreachable 8787 still outranks it: nothing can be witnessed at all.
    expect(await runProbe(script, { 8787: "error", 8788: "error" })).toBe(4);
    expect(await runProbe(script, { 8787: "timeout", 8788: "error" })).toBe(4);
  });

  // The complete 3x3 contract, so no socket-outcome pair is left to inference.
  it.each([
    ["connect", "timeout", 0, "proven: the SYN to 8788 was dropped while the same host answered on 8787"],
    ["connect", "connect", 3, "deny port reachable: no policy, or not port-scoped"],
    ["connect", "error", 5, "deny port refused: the packet arrived, so nothing is blocking it"],
    ["timeout", "timeout", 4, "proxy unreachable"],
    ["timeout", "connect", 4, "proxy unreachable outranks a reachable deny port"],
    ["timeout", "error", 4, "proxy unreachable outranks a refused deny port"],
    ["error", "timeout", 4, "proxy refused"],
    ["error", "connect", 4, "proxy refused outranks a reachable deny port"],
    ["error", "error", 4, "proxy refused outranks a refused deny port"],
  ])("8787 %s + 8788 %s exits %i (%s)", async (proxy, deny, code) => {
    const script = enforcementProbeScript("10.96.0.50");
    expect(
      await runProbe(script, {
        8787: proxy as "connect" | "timeout" | "error",
        8788: deny as "connect" | "timeout" | "error",
      }),
    ).toBe(code);
  });
});

describe("enforcementStreakScript", () => {
  type Outcome = "connect" | "timeout" | "error";
  /**
   * Drives the real script in a VM with a fake net. `probes[i]` is the i-th probe's outcome per
   * port; connects past the scripted probes are recorded but never answered. Records every connect
   * (in order) and every delay the script itself asked setTimeout for.
   */
  async function runStreak(script: string, probes: Record<number, Outcome>[]) {
    const connects: number[] = [];
    const delays: number[] = [];
    const startedAt = Date.now();
    const exitTimes: number[] = [];
    const code = await new Promise<number>((resolve) => {
      runInNewContext(script, {
        require: () => ({
          connect: ({ port }: { port: number }) => {
            const probe = Math.floor(connects.length / 2);
            connects.push(port);
            const handlers: Record<string, () => void> = {};
            const outcome = probes[probe]?.[port];
            if (outcome) setTimeout(() => handlers[outcome]?.(), 0);
            return {
              once: (event: string, handler: () => void) => void (handlers[event] = handler),
              destroy: () => {},
            };
          },
        }),
        process: {
          exit: (exitCode: number) => {
            exitTimes.push(Date.now() - startedAt);
            resolve(exitCode);
          },
        },
        setTimeout: (handler: () => void, ms: number) => {
          delays.push(ms);
          return setTimeout(handler, ms);
        },
      });
    });
    // Let anything the script might (wrongly) still do after exiting surface before asserting.
    await new Promise((settle) => setTimeout(settle, 30));
    return { code, connects, delays, exits: exitTimes.length, elapsedMs: exitTimes[0] };
  }
  const PROVEN: Record<number, Outcome> = { 8787: "connect", 8788: "timeout" };

  it("uses exactly the single probe's measurement: same host literal, 3 s connects, 8787 then 8788", () => {
    const script = enforcementStreakScript("10.96.0.50", 3, 500);
    expect(script).toContain('host: "10.96.0.50"');
    expect(script).toContain("timeout: 3000");
    expect(script).toContain("await tcp(8787)");
    expect(script).toContain("await tcp(8788)");
    // The per-probe body is shared with enforcementProbeScript verbatim, not re-implemented.
    const single = enforcementProbeScript("10.96.0.50");
    const body = single.slice(0, single.indexOf("(async () => {"));
    expect(body.length).toBeGreaterThan(0);
    expect(script.startsWith(body)).toBe(true);
  });

  it("exits 0 only after `streak` consecutive proven probes", async () => {
    const run = await runStreak(enforcementStreakScript("10.96.0.50", 3, 1), [PROVEN, PROVEN, PROVEN, PROVEN]);
    expect(run.code).toBe(0);
    expect(run.connects).toEqual([8787, 8788, 8787, 8788, 8787, 8788]);
    expect(run.exits).toBe(1);
  });

  it("honours streak 1 as a single probe", async () => {
    const run = await runStreak(enforcementStreakScript("10.96.0.50", 1, 500), [PROVEN, PROVEN]);
    expect(run.code).toBe(0);
    expect(run.connects).toEqual([8787, 8788]);
    expect(run.delays.filter((ms) => ms === 500)).toHaveLength(0);
  });

  it.each([
    [0, { 8787: "connect", 8788: "connect" }, 3],
    [1, { 8787: "connect", 8788: "connect" }, 3],
    [2, { 8787: "connect", 8788: "connect" }, 3],
    [0, { 8787: "timeout", 8788: "timeout" }, 4],
    [1, { 8787: "error", 8788: "connect" }, 4],
    [2, { 8787: "timeout", 8788: "error" }, 4],
    [0, { 8787: "connect", 8788: "error" }, 5],
    [1, { 8787: "connect", 8788: "error" }, 5],
    [2, { 8787: "connect", 8788: "error" }, 5],
  ] as const)(
    "a non-proven probe #%i (%o) exits with that probe's code %i and runs no further probe",
    async (index, failing, code) => {
      const probes = [PROVEN, PROVEN, PROVEN, PROVEN];
      probes[index] = failing;
      const run = await runStreak(enforcementStreakScript("10.96.0.50", 3, 1), probes);
      expect(run.code).toBe(code);
      expect(run.connects).toHaveLength((index + 1) * 2);
      expect(run.exits).toBe(1);
    },
  );

  // The complete 3x3 contract per probe, identical to enforcementProbeScript's.
  it.each(
    (["connect", "timeout", "error"] as const).flatMap((proxy) =>
      (["connect", "timeout", "error"] as const).map((deny) => [proxy, deny] as const),
    ),
  )("classifies 8787 %s + 8788 %s exactly as the single probe does", async (proxy, deny) => {
    const outcome = { 8787: proxy, 8788: deny };
    const single = await runStreak(enforcementProbeScript("10.96.0.50"), [outcome]);
    const streak = await runStreak(enforcementStreakScript("10.96.0.50", 1, 500), [outcome]);
    expect(streak.code).toBe(single.code);
  });

  it("waits intervalMs between probes, and not before the first or after the last", async () => {
    const run = await runStreak(enforcementStreakScript("10.96.0.50", 3, 40), [PROVEN, PROVEN, PROVEN]);
    expect(run.code).toBe(0);
    expect(run.delays.filter((ms) => ms === 40)).toHaveLength(2);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(75);
    expect(run.elapsedMs).toBeLessThan(1_000);
  });

  it("rejects an address that is not an IP", () => {
    expect(() => enforcementStreakScript("wardby-proxy", 3, 500)).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => enforcementStreakScript('10.0.0.1"; require("child_process")', 3, 500)).toThrow(
      KUBERNETES_ISOLATION_ERROR,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a streak or interval of %s",
    (value) => {
      expect(() => enforcementStreakScript("10.96.0.50", value, 500)).toThrow(KUBERNETES_ISOLATION_ERROR);
      expect(() => enforcementStreakScript("10.96.0.50", 3, value)).toThrow(KUBERNETES_ISOLATION_ERROR);
    },
  );

  it("rejects a non-number streak or interval smuggled past the types", () => {
    const smuggled = "3; require('child_process')" as unknown as number;
    expect(() => enforcementStreakScript("10.96.0.50", smuggled, 500)).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => enforcementStreakScript("10.96.0.50", 3, smuggled)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});

describe("enforcement scripts never exit 0 without an explicit proven exit", () => {
  // A real `node` whose net.connect is replaced before the script runs, so the script's own
  // `require("node:net")` sees the stub. Nothing the stub returns holds the event loop open: if the
  // script's promises never settle (or reject under a non-throwing --unhandled-rejections mode, as a
  // BYO worker image's NODE_OPTIONS could set), the process drains and exits naturally. A natural
  // exit must read as "did not run", never as PROVEN — for the streak, that would open the gate.
  const NEVER_ANSWERS = 'require("node:net").connect = () => ({ once: () => {}, destroy: () => {} });';
  const REJECTS = 'require("node:net").connect = () => { throw new Error("stubbed connect failure"); };';
  const scripts = [
    ["enforcementProbeScript", () => enforcementProbeScript("10.96.0.50")],
    ["enforcementStreakScript", () => enforcementStreakScript("10.96.0.50", 3, 1)],
  ] as const;
  const run = (stub: string, script: string, nodeArgs: string[] = []) =>
    spawnSync(process.execPath, [...nodeArgs, "-e", `${stub}\n${script}`], { encoding: "utf8", timeout: 20_000 });

  it.each(scripts)("%s exits non-zero when no probe ever settles", (_name, build) => {
    const result = run(NEVER_ANSWERS, build());
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(1);
  });

  it.each(scripts)("%s exits non-zero when a probe rejects and rejections only warn", (_name, build) => {
    for (const mode of ["warn", "none"]) {
      const result = run(REJECTS, build(), [`--unhandled-rejections=${mode}`]);
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.status).toBe(1);
    }
  });

  it.each(scripts)("%s presets a did-not-run exit code before doing anything else", (_name, build) => {
    expect(build().startsWith("process.exitCode = 1;\n")).toBe(true);
  });
});

describe("buildRunPod with services", () => {
  const builtin = (name: string, version: string) =>
    resolvedFromDefinition(BUILTIN_CODING_SERVICES.find((s) => s.name === name && s.version === version)!);
  const POSTGRES = builtin("postgres", "16");
  const REDIS = builtin("redis", "7");
  const withServices: JobSpec = { ...spec, services: [POSTGRES, REDIS] };
  const p = () => buildRunPod(withServices, options);
  const sidecar = (built: V1Pod, name: string) =>
    built.spec!.initContainers!.find((c) => c.name === `service-${name}`)!;
  const autopilot = { ...options, platform: "gke-autopilot" as const, runtimeClassName: "gvisor" };

  it("builds exactly the pod it always has when a run has no services", () => {
    expect(buildRunPod({ ...spec, services: undefined }, options)).toEqual(pod());
  });

  it("starts each service as a native sidecar after storage-init, before the keeper and worker", () => {
    const built = p();
    expect(built.spec!.initContainers!.map((c) => c.name)).toEqual([
      "storage-init",
      "service-postgres",
      "service-redis",
    ]);
    for (const c of built.spec!.initContainers!.slice(1)) expect(c.restartPolicy).toBe("Always");
    expect(storageInit(built).restartPolicy).toBeUndefined();
    expect(built.spec!.containers.map((c) => c.name)).toEqual(["keeper", "worker"]);
    expect(built.spec!.restartPolicy).toBe("Never");
  });

  it("gates everything after a service on its readiness command, as a startup probe", () => {
    const c = sidecar(p(), "postgres");
    expect(c.startupProbe).toEqual({
      exec: { command: ["pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "test", "-d", "test"] },
      periodSeconds: 2,
      timeoutSeconds: 2,
      failureThreshold: 30,
      successThreshold: 1,
    });
    expect(c.readinessProbe).toBeUndefined();
    expect(c.livenessProbe).toBeUndefined();
  });

  it("runs the catalog's digest-pinned image as-is, non-root, read-only, with nothing privileged", () => {
    const c = sidecar(p(), "postgres");
    expect(c.image).toBe(POSTGRES.image);
    expect(c.command).toBeUndefined();
    expect(c.args).toBeUndefined();
    expect(c.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    // Pod-level: uid 10001 and RuntimeDefault seccomp cover every sidecar too.
    expect(p().spec!.securityContext).toEqual(pod().spec!.securityContext);
  });

  it("gives a service its own environment, sorted, and the worker none of it", () => {
    expect(sidecar(p(), "postgres").env).toEqual([
      { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
      { name: "POSTGRES_DB", value: "test" },
      { name: "POSTGRES_PASSWORD", value: "test" },
      { name: "POSTGRES_USER", value: "test" },
    ]);
    expect(sidecar(p(), "redis").env).toBeUndefined();
    expect(worker(p()).env!.map((e) => e.name)).toEqual(["WARDBY_PROXY_URL", "WARDBY_RUN_CAPABILITY"]);
  });

  it("mounts an emptyDir at the data path and at each writable path, and none of the run's storage", () => {
    expect(sidecar(p(), "postgres").volumeMounts).toEqual([
      { name: "service-0-data", mountPath: "/var/lib/postgresql/data" },
      { name: "service-0-scratch-0", mountPath: "/var/run/postgresql" },
      { name: "service-0-scratch-1", mountPath: "/tmp" },
    ]);
    expect(sidecar(p(), "redis").volumeMounts).toEqual([{ name: "service-1-data", mountPath: "/data" }]);
    expect(p().spec!.volumes!.slice(3)).toEqual([
      { name: "service-0-data", emptyDir: { sizeLimit: "1024Mi" } },
      { name: "service-0-scratch-0", emptyDir: { sizeLimit: "64Mi" } },
      { name: "service-0-scratch-1", emptyDir: { sizeLimit: "64Mi" } },
      { name: "service-1-data", emptyDir: { sizeLimit: "256Mi" } },
    ]);
  });

  it("sizes each sidecar from its catalog entry, requests equal to limits", () => {
    expect(sidecar(p(), "postgres").resources).toEqual({
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    });
  });

  it("leaves the run's NetworkPolicy unchanged: a service shares the pod's loopback", () => {
    expect(buildRunNetworkPolicy(withServices, options.namespace)).toEqual(
      buildRunNetworkPolicy(spec, options.namespace),
    );
    expect(JSON.stringify(buildRunNetworkPolicy(withServices, options.namespace))).toBe(
      JSON.stringify(buildRunNetworkPolicy(spec, options.namespace)),
    );
  });

  it("conforms sidecars to Autopilot and counts their disk in the pod's ephemeral storage", () => {
    const built = buildRunPod(withServices, autopilot);
    expect(sidecar(built, "postgres").resources).toEqual({
      requests: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1152Mi" },
      limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "1152Mi" },
    });
    expect(sidecar(built, "redis").resources).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "256Mi" },
    });
    // 8192 (workspace) + 1024 (worker) + 1152 + 256 (services) = 10624 MiB > 10240.
    expect(() => buildRunPod({ ...withServices, limits: { ...spec.limits, diskMb: 8192 } }, autopilot)).toThrow(
      /8192 MiB workspace and its services need 10624 MiB of pod ephemeral storage/,
    );
    expect(() => buildRunPod({ ...spec, limits: { ...spec.limits, diskMb: 8192 } }, autopilot)).not.toThrow();
  });

  it("attests a read-back pod with sidecars, and rejects a swapped service image", () => {
    const built = p();
    expect(() => assertRunPodMatches(apiRoundTrip(built, "V1Pod"), built)).not.toThrow();
    const swapped = structuredClone(built);
    swapped.spec!.initContainers![1].image = `docker.io/library/postgres@sha256:${"f".repeat(64)}`;
    expect(() => assertRunPodMatches(swapped, built)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("refuses a spec whose services are malformed", () => {
    for (const services of [[{ ...POSTGRES, image: "postgres:16" }], [POSTGRES, POSTGRES], []]) {
      expect(() => validateKubernetesSpec({ ...spec, services })).toThrow(KUBERNETES_ISOLATION_ERROR);
    }
  });
});

describe("buildRunPod for Claude Code", () => {
  const TOOL_IMAGE = `localhost:5001/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`;
  const claude: JobSpec = { ...spec, provider: "claude-code", toolImage: TOOL_IMAGE };
  const p = () => buildRunPod(claude, options);
  const tools = (built: V1Pod) => built.spec!.initContainers!.find((c) => c.name === "tool-runner")!;
  const names = kubernetesRunNames(claude.runId);

  it("accepts a Claude spec with a registry-digest tool image", () => {
    expect(() => validateKubernetesSpec(claude)).not.toThrow();
  });

  it("starts the tool runner as a native sidecar after storage-init; keeper and worker stay the main containers", () => {
    const built = p();
    expect(built.spec!.initContainers!.map((c) => c.name)).toEqual(["storage-init", "tool-runner"]);
    expect(tools(built).restartPolicy).toBe("Always");
    expect(built.spec!.containers.map((c) => c.name)).toEqual(["keeper", "worker"]);
  });

  it("holds the keeper and worker until the tool runner's socket exists", () => {
    expect(tools(p()).startupProbe).toEqual({
      exec: { command: ["test", "-S", "/run/wardby/tool/runner.sock"] },
      periodSeconds: 1,
      timeoutSeconds: 1,
      failureThreshold: 60,
      successThreshold: 1,
    });
  });

  it("runs Claude's entrypoint in the worker, which holds the capability but never mounts the workspace", () => {
    const w = worker(p());
    expect(w.image).toBe(IMAGE);
    expect(w.command![2]).toContain('import("/opt/wardby/claude-coding-worker/main.js")');
    expect(w.env!.map((e) => e.name)).toEqual(["WARDBY_PROXY_URL", "WARDBY_RUN_CAPABILITY"]);
    expect(w.volumeMounts).toEqual([
      { name: "storage", mountPath: "/run/wardby/input", subPath: "input", readOnly: true },
      { name: "storage", mountPath: "/run/wardby/output", subPath: "output" },
      { name: "tool-socket", mountPath: "/run/wardby/tool" },
      { name: "tmp", mountPath: "/tmp" },
      { name: "home", mountPath: "/home/wardby" },
    ]);
  });

  it("gives the tool runner the workspace, the socket, and its setup from the run's Secret, never the capability", () => {
    const t = tools(p());
    expect(t.image).toBe(TOOL_IMAGE);
    expect(t.command).toEqual(["node", "/opt/wardby/claude-tool-runner/main.mjs"]);
    expect(t.env).toEqual([
      { name: "WARDBY_TOOL_SETUP", valueFrom: { secretKeyRef: { name: names.secret, key: "tool-setup" } } },
    ]);
    expect(t.volumeMounts).toEqual([
      { name: "storage", mountPath: "/workspace", subPath: "workspace" },
      { name: "tool-socket", mountPath: "/run/wardby/tool" },
      { name: "tool-tmp", mountPath: "/tmp" },
      { name: "tool-home", mountPath: "/home/wardby" },
    ]);
    expect(t.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("gives a session-resume run's Claude config dir its own memory-backed scratch, off /tmp's budget", () => {
    const resumed = buildRunPod({ ...claude, sessionResume: true }, options);
    expect(worker(resumed).volumeMounts).toContainEqual({ name: "claude-config", mountPath: CLAUDE_CONFIG_PATH });
    expect(resumed.spec!.volumes).toContainEqual({
      name: "claude-config",
      emptyDir: { medium: "Memory", sizeLimit: `${CLAUDE_CONFIG_SCRATCH_MIB}Mi` },
    });
    // Only the worker mounts it, and only a session-resume run has it.
    const mounting = [...resumed.spec!.initContainers!, ...resumed.spec!.containers]
      .filter((c) => c.volumeMounts?.some((m) => m.name === "claude-config"))
      .map((c) => c.name);
    expect(mounting).toEqual(["worker"]);
    expect(JSON.stringify(p())).not.toContain("claude-config");
    expect(() => assertRunPodMatches(resumed, buildRunPod({ ...claude, sessionResume: true }, options))).not.toThrow();
    expect(() => assertRunPodMatches(resumed, p())).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("refuses sessionResume on a Codex spec", () => {
    expect(() => validateKubernetesSpec({ ...spec, sessionResume: true })).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("gives the tool runner its own scratch, never the worker's /tmp or home", () => {
    expect(p().spec!.volumes!.slice(3)).toEqual([
      { name: "tool-socket", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } },
      { name: "tool-tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
      { name: "tool-home", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
    ]);
  });

  it("shares the socket through its own memory-backed volume that only the worker and tool runner mount", () => {
    // Under gVisor a Unix socket bound on the disk-backed storage volume is invisible to another
    // container; a memory-backed emptyDir mounted by both containers is shared across the sandbox.
    const built = p();
    const mounting = [...built.spec!.initContainers!, ...built.spec!.containers]
      .filter((c) => c.volumeMounts?.some((m) => m.name === "tool-socket"))
      .map((c) => c.name);
    expect(mounting).toEqual(["tool-runner", "worker"]);
    for (const c of [...built.spec!.initContainers!, ...built.spec!.containers]) {
      expect(c.volumeMounts ?? []).not.toContainEqual(expect.objectContaining({ subPath: "tool" }));
    }
  });

  it("splits the run's CPU and memory like Docker, and the worker's disk reservation between the two", () => {
    expect(tools(p()).resources).toEqual({
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { cpu: "250m", memory: "512Mi" },
    });
    expect(worker(p()).resources).toEqual({
      requests: { cpu: "750m", memory: "1536Mi" },
      limits: { cpu: "750m", memory: "1536Mi" },
    });
    const autopilot = buildRunPod(claude, { ...options, platform: "gke-autopilot", runtimeClassName: "gvisor" });
    const tool = tools(autopilot).resources!.requests!["ephemeral-storage"];
    const agent = worker(autopilot).resources!.requests!["ephemeral-storage"];
    expect([tool, agent]).toEqual(["256Mi", "768Mi"]);
  });

  it("keeps the socket off the storage volume, so storage-init creates only the Codex directories", () => {
    expect(storageInit(p()).command).toEqual(storageInit(pod()).command);
  });

  it("puts the tool runner before any service sidecar", () => {
    const POSTGRES = resolvedFromDefinition(
      BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!,
    );
    const built = buildRunPod({ ...claude, services: [POSTGRES] }, options);
    expect(built.spec!.initContainers!.map((c) => c.name)).toEqual(["storage-init", "tool-runner", "service-postgres"]);
  });

  it("leaves the run's NetworkPolicy unchanged: the pod has one egress rule, to the proxy", () => {
    expect(buildRunNetworkPolicy(claude, options.namespace)).toEqual(buildRunNetworkPolicy(spec, options.namespace));
  });

  it("leaves the Codex pod exactly as it was", () => {
    expect(storageInit(pod()).command![2]).not.toContain('"tool"');
    expect(worker(pod()).command![2]).toContain('import("/opt/wardby/coding-worker/main.js")');
    expect(pod().spec!.initContainers!.map((c) => c.name)).toEqual(["storage-init"]);
  });

  it("attests a read-back Claude pod, and rejects a swapped tool image", () => {
    const built = p();
    expect(() => assertRunPodMatches(apiRoundTrip(built, "V1Pod"), built)).not.toThrow();
    const swapped = structuredClone(built);
    swapped.spec!.initContainers![1].image = `localhost:5001/other@sha256:${"f".repeat(64)}`;
    expect(() => assertRunPodMatches(swapped, built)).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("stores the tool setup next to the capability for a Claude run only", () => {
    expect(buildCapabilitySecret(claude, "wardby-coding", "rrp_x", '{"schemaVersion":1}').stringData).toEqual({
      capability: "rrp_x",
      "tool-setup": '{"schemaVersion":1}',
    });
    expect(buildCapabilitySecret(spec, "wardby-coding", "rrp_x").stringData).toEqual({ capability: "rrp_x" });
  });
});
