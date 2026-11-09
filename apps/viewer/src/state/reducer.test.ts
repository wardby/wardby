import { describe, expect, it } from "vitest";
import type { GraphRun, GraphSnapshot, ViewerEvent } from "../api/types";
import { initialModel, reduce, type ViewerModel } from "./reducer";

function makeRun(id: string, overrides: Partial<GraphRun> = {}): GraphRun {
  return {
    id,
    parentRunId: null,
    agentId: "agent-1",
    agentName: "Triage",
    agentKind: "native",
    status: "running",
    turns: 1,
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.01,
    finishedAt: null,
    outcomes: [],
    services: [
      {
        name: "db",
        state: "pending",
        attempts: null,
        reason: "r",
        readyAt: null,
        failedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as GraphRun;
}

function makeSnapshot(runs: GraphRun[], truncated = false): GraphSnapshot {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    since: "2025-12-31T00:00:00.000Z",
    limit: 100,
    truncated,
    runs,
    spend: { todayUsd: 1.5, groups: [] },
  } as GraphSnapshot;
}

function deepFreeze(model: ViewerModel): ViewerModel {
  for (const run of model.runs.values()) {
    for (const s of run.services) Object.freeze(s);
    Object.freeze(run.services);
    Object.freeze(run.outcomes);
    Object.freeze(run);
  }
  Object.freeze(model.ticker);
  return Object.freeze(model);
}

const stepEvent = (runId = "run-abcdef123456"): ViewerEvent => ({
  kind: "step",
  runId,
  seq: 1,
  stepKind: "tool",
  tool: "Bash",
  summary: "npm test",
  status: null,
  at: "2026-01-01T00:00:00.000Z",
});

const loaded = (runs: GraphRun[] = [makeRun("run-abcdef123456")]) =>
  reduce(initialModel, { type: "snapshot", snapshot: makeSnapshot(runs) });

const runEvent = (over: Partial<Extract<ViewerEvent, { kind: "run" }>> = {}): ViewerEvent => ({
  kind: "run",
  runId: "run-abcdef123456",
  parentRunId: "parent-1",
  agentId: "agent-1",
  status: "succeeded",
  turns: 3,
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.456,
  finishedAt: "2026-01-01T00:05:00.000Z",
  ...over,
});

describe("reduce", () => {
  it("snapshot replaces runs, spend and truncated", () => {
    const stale = { ...initialModel, runs: new Map([["old", makeRun("old")]]) };
    const next = reduce(stale, { type: "snapshot", snapshot: makeSnapshot([makeRun("a"), makeRun("b")], true) });
    expect([...next.runs.keys()]).toEqual(["a", "b"]);
    expect(next.spend).toEqual({ todayUsd: 1.5, groups: [] });
    expect(next.truncated).toBe(true);
  });

  it("run event on a known run merges fields", () => {
    const next = reduce(loaded(), { type: "event", event: runEvent(), at: 1 });
    const run = next.runs.get("run-abcdef123456")!;
    expect(run).toMatchObject({
      status: "succeeded",
      turns: 3,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.456,
      finishedAt: "2026-01-01T00:05:00.000Z",
      parentRunId: "parent-1",
      agentName: "Triage",
    });
  });

  it("run event on an unknown run leaves the runs alone (the hook refetches)", () => {
    const before = loaded();
    const next = reduce(before, { type: "event", event: runEvent({ runId: "zzz-unknown" }), at: 1 });
    expect(next.runs).toBe(before.runs);
    expect(next.runs.has("zzz-unknown")).toBe(false);
  });

  it("service event upserts an existing service by name, keeping other fields", () => {
    const event: ViewerEvent = { kind: "service", runId: "run-abcdef123456", name: "db", state: "ready", attempts: 2 };
    const svc = reduce(loaded(), { type: "event", event, at: 1 }).runs.get("run-abcdef123456")!.services;
    expect(svc).toHaveLength(1);
    expect(svc[0]).toMatchObject({ name: "db", state: "ready", attempts: 2, reason: "r" });
  });

  it("service event adds a new service with null fields and createdAt from at", () => {
    const at = Date.UTC(2026, 5, 1);
    const event: ViewerEvent = {
      kind: "service",
      runId: "run-abcdef123456",
      name: "cache",
      state: "probing",
      attempts: 1,
    };
    const svc = reduce(loaded(), { type: "event", event, at }).runs.get("run-abcdef123456")!.services;
    expect(svc).toHaveLength(2);
    expect(svc[1]).toEqual({
      name: "cache",
      state: "probing",
      attempts: 1,
      reason: null,
      readyAt: null,
      failedAt: null,
      createdAt: new Date(at).toISOString(),
    });
  });

  it("service event on an unknown run leaves the runs alone", () => {
    const before = loaded();
    const event: ViewerEvent = { kind: "service", runId: "nope", name: "db", state: "ready", attempts: 1 };
    expect(reduce(before, { type: "event", event, at: 1 }).runs).toBe(before.runs);
  });

  it("outcome event leaves the runs alone but is shown in the ticker", () => {
    const before = loaded();
    const event: ViewerEvent = { kind: "outcome", runId: "run-abcdef123456", source: "pull_request" };
    const next = reduce(before, { type: "event", event, at: 1 });
    expect(next.runs).toBe(before.runs);
    expect(next.ticker).toHaveLength(1);
  });

  it("ignores malformed events instead of throwing", () => {
    const before = loaded();
    const bad: unknown[] = [
      null,
      undefined,
      "run",
      42,
      {},
      { kind: "mystery", runId: "run-abcdef123456" },
      { kind: "run" },
      { kind: "run", runId: 7 },
      { ...runEvent(), turns: "3" },
      { ...runEvent(), costUsd: null },
      { ...runEvent(), status: undefined },
      { ...runEvent(), finishedAt: 5 },
      { kind: "service", runId: "run-abcdef123456", name: "db" },
      { kind: "service", runId: "run-abcdef123456", name: "db", state: "ready", attempts: "2" },
      { kind: "outcome", runId: "run-abcdef123456" },
    ];
    for (const event of bad) {
      const next = reduce(before, { type: "event", event: event as ViewerEvent, at: 1 });
      expect(next, JSON.stringify(event)).toBe(before);
    }
  });

  it("pushes ticker lines for each event kind", () => {
    let m = loaded();
    m = reduce(m, { type: "event", event: runEvent(), at: 10 });
    m = reduce(m, {
      type: "event",
      event: { kind: "service", runId: "run-abcdef123456", name: "db", state: "ready", attempts: 1 },
      at: 20,
    });
    m = reduce(m, {
      type: "event",
      event: { kind: "outcome", runId: "run-abcdef123456", source: "host_status" },
      at: 30,
    });
    expect(m.ticker).toEqual([
      { at: 30, text: "123456 host status" },
      { at: 20, text: "123456 db ready" },
      { at: 10, text: "123456 succeeded · turn 3 · $0.46" },
    ]);
  });

  it("prefixes run ticker lines with the agent name when known", () => {
    const m = reduce(loaded(), {
      type: "event",
      event: runEvent(),
      at: 1,
      agentName: (id) => (id === "agent-1" ? "Triage" : undefined),
    });
    expect(m.ticker[0]!.text).toBe("Triage 123456 succeeded · turn 3 · $0.46");
  });

  it("caps the ticker at 50, newest first", () => {
    let m = loaded();
    for (let i = 0; i < 60; i++) m = reduce(m, { type: "event", event: runEvent({ turns: i }), at: i });
    expect(m.ticker).toHaveLength(50);
    expect(m.ticker[0]!.at).toBe(59);
    expect(m.ticker[49]!.at).toBe(10);
  });

  it("status sets live", () => {
    expect(reduce(initialModel, { type: "status", connected: true }).live).toBe(true);
    expect(reduce({ ...initialModel, live: true }, { type: "status", connected: false }).live).toBe(false);
  });

  it("reset returns the initial model", () => {
    expect(reduce(loaded(), { type: "reset" })).toBe(initialModel);
  });

  it("never mutates its input", () => {
    const model = deepFreeze(loaded([makeRun("run-abcdef123456"), makeRun("other-1")]));
    const before = structuredClone(model);
    const originalRuns = model.runs;
    const originalRun = model.runs.get("run-abcdef123456");
    const events: ViewerEvent[] = [
      runEvent(),
      { kind: "service", runId: "run-abcdef123456", name: "db", state: "ready", attempts: 2 },
      { kind: "service", runId: "run-abcdef123456", name: "new", state: "ready", attempts: 2 },
      { kind: "outcome", runId: "run-abcdef123456", source: "pull_request" },
      runEvent({ runId: "unknown" }),
    ];
    for (const event of events) {
      const next = reduce(model, { type: "event", event, at: 1 });
      expect(next).not.toBe(model);
    }
    reduce(model, { type: "snapshot", snapshot: makeSnapshot([]) });
    reduce(model, { type: "status", connected: true });
    expect(model.runs).toBe(originalRuns);
    expect(model.runs.get("run-abcdef123456")).toBe(originalRun);
    expect(model).toEqual(before);
    expect(model.runs.size).toBe(2);
  });

  it("a step event counts a change for its known run, without a ticker line", () => {
    const model = deepFreeze(loaded());
    const next = reduce(model, { type: "event", event: stepEvent(), at: 1 });
    expect(next.stepChanges.get("run-abcdef123456")).toBe(1);
    expect(reduce(next, { type: "event", event: stepEvent(), at: 2 }).stepChanges.get("run-abcdef123456")).toBe(2);
    expect(next.ticker).toEqual(model.ticker);
    expect(next.runs).toBe(model.runs);
  });

  it("a step event for an unknown run changes nothing, and a malformed one is dropped", () => {
    const model = loaded();
    expect(reduce(model, { type: "event", event: stepEvent("other"), at: 1 })).toBe(model);
    const bad = { ...stepEvent(), seq: "1" } as unknown as ViewerEvent;
    expect(reduce(model, { type: "event", event: bad, at: 1 })).toBe(model);
  });
});
