import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../providers/executor/types.js";

const logs = vi.hoisted(() => [] as unknown[][]);
vi.mock("./logger.js", () => {
  const sink = {
    error: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    info: (...a: unknown[]) => logs.push(a),
    debug: () => {},
  };
  return { logger: { child: () => sink, ...sink } };
});
vi.mock("./self-defects.js", () => ({ fileSelfDefect: vi.fn(async () => null) }));
vi.mock("./workflow-run-events.js", () => ({ emitRunFinishedEvents: vi.fn(async () => undefined) }));
import { fileSelfDefect } from "./self-defects.js";
import { emitRunFinishedEvents } from "./workflow-run-events.js";
import {
  FOLLOW_UP_KINDS,
  LOST_RUN_FOLLOW_UP_KINDS,
  buildRunFollowUpHandlers,
  enqueueLostRunFollowUps,
  runFollowUpHandlersFor,
} from "./run-follow-up-handlers.js";

const FAKE_SECRET = "ghp_fake_secret_value";

function context(runId = "r1") {
  return { runId, kind: "test", payload: {}, attempt: 1, signal: new AbortController().signal };
}

function fakeDb(children: { id: string; status: string }[] = [], run: Record<string, unknown> | null = null) {
  return {
    run: {
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(async () => children.filter((child) => child.status === "pending").map(({ id }) => ({ id }))),
      count: vi.fn(async () => children.filter((child) => child.status === "pending").length),
    },
  } as any;
}

beforeEach(() => {
  logs.length = 0;
  vi.mocked(fileSelfDefect).mockClear();
  vi.mocked(emitRunFinishedEvents).mockClear();
});

describe("enqueueLostRunFollowUps", () => {
  it("queues the three chores of a lost run, in order, with ids only", async () => {
    const createMany = vi.fn(async (_arg: { data: unknown[] }) => ({ count: 1 }));

    await enqueueLostRunFollowUps({ runFollowUp: { createMany } } as never, "r1");

    expect(createMany.mock.calls.map(([arg]) => arg.data)).toEqual([
      [{ runId: "r1", kind: "stop_children", payload: {} }],
      [{ runId: "r1", kind: "self_defect", payload: {} }],
      [{ runId: "r1", kind: "run_finished_events", payload: {} }],
    ]);
    expect(LOST_RUN_FOLLOW_UP_KINDS).toEqual(["stop_children", "self_defect", "run_finished_events"]);
  });

  it("queues nothing when the transaction's insert fails, so the status write can roll back with it", async () => {
    const createMany = vi.fn(async () => {
      throw new Error("insert failed");
    });
    await expect(enqueueLostRunFollowUps({ runFollowUp: { createMany } } as never, "r1")).rejects.toThrow(
      "insert failed",
    );
  });
});

describe("stop_children", () => {
  const handler = (deps: Parameters<typeof buildRunFollowUpHandlers>[0]) =>
    buildRunFollowUpHandlers(deps)[FOLLOW_UP_KINDS.stopChildren];

  it("stops the drivable children with the parent-lost reason", async () => {
    const children = [{ id: "c1", status: "pending" }];
    const stop = vi.fn(async (id: string) => {
      children.find((child) => child.id === id)!.status = "cancelled";
    });

    await handler({ db: fakeDb(children), executor: { stop } })(context());

    expect(stop).toHaveBeenCalledWith("c1", "parent run lost");
  });

  it("is safe to run again: a second run finds nothing to stop", async () => {
    const children = [{ id: "c1", status: "pending" }];
    const stop = vi.fn(async (id: string) => {
      children.find((child) => child.id === id)!.status = "cancelled";
    });
    const run = handler({ db: fakeDb(children), executor: { stop } });

    await run(context());
    await run(context());

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("fails while a child is still drivable, so the drain retries it", async () => {
    const stop = vi.fn(async () => {
      throw new Error(`executor said ${FAKE_SECRET}`);
    });

    const failure = (await handler({ db: fakeDb([{ id: "c1", status: "pending" }]), executor: { stop } })(
      context(),
    ).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;

    expect(failure).toMatchObject({ name: "ChildrenStillDrivable" });
    expect(failure.message).not.toContain(FAKE_SECRET);
    // The executor's own error text (it could carry a secret) reaches neither the thrown error nor a log.
    expect(JSON.stringify(logs)).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(logs)).toContain("could not stop a child of a lost run");
  });

  it("does nothing without an executor", async () => {
    const db = fakeDb([{ id: "c1", status: "pending" }]);
    await handler({ db })(context());
    expect(db.run.findMany).not.toHaveBeenCalled();
  });
});

describe("self_defect", () => {
  const row = { id: "r1", agentId: "a1", status: "lost", error: "x", finishedAt: new Date() };

  it("files the defect for the run's final row, waiting inside the handler timeout", async () => {
    const trackers = { jira: {} } as never;
    await buildRunFollowUpHandlers({ db: fakeDb([], row), issueTrackers: trackers })[FOLLOW_UP_KINDS.selfDefect](
      context(),
    );
    expect(fileSelfDefect).toHaveBeenCalledWith(expect.anything(), trackers, row, { waitMs: 90_000 });
  });

  it("does nothing for a run that no longer exists", async () => {
    await buildRunFollowUpHandlers({ db: fakeDb([], null) })[FOLLOW_UP_KINDS.selfDefect](context());
    expect(fileSelfDefect).not.toHaveBeenCalled();
  });
});

describe("run_finished_events", () => {
  it("emits the events for the run's final row", async () => {
    const row = { id: "r1", agentId: "a1", status: "lost", error: "x", parentRunId: null };
    await buildRunFollowUpHandlers({ db: fakeDb([], row) })[FOLLOW_UP_KINDS.runFinishedEvents](context());
    expect(emitRunFinishedEvents).toHaveBeenCalledWith(expect.anything(), row);
  });

  it("does nothing for a run that no longer exists", async () => {
    await buildRunFollowUpHandlers({ db: fakeDb([], null) })[FOLLOW_UP_KINDS.runFinishedEvents](context());
    expect(emitRunFinishedEvents).not.toHaveBeenCalled();
  });
});

describe("runFollowUpHandlersFor", () => {
  it("adds the executor's own chores to the shared ones", () => {
    const own = vi.fn(async () => undefined);
    const executor = { followUpHandlers: () => ({ coding_run_host_notify: own }) } as unknown as Executor;

    const handlers = runFollowUpHandlersFor({ db: fakeDb(), executor });

    expect(Object.keys(handlers).sort()).toEqual(
      ["coding_run_host_notify", "run_finished_events", "self_defect", "stop_children"].sort(),
    );
  });

  it("is just the shared chores for an executor with none", () => {
    expect(Object.keys(runFollowUpHandlersFor({ db: fakeDb(), executor: {} as Executor })).sort()).toEqual(
      ["run_finished_events", "self_defect", "stop_children"].sort(),
    );
  });
});
