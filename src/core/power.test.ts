import { describe, expect, it, vi } from "vitest";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { createPower, DISABLED_POWER, POWER_WOKE_AT, type PowerTarget } from "./power.js";

const NS = "wardby-coding";
const names = { proxy: "wardby-coding-proxy", gateway: "wardby-native-gateway" };
const readyEndpoints = { metadata: { name: names.proxy }, subsets: [{ addresses: [{ ip: "10.0.0.5" }] }] };

function setup(
  replicas: number,
  opts: {
    ready?: boolean;
    onSleep?: (calls: number, api: FakeKubernetesApi) => void;
    busy?: (target: PowerTarget, since: Date) => Promise<boolean>;
    blockers?: (target: PowerTarget) => Promise<string[]>;
    /** Seeds the proxy Deployment's POWER_WOKE_AT annotation. */
    wokeAt?: string;
    enabled?: boolean;
    /** When this process (createPower) started. Default: an hour before the clock's start. */
    processStart?: string;
  } = {},
) {
  const api = new FakeKubernetesApi();
  api.put("deployment", NS, {
    metadata: { name: names.proxy, ...(opts.wokeAt ? { annotations: { [POWER_WOKE_AT]: opts.wokeAt } } : {}) },
    spec: { replicas, selector: {}, template: {} },
  });
  if (opts.ready) api.put("endpoints", NS, readyEndpoints);
  const clockStart = Date.parse("2026-10-11T12:00:00Z");
  let t = opts.processStart ? Date.parse(opts.processStart) : clockStart - 60 * 60_000;
  let sleeps = 0;
  const power = createPower({
    config: { enabled: opts.enabled ?? true, idleMinutes: 30 },
    api,
    namespace: NS,
    deployments: names,
    busy: opts.busy,
    blockers: opts.blockers,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
      opts.onSleep?.(++sleeps, api);
    },
    pollMs: 1000,
  });
  t = clockStart;
  return { api, power, advance: (ms: number) => (t += ms) };
}

describe("power (wake)", () => {
  it("disabled power makes no API calls", async () => {
    const api = new FakeKubernetesApi();
    const power = createPower({ config: { enabled: false, idleMinutes: 30 }, api, namespace: NS, deployments: names });
    expect(power.enabled).toBe(false);
    await power.ensureAwake("proxy", { timeoutMs: 1000, runId: "r" });
    expect(api.deploymentPatches).toEqual([]);
    expect(await power.isAsleep("proxy")).toBe(false);
    expect(await power.checkAccess()).toEqual([]);
  });

  it("DISABLED_POWER is a no-op", async () => {
    expect(DISABLED_POWER.enabled).toBe(false);
    await DISABLED_POWER.ensureAwake("gateway", { timeoutMs: 1000, runId: "r" });
    await DISABLED_POWER.sleepIfIdle();
    expect(await DISABLED_POWER.isAsleep("gateway")).toBe(false);
    expect(await DISABLED_POWER.checkAccess()).toEqual([]);
  });

  it("wakes a deployment at 0, stamps woke-at, and waits for a ready endpoint", async () => {
    // The endpoint turns ready during the first poll wait, so the wake must poll at least once.
    const { api, power } = setup(0, {
      onSleep: (calls, fake) => {
        if (calls === 1) fake.put("endpoints", NS, readyEndpoints);
      },
    });
    await expect(power.ensureAwake("proxy", { timeoutMs: 60_000, runId: "r1" })).resolves.toBeUndefined();
    expect(api.deploymentPatches).toEqual([
      { name: names.proxy, replicas: 1, annotations: { [POWER_WOKE_AT]: "2026-10-11T12:00:00.000Z" } },
    ]);
    expect(await power.isAsleep("proxy")).toBe(false);
  });

  it("returns at once when already awake and ready", async () => {
    const { api, power } = setup(1, { ready: true });
    await power.ensureAwake("proxy", { timeoutMs: 1000, runId: "r" });
    expect(api.deploymentPatches).toEqual([]);
  });

  it("isAsleep reports a deployment at 0 replicas", async () => {
    const { power } = setup(0);
    expect(await power.isAsleep("proxy")).toBe(true);
  });

  it("fails with low_power_wake_timeout and leaves replicas at 1", async () => {
    const { api, power } = setup(0);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_wake_timeout: /,
    );
    expect((await api.readDeployment(NS, names.proxy))?.spec?.replicas).toBe(1);
  });

  it("fails fast with low_power_scale_forbidden", async () => {
    const { api, power } = setup(0);
    api.forbidden.add(names.proxy);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_scale_forbidden: .*wardby-coding-proxy/,
    );
  });

  it("two concurrent wakes both succeed", async () => {
    const { api, power } = setup(0, { ready: true });
    await Promise.all([
      power.ensureAwake("proxy", { timeoutMs: 5000, runId: "a" }),
      power.ensureAwake("proxy", { timeoutMs: 5000, runId: "b" }),
    ]);
    expect((await api.readDeployment(NS, names.proxy))?.spec?.replicas).toBe(1);
  });

  it("checkAccess lists missing permissions", async () => {
    const { api, power } = setup(1);
    api.accessDenied.add("patch/deployments/wardby-native-gateway");
    expect(await power.checkAccess()).toEqual(["patch deployments/wardby-native-gateway"]);
  });

  it("checkAccess checks get on each target's Endpoints too", async () => {
    const { api, power } = setup(1);
    const canI = vi.spyOn(api, "canI");
    api.accessDenied.add("get/endpoints/wardby-native-gateway");
    expect(await power.checkAccess()).toEqual(["get endpoints/wardby-native-gateway"]);
    expect(canI).toHaveBeenCalledWith(NS, "get", "", "endpoints", names.proxy);
    expect(canI).toHaveBeenCalledWith(NS, "get", "", "endpoints", names.gateway);
  });

  it("maps a forbidden Deployment read to low_power_scale_forbidden", async () => {
    const { api, power } = setup(0);
    api.forbiddenReads.add(`deployment/${names.proxy}`);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_scale_forbidden: .*get Deployment "wardby-coding-proxy"/,
    );
    await expect(power.isAsleep("proxy")).rejects.toThrow(/^low_power_scale_forbidden: .*wardby-coding-proxy/);
  });

  it("maps a forbidden Endpoints read to low_power_scale_forbidden after waking", async () => {
    const { api, power } = setup(0);
    api.forbiddenReads.add(`endpoints/${names.proxy}`);
    await expect(power.ensureAwake("proxy", { timeoutMs: 5000, runId: "r" })).rejects.toThrow(
      /^low_power_scale_forbidden: .*get Endpoints "wardby-coding-proxy"/,
    );
  });
});

