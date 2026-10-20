import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { nativeKubernetesNames, nativeWarmWorkerName } from "./kubernetes-isolation.js";
import { KubernetesNativeWorkerLauncher } from "./kubernetes-launcher.js";
import type { WorkerInput } from "./protocol.js";
import type { Power } from "../core/power.js";

const k8sWarn = vi.hoisted(() => vi.fn());
vi.mock("../core/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../core/logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    if (bindings.module === "native-kubernetes-launcher") vi.spyOn(log, "warn").mockImplementation(k8sWarn);
    return log;
  });
  return real;
});

const ns = "wardby-runs";
const image = `registry.local:5001/wardby-native-worker@sha256:${"a".repeat(64)}`;
const input = {
  runId: "run_k1",
  gateway: { url: "http://10.96.0.42:8790/x", capability: "c".repeat(43) },
} as unknown as WorkerInput;
const names = nativeKubernetesNames("run_k1");

function setup(
  options: {
    probe?: number;
    serviceIp?: string | null;
    power?: Power;
    readyTimeoutMs?: number;
    diagnosticTimeoutMs?: number;
  } = {},
) {
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
    for (const pod of await api.listPods(ns, "wardby.io/component=native-run")) {
      if (!pod.status) api.put("pod", ns, { ...pod, status: { phase: "Running" } });
    }
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
    readyTimeoutMs: options.readyTimeoutMs ?? 5_000,
    pollMs: 1,
    sleep,
    power: options.power,
    diagnosticTimeoutMs: options.diagnosticTimeoutMs,
  });
  return { api, launcher, proven };
}

const exists = (api: FakeKubernetesApi, kind: string, name: string) => api.objects.has(`${kind}/${ns}/${name}`);

describe("KubernetesNativeWorkerLauncher", () => {
  it("wakes the native gateway before creating any cluster object (low-power mode)", async () => {
    let seenAtWake: number | undefined;
    const holder: { api?: FakeKubernetesApi } = {};
    const ensureAwake = vi.fn(async () => {
      seenAtWake = [...(holder.api?.objects.keys() ?? [])].filter((k) =>
        /^(secret|pod|networkpolicy)\//.test(k),
      ).length;
    });
    const power = { enabled: true, ensureAwake } as unknown as Power;
    const made = setup({ power });
    holder.api = made.api;
    await made.launcher.launch(input);
    // The wake bound has a 5-minute floor (a cold node can take minutes), above the 5 s ready timeout.
    expect(ensureAwake).toHaveBeenCalledWith("gateway", { timeoutMs: 300_000, runId: "run_k1" });
    expect(seenAtWake).toBe(0);
    expect(exists(made.api, "pod", names.pod)).toBe(true);
  });

  it("a ready timeout above the 5-minute floor raises the gateway wake bound too", async () => {
    const ensureAwake = vi.fn(async () => {});
    const { launcher } = setup({ power: { enabled: true, ensureAwake } as unknown as Power, readyTimeoutMs: 420_000 });
    await launcher.launch(input);
    expect(ensureAwake).toHaveBeenCalledWith("gateway", { timeoutMs: 420_000, runId: "run_k1" });
  });

  it("creates nothing for a run that ended during the wake (stillWanted false)", async () => {
    const ensureAwake = vi.fn(async () => {});
    const made = setup({ power: { enabled: true, ensureAwake } as unknown as Power });
    const stillWanted = vi.fn(async () => false);
    await expect(made.launcher.launch(input, { stillWanted })).rejects.toThrow("native_sandbox_launch_abandoned");
    expect(stillWanted).toHaveBeenCalledTimes(1);
    expect([...made.api.objects.keys()].filter((k) => /^(secret|pod|networkpolicy)\//.test(k))).toEqual([]);

    const live = setup({ power: { enabled: true, ensureAwake } as unknown as Power });
    await live.launcher.launch(input, { stillWanted: async () => true });
    expect(exists(live.api, "pod", names.pod)).toBe(true);
  });

  it("never calls power when it is disabled", async () => {
    const ensureAwake = vi.fn(async () => {});
    const { launcher } = setup({ power: { enabled: false, ensureAwake } as unknown as Power });
    await launcher.launch(input);
    expect(ensureAwake).not.toHaveBeenCalled();
  });

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

  it("refuses a pod whose resources or priority class admission changed, but not a re-rendered quantity", async () => {
    const mutate = (change: (pod: V1Pod) => void) => {
      const ctx = setup();
      const create = ctx.api.createPod.bind(ctx.api);
      ctx.api.createPod = async (namespace, body) => {
        const stored = structuredClone(body);
        change(stored);
        return create(namespace, stored);
      };
      return ctx;
    };
    const rewritten = mutate((pod) => {
      pod.spec!.containers[0].resources = {
        requests: { cpu: "2", memory: "2Gi", "ephemeral-storage": "128Mi" },
        limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "128Mi" },
      };
    });
    await expect(rewritten.launcher.launch(input)).rejects.toThrow(/native_sandbox_isolation_mismatch/);
    const prioritized = mutate((pod) => {
      pod.spec!.priorityClassName = "system-node-critical";
    });
    await expect(prioritized.launcher.launch(input)).rejects.toThrow(/native_sandbox_isolation_mismatch/);
    // "1000m" read back as "1", "128Mi" as its byte count spelled differently: the same values.
    const rerendered = mutate((pod) => {
      pod.spec!.containers[0].resources = {
        requests: { cpu: "1", memory: "512Mi", "ephemeral-storage": "134217728" },
        limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "134217728" },
      };
    });
    await expect(rerendered.launcher.launch(input)).resolves.toBeDefined();
  });

  it("reports a ResourceQuota refusal as capacity, leaving nothing behind", async () => {
    const { api, launcher, proven } = setup();
    api.createPod = async () => {
      throw Object.assign(new Error("HTTP-Code: 403"), {
        code: 403,
        body: '{"message":"pods \\"x\\" is forbidden: exceeded quota: wardby-coding, requested: pods=1"}',
      });
    };
    await expect(launcher.launch(input)).rejects.toThrow(/native_sandbox_capacity/);
    expect(proven).not.toHaveBeenCalled();
    expect(exists(api, "secret", names.secret)).toBe(false);
    expect(exists(api, "networkpolicy", names.policy)).toBe(false);
  });
});

