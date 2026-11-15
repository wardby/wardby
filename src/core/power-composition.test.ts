import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./logger.js", () => ({ logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn() }) } }));
const apiCtor = vi.hoisted(() => vi.fn());
vi.mock("../providers/jobs/kubernetes-client.js", () => ({
  ClientNodeKubernetesApi: class {
    constructor(opts: unknown) {
      apiCtor(opts);
    }
    async readEndpoints() {
      return undefined;
    }
    async readDeployment() {
      return undefined;
    }
  },
}));

import { buildPower, lowPowerActive } from "./power-composition.js";
import { DISABLED_POWER } from "./power.js";

const db = {} as PrismaClient;
afterEach(() => {
  warn.mockClear();
  apiCtor.mockClear();
});

describe("buildPower", () => {
  it("is DISABLED_POWER with no side effects when the flag is off", () => {
    expect(buildPower({ env: {}, db })).toBe(DISABLED_POWER);
    expect(buildPower({ env: { WARDBY_LOW_POWER: "0", JOB_LAUNCHER: "kubernetes" }, db })).toBe(DISABLED_POWER);
    expect(apiCtor).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and stays disabled when the launcher is not kubernetes", () => {
    expect(buildPower({ env: { WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "docker" }, db })).toBe(DISABLED_POWER);
    expect(warn).toHaveBeenCalledWith("low_power_ignored: WARDBY_LOW_POWER requires JOB_LAUNCHER=kubernetes");
    expect(apiCtor).not.toHaveBeenCalled();
  });

  it("is enabled with a Kubernetes client for the configured context", () => {
    const power = buildPower({
      env: { WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "kubernetes", KUBERNETES_CONTEXT: "ctx" },
      db,
    });
    expect(power.enabled).toBe(true);
    expect(apiCtor).toHaveBeenCalledWith({ context: "ctx" });
  });
});

describe("lowPowerActive", () => {
  it.each([
    [{ WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "kubernetes" }, true],
    [{ WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "docker" }, false],
    [{ WARDBY_LOW_POWER: "1" }, false],
    [{ WARDBY_LOW_POWER: "0", JOB_LAUNCHER: "kubernetes" }, false],
    [{ JOB_LAUNCHER: "kubernetes" }, false],
  ])("%j -> %s, as buildPower decides", (env, active) => {
    expect(lowPowerActive(env)).toBe(active);
    expect(buildPower({ env, db }).enabled).toBe(active);
  });

  it("still rejects an invalid WARDBY_LOW_POWER", () => {
    expect(() => lowPowerActive({ WARDBY_LOW_POWER: "yes", JOB_LAUNCHER: "kubernetes" })).toThrow(
      /WARDBY_LOW_POWER must be 0 or 1/,
    );
  });

  it("makes the renderer a target only when WARDBY_RENDERER_URL is set", async () => {
    const base = { WARDBY_LOW_POWER: "1", JOB_LAUNCHER: "kubernetes" };
    // readDeployment is mocked to return undefined: a target with a Deployment name does not throw
    // low_power_disabled, and one without does.
    const withRenderer = buildPower({ env: { ...base, WARDBY_RENDERER_URL: "http://wardby-renderer:8796" }, db });
    await expect(withRenderer.isAsleep("renderer")).resolves.toBe(false);
    const without = buildPower({ env: base, db });
    await expect(without.isAsleep("renderer")).rejects.toThrow(/^low_power_disabled: renderer is not deployed here/);
  });
});