describe("power (sleep)", () => {
  // setup()'s clock starts at 2026-10-11T12:00:00Z; idleMinutes is 30.
  const SIXTY_MIN_AGO = "2026-10-11T11:00:00Z";

  it("sleeps an idle target after the window", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches.at(-1)).toEqual({ name: names.proxy, replicas: 0 });
    expect(await power.isAsleep("proxy")).toBe(true);
    expect(busy).toHaveBeenCalledTimes(2); // check + re-check
    expect(busy).toHaveBeenCalledWith("proxy", new Date("2026-10-11T11:30:00Z"));
  });

  it("does not sleep a target woken less than idleMinutes ago", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: "2026-10-11T11:50:00Z" });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).not.toHaveBeenCalled();
  });

  it("counts from process start when the Deployment has no woke-at annotation", async () => {
    const busy = vi.fn(async () => false);
    const { api, power, advance } = setup(1, { busy, processStart: "2026-10-11T12:00:00Z" });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    advance(31 * 60_000);
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("counts from process start when it is later than a stale woke-at annotation", async () => {
    const busy = vi.fn(async () => false);
    const { api, power, advance } = setup(1, {
      busy,
      wokeAt: SIXTY_MIN_AGO,
      processStart: "2026-10-11T11:50:00Z",
    });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).not.toHaveBeenCalled();
    advance(21 * 60_000);
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("sleeps at once when both the woke-at annotation and process start are older than the window", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO, processStart: "2026-10-11T11:20:00Z" });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("does not sleep when busy", async () => {
    const busy = vi.fn(async () => true);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).toHaveBeenCalledTimes(1);
    expect(await power.isAsleep("proxy")).toBe(false);
  });

  it("does not sleep when the re-check finds a run", async () => {
    const busy = vi.fn<(target: PowerTarget, since: Date) => Promise<boolean>>();
    busy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("leaves a target already at zero replicas alone", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(0, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
    expect(busy).not.toHaveBeenCalled();
  });

  it("skips a target whose Deployment does not exist", async () => {
    // Only the proxy Deployment is seeded; the gateway one is missing.
    const busy = vi.fn(async (_target: PowerTarget, _since: Date) => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    expect(busy.mock.calls.map(([target]) => target)).toEqual(["proxy", "proxy"]);
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("sleeps the gateway too when it is idle", async () => {
    const busy = vi.fn(async (target: PowerTarget) => target === "proxy");
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    api.put("deployment", NS, {
      metadata: { name: names.gateway, annotations: { [POWER_WOKE_AT]: SIXTY_MIN_AGO } },
      spec: { replicas: 1, selector: {}, template: {} },
    });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.gateway, replicas: 0 }]);
  });

  it("throttles to once per minute", async () => {
    const busy = vi.fn(async () => true);
    const { power, advance } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(1);
    advance(10_000);
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(1);
    advance(50_000);
    await power.sleepIfIdle();
    expect(busy).toHaveBeenCalledTimes(2);
  });

  it("swallows and logs API errors, per target", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    api.put("deployment", NS, {
      metadata: { name: names.gateway, annotations: { [POWER_WOKE_AT]: SIXTY_MIN_AGO } },
      spec: { replicas: 1, selector: {}, template: {} },
    });
    const read = api.readDeployment.bind(api);
    vi.spyOn(api, "readDeployment").mockImplementation(async (ns, name) => {
      if (name === names.proxy) throw new Error("apiserver down");
      return read(ns, name);
    });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    // The proxy's failure did not stop the gateway from sleeping.
    expect(api.deploymentPatches).toEqual([{ name: names.gateway, replicas: 0 }]);
  });

  it("swallows a forbidden read and still sleeps the other target", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    api.put("deployment", NS, {
      metadata: { name: names.gateway, annotations: { [POWER_WOKE_AT]: SIXTY_MIN_AGO } },
      spec: { replicas: 1, selector: {}, template: {} },
    });
    api.forbiddenReads.add(`deployment/${names.proxy}`);
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    expect(api.deploymentPatches).toEqual([{ name: names.gateway, replicas: 0 }]);
  });

  it("swallows a busy-check failure and leaves the target up", async () => {
    const busy = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO });
    await expect(power.sleepIfIdle()).resolves.toBeUndefined();
    expect(api.deploymentPatches).toEqual([]);
  });

  it("does nothing without a busy check", async () => {
    const { api, power } = setup(1, { wokeAt: SIXTY_MIN_AGO });
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([]);
  });

  it("is a no-op when disabled", async () => {
    const busy = vi.fn(async () => false);
    const { api, power } = setup(1, { busy, wokeAt: SIXTY_MIN_AGO, enabled: false });
    vi.spyOn(api, "readDeployment");
    await power.sleepIfIdle();
    expect(api.readDeployment).not.toHaveBeenCalled();
    expect(busy).not.toHaveBeenCalled();
    expect(api.deploymentPatches).toEqual([]);
  });
});

