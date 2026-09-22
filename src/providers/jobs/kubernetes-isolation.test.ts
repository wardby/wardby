import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
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
});

describe("buildRunPod", () => {
  it("never mounts a Kubernetes token, shares host namespaces, or restarts", () => {
    const s = pod().spec!;
    expect(s.automountServiceAccountToken).toBe(false);
    expect(s.serviceAccountName).toBe("wardby-coding-worker");
    expect(s.enableServiceLinks).toBe(false);
    expect([s.hostNetwork, s.hostPID, s.hostIPC, s.shareProcessNamespace]).toEqual([false, false, false, false]);
    expect(s.restartPolicy).toBe("Never");
    expect(s.activeDeadlineSeconds).toBe(900);
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
  const withApiDefaults = (p: V1Pod): V1Pod => {
    const c = structuredClone(p);
    c.spec!.schedulerName = "default-scheduler";
    c.spec!.containers = c.spec!.containers.map((x) => ({
      ...x,
      terminationMessagePath: "/dev/termination-log",
      imagePullPolicy: "IfNotPresent",
    }));
    c.spec!.containers[1].resources = {
      requests: { cpu: "1000m", memory: "2Gi" },
      limits: { cpu: "1000m", memory: "2Gi" },
    };
    return c;
  };

  it("accepts the expected pod and API defaults / normalized quantities", () => {
    expect(() => assertRunPodMatches(withApiDefaults(expected), expected)).not.toThrow();
  });

  const mutations: Array<[string, (p: V1Pod) => void]> = [
    ["missing runtime class", (p) => void (p.spec!.runtimeClassName = "runc")],
    ["token mounted", (p) => void (p.spec!.automountServiceAccountToken = true)],
    ["host network", (p) => void (p.spec!.hostNetwork = true)],
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
  ];
  it.each(mutations)("rejects %s", (_name, mutate) => {
    const actual = withApiDefaults(expected);
    if (_name === "missing runtime class") {
      const gv = buildRunPod(spec, { ...options, runtimeClassName: "gvisor" });
      const a = withApiDefaults(gv);
      mutate(a);
      expect(() => assertRunPodMatches(a, gv)).toThrow(KUBERNETES_ISOLATION_ERROR);
      return;
    }
    mutate(actual);
    expect(() => assertRunPodMatches(actual, expected)).toThrow(KUBERNETES_ISOLATION_ERROR);
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
});
