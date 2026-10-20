/**
 * An in-memory BudgetGroupsDb answering exactly the queries budget-groups.ts makes, shared by its
 * unit tests and the release suite's model-based budget property (src/release/budget.release.test.ts).
 */
import type { BudgetGroupsDb } from "./budget-groups.js";

export interface FakeRun {
  id?: string;
  agentId: string;
  costUsd: number;
  startedAt: Date;
  parentRunId?: string | null;
  /** Defaults to a finished run. */
  status?: string;
  /** Defaults to `now`: a live run. */
  heartbeatAt?: Date | null;
  codingRun?: { budgetReservedUsd: number; timeoutSec?: number } | null;
}
export interface FakeGroup {
  id: string;
  name: string;
  dailyBudgetUsd: number | null;
  weeklyBudgetUsd: number | null;
  monthlyBudgetUsd: number | null;
  warnThresholdRatio: number;
  agentIds: string[];
}
export interface FakeAgent {
  id: string;
  budgetGroupId: string | null;
  budgetUsd: number;
  allowedOverrunPercent?: number;
}

/** A snapshot of `groups`, `runs` and `agents`: build a new one after the world changes. */
export function fakeBudgetDb(groups: FakeGroup[], runs: FakeRun[], agents: FakeAgent[], now: Date): BudgetGroupsDb {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const withDefaults = runs.map((r) => ({
    status: "succeeded",
    heartbeatAt: now,
    ...r,
    codingRun: r.codingRun ? { timeoutSec: 1800, ...r.codingRun } : null,
  }));
  const runsById = new Map(withDefaults.filter((r) => r.id).map((r) => [r.id!, r]));
  return {
    budgetGroup: {
      findUnique: (async ({ where }: { where: { id: string } }) => {
        const g = byId.get(where.id);
        if (!g) return null;
        return { ...g, agents: g.agentIds.map((id) => ({ id, budgetUsd: agentsById.get(id)?.budgetUsd ?? 0 })) };
      }) as never,
    },
    agent: {
      findUniqueOrThrow: (async ({ where }: { where: { id: string } }) => {
        const a = agentsById.get(where.id);
        if (!a) throw new Error(`fakeDb: no agent "${where.id}"`);
        return a;
      }) as never,
    },
    run: {
      findUniqueOrThrow: (async ({ where }: { where: { id: string } }) => {
        const r = runsById.get(where.id);
        if (!r) throw new Error(`fakeDb: no run "${where.id}"`);
        return r;
      }) as never,
      findMany: (async (opts: {
        where: {
          agentId?: { in: string[] };
          startedAt?: { gte: Date };
          parentRunId?: { in: string[] };
          id?: { in: string[] };
        };
      }) => {
        const { where } = opts;
        if (where.agentId) {
          return withDefaults.filter(
            (r) => where.agentId!.in.includes(r.agentId) && r.startedAt >= where.startedAt!.gte,
          );
        }
        if (where.parentRunId) {
          return withDefaults.filter(
            (r) => r.parentRunId !== undefined && where.parentRunId!.in.includes(r.parentRunId as string),
          );
        }
        if (where.id) {
          // Like the real relation: each tree row carries its agent's budgetUsd.
          return withDefaults
            .filter((r) => r.id && where.id!.in.includes(r.id))
            .map((r) => ({ ...r, agent: { budgetUsd: agentsById.get(r.agentId)?.budgetUsd ?? 0 } }));
        }
        return [];
      }) as never,
    },
  } as unknown as BudgetGroupsDb;
}
