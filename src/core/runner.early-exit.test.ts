import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import type { CatalogLlmAdapter } from "../providers/llm/routing.js";
import { RoutingLlmProvider } from "../providers/llm/routing.js";
import type { IssueTracker } from "../providers/issue-tracker/types.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { Engine } from "../providers/engine/types.js";
import { executeRun, type RunnerDb } from "./runner.js";

// A run that ends in the runner before its engine starts (its model is
// unavailable, or it is a coding run with no container executor) must still
// close what its trigger opened: the review check, the host status comment
// and the issue status comment. The three finalisers are spied on here; their
// own behaviour is covered by review-host-checks / host-status / issue-status tests.
const finalisers = vi.hoisted(() => ({
  closeOpenHostCheck: vi.fn(async () => undefined),
  completeHostStatus: vi.fn(async () => undefined),
  completeIssueStatus: vi.fn(async () => undefined),
}));
vi.mock("./review-host-checks.js", () => ({ closeOpenHostCheck: finalisers.closeOpenHostCheck }));
vi.mock("./host-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./host-status.js")>()),
  completeHostStatus: finalisers.completeHostStatus,
}));
vi.mock("./issue-status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./issue-status.js")>()),
  completeIssueStatus: finalisers.completeIssueStatus,
}));

const host = { provider: "github" } as unknown as CodeReviewHost;
const tracker = { provider: "jira" } as unknown as IssueTracker;

function harness(agent: Record<string, unknown>) {
  const runs = new Map<string, any>([
    [
      "run1",
      {
        id: "run1",
        agentId: "a1",
        status: "pending",
        trigger: "host_event",
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
        finalText: null,
        turns: 0,
        parentRunId: null,
        taskOverride: null,
        pricingVersion: null,
        pricingSnapshot: null,
      },
    ],
  ]);
  const db: any = {
    agent: { findUnique: async ({ where }: any) => (where.id === agent.id ? agent : null) },
    run: {
      findUnique: async ({ where }: any) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => runs.get(where.id),
      updateMany: async ({ where, data }: any) => {
        const record = runs.get(where.id);
        if (!record || (where.status && !where.status.in.includes(record.status))) return { count: 0 };
        runs.set(where.id, { ...record, ...data });
        return { count: 1 };
      },
      findMany: async () => [],
    },
    agentTool: { findMany: async () => [] },
    agentSecret: { findMany: async () => [] },
    budgetGroup: { findUnique: async () => null },
    agentSubAgent: { findMany: async () => [] },
    agentRepository: { findMany: async () => [] },
    agentIssueProject: { findMany: async () => [] },
  };
  return db as RunnerDb;
}

function providers() {
  const adapter: CatalogLlmAdapter = {
    async *stream() {
      yield { type: "done", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async countTokens() {
      return 1;
    },
    priceUsd() {
      return 0;
    },
    withEntry: () => adapter,
  };
  const engine: Engine = { run: vi.fn() };
  return {
    llm: new RoutingLlmProvider([{ provider: "anthropic", adapter }]),
    engine,
    datastore: {} as Datastore,
    secrets: {} as SecretCipher,
    memory: {} as AgentMemoryStore,
    reviewHosts: { github: host },
    issueTrackers: { jira: tracker },
  };
}

function expectFinalised(run: { id: string; status: string }) {
  for (const finaliser of Object.values(finalisers)) {
    expect(finaliser).toHaveBeenCalledTimes(1);
    expect(finaliser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: run.id, status: "failed" }),
      expect.anything(),
    );
  }
}

describe("runs that end before the engine starts still close their host and issue status", () => {
  beforeEach(() => {
    for (const finaliser of Object.values(finalisers)) finaliser.mockClear();
  });

  it("a native run whose model is unavailable (model_unavailable)", async () => {
    const db = harness({ id: "a1", name: "reviewer", kind: "native", model: "not-a-model", budgetUsd: 10 });
    const p = providers();

    const run = await executeRun("run1", p, db);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/^model_unavailable: .*reason: not_in_catalog/);
    expect(p.engine.run).not.toHaveBeenCalled();
    expectFinalised(run);
  });

  it("a coding run in a process with no container executor", async () => {
    const db = harness({ id: "a1", name: "coder", kind: "coding", model: "gpt-5.6-luna", budgetUsd: 10 });
    const p = providers();

    const run = await executeRun("run1", p, db);

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/container executor/);
    expectFinalised(run);
  });
});
