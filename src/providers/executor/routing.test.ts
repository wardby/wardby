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
});