describe("power (sleep now and status)", () => {
  it("sleepNow scales an awake, unblocked target to 0 regardless of woke-at", async () => {
    const { api, power } = setup(1, {
      busy: async () => true,
      blockers: async () => [],
      wokeAt: new Date().toISOString(),
    });
    expect(await power.sleepNow(["proxy"])).toEqual({ slept: ["proxy"], blocked: [] });
    expect(api.deploymentPatches.at(-1)).toEqual({ name: names.proxy, replicas: 0 });
  });

  it("sleepNow refuses a target with blockers and reports them", async () => {
    const { api, power } = setup(1, { blockers: async () => ["run_1", "run_2"] });
    expect(await power.sleepNow(["proxy"])).toEqual({
      slept: [],
      blocked: [{ target: "proxy", runIds: ["run_1", "run_2"] }],
    });
    expect(api.deploymentPatches).toEqual([]);
  });

  it("sleepNow re-checks blockers right before patching", async () => {
    const blockers = vi.fn<(target: PowerTarget) => Promise<string[]>>();
    blockers.mockResolvedValueOnce([]).mockResolvedValueOnce(["run_late"]);
    const { api, power } = setup(1, { blockers });
    expect((await power.sleepNow(["proxy"])).blocked).toEqual([{ target: "proxy", runIds: ["run_late"] }]);
    expect(blockers).toHaveBeenCalledTimes(2);
    expect(api.deploymentPatches).toEqual([]);
  });

  it("sleepNow on an already-sleeping target reports it slept without patching", async () => {
    const blockers = vi.fn(async () => ["run_1"]);
    const { api, power } = setup(0, { blockers });
    expect((await power.sleepNow(["proxy"])).slept).toEqual(["proxy"]);
    expect(api.deploymentPatches).toEqual([]);
    expect(blockers).not.toHaveBeenCalled();
  });

  it("sleepNow handles each target on its own and skips a Deployment that does not exist", async () => {
    const { api, power } = setup(1, { blockers: async (target) => (target === "gateway" ? ["run_g"] : []) });
    // Only the proxy Deployment exists: the gateway is neither slept nor blocked.
    expect(await power.sleepNow(["proxy", "gateway"])).toEqual({ slept: ["proxy"], blocked: [] });
    api.put("deployment", NS, { metadata: { name: names.gateway }, spec: { replicas: 2, selector: {}, template: {} } });
    expect(await power.sleepNow(["proxy", "gateway"])).toEqual({
      slept: ["proxy"],
      blocked: [{ target: "gateway", runIds: ["run_g"] }],
    });
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
  });

  it("sleepNow fails with low_power_scale_forbidden when it may not patch", async () => {
    const { api, power } = setup(1, { blockers: async () => [] });
    api.forbidden.add(names.proxy);
    await expect(power.sleepNow(["proxy"])).rejects.toThrow(/^low_power_scale_forbidden: .*wardby-coding-proxy/);
  });

  it("sleepNow maps a forbidden Deployment read to low_power_scale_forbidden", async () => {
    const { api, power } = setup(1, { blockers: async () => [] });
    api.forbiddenReads.add(`deployment/${names.proxy}`);
    await expect(power.sleepNow(["proxy"])).rejects.toThrow(/^low_power_scale_forbidden: .*wardby-coding-proxy/);
    expect(api.deploymentPatches).toEqual([]);
  });

  it("status maps a forbidden Deployment or Endpoints read to low_power_scale_forbidden", async () => {
    const { api, power } = setup(1, { ready: true, blockers: async () => [] });
    api.put("deployment", NS, { metadata: { name: names.gateway }, spec: { replicas: 1, selector: {}, template: {} } });
    api.forbiddenReads.add(`endpoints/${names.gateway}`);
    await expect(power.status()).rejects.toThrow(/^low_power_scale_forbidden: .*get Endpoints "wardby-native-gateway"/);
    api.forbiddenReads.clear();
    api.forbiddenReads.add(`deployment/${names.proxy}`);
    await expect(power.status()).rejects.toThrow(/^low_power_scale_forbidden: .*get Deployment "wardby-coding-proxy"/);
  });

  it("sleepNow refuses to scale anything without a blockers check", async () => {
    const { api, power } = setup(1);
    await expect(power.sleepNow(["proxy"])).rejects.toThrow(/blockers/);
    expect(api.deploymentPatches).toEqual([]);
  });

  it("status reports replicas, readiness, wokeAt and blockers; disabled reports enabled false with no API call", async () => {
    // Enabled: an awake, ready, busy proxy and a sleeping gateway.
    const blockers = vi.fn(async (target: PowerTarget) => (target === "proxy" ? ["run_1", "run_2"] : []));
    const { api, power } = setup(1, { ready: true, wokeAt: "2026-10-11T11:00:00.000Z", blockers });
    api.put("deployment", NS, { metadata: { name: names.gateway }, spec: { replicas: 0, selector: {}, template: {} } });
    expect(await power.status()).toEqual({
      enabled: true,
      targets: [
        { target: "proxy", replicas: 1, ready: true, wokeAt: "2026-10-11T11:00:00.000Z", blockers: ["run_1", "run_2"] },
        { target: "gateway", replicas: 0, ready: false, wokeAt: null, blockers: [] },
      ],
    });
    expect(api.deploymentPatches).toEqual([]);

    // Disabled: no Kubernetes call, no blockers query.
    const offBlockers = vi.fn(async () => ["run_1"]);
    const off = setup(1, { ready: true, blockers: offBlockers, enabled: false });
    vi.spyOn(off.api, "readDeployment");
    vi.spyOn(off.api, "readEndpoints");
    expect(await off.power.status()).toEqual({ enabled: false });
    expect(off.api.readDeployment).not.toHaveBeenCalled();
    expect(off.api.readEndpoints).not.toHaveBeenCalled();
    expect(offBlockers).not.toHaveBeenCalled();
    expect(await DISABLED_POWER.status()).toEqual({ enabled: false });
  });

  it("DISABLED_POWER.sleepNow fails with low_power_disabled", async () => {
    await expect(DISABLED_POWER.sleepNow(["proxy"])).rejects.toThrow(
      "low_power_disabled: WARDBY_LOW_POWER is not 1 on this deployment.",
    );
  });
});