describe("KubernetesNativeWorkerLauncher worker exit logging", () => {
  const secret = "fake-secret-value-123";
  const capability = input.gateway!.capability;
  const fail = async (api: FakeKubernetesApi, exitCode: number) => {
    const pod = (await api.readPod(ns, names.pod))!;
    api.put("pod", ns, {
      ...pod,
      status: { phase: "Failed", containerStatuses: [{ name: "worker", state: { terminated: { exitCode } } }] },
    } as V1Pod);
  };

  it("logs the worker's log tail on a non-zero exit, masking its capability and secret values", async () => {
    k8sWarn.mockClear();
    const { api, launcher } = setup();
    const handle = await launcher.launch(input, { secretValues: async () => [secret] });
    api.logs.set(`${ns}/${names.pod}/worker`, `starting\ntoken ${capability}\nsecret ${secret}\nError: boom\n`);
    await fail(api, 2);
    expect(await handle.exited).toBe(2);
    expect(k8sWarn).toHaveBeenCalledTimes(1);
    const [fields, message] = k8sWarn.mock.calls[0];
    expect(message).toBe("native worker exited non-zero");
    expect(fields).toMatchObject({ pod: names.pod, code: 2 });
    expect(fields.stderrTail).toContain("Error: boom");
    expect(fields.stderrTail).toContain("[REDACTED]");
    expect(JSON.stringify(k8sWarn.mock.calls)).not.toContain(capability);
    expect(JSON.stringify(k8sWarn.mock.calls)).not.toContain(secret);
  });

  it("masks a value the bounded log read cut at its start", async () => {
    k8sWarn.mockClear();
    const { api, launcher } = setup();
    const handle = await launcher.launch(input, { secretValues: async () => [secret] });
    // Over the read's line bound, the oldest line holding the value's tail is where the read begins.
    const lines = [`x${secret}`.slice(0, 5), secret.slice(4), ...Array.from({ length: 99 }, (_, i) => `line ${i}`)];
    api.logs.set(`${ns}/${names.pod}/worker`, lines.join("\n"));
    await fail(api, 1);
    expect(await handle.exited).toBe(1);
    const [fields] = k8sWarn.mock.calls[0];
    expect(fields.stderrTail).toContain("line 98");
    expect(fields.stderrTail).not.toContain(secret.slice(4));
  });

  it("masks a secret's suffix at the start of a short read (a split long line or a rotated log)", async () => {
    k8sWarn.mockClear();
    const { api, launcher } = setup();
    const handle = await launcher.launch(input, { secretValues: async () => [secret] });
    // Far fewer lines than the read's bound, yet the first returned line begins inside the value.
    api.logs.set(`${ns}/${names.pod}/worker`, `${secret.slice(4)} rest of the line ${"r".repeat(60)}\nError: boom\n`);
    await fail(api, 1);
    expect(await handle.exited).toBe(1);
    const [fields] = k8sWarn.mock.calls[0];
    expect(fields.stderrTail).toContain("Error: boom");
    expect(fields.stderrTail).not.toContain(secret.slice(4));
    expect(fields.stderrTail).not.toContain("value-123");
  });

  it("reports the exit promptly when the log read or the secret values read never answers", async () => {
    k8sWarn.mockClear();
    const hungLog = setup({ diagnosticTimeoutMs: 50 });
    hungLog.api.readLogTail = () => new Promise<string>(() => {});
    const first = await hungLog.launcher.launch(input, { secretValues: async () => [secret] });
    await fail(hungLog.api, 1);
    const started = Date.now();
    expect(await first.exited).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(k8sWarn.mock.calls[0][0]).toEqual({ pod: names.pod, code: 1, stderrTailOmitted: "log_read_failed" });

    k8sWarn.mockClear();
    const hungSecrets = setup({ diagnosticTimeoutMs: 50 });
    hungSecrets.api.logs.set(`${ns}/${names.pod}/worker`, `leak ${capability}\n`);
    const second = await hungSecrets.launcher.launch(input, { secretValues: () => new Promise<string[]>(() => {}) });
    await fail(hungSecrets.api, 1);
    expect(await second.exited).toBe(1);
    expect(k8sWarn.mock.calls[0][0]).toEqual({ pod: names.pod, code: 1, stderrTailOmitted: "secrets_unavailable" });
  });

  it("tells a failed log read from an empty log", async () => {
    k8sWarn.mockClear();
    const refused = setup();
    refused.api.readLogTail = () => Promise.reject(new Error("forbidden"));
    const first = await refused.launcher.launch(input, { secretValues: async () => [] });
    await fail(refused.api, 1);
    expect(await first.exited).toBe(1);
    expect(k8sWarn.mock.calls[0][0]).toEqual({ pod: names.pod, code: 1, stderrTailOmitted: "log_read_failed" });

    k8sWarn.mockClear();
    const empty = setup();
    const second = await empty.launcher.launch(input, { secretValues: async () => [] });
    await fail(empty.api, 1);
    expect(await second.exited).toBe(1);
    expect(k8sWarn.mock.calls[0][0]).toEqual({ pod: names.pod, code: 1 });
  });

  it("keeps the log's last line when the selected lines are long", async () => {
    k8sWarn.mockClear();
    const { api, launcher } = setup();
    const handle = await launcher.launch(input, { secretValues: async () => [] });
    const long = Array.from({ length: 150 }, (_, i) => `${i} ${"j".repeat(1_000)}`);
    api.logs.set(`${ns}/${names.pod}/worker`, [...long, "native sandbox worker failed: boom"].join("\n"));
    await fail(api, 1);
    expect(await handle.exited).toBe(1);
    expect(k8sWarn.mock.calls[0][0].stderrTail).toMatch(/native sandbox worker failed: boom$/);
  });

  it("logs no tail when the secret values cannot be read (fail closed), and nothing on a clean exit", async () => {
    k8sWarn.mockClear();
    const { api, launcher } = setup();
    const handle = await launcher.launch(input, { secretValues: () => Promise.reject(new Error("read failed")) });
    api.logs.set(`${ns}/${names.pod}/worker`, `leak ${capability}\n`);
    await fail(api, 1);
    expect(await handle.exited).toBe(1);
    expect(k8sWarn.mock.calls[0][0]).toEqual({ pod: names.pod, code: 1, stderrTailOmitted: "secrets_unavailable" });

    k8sWarn.mockClear();
    const clean = setup();
    const ok = await clean.launcher.launch(input, { secretValues: async () => [] });
    await fail(clean.api, 0);
    expect(await ok.exited).toBe(0);
    expect(k8sWarn).not.toHaveBeenCalled();
  });
});

