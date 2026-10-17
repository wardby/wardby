import { describe, expect, it, vi } from "vitest";
import { headStoppedAtBudget, lastPusher, pushingRunInFlight } from "./budget-stopped-head.js";

const ROOT_SHA = "a".repeat(40);
const LATER_SHA = "b".repeat(40);
const CONT_SHA = "c".repeat(40);

const opened = (commitSha: string, pullRequestNumber = 7) => ({
  outcome: "pull_request_opened",
  repository: "acme/web",
  pullRequestNumber,
  pullRequestUrl: `https://github.com/acme/web/pull/${pullRequestNumber}`,
  commitSha,
});
const updated = (commitSha: string) => ({ ...opened(commitSha), outcome: "pull_request_updated" });

interface Row {
  runId: string;
  repository?: string;
  rootCodingRunId: string | null;
  result: unknown;
  run: { status: string } | null;
}

function db(
  rows: Row[],
  continuations: Array<{ result: unknown; run: { status: string } | null }> = [],
  inFlight: { runId: string } | null = null,
) {
  return {
    codingRun: {
      findFirst: vi.fn(async (_args: unknown) => inFlight),
      findUnique: vi.fn(
        async (args: { where: { runId: string } }) => rows.find((r) => r.runId === args.where.runId) ?? null,
      ),
      findMany: vi.fn(async (_args: unknown) => continuations),
    },
  };
}

const root = (over: Partial<Row> = {}): Row => ({
  runId: "root",
  repository: "acme/web",
  rootCodingRunId: null,
  result: opened(ROOT_SHA),
  run: { status: "budget_exhausted" },
  ...over,
});

const check = (
  d: ReturnType<typeof db>,
  headSha: string,
  over: { markerRunId?: string | null; prNumber?: number; repository?: string } = {},
) =>
  headStoppedAtBudget(d as never, {
    markerRunId: "markerRunId" in over ? over.markerRunId : "root",
    repository: over.repository ?? "ACME/Web",
    prNumber: over.prNumber ?? 7,
    headSha,
  });

describe("headStoppedAtBudget", () => {
  it("is true for a head that is the budget-stopped root's own push", async () => {
    const d = db([root()]);
    expect(await check(d, ROOT_SHA)).toBe(true);
    expect(d.codingRun.findMany).toHaveBeenCalledWith({
      where: { rootCodingRunId: "root" },
      select: { result: true, run: { select: { status: true } } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("is false once a later commit (a person's push) is the head", async () => {
    expect(await check(db([root()]), LATER_SHA)).toBe(false);
  });

  it("is false when the last pusher is a continuation that finished", async () => {
    const d = db([root()], [{ result: updated(CONT_SHA), run: { status: "succeeded" } }]);
    expect(await check(d, CONT_SHA)).toBe(false);
    expect(await check(d, ROOT_SHA)).toBe(false);
  });

  it("is true when the last pusher is a continuation that stopped at its budget at that head", async () => {
    const d = db(
      [root({ run: { status: "succeeded" } })],
      [
        { result: { outcome: "no_changes" }, run: { status: "succeeded" } },
        { result: updated(CONT_SHA), run: { status: "budget_exhausted" } },
        { result: updated(ROOT_SHA), run: { status: "succeeded" } },
      ],
    );
    expect(await check(d, CONT_SHA)).toBe(true);
  });

  it("resolves a continuation's marker to its root", async () => {
    const d = db(
      [
        root(),
        { runId: "cont", rootCodingRunId: "root", result: updated(CONT_SHA), run: { status: "budget_exhausted" } },
      ],
      [{ result: updated(CONT_SHA), run: { status: "budget_exhausted" } }],
    );
    expect(await check(d, CONT_SHA, { markerRunId: "cont" })).toBe(true);
    expect(d.codingRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { rootCodingRunId: "root" } }));
  });

  it("is false with no marker, an unknown run, a missing root, or another pull request", async () => {
    expect(await check(db([root()]), ROOT_SHA, { markerRunId: undefined })).toBe(false);
    expect(await check(db([root()]), ROOT_SHA, { markerRunId: null })).toBe(false);
    expect(await check(db([root()]), ROOT_SHA, { markerRunId: "unknown" })).toBe(false);
    expect(await check(db([root({ runId: "cont", rootCodingRunId: "gone" })]), ROOT_SHA, { markerRunId: "cont" })).toBe(
      false,
    );
    expect(await check(db([root()]), ROOT_SHA, { prNumber: 8 })).toBe(false);
  });

  it("is false when the root coding run is in another repository", async () => {
    expect(await check(db([root()]), ROOT_SHA, { repository: "acme/other" })).toBe(false);
  });

  it("is false (review as usual) when a lookup fails", async () => {
    const d = db([root()]);
    d.codingRun.findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await check(d, ROOT_SHA)).toBe(false);
  });
});

describe("lastPusher", () => {
  it("is the root when no continuation pushed to the pull request", async () => {
    const d = db([], [{ result: opened(CONT_SHA, 8), run: { status: "succeeded" } }]);
    expect(await lastPusher(d as never, root(), 7)).toEqual({ status: "budget_exhausted", commitSha: ROOT_SHA });
  });

  it("is undefined fields for a root without a run or a commit", async () => {
    expect(await lastPusher(db([]) as never, { runId: "root", result: null, run: null }, 7)).toEqual({
      status: undefined,
      commitSha: undefined,
    });
  });
});

describe("pushingRunInFlight", () => {
  const inFlight = (d: ReturnType<typeof db>, markerRunId: string | null = "root", repository = "acme/web") =>
    pushingRunInFlight(d as never, { markerRunId, repository });

  it("is the root while it is pending or running", async () => {
    for (const status of ["pending", "running"]) {
      const d = db([root({ result: null, run: { status } })]);
      expect(await inFlight(d)).toBe("root");
      expect(d.codingRun.findFirst).not.toHaveBeenCalled();
    }
  });

  it("is the newest continuation in flight once the root finished", async () => {
    const d = db([root()], [], { runId: "cont" });
    expect(await inFlight(d)).toBe("cont");
    expect(d.codingRun.findFirst).toHaveBeenCalledWith({
      where: { rootCodingRunId: "root", run: { status: { in: ["pending", "running"] } } },
      select: { runId: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("is null when nothing is in flight, with no marker, or for another repository", async () => {
    expect(await inFlight(db([root()]))).toBeNull();
    expect(await inFlight(db([root()]), null)).toBeNull();
    expect(await inFlight(db([root({ run: { status: "running" } })]), "root", "acme/other")).toBeNull();
  });
});
