import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { startRouterRun } from "./start.js";

const input = {
  routerAgentId: "r",
  task: "t",
  triggeredById: "p",
  jobId: "j",
  documentIds: [] as string[],
  trigger: "manual" as const,
};

function setup(dispatch: (o: never) => Promise<unknown>) {
  const update = vi.fn(async () => ({}));
  const db = { reviewJob: { update } } as unknown as PrismaClient;
  const run = (extra: Record<string, unknown> = {}) =>
    startRouterRun({ db, executor: {} as never, dispatch: dispatch as never }, { ...input, ...extra });
  return { update, run };
}

describe("startRouterRun job outcomes", () => {
  it("records started with the run", async () => {
    const { update, run } = setup(async () => ({ run: { id: "run-1", status: "pending" } }));
    expect(await run()).toEqual({ runId: "run-1" });
    expect(update).toHaveBeenCalledWith({ where: { id: "j" }, data: { routerRunId: "run-1", outcome: "started" } });
  });

  it("records run_refused and run_failed and keeps the job", async () => {
    for (const status of ["refused", "failed"]) {
      const { update, run } = setup(async () => ({ run: { id: "run-2", status, error: "x" } }));
      expect(await run()).toEqual({ refused: `run_${status}` });
      expect(update).toHaveBeenCalledWith({
        where: { id: "j" },
        data: { routerRunId: "run-2", outcome: `run_${status}` },
      });
    }
  });

  it("records route_failed and rethrows when a check or the dispatch throws", async () => {
    const { update, run } = setup(async () => {
      throw new Error("boom");
    });
    await expect(run()).rejects.toThrow("boom");
    expect(update).toHaveBeenCalledWith({ where: { id: "j" }, data: { outcome: "route_failed" } });
  });

  it("records review_router_invalid when the agent stopped being a router", async () => {
    const { update, run } = setup(async (o: { beforePersist: (t: unknown, a: unknown) => Promise<boolean> }) => {
      expect(await o.beforePersist({}, { router: false })).toBe(false);
      return null;
    });
    expect(await run()).toEqual({ refused: "review_router_invalid" });
    expect(update).toHaveBeenCalledWith({ where: { id: "j" }, data: { outcome: "review_router_invalid" } });
  });
});
