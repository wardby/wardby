import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { FakeKubernetesApi } from "../providers/jobs/fake-kubernetes-api.js";
import { createPower, POWER_WOKE_AT } from "./power.js";
import { gatewayBusy, powerBlockers, powerBusy, proxyBusy } from "./power-idle.js";

const since = new Date("2026-10-11T11:30:00Z");

/** A Prisma stub with only the count methods the idle rules call. */
function stubDb(counts: { codingRuns?: number; mcpCodingRuns?: number; sandboxRuns?: number; sessions?: number } = {}) {
  // A where clause naming the proxy session is the gateway's "coding run with MCP tools" count.
  const codingRunCount = vi.fn(async (args: unknown) =>
    JSON.stringify(args).includes("mcpTokenHash") ? (counts.mcpCodingRuns ?? 0) : (counts.codingRuns ?? 0),
  );
  const runCount = vi.fn(async (_args: unknown) => counts.sandboxRuns ?? 0);
  const sessionCount = vi.fn(async (_args: unknown) => counts.sessions ?? 0);
  const db = {
    codingRun: { count: codingRunCount },
    run: { count: runCount },
    nativeGatewaySession: { count: sessionCount },
  } as unknown as PrismaClient;
  return { db, codingRunCount, runCount, sessionCount };
}

describe("low-power idle rules (where clauses)", () => {
  it("proxyBusy counts coding runs that are active or finished since the window start", async () => {
    const { db, codingRunCount } = stubDb();
    expect(await proxyBusy(db, since)).toBe(false);
    expect(codingRunCount).toHaveBeenCalledWith({
      where: { run: { OR: [{ status: { in: ["pending", "running"] } }, { finishedAt: { gte: since } }] } },
    });
  });

  it("gatewayBusy is false with no sandbox run, no MCP coding run in the window and no active session", async () => {
    const { db, runCount, codingRunCount, sessionCount } = stubDb();
    expect(await gatewayBusy(db, since)).toBe(false);
    expect(runCount).toHaveBeenCalledWith({
      where: {
        nativeExecutionMode: "sandbox",
        OR: [{ status: { in: ["pending", "running"] } }, { finishedAt: { gte: since } }],
      },
    });
    expect(codingRunCount).toHaveBeenCalledWith({
      where: {
        proxySession: { is: { mcpTokenHash: { not: null } } },
        run: { OR: [{ status: { in: ["pending", "running"] } }, { finishedAt: { gte: since } }] },
      },
    });
    expect(sessionCount).toHaveBeenCalledWith({ where: { status: "active" } });
  });

  it("gatewayBusy is true on a coding run with MCP tools in the window, without checking sessions", async () => {
    const { db, sessionCount } = stubDb({ mcpCodingRuns: 1 });
    expect(await gatewayBusy(db, since)).toBe(true);
    expect(sessionCount).not.toHaveBeenCalled();
  });

  it("gatewayBusy ignores coding runs without MCP tools", async () => {
    const { db } = stubDb({ codingRuns: 3 });
    expect(await gatewayBusy(db, since)).toBe(false);
  });

  it("gatewayBusy is true on a sandbox run in the window, without checking sessions", async () => {
    const { db, sessionCount } = stubDb({ sandboxRuns: 1 });
    expect(await gatewayBusy(db, since)).toBe(true);
    expect(sessionCount).not.toHaveBeenCalled();
  });

  it("gatewayBusy is true on an active gateway session alone", async () => {
    const { db } = stubDb({ sessions: 1 });
    expect(await gatewayBusy(db, since)).toBe(true);
  });

  it("powerBusy routes each target to its rule", async () => {
    const { db, codingRunCount, runCount } = stubDb({ codingRuns: 2 });
    const busy = powerBusy(db);
    expect(await busy("proxy", since)).toBe(true);
    expect(await busy("gateway", since)).toBe(false);
    // proxy: one coding-run count; gateway: one sandbox-run count and one MCP coding-run count.
    expect(codingRunCount).toHaveBeenCalledTimes(2);
    expect(runCount).toHaveBeenCalledTimes(1);
  });
});

describe("powerBlockers (where clauses)", () => {
  it("the gateway's blockers add active coding runs with MCP tools, deduplicated and sorted", async () => {
    const codingRunFindMany = vi.fn(async (_args: unknown) => [{ runId: "run-c" }, { runId: "run-a" }]);
    const db = {
      run: { findMany: vi.fn(async () => [{ id: "run-b" }]) },
      nativeGatewaySession: { findMany: vi.fn(async () => [{ runId: "run-a" }]) },
      codingRun: { findMany: codingRunFindMany },
    } as unknown as PrismaClient;
    expect(await powerBlockers(db, "gateway")).toEqual(["run-a", "run-b", "run-c"]);
    expect(codingRunFindMany).toHaveBeenCalledWith({
      where: {
        proxySession: { is: { mcpTokenHash: { not: null } } },
        run: { status: { in: ["pending", "running"] } },
      },
      select: { runId: true },
    });
  });
});

describe("low-power sweep with a coding run that has MCP tools", () => {
  const NS = "wardby-coding";
  const names = { proxy: "wardby-coding-proxy", gateway: "wardby-native-gateway" };
  const wokeAt = "2026-10-11T11:00:00Z";

  /** Both targets awake and past the idle window; the database holds one active coding run with MCP tools. */
  function setup(mcpRun: boolean) {
    const api = new FakeKubernetesApi();
    for (const name of Object.values(names)) {
      api.put("deployment", NS, {
        metadata: { name, annotations: { [POWER_WOKE_AT]: wokeAt } },
        spec: { replicas: 1, selector: {}, template: {} },
      });
    }
    const mcpWhere = (args: unknown) => JSON.stringify(args).includes("mcpTokenHash");
    const db = {
      // The proxy's own count stays 0, so only the gateway's MCP rule can keep anything up.
      codingRun: {
        count: vi.fn(async (args: unknown) => (mcpRun && mcpWhere(args) ? 1 : 0)),
        findMany: vi.fn(async (args: unknown) => (mcpRun && mcpWhere(args) ? [{ runId: "run-mcp" }] : [])),
      },
      run: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      nativeGatewaySession: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    } as unknown as PrismaClient;
    // The process started an hour ago, so its start does not hold the idle window open.
    let t = Date.parse("2026-10-11T11:00:00Z");
    const power = createPower({
      config: { enabled: true, idleMinutes: 30 },
      api,
      namespace: NS,
      deployments: names,
      busy: powerBusy(db),
      blockers: (target) => powerBlockers(db, target),
      now: () => new Date(t),
    });
    t = Date.parse("2026-10-11T12:00:00Z");
    return { api, power };
  }

  it("never scales the gateway down while the run is active (the proxy, idle, sleeps)", async () => {
    const { api, power } = setup(true);
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([{ name: names.proxy, replicas: 0 }]);
    expect(await power.sleepNow(["gateway"])).toEqual({
      slept: [],
      blocked: [{ target: "gateway", runIds: ["run-mcp"] }],
    });
    const status = await power.status();
    expect(status.targets?.find((t) => t.target === "gateway")?.blockers).toEqual(["run-mcp"]);
  });

  it("scales the gateway down once no such run exists", async () => {
    const { api, power } = setup(false);
    await power.sleepIfIdle();
    expect(api.deploymentPatches).toEqual([
      { name: names.proxy, replicas: 0 },
      { name: names.gateway, replicas: 0 },
    ]);
  });
});
