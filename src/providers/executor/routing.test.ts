import { describe, expect, it, vi } from "vitest";
import { PrismaExecutionKindResolver, RoutingExecutor, type ExecutionTarget } from "./routing.js";

describe("RoutingExecutor", () => {
  it("routes starts and stops by durable agent kind", async () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const kinds = new Map<string, "native" | "coding">([
      ["native-run", "native"],
      ["coding-run", "coding"],
    ]);
    const executor = new RoutingExecutor({ kindForRun: async (id) => kinds.get(id) ?? null }, native, coding);

    await executor.start("native-run");
    await executor.start("coding-run");
    await executor.stop("coding-run", "requested");
    expect(native.start).toHaveBeenCalledWith("native-run");
    expect(coding.start).toHaveBeenCalledWith("coding-run");
    expect(coding.stop).toHaveBeenCalledWith("coding-run", "requested");
  });

  it("hands a queue-timed-out run's cleanup to the coding executor only", async () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), cleanupQueueTimeout: vi.fn() };
    const coding = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), cleanupQueueTimeout: vi.fn() };
    const executor = new RoutingExecutor({ kindForRun: async () => "coding" }, native, coding);

    await executor.cleanupQueueTimeout("coding-run");
    expect(coding.cleanupQueueTimeout).toHaveBeenCalledWith("coding-run");
    expect(native.cleanupQueueTimeout).not.toHaveBeenCalled();
    // A coding executor without the hook is fine.
    await new RoutingExecutor({ kindForRun: async () => "coding" }, native, {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }).cleanupQueueTimeout("coding-run");
  });

  it("routes recovery by agent kind so a native durable handle never reaches the coding executor", async () => {
    const native = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      recover: vi.fn(async () => ({ state: "active" as const })),
    };
    const coding = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      recover: vi.fn(async () => ({ state: "terminal" as const })),
    };
    const kinds = new Map<string, "native" | "coding">([
      ["native-run", "native"],
      ["coding-run", "coding"],
    ]);
    const executor = new RoutingExecutor({ kindForRun: async (id) => kinds.get(id) ?? null }, native, coding);

    const nativeHandle = { runId: "native-run", backend: "dbos", id: "native-run" };
    const codingHandle = { runId: "coding-run", backend: "docker", id: "job-1" };
    expect(await executor.recover(nativeHandle)).toEqual({ state: "active" });
    expect(await executor.recover(codingHandle)).toEqual({ state: "terminal" });
    expect(native.recover).toHaveBeenCalledWith(nativeHandle);
    expect(coding.recover).toHaveBeenCalledWith(codingHandle);
    expect(coding.recover).not.toHaveBeenCalledWith(nativeHandle);
  });

  it("reports a native handle lost when the native executor cannot recover", async () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      recover: vi.fn(async () => ({ state: "terminal" as const })),
    };
    const executor = new RoutingExecutor({ kindForRun: async () => "native" }, native, coding);

    expect(await executor.recover({ runId: "r", backend: "dbos", id: "r" })).toEqual({
      state: "lost",
      reason: "native_recovery_unavailable",
    });
    expect(coding.recover).not.toHaveBeenCalled();
  });

  it("fans launch and close out to both executors when they implement them", async () => {
    const order: string[] = [];
    const native = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      launch: vi.fn(async () => {
        order.push("native-launch");
      }),
      close: vi.fn(async () => {
        order.push("native-close");
      }),
    };
    const coding = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const executor = new RoutingExecutor({ kindForRun: async () => "native" }, native, coding);

    await executor.launch();
    await executor.close();
    expect(order).toEqual(["native-launch", "native-close"]);
  });

  it("fans warmUp out to both executors when they implement it", async () => {
    const order: string[] = [];
    const native = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      warmUp: vi.fn(async () => {
        order.push("native-warmup");
      }),
    };
    const coding = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      warmUp: vi.fn(async () => {
        order.push("coding-warmup");
      }),
    };
    const executor = new RoutingExecutor({ kindForRun: async () => "native" }, native, coding);

    await executor.warmUp();
    expect(order).toEqual(["native-warmup", "coding-warmup"]);
  });

  it("does nothing for warmUp when neither sub-executor implements it", async () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const executor = new RoutingExecutor({ kindForRun: async () => "native" }, native, coding);

    await expect(executor.warmUp()).resolves.toBeUndefined();
  });

  it("delegates resolveCodingWorkerImage to the coding sub-executor", () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      resolveCodingWorkerImage: vi.fn(() => "sha256:deadbeef".padEnd(71, "0")),
    };
    const executor = new RoutingExecutor({ kindForRun: async () => "coding" }, native, coding);

    expect(
      executor.resolveCodingWorkerImage({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toBe("sha256:deadbeef".padEnd(71, "0"));
  });

  it("throws a clear error if the coding sub-executor doesn't implement resolveCodingWorkerImage", () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const executor = new RoutingExecutor({ kindForRun: async () => "coding" }, native, coding);

    expect(() =>
      executor.resolveCodingWorkerImage({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toThrow(/coding_execution_not_configured/);
  });

  it("delegates the coding-service declaration read and launcher support to the coding sub-executor", async () => {
    const native = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const coding = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      readCodingServiceDeclaration: vi.fn(async () => "services: {}\n"),
      supportsCodingServices: vi.fn((provider: string) => provider === "codex"),
    };
    const executor = new RoutingExecutor({ kindForRun: async () => "coding" }, native, coding);
    await expect(executor.readCodingServiceDeclaration({ repository: "o/r", baseRef: "main" })).resolves.toBe(
      "services: {}\n",
    );
    expect(coding.readCodingServiceDeclaration).toHaveBeenCalledWith({ repository: "o/r", baseRef: "main" });
    expect(executor.supportsCodingServices("codex")).toBe(true);
    expect(coding.supportsCodingServices).toHaveBeenCalledWith("codex");
    expect(executor.supportsCodingServices("claude-code")).toBe(false);
    expect(coding.supportsCodingServices).toHaveBeenCalledWith("claude-code");

    const bare = new RoutingExecutor({ kindForRun: async () => "coding" }, native, native);
    await expect(bare.readCodingServiceDeclaration({ repository: "o/r", baseRef: "main" })).resolves.toBeNull();
    expect(bare.supportsCodingServices("codex")).toBe(false);
  });
});

