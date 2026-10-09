import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { initialFilters } from "../state/filters";
import { buildGraph } from "./build";
import { layoutGraph } from "./layout";
import { trayServices } from "./services";
import { OUTCOME_SIZE, RUN_WIDTH, TRIGGER_SIZE, runHeight } from "./sizes";

function run(id: string, parentRunId: string | null, startedAt: string): GraphRun {
  return {
    id,
    parentRunId,
    agentId: "a",
    agentName: "A",
    agentKind: "native",
    model: "m",
    codingProvider: null,
    nativeExecutionMode: null,
    warmWorkerName: null,
    declaredServices: [],
    status: "running",
    trigger: { kind: "manual" },
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    budgetUsd: 1,
    startedAt,
    finishedAt: null,
    heartbeatAt: null,
    outcomes: [{ kind: "issue_comment", provider: "jira", issueKey: "K-1", url: null, at: null }],
    services: [],
  } as GraphRun;
}

const graph = buildGraph(
  [
    run("p", null, "2026-01-01T00:00:00.000Z"),
    run("c", "p", "2026-01-01T00:01:00.000Z"),
    run("q", null, "2026-01-02T00:00:00.000Z"),
  ],
  initialFilters,
  null,
);

describe("layoutGraph", () => {
  it("positions every node, children right of parents", async () => {
    const pos = await layoutGraph(graph);
    for (const n of graph.nodes) expect(pos.get(n.id)).toBeDefined();
    expect(pos.get("r:c")!.x).toBeGreaterThan(pos.get("r:p")!.x);
    expect(pos.get("r:p")!.x).toBeGreaterThan(pos.get("t:p")!.x);
    expect(pos.get("o:p:0")!.x).toBeGreaterThan(pos.get("r:p")!.x);
  });

  it("stacks run trees vertically, newest first, without overlap", async () => {
    const pos = await layoutGraph(graph);
    const boxes = new Map<string, { top: number; bottom: number; left: number }>();
    for (const n of graph.nodes) {
      const p = pos.get(n.id)!;
      const h =
        n.data.kind === "trigger"
          ? TRIGGER_SIZE.height
          : n.data.kind === "outcome"
            ? OUTCOME_SIZE.height
            : runHeight(trayServices(n.data.run).length);
      const root = n.id.startsWith("t:") ? n.id.slice(2) : n.id.startsWith("r:") ? n.id.slice(2) : n.id.split(":")[1];
      const tree = root === "c" ? "p" : root;
      const b = boxes.get(tree) ?? { top: Infinity, bottom: -Infinity, left: Infinity };
      boxes.set(tree, { top: Math.min(b.top, p.y), bottom: Math.max(b.bottom, p.y + h), left: Math.min(b.left, p.x) });
    }
    const q = boxes.get("q")!;
    const p = boxes.get("p")!;
    expect(RUN_WIDTH).toBe(240);
    expect(q.left).toBe(0);
    expect(p.left).toBe(0);
    expect(q.top).toBeLessThan(p.top);
    expect(q.bottom).toBeLessThanOrEqual(p.top);
  });

  it("lays out a pull-request chain as one tree", async () => {
    const at = (n: number) => new Date(Date.UTC(2026, 9, 6, 10, n)).toISOString();
    const pr = {
      kind: "pull_request",
      provider: "github",
      repository: "o/r",
      number: 6,
      url: "https://github.com/o/r/pull/6",
      state: "open",
      at: null,
    } as const;
    const review = { kind: "code_host", provider: "github", repository: "o/r", number: 6, event: "review" } as const;
    const chained = buildGraph(
      [
        { ...run("build", null, at(0)), outcomes: [pr] },
        { ...run("rev", null, at(5)), trigger: review, outcomes: [] },
        run("other", null, at(9)),
      ] as GraphRun[],
      initialFilters,
      null,
    );
    const pos = await layoutGraph(chained);
    // The review sits right of the PR box it links from, in the same band; the unrelated tree is stacked apart.
    expect(pos.get("r:rev")!.x).toBeGreaterThan(pos.get("o:build:0")!.x);
    const other = pos.get("r:other")!.y;
    const band = [pos.get("r:build")!.y, pos.get("r:rev")!.y];
    expect(band.every((y) => y > other) || band.every((y) => y < other)).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await layoutGraph(graph);
    const b = await layoutGraph(graph);
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("handles an empty graph", async () => {
    expect((await layoutGraph({ nodes: [], edges: [] })).size).toBe(0);
  });
});
