import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitRunFinishedEvents } from "./workflow-run-events.js";
import { setWorkflowEventSink, type WorkflowEventInput } from "./workflow-events.js";

const db = (check: unknown = null) => ({
  agent: { findUnique: vi.fn(async () => ({ name: "lead" })) },
  runHostCheck: { findUnique: vi.fn(async () => check) },
});
const run = { id: "r1", agentId: "a1", status: "failed", error: "boom\ntrace", parentRunId: null };

describe("emitRunFinishedEvents", () => {
  const events: WorkflowEventInput[] = [];
  beforeEach(() => {
    events.length = 0;
    setWorkflowEventSink(async (e) => {
      events.push(e);
    });
  });
  afterEach(() => setWorkflowEventSink(null));

  it("emits run_failed for a failed top-level run", async () => {
    await emitRunFinishedEvents(db() as never, run);
    expect(events).toEqual([
      {
        dedupeKey: "run_failed:r1",
        runId: "r1",
        agentId: "a1",
        payload: { kind: "run_failed", agentName: "lead", status: "failed", reason: "boom" },
      },
    ]);
  });
  it("emits run_failed for a top-level run refused before any LLM call", async () => {
    await emitRunFinishedEvents(db() as never, {
      ...run,
      status: "refused",
      error: "Estimated input cost meets budget",
    });
    expect(events).toEqual([
      {
        dedupeKey: "run_failed:r1",
        runId: "r1",
        agentId: "a1",
        payload: {
          kind: "run_failed",
          agentName: "lead",
          status: "refused",
          reason: "Estimated input cost meets budget",
        },
      },
    ]);
  });
  it("skips child runs and successes", async () => {
    await emitRunFinishedEvents(db() as never, { ...run, parentRunId: "p" });
    await emitRunFinishedEvents(db() as never, { ...run, status: "succeeded" });
    expect(events).toEqual([]);
  });
  it("emits review_posted when the run published a verdict", async () => {
    const check = {
      provider: "github",
      repository: "acme/api",
      prNumber: 12,
      verdict: "APPROVE",
      ciPendingAtReview: false,
    };
    await emitRunFinishedEvents(db(check) as never, { ...run, status: "succeeded" });
    expect(events).toEqual([
      {
        dedupeKey: "review_posted:r1",
        runId: "r1",
        agentId: "a1",
        pullRequest: { codeProvider: "github", repository: "acme/api", number: 12 },
        payload: {
          kind: "review_posted",
          agentName: "lead",
          verdict: "APPROVE",
          prLabel: "acme/api#12",
          prUrl: "https://github.com/acme/api/pull/12",
          ciPending: false,
        },
      },
    ]);
  });
  describe("packages_audited", () => {
    const auditDb = (rows: unknown[], modes: (string | null)[] = ["audit"]) => ({
      ...db(),
      run: {
        findMany: vi.fn(async () =>
          modes.map((packageAuditMode, i) => ({
            id: `c${i}`,
            status: "succeeded",
            error: null,
            codingRun: { result: null, failureCategory: null, services: [], packageAuditMode },
          })),
        ),
      },
      registryFetch: { findMany: vi.fn(async () => []) },
      registryAuditRecord: { findMany: vi.fn(async () => rows) },
    });
    const row = (name: string, relation: string, extra: Record<string, unknown> = {}) => ({
      ecosystem: "npm",
      name,
      version: "1.0.0",
      relation,
      via: null,
      sizeBytes: 1,
      advisories: [],
      ...extra,
    });
    const audited = (e: WorkflowEventInput) => e.payload.kind === "packages_audited";

    it("emits once for a top-level run whose coding children recorded anything, whatever its status", async () => {
      const rows = [
        row("expo-dev-client", "top-level"),
        row("expo-dev-launcher", "transitive", { via: "expo-dev-client" }),
        row("lodash", "allowed", { advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "" }] }),
      ];
      for (const status of ["succeeded", "failed"]) {
        events.length = 0;
        await emitRunFinishedEvents(auditDb(rows, ["audit", "full"]) as never, { ...run, status });
        expect(events.filter(audited)).toEqual([
          {
            dedupeKey: "packages_audited:r1",
            runId: "r1",
            agentId: "a1",
            payload: {
              kind: "packages_audited",
              agentName: "lead",
              mode: "full",
              toApprove: [{ ecosystem: "npm", name: "expo-dev-client" }],
              moreToApprove: 0,
              transitive: 1,
              advisories: 1,
            },
          },
        ]);
      }
    });

    it("emits nothing when nothing was recorded, or for a child run", async () => {
      await emitRunFinishedEvents(auditDb([]) as never, { ...run, status: "succeeded" });
      await emitRunFinishedEvents(auditDb([row("x", "top-level")]) as never, { ...run, parentRunId: "p" });
      expect(events.filter(audited)).toEqual([]);
    });
  });

  it("never throws", async () => {
    const broken = {
      agent: {
        findUnique: vi.fn(async () => {
          throw new Error("x");
        }),
      },
      runHostCheck: { findUnique: vi.fn() },
    };
    await expect(emitRunFinishedEvents(broken as never, run)).resolves.toBeUndefined();
  });
});