describe("KubernetesNativeWorkerLauncher warm pool workers", () => {
  const token = "0123456789abcdef0123";
  const warm = nativeWarmWorkerName(token);

  it("starts a warm pod with no input, proves its isolation, and lists it by token", async () => {
    const { api, launcher, proven } = setup();
    await launcher.startWarm(token, 60_000);
    const pod = (await api.readPod(ns, warm))!;
    expect(pod.spec!.volumes!.map((v) => v.name)).toEqual(["tmp"]);
    expect(pod.spec!.containers[0].env).toEqual([
      { name: "NATIVE_WORKER_INPUT_FILE", value: "/tmp/wardby-input/input.json" },
      { name: "NATIVE_WORKER_INPUT_WAIT_MS", value: "60000" },
    ]);
    expect(pod.spec!.activeDeadlineSeconds).toBe(60 + 3600);
    expect(exists(api, "networkpolicy", warm)).toBe(true);
    expect(api.execCalls).toHaveLength(1);
    expect(proven).not.toHaveBeenCalled();
    expect(await launcher.listWarm()).toEqual([token]);
    // The run janitor never sees a pool pod: it has no run hash.
    expect(await launcher.listWorkers()).toEqual([]);
  });

  it("removes a warm pod whose isolation cannot be proven", async () => {
    const { api, launcher } = setup({ probe: 5 });
    await expect(launcher.startWarm(token, 60_000)).rejects.toThrow(/native_sandbox_network_unenforced/);
    expect(exists(api, "pod", warm)).toBe(false);
    expect(exists(api, "networkpolicy", warm)).toBe(false);
  });

  it("delivers the input on exec stdin, never in the command", async () => {
    const { api, launcher } = setup();
    await launcher.startWarm(token, 60_000);
    let received = "";
    api.onExec = async ({ stdin }) => {
      for await (const chunk of stdin ?? []) received += String(chunk);
      return 0;
    };
    await launcher.deliver(token, input);
    const call = api.execCalls.at(-1)!;
    expect(call.pod).toBe(warm);
    expect(call.command.join(" ")).not.toContain(input.gateway!.capability);
    expect(JSON.parse(received)).toEqual(input);
    api.onExec = async () => 2;
    await expect(launcher.deliver(token, input)).rejects.toThrow(/native_sandbox_warm_delivery_failed/);
  });

  it("re-attests a running, unchanged warm pod, and refuses a changed, ended, or other-spec one", async () => {
    const { api, launcher } = setup();
    await launcher.startWarm(token, 60_000);
    expect(await launcher.reattestWarm(token, 60_000)).toBe(true);
    expect(await launcher.reattestWarm(token, 90_000)).toBe(false);
    const policy = (await api.readNetworkPolicy(ns, warm))!;
    api.put("networkpolicy", ns, { ...policy, spec: { ...policy.spec!, egress: [{}] } });
    expect(await launcher.reattestWarm(token, 60_000)).toBe(false);
    api.put("networkpolicy", ns, policy);
    const pod = (await api.readPod(ns, warm))!;
    api.put("pod", ns, { ...pod, status: { phase: "Succeeded" } });
    expect(await launcher.reattestWarm(token, 60_000)).toBe(false);
    await launcher.removeWarm(token);
    expect(await launcher.reattestWarm(token, 60_000)).toBe(false);
    expect(exists(api, "networkpolicy", warm)).toBe(false);
  });

  it("hashes its spec: same config, same hash; another image or wait, another hash", () => {
    const a = setup().launcher;
    expect(a.warmSpecHash(60_000)).toBe(setup().launcher.warmSpecHash(60_000));
    expect(a.warmSpecHash(60_000)).not.toBe(a.warmSpecHash(61_000));
  });
});