describe("power (renderer target)", () => {
  const rendererName = "wardby-renderer";
  const wokeAt = "2026-10-11T11:00:00Z";

  /** Proxy and renderer Deployments, both awake past the idle window; the renderer is a target only when `withRenderer`. */
  function rendererSetup(opts: { withRenderer: boolean; rendererReplicas?: number; busy?: PowerTarget[] }) {
    const api = new FakeKubernetesApi();
    for (const name of [names.proxy, rendererName]) {
      api.put("deployment", NS, {
        metadata: { name, annotations: { [POWER_WOKE_AT]: wokeAt } },
        spec: { replicas: name === rendererName ? (opts.rendererReplicas ?? 1) : 1, selector: {}, template: {} },
      });
    }
    let t = Date.parse("2026-10-11T11:00:00Z");
    const power = createPower({
      config: { enabled: true, idleMinutes: 30 },
      api,
      namespace: NS,
      deployments: { ...names, ...(opts.withRenderer ? { renderer: rendererName } : {}) },
      busy: async (target) => (opts.busy ?? []).includes(target),
      blockers: async (target) => (target === "renderer" ? ["exp_1"] : []),
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
        api.put("endpoints", NS, { metadata: { name: rendererName }, subsets: [{ addresses: [{ ip: "10.0.0.9" }] }] });
      },
      pollMs: 1000,
    });
    t = Date.parse("2026-10-11T12:00:00Z");
    return { api, power };
  }

  it("status lists the renderer when it is a target, and not otherwise", async () => {
    const on = rendererSetup({ withRenderer: true });
    expect((await on.power.status()).targets?.map((x) => x.target)).toEqual(["proxy", "renderer"]);
    expect((await on.power.status()).targets?.[1]?.blockers).toEqual(["exp_1"]);
    const off = rendererSetup({ withRenderer: false });
    expect((await off.power.status()).targets?.map((x) => x.target)).toEqual(["proxy"]);
  });

  it("sleepIfIdle scales an idle renderer to 0 and leaves a busy one", async () => {
    const idle = rendererSetup({ withRenderer: true });
    await idle.power.sleepIfIdle();
    expect(idle.api.deploymentPatches).toContainEqual({ name: rendererName, replicas: 0 });
    const busy = rendererSetup({ withRenderer: true, busy: ["renderer"] });
    await busy.power.sleepIfIdle();
    expect(busy.api.deploymentPatches.some((p) => p.name === rendererName)).toBe(false);
  });

  it("ensureAwake wakes a sleeping renderer and waits for its endpoint", async () => {
    const { api, power } = rendererSetup({ withRenderer: true, rendererReplicas: 0 });
    await power.ensureAwake("renderer", { timeoutMs: 10_000, runId: "exp_1" });
    expect(api.deploymentPatches.at(-1)).toMatchObject({ name: rendererName, replicas: 1 });
    expect(await power.isAsleep("renderer")).toBe(false);
  });

  it("without a renderer deployment, ensureAwake rejects with low_power_disabled and sleepNow skips it", async () => {
    const { api, power } = rendererSetup({ withRenderer: false });
    await expect(power.ensureAwake("renderer", { timeoutMs: 1000, runId: "exp_1" })).rejects.toThrow(
      /^low_power_disabled: renderer is not deployed here/,
    );
    expect(await power.sleepNow(["renderer"])).toEqual({ slept: [], blocked: [] });
    expect(api.deploymentPatches).toEqual([]);
    expect(await power.checkAccess()).not.toContain("get deployments/undefined");
  });

  it("sleepNow over every target (power_sleep with no target) skips a renderer that is not deployed", async () => {
    const { api, power } = rendererSetup({ withRenderer: false });
    const result = await power.sleepNow(["proxy", "gateway", "renderer"]);
    expect(result.slept).toContain("proxy");
    expect(result.slept).not.toContain("renderer");
    expect(result.blocked).toEqual([]);
    expect(api.deploymentPatches.some((p) => p.name === rendererName)).toBe(false);
  });

  it("sleepNow refuses a renderer with queued or running exports", async () => {
    const { power } = rendererSetup({ withRenderer: true });
    expect(await power.sleepNow(["renderer"])).toEqual({
      slept: [],
      blocked: [{ target: "renderer", runIds: ["exp_1"] }],
    });
  });
});
