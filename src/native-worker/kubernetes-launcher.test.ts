import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { nativeKubernetesNames } from "./kubernetes-isolation.js";
import { KubernetesNativeWorkerLauncher } from "./kubernetes-launcher.js";
import type { WorkerInput } from "./protocol.js";

const ns = "wardby-runs";
const image = `registry.local:5001/wardby-native-worker@sha256:${"a".repeat(64)}`;
const input = {
  runId: "run_k1",
  gateway: { url: "http://10.96.0.42:8790/x", capability: "c".repeat(43) },
} as unknown as WorkerInput;
const names = nativeKubernetesNames("run_k1");

function setup(options: { probe?: number; serviceIp?: string | null } = {}) {
  const api = new FakeKubernetesApi();
  api.namespaces.add(ns);
  if (options.serviceIp !== null) {
    api.put("service", ns, {
      metadata: { name: "wardby-native-gateway" },
      spec: { clusterIP: options.serviceIp ?? "10.96.0.42" },
    });
  }
  api.onExec = async () => options.probe ?? 0;
  const proven = vi.fn(async () => {});
  // The "kubelet": a created pod is Running by the launcher's first wait.
  const sleep = async () => {
    const pod = await api.readPod(ns, names.pod);
    if (pod && !pod.status) api.put("pod", ns, { ...pod, status: { phase: "Running" } });
    // Yield for real: a handle's watch loop polls until the pod ends.
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const launcher = new KubernetesNativeWorkerLauncher({
    api,
    namespace: ns,
    image,
    limits: { cpus: 1, memoryMb: 512, pids: 128 },
    gatewayService: "wardby-native-gateway",
    onNetworkProven: proven,
    deadlineSeconds: 3600,
    enforcementTimeoutMs: 0,
    readyTimeoutMs: 5_000,
    pollMs: 1,
    sleep,
  });
  return { api, launcher, proven };
}

const exists = (api: FakeKubernetesApi, kind: string, name: string) => api.objects.has(`${kind}/${ns}/${name}`);

describe("KubernetesNativeWorkerLauncher", () => {
  it("creates policy, input Secret and pod; proves isolation from inside the pod; then marks the run ready", async () => {
    const { api, launcher, proven } = setup();
    await launcher.launch(input);
    expect(exists(api, "networkpolicy", names.policy)).toBe(true);
    expect(exists(api, "secret", names.secret)).toBe(true);
    expect(exists(api, "pod", names.pod)).toBe(true);
    expect(api.execCalls).toHaveLength(1);
    expect(api.execCalls[0]).toMatchObject({ pod: names.pod, container: "worker" });
    expect(api.execCalls[0].command.join(" ")).toContain("10.96.0.42");
    expect(proven).toHaveBeenCalledWith("run_k1");
    expect(await launcher.listWorkers()).toEqual([{ name: names.pod, runHash: names.runSha }]);
  });

  it("refuses a run whose isolation cannot be proven, removing everything and never marking it ready", async () => {
    const { api, launcher, proven } = setup({ probe: 4 });
    await expect(launcher.launch(input)).rejects.toThrow(
      /native_sandbox_network_unenforced: .*deny port was reachable/,
    );
    expect(proven).not.toHaveBeenCalled();
    for (const [kind, name] of [
      ["pod", names.pod],
      ["secret", names.secret],
      ["networkpolicy", names.policy],
    ]) {
      expect(exists(api, kind, name)).toBe(false);
    }
  });

  it("refuses a pod an admission controller changed", async () => {
    const { api, launcher, proven } = setup();
    const create = api.createPod.bind(api);
    api.createPod = async (namespace, body) => {
      const mutated = structuredClone(body);
      mutated.spec!.containers[0].securityContext = {
        ...mutated.spec!.containers[0].securityContext,
        readOnlyRootFilesystem: false,
      };
      return create(namespace, mutated);
    };
    await expect(launcher.launch(input)).rejects.toThrow(/native_sandbox_isolation_mismatch/);
    expect(proven).not.toHaveBeenCalled();
    expect(exists(api, "pod", names.pod)).toBe(false);
  });

  it("attaches to an existing pod instead of launching (or probing) again", async () => {
    const { api, launcher, proven } = setup();
    await launcher.launch(input);
    await launcher.launch(input);
    expect(api.execCalls).toHaveLength(1);
    expect(proven).toHaveBeenCalledTimes(1);
  });

  it("reports the worker's exit from the pod's status, and missing when it is gone", async () => {
    const { api, launcher } = setup();
    const handle = await launcher.launch(input);
    const pod = (await api.readPod(ns, names.pod))!;
    api.put("pod", ns, {
      ...pod,
      status: { phase: "Failed", containerStatuses: [{ name: "worker", state: { terminated: { exitCode: 2 } } }] },
    } as V1Pod);
    expect(await launcher.inspect("run_k1")).toEqual({ state: "exited", exitCode: 2 });
    expect(await handle.exited).toBe(2);
    await launcher.remove("run_k1");
    expect(await launcher.inspect("run_k1")).toEqual({ state: "missing" });
  });

  it("dials the gateway by its Service's ClusterIP, and fails clearly without one", async () => {
    expect(await setup().launcher.resolveGatewayUrl()).toBe("http://10.96.0.42:8790/native-gateway/v1/call");
    await expect(setup({ serviceIp: null }).launcher.resolveGatewayUrl()).rejects.toThrow(
      /native_sandbox_gateway_unavailable/,
    );
  });

  it("removes only its own objects by name", async () => {
    const { api, launcher } = setup();
    await launcher.launch(input);
    await launcher.removeByWorkerName("some-other-pod");
    expect(exists(api, "pod", names.pod)).toBe(true);
    await launcher.removeByWorkerName(names.pod);
    expect(exists(api, "pod", names.pod)).toBe(false);
  });

  it("compares stored objects canonically: key order and dropped empty arrays are not a change", async () => {
    const { canonical } = await import("./kubernetes-launcher.js");
    const built = { podSelector: { matchLabels: { a: "1" } }, policyTypes: ["Ingress", "Egress"], ingress: [] };
    const stored = { policyTypes: ["Ingress", "Egress"], podSelector: { matchLabels: { a: "1" } } };
    expect(JSON.stringify(canonical(stored))).toBe(JSON.stringify(canonical(built)));
    expect(JSON.stringify(canonical({ ...stored, ingress: [{ from: [] }] }))).not.toBe(
      JSON.stringify(canonical(built)),
    );
  });
});