describe("RoutingExecutor native sandbox routing", () => {
  const fake = (name: string, calls: string[]) => ({
    start: vi.fn(async (runId: string) => {
      calls.push(`${name}.start:${runId}`);
    }),
    stop: vi.fn(async (runId: string) => {
      calls.push(`${name}.stop:${runId}`);
    }),
    recover: vi.fn(async (handle: { runId: string }) => {
      calls.push(`${name}.recover:${handle.runId}`);
      return { state: "active" as const };
    }),
  });
  const targets = new Map<string, ExecutionTarget>([
    ["native-run", "native"],
    ["sandbox-run", "native-sandbox"],
    ["coding-run", "coding"],
  ]);
  const resolver = { kindForRun: async (id: string) => targets.get(id) ?? null };

  it("routes start, stop and recover for a sandbox run to the sandbox executor, and the others unchanged", async () => {
    const calls: string[] = [];
    const executor = new RoutingExecutor(
      resolver,
      fake("native", calls),
      fake("coding", calls),
      fake("sandbox", calls),
    );
    for (const runId of ["native-run", "sandbox-run", "coding-run"]) {
      await executor.start(runId);
      await executor.stop(runId);
      await executor.recover({ runId, backend: "x", id: runId });
    }
    expect(calls).toEqual([
      "native.start:native-run",
      "native.stop:native-run",
      "native.recover:native-run",
      "sandbox.start:sandbox-run",
      "sandbox.stop:sandbox-run",
      "sandbox.recover:sandbox-run",
      "coding.start:coding-run",
      "coding.stop:coding-run",
      "coding.recover:coding-run",
    ]);
  });

  it("without a sandbox executor, sends a sandbox run to the native executor, whose runner refuses it", async () => {
    const calls: string[] = [];
    const executor = new RoutingExecutor(resolver, fake("native", calls), fake("coding", calls));
    await executor.start("sandbox-run");
    await executor.recover({ runId: "sandbox-run", backend: "dbos", id: "sandbox-run" });
    expect(calls).toEqual(["native.start:sandbox-run", "native.recover:sandbox-run"]);
  });

  it("reports a sandbox handle lost when the sandbox executor cannot recover", async () => {
    const calls: string[] = [];
    const sandbox = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const executor = new RoutingExecutor(resolver, fake("native", calls), fake("coding", calls), sandbox);
    expect(await executor.recover({ runId: "sandbox-run", backend: "native-sandbox", id: "sandbox-run" })).toEqual({
      state: "lost",
      reason: "native_sandbox_recovery_unavailable",
    });
    expect(calls).toEqual([]);
  });

  it("runs lifecycle hooks once per distinct executor, even when one fills two roles", async () => {
    const order: string[] = [];
    const native = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      launch: vi.fn(async () => void order.push("native-launch")),
      warmUp: vi.fn(async () => void order.push("native-warmup")),
      close: vi.fn(async () => void order.push("native-close")),
    };
    const sandbox = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      launch: vi.fn(async () => void order.push("sandbox-launch")),
      warmUp: vi.fn(async () => void order.push("sandbox-warmup")),
      close: vi.fn(async () => void order.push("sandbox-close")),
    };
    const executor = new RoutingExecutor(resolver, native, native, sandbox);
    await executor.launch();
    await executor.warmUp();
    await executor.close();
    expect(order).toEqual([
      "native-launch",
      "sandbox-launch",
      "native-warmup",
      "sandbox-warmup",
      "sandbox-close",
      "native-close",
    ]);
  });
});

describe("PrismaExecutionKindResolver", () => {
  const resolverFor = (row: { agent: { kind: string }; nativeExecutionMode: string | null } | null) =>
    new PrismaExecutionKindResolver({ run: { findUnique: async () => row } });

  it("resolves a native run's target from the run's own snapshot, not the agent's current setting", async () => {
    expect(await resolverFor({ agent: { kind: "native" }, nativeExecutionMode: "sandbox" }).kindForRun("r")).toBe(
      "native-sandbox",
    );
    expect(await resolverFor({ agent: { kind: "native" }, nativeExecutionMode: "control_plane" }).kindForRun("r")).toBe(
      "native",
    );
  });

  it("treats a native run with no snapshot (created before the field) as control-plane", async () => {
    expect(await resolverFor({ agent: { kind: "native" }, nativeExecutionMode: null }).kindForRun("r")).toBe("native");
  });

  it("resolves coding runs and unknown runs as before", async () => {
    expect(await resolverFor({ agent: { kind: "coding" }, nativeExecutionMode: null }).kindForRun("r")).toBe("coding");
    expect(await resolverFor(null).kindForRun("r")).toBeNull();
  });
});
