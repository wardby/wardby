import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { kubernetesPreflight, type CanaryResult } from "./kubernetes-preflight.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const config = { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" };

function cluster(canary: CanaryResult | "no-output") {
  const api = new FakeKubernetesApi();
  api.put("service", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, spec: { clusterIP: "10.96.0.50" } });
  const originalCreate = api.createPod.bind(api);
  api.createPod = async (ns, body: V1Pod) => {
    const created = await originalCreate(ns, body);
    const name = body.metadata!.name!;
    api.put("pod", ns, {
      ...body,
      status: {
        phase: "Succeeded",
        containerStatuses: [
          {
            name: "worker",
            ready: false,
            image: IMAGE,
            imageID: IMAGE,
            restartCount: 0,
            state: { terminated: { exitCode: 0 } },
          },
        ],
      },
    });
    if (canary !== "no-output") api.logs.set(`${ns}/${name}/worker`, JSON.stringify({ wardbyCanary: canary }));
    return created;
  };
  return api;
}
const ok: CanaryResult = { dns: false, internet: false, metadata: false, proxy: true };

function leftovers(api: FakeKubernetesApi): string[] {
  return [...api.objects.keys()].filter((k) => !k.startsWith("service/"));
}

describe("kubernetesPreflight", () => {
  it("passes every check on an enforcing cluster and cleans up the canary", async () => {
    const api = cluster(ok);
    expect(await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).toEqual([
      "namespace",
      "proxy-service",
      "worker-image",
      "canary",
    ]);
    expect([...api.objects.keys()].filter((k) => k.startsWith("pod/") || k.startsWith("networkpolicy/"))).toEqual([]);
  });

  it.each([
    ["internet reachable", { ...ok, internet: true }],
    ["metadata reachable", { ...ok, metadata: true }],
    ["dns resolves", { ...ok, dns: true }],
    ["proxy unreachable", { ...ok, proxy: false }],
  ])("fails closed when %s", async (_label, result) => {
    await expect(
      kubernetesPreflight({ api: cluster(result), config, workerImage: IMAGE, sleep: async () => {} }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
  });

  it("fails when the canary prints nothing", async () => {
    await expect(
      kubernetesPreflight({ api: cluster("no-output"), config, workerImage: IMAGE, sleep: async () => {} }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
  });

  it("fails on a missing namespace, a missing proxy Service, or a local image ID", async () => {
    const noNs = cluster(ok);
    noNs.namespaces.clear();
    await expect(kubernetesPreflight({ api: noNs, config, workerImage: IMAGE })).rejects.toThrow(
      "kubernetes_isolation_unsupported:namespace",
    );
    const noProxy = cluster(ok);
    noProxy.objects.delete("service/wardby-coding/wardby-coding-proxy");
    await expect(kubernetesPreflight({ api: noProxy, config, workerImage: IMAGE })).rejects.toThrow(
      "kubernetes_isolation_unsupported:proxy-service",
    );
    await expect(
      kubernetesPreflight({ api: cluster(ok), config, workerImage: `sha256:${"b".repeat(64)}` }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:worker-image");
  });

  it("rejects a headless or non-IP proxy Service address", async () => {
    for (const clusterIP of ["None", "", "wardby-proxy"]) {
      const api = cluster(ok);
      api.put("service", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, spec: { clusterIP } });
      await expect(kubernetesPreflight({ api, config, workerImage: IMAGE })).rejects.toThrow(
        "kubernetes_isolation_unsupported:proxy-service",
      );
    }
  });

  it("builds the canary from the run pod: worker only, canary env and command, run network policy", async () => {
    const api = cluster(ok);
    let pod: V1Pod | undefined;
    let policyPresentAtPodCreate = false;
    const create = api.createPod.bind(api);
    api.createPod = async (ns, body) => {
      pod = structuredClone(body);
      policyPresentAtPodCreate = [...api.objects.keys()].some((k) => k.startsWith("networkpolicy/"));
      return create(ns, body);
    };
    await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {}, timeoutMs: 30_000 });
    expect(policyPresentAtPodCreate).toBe(true);
    expect(pod!.metadata!.annotations!["wardby.io/run-id"]).toMatch(/^preflight-[0-9a-f]+$/);
    const containers = pod!.spec!.containers;
    expect(containers.map((c) => c.name)).toEqual(["worker"]);
    expect(containers[0].image).toBe(IMAGE);
    expect(containers[0].env).toEqual([{ name: "WARDBY_CANARY_PROXY_IP", value: "10.96.0.50" }]);
    expect(containers[0].command!.slice(0, 2)).toEqual(["node", "-e"]);
    expect(containers[0].command![2]).toContain("wardbyCanary");
    expect(pod!.spec!.hostAliases).toEqual([{ ip: "10.96.0.50", hostnames: ["wardby-proxy"] }]);
    expect(pod!.spec!.activeDeadlineSeconds).toBe(30);
    expect(api.deletedPods).toEqual([{ name: pod!.metadata!.name, gracePeriodSeconds: 0 }]);
  });

  it("times out, fails closed, and still deletes the canary pod and policy", async () => {
    const api = cluster(ok);
    // A pod that never terminates: the plain fake create leaves it without a status.
    api.createPod = FakeKubernetesApi.prototype.createPod.bind(api);
    let clock = 0;
    const sleeps: number[] = [];
    await expect(
      kubernetesPreflight({
        api,
        config,
        workerImage: IMAGE,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
    expect(sleeps.every((ms) => ms === 500)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(9);
    expect(leftovers(api)).toEqual([]);
    expect(api.deletedPods).toHaveLength(1);
  });

  it("fails closed and cleans up when the canary exits non-zero", async () => {
    const api = cluster(ok);
    const create = api.createPod.bind(api);
    api.createPod = async (ns, body) => {
      const created = await create(ns, body);
      const stored = (await api.readPod(ns, body.metadata!.name!))!;
      stored.status!.phase = "Failed";
      stored.status!.containerStatuses![0].state = { terminated: { exitCode: 1 } };
      api.put("pod", ns, stored);
      return created;
    };
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:canary",
    );
    expect(leftovers(api)).toEqual([]);
  });

  it("fails closed when the canary pod disappears", async () => {
    const api = cluster(ok);
    api.createPod = async (ns, body) => ({ ...body, metadata: { ...body.metadata, namespace: ns } });
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:canary",
    );
    expect(leftovers(api)).toEqual([]);
  });

  it("fails closed and deletes the policy when pod creation errors", async () => {
    const api = cluster(ok);
    api.createPod = async () => {
      throw new Error("forbidden");
    };
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:canary",
    );
    expect(leftovers(api)).toEqual([]);
  });

  it("requires exactly the four expected booleans", async () => {
    for (const result of [
      { ...ok, extra: false },
      { dns: false, internet: false, metadata: false },
      { ...ok, proxy: "true" },
      { ...ok, dns: 0 },
    ]) {
      const api = cluster(result as unknown as CanaryResult);
      await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
        "kubernetes_isolation_unsupported:canary",
      );
    }
  });

  it("ignores other log lines but never echoes canary output in the error", async () => {
    const api = cluster(ok);
    const create = api.createPod.bind(api);
    api.createPod = async (ns, body) => {
      const created = await create(ns, body);
      api.logs.set(
        `${ns}/${body.metadata!.name}/worker`,
        `secret-looking-noise\n${JSON.stringify({ wardbyCanary: { ...ok, internet: true } })}\nmore-noise`,
      );
      return created;
    };
    const error = await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("kubernetes_isolation_unsupported:canary");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("noise");
    expect((error as Error).cause).toBeUndefined();
  });

  it("fails closed when cleanup fails after a passing canary", async () => {
    const api = cluster(ok);
    api.deleteNetworkPolicy = async () => {
      throw new Error("api down");
    };
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:canary",
    );
    expect(api.deletedPods).toHaveLength(1);
  });
});
