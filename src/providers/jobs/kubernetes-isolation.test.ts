import { describe, expect, it } from "vitest";
import type { V1NetworkPolicy, V1Pod } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/serializer.js";
import type { JobSpec } from "./types.js";
import {
  KUBERNETES_ISOLATION_ERROR,
  KUBERNETES_PROVIDER_UNSUPPORTED,
  assertRunNetworkPolicyMatches,
  assertRunPodMatches,
  buildCapabilitySecret,
  buildRunNetworkPolicy,
  buildRunPod,
  isRegistryDigest,
  kubernetesRunNames,
  runLabels,
  validateKubernetesSpec,
} from "./kubernetes-isolation.js";

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
    for (const c of pod().spec!.containers) {
      expect(c.securityContext).toEqual({
        allowPrivilegeEscalation: false,
        privileged: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
        capabilities: { drop: ["ALL"] },
      });
    }
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
      requests: { cpu: "1", memory: "2048Mi" },
      limits: { cpu: "1", memory: "2048Mi" },
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
    s.containers = s.containers.map((x) => ({
      ...x,
      terminationMessagePath: "/dev/termination-log",
      terminationMessagePolicy: "File",
      imagePullPolicy: "IfNotPresent",
    }));
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
