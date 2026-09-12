import { describe, expect, it, vi } from "vitest";
import { RoutingExecutor } from "./routing.js";

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
});
