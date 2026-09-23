import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import type { KubernetesJobConfig } from "../../config/providers.js";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import {
  CANARY_SCRIPT,
  describePreflightFailure,
  kubernetesPreflight,
  runKubernetesPreflight,
  type CanaryResult,
} from "./kubernetes-preflight.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const config: KubernetesJobConfig = {
  namespace: "wardby-coding",
  proxyService: "wardby-coding-proxy",
  platform: "generic",
};

function cluster(canary: CanaryResult | "no-output") {
  const api = new FakeKubernetesApi();
  api.put("service", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: {
      clusterIP: "10.96.0.50",
      ports: [
        { name: "proxy", port: 8787, protocol: "TCP" },
        { name: "deny", port: 8788, protocol: "TCP" },
      ],
    },
  });
  api.put("endpoints", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    subsets: [
      {
        addresses: [{ ip: "10.244.0.5" }],
        ports: [
          { name: "proxy", port: 8787, protocol: "TCP" },
          { name: "deny", port: 8788, protocol: "TCP" },
        ],
      },
    ],
  });
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
const ok: CanaryResult = { dns: false, proxyDeny: false, internet: false, metadata: false, proxy: true };

function leftovers(api: FakeKubernetesApi): string[] {
  return [...api.objects.keys()].filter((k) => !k.startsWith("service/") && !k.startsWith("endpoints/"));
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
    ["the proxy deny port reachable", { ...ok, proxyDeny: true }],
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

  it("times out polling, fails closed, and still deletes the canary pod and policy", async () => {
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
    ).rejects.toThrow("kubernetes_isolation_unsupported:timeout");
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

  it("requires exactly the five expected booleans", async () => {
    for (const result of [
      { ...ok, extra: false },
      { dns: false, internet: false, metadata: false, proxy: true },
      { ...ok, proxy: "true" },
      { ...ok, proxyDeny: 0 },
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
  it("fails proxy-service when the Service does not expose the deny port", async () => {
    const api = cluster(ok);
    api.put("service", "wardby-coding", {
      metadata: { name: "wardby-coding-proxy" },
      spec: { clusterIP: "10.96.0.50", ports: [{ name: "proxy", port: 8787, protocol: "TCP" }] },
    });
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:proxy-service",
    );
  });

  it("names the reason the proxy witness is unusable", async () => {
    const api = cluster(ok);
    api.put("endpoints", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, subsets: [] });
    const error = await kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} }).catch(
      (e: unknown) => e,
    );
    expect(describePreflightFailure(error)).toContain("has no ready endpoint address");
  });

  it("fails the canary when the deny port is reachable", async () => {
    const api = cluster({ ...ok, proxyDeny: true });
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {} })).rejects.toThrow(
      "kubernetes_isolation_unsupported:canary",
    );
  });

  it("bounds the whole preflight: a hung API call fails with timeout", async () => {
    const api = cluster(ok);
    api.readNamespace = () => new Promise<boolean>(() => {});
    await expect(kubernetesPreflight({ api, config, workerImage: IMAGE, timeoutMs: 20 })).rejects.toThrow(
      "kubernetes_isolation_unsupported:timeout",
    );
    expect(leftovers(api)).toEqual([]);
  });

  it("times out on a createPod that never resolves and keeps the policy for the in-flight pod", async () => {
    const api = cluster(ok);
    api.createPod = () => new Promise(() => {});
    await expect(
      kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {}, timeoutMs: 20 }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:timeout");
    // No pod exists; the deny policy stays until the hung create settles, so a late pod is never unpoliced.
    expect(leftovers(api).filter((k) => k.startsWith("pod/"))).toEqual([]);
    expect(leftovers(api).filter((k) => k.startsWith("networkpolicy/"))).toHaveLength(1);
  });

  it("deletes a pod created after the timeout, then its policy", async () => {
    const api = cluster(ok);
    const calls: string[] = [];
    const create = api.createPod.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    api.createPod = async (ns, body) => {
      await gate;
      return create(ns, body);
    };
    const deletePod = api.deletePod.bind(api);
    api.deletePod = async (ns, name, grace) => {
      calls.push("pod");
      return deletePod(ns, name, grace);
    };
    const deletePolicy = api.deleteNetworkPolicy.bind(api);
    let policyDeleted!: () => void;
    const policyGone = new Promise<void>((done) => (policyDeleted = done));
    api.deleteNetworkPolicy = async (ns, name) => {
      calls.push("policy");
      await deletePolicy(ns, name);
      policyDeleted();
    };
    await expect(
      kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {}, timeoutMs: 20 }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:timeout");
    expect(calls).toEqual([]);
    release();
    await policyGone;
    expect(calls).toEqual(["pod", "policy"]);
    expect(leftovers(api)).toEqual([]);
  });

  it("deletes the pod before the policy, and keeps the policy when the pod delete fails", async () => {
    const ordered = cluster(ok);
    const calls: string[] = [];
    const deletePod = ordered.deletePod.bind(ordered);
    ordered.deletePod = async (ns, name, grace) => {
      await new Promise((done) => setTimeout(done, 5));
      calls.push("pod");
      return deletePod(ns, name, grace);
    };
    const deletePolicy = ordered.deleteNetworkPolicy.bind(ordered);
    ordered.deleteNetworkPolicy = async (ns, name) => {
      calls.push("policy");
      return deletePolicy(ns, name);
    };
    await kubernetesPreflight({ api: ordered, config, workerImage: IMAGE, sleep: async () => {} });
    expect(calls).toEqual(["pod", "policy"]);

    const failing = cluster(ok);
    failing.deletePod = async () => {
      throw new Error("api down");
    };
    await expect(
      kubernetesPreflight({ api: failing, config, workerImage: IMAGE, sleep: async () => {} }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
    expect(leftovers(failing).filter((k) => k.startsWith("networkpolicy/"))).toHaveLength(1);
  });

  it("bounds cleanup: a hung pod delete fails the preflight instead of hanging it", async () => {
    const api = cluster(ok);
    api.deletePod = () => new Promise<void>(() => {});
    await expect(
      kubernetesPreflight({ api, config, workerImage: IMAGE, sleep: async () => {}, cleanupTimeoutMs: 20 }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:canary");
  });

  it("a hung cleanup after a timeout still fails with timeout", async () => {
    const api = cluster(ok);
    api.readLogTail = () => new Promise<string>(() => {});
    api.deletePod = () => new Promise<void>(() => {});
    await expect(
      kubernetesPreflight({
        api,
        config,
        workerImage: IMAGE,
        sleep: async () => {},
        timeoutMs: 20,
        cleanupTimeoutMs: 20,
      }),
    ).rejects.toThrow("kubernetes_isolation_unsupported:timeout");
  });

  it("describes failures for the CLI: API causes shown briefly, canary output never", async () => {
    const forbidden = cluster(ok);
    forbidden.readNamespace = async () => {
      throw new Error("namespaces is forbidden: User cannot get\nsecond line");
    };
    const apiError = await kubernetesPreflight({ api: forbidden, config, workerImage: IMAGE }).catch((e: unknown) => e);
    expect(describePreflightFailure(apiError)).toBe(
      "kubernetes_isolation_unsupported:namespace (namespaces is forbidden: User cannot get)",
    );

    const leaky = cluster({ ...ok, internet: true });
    const create = leaky.createPod.bind(leaky);
    leaky.createPod = async (ns, body) => {
      const created = await create(ns, body);
      leaky.logs.set(`${ns}/${body.metadata!.name}/worker`, "secret-noise");
      return created;
    };
    const canaryError = await kubernetesPreflight({
      api: leaky,
      config,
      workerImage: IMAGE,
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(describePreflightFailure(canaryError)).toBe("kubernetes_isolation_unsupported:canary");

    expect(describePreflightFailure(new Error("invalid kubeconfig"))).toBe("invalid kubeconfig");
  });
});

describe("runKubernetesPreflight", () => {
  it("returns the passed checks and the validated proxy ClusterIP", async () => {
    expect(
      await runKubernetesPreflight({ api: cluster(ok), config, workerImage: IMAGE, sleep: async () => {} }),
    ).toEqual({
      checks: ["namespace", "proxy-service", "worker-image", "canary"],
      proxyIp: "10.96.0.50",
    });
  });
});

describe("CANARY_SCRIPT", () => {
  /**
   * Runs the real script against a fake `net`/`dns`; `reachable(address, attempt)` decides each
   * connect, where `address` is `"<host>:<port>"`. Keying on both halves is deliberate: keying on
   * the port alone would let a script that probed the right port on the *wrong host* pass, and
   * keying on the host alone would let one that probed the wrong port on the right host pass.
   */
  async function runCanaryScript(
    reachable: (address: string, attempt: number) => boolean,
    timers: { setTimeout: (wake: () => void, ms: number) => unknown; Date: { now: () => number } } = {
      setTimeout,
      Date,
    },
  ) {
    const attempts = new Map<string, number>();
    const net = {
      connect({ host, port }: { host: string; port: number }) {
        const socket = Object.assign(new EventEmitter(), { destroy() {} });
        const address = `${host}:${port}`;
        const attempt = (attempts.get(address) ?? 0) + 1;
        attempts.set(address, attempt);
        setImmediate(() => socket.emit(reachable(address, attempt) ? "connect" : "error", new Error("blocked")));
        return socket;
      },
    };
    const dns = { promises: { lookup: async () => Promise.reject(new Error("ENOTFOUND")) } };
    const lines: string[] = [];
    let done!: () => void;
    const printed = new Promise<void>((r) => (done = r));
    runInNewContext(CANARY_SCRIPT, {
      require: (name: string) => (name === "node:net" ? net : dns),
      process: { env: { WARDBY_CANARY_PROXY_IP: "10.96.0.50" } },
      console: {
        log: (line: string) => {
          lines.push(line);
          done();
        },
      },
      ...timers,
    });
    await printed;
    return { output: JSON.parse(lines[0]) as { wardbyCanary: CanaryResult }, attempts };
  }

  it("waits for the deny port to be blocked before probing, then reports all five", async () => {
    // Policy programmed after two probes: early attempts connect, like a pod that starts before its policy.
    const { output, attempts } = await runCanaryScript(
      (address, attempt) => address === "10.96.0.50:8787" || (address === "10.96.0.50:8788" && attempt <= 2),
    );
    expect(output).toEqual({ wardbyCanary: ok });
    expect(attempts.get("10.96.0.50:8788")).toBe(4); // 2 connected + 1 blocked settle attempt + the real probe
    // The proxy port is probed once, on the SAME address as the deny port — that both probes go to
    // WARDBY_CANARY_PROXY_IP is exactly what makes `proxy` true with `proxyDeny` false decisive.
    expect(attempts.get("10.96.0.50:8787")).toBe(1);
    // Every address the script connects to, and nothing else: no probe reaches an unintended host.
    expect([...attempts.keys()].sort()).toEqual([
      "1.1.1.1:443",
      "10.96.0.50:8787",
      "10.96.0.50:8788",
      "169.254.169.254:80",
    ]);
  });

  it("reports proxyDeny true when the policy is never enforced within the settle window", async () => {
    let clock = 0;
    const timers = {
      setTimeout: (wake: () => void, ms: number) => {
        clock += ms;
        return setImmediate(wake);
      },
      Date: { now: () => clock },
    };
    const { output, attempts } = await runCanaryScript(() => true, timers);
    expect(output.wardbyCanary.proxyDeny).toBe(true);
    expect(attempts.get("10.96.0.50:8788")).toBe(41); // 40 settle attempts over 20 s, then the real probe
  });
});
