import { describe, expect, it } from "vitest";
import {
  loadBudgetEvent,
  hostBudgetSentence,
  ownerBudgetSentence,
  type BudgetEventView,
  type BudgetLimit,
  type ProxyRefusalDetails,
} from "./budget-events.js";

const proxy = (extra: Partial<ProxyRefusalDetails> = {}): ProxyRefusalDetails => ({
  source: "proxy",
  budgetUsd: 3,
  spentUsd: 0.87,
  heldReservedUsd: 0,
  heldUncertainUsd: 0,
  refusedHoldUsd: 2.24,
  model: "gpt-6",
  turn: 41,
  ...extra,
});
const event = (limit: BudgetLimit, details: BudgetEventView["details"]): BudgetEventView => ({
  kind: "refused",
  limit,
  at: "2026-10-16T00:00:00.000Z",
  details,
});

describe("budget event sentences", () => {
  it("proxy, run", () => {
    const e = event("run", proxy());
    expect(ownerBudgetSentence(e, "mobile-builder")).toBe(
      "Stopped before turn 41: the next request needed a $2.24 hold, but only $2.13 of this run's $3.00 budget was left ($0.87 spent). To continue, raise budgetUsd on mobile-builder.",
    );
    expect(hostBudgetSentence(e)).toBe(
      "Out of budget: the next model request needed a $2.24 hold, but only $2.13 of this run's $3.00 budget was left ($0.87 spent).",
    );
  });

  it("proxy, run, with holds in flight", () => {
    const e = event("run", proxy({ heldReservedUsd: 0.5, heldUncertainUsd: 0.25 }));
    expect(ownerBudgetSentence(e, "mobile-builder")).toContain(
      "only $1.38 of this run's $3.00 budget was left ($0.87 spent, $0.75 held by requests in flight).",
    );
  });

  it("proxy, period", () => {
    const e = event("week", proxy({ budgetUsd: 4, spentUsd: 1.19, refusedHoldUsd: 3.4, groupName: 'mo"bile' }));
    expect(ownerBudgetSentence(e, "mobile-builder")).toBe(
      "Stopped before turn 41: the next request needed a $3.40 hold, but only $2.81 of this run's $4.00 budget was left ($1.19 spent). " +
        "The \"mobile\" group's weekly cap limited this run to $4.00. To continue, raise the group's weekly cap.",
    );
    expect(hostBudgetSentence(e)).toBe(
      "Out of budget: the next model request needed a $3.40 hold, but only $2.81 of this run's $4.00 budget was left ($1.19 spent). " +
        "The \"mobile\" group's weekly cap limited this run to $4.00. To continue, raise the group's weekly cap.",
    );
  });

  it("proxy, run-tree", () => {
    const e = event(
      "run-tree",
      proxy({ budgetUsd: 5, spentUsd: 1, refusedHoldUsd: 4.5, leadAgentName: "wardby-delivery" }),
    );
    expect(ownerBudgetSentence(e, "mobile-builder")).toBe(
      "Stopped before turn 41: the next request needed a $4.50 hold, but only $4.00 of this run's $5.00 budget was left ($1.00 spent). " +
        "The lead's (wardby-delivery) remaining budget limited this run to $5.00. To continue, raise budgetUsd on wardby-delivery.",
    );
    expect(hostBudgetSentence(e)).toBe(
      "Out of budget: the next model request needed a $4.50 hold, but only $4.00 of this run's $5.00 budget was left ($1.00 spent).",
    );
  });

  it("dispatch, period", () => {
    const e = event("week", {
      source: "dispatch",
      capUsd: 75,
      spentUsd: 60,
      heldUsd: 14.6,
      heldRuns: 2,
      groupName: "mobile",
    });
    const body =
      'the "mobile" group had $0.40 left of its $75.00 weekly cap ($60.00 spent, $14.60 held by 2 running run(s)).';
    expect(ownerBudgetSentence(e, "mobile-builder")).toBe(`Could not start: ${body}`);
    expect(hostBudgetSentence(e)).toBe(`Out of budget: could not start: ${body}`);
  });

  it("dispatch, run-tree", () => {
    const e = event("run-tree", {
      source: "dispatch",
      capUsd: 5,
      spentUsd: 5,
      heldUsd: 0,
      heldRuns: 0,
      leadAgentName: "wardby-delivery",
    });
    expect(ownerBudgetSentence(e, "mobile-builder")).toBe(
      "Could not start: the lead's (wardby-delivery) run tree had nothing left of its $5.00 budget ($5.00 spent).",
    );
    expect(hostBudgetSentence(e)).toBe(
      "Out of budget: could not start: the lead's run tree had nothing left of its $5.00 budget ($5.00 spent).",
    );
  });

  it("a host sentence never names agents or turns (scenario J)", () => {
    const events = [
      event("run", proxy({ leadAgentName: "wardby-delivery" })),
      event("run-tree", proxy({ leadAgentName: "wardby-delivery" })),
      event("week", proxy({ groupName: "mobile", leadAgentName: "wardby-delivery" })),
      event("run-tree", {
        source: "dispatch",
        capUsd: 5,
        spentUsd: 5,
        heldUsd: 0,
        heldRuns: 0,
        leadAgentName: "wardby-delivery",
      }),
    ];
    for (const e of events) {
      const sentence = hostBudgetSentence(e);
      expect(sentence).not.toContain("mobile-builder");
      expect(sentence).not.toContain("wardby-delivery");
      expect(sentence).not.toContain("turn");
    }
  });
});

describe("loadBudgetEvent", () => {
  interface RunRow {
    parentRunId: string | null;
    agent: { name: string; budgetUsd: number; budgetGroup: { name: string } | null } | null;
  }
  const agent = (name: string, group: string | null = null) => ({
    name,
    budgetUsd: 9,
    budgetGroup: group ? { name: group } : null,
  });
  const fakeDb = (rows: Record<string, RunRow>, limit: BudgetLimit, details: unknown, throws = false) => {
    let lookups = 0;
    const db = {
      run: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          lookups++;
          if (throws) throw new Error("db down");
          return rows[where.id] ?? null;
        },
      },
      runBudgetEvent: {
        findFirst: async () => ({ limit, at: new Date(0), details }),
      },
    };
    return { db: db as never, lookups: () => lookups };
  };
  const chain: Record<string, RunRow> = {
    child: { parentRunId: "mid", agent: agent("child-agent", "team") },
    mid: { parentRunId: "root", agent: agent("mid-agent") },
    root: { parentRunId: null, agent: agent("root-agent") },
  };

  it("names the tree root, not the immediate parent, as the lead", async () => {
    const { db } = fakeDb(chain, "run-tree", proxy());
    const loaded = await loadBudgetEvent(db, "child");
    expect(loaded?.event.details.leadAgentName).toBe("root-agent");
    expect(loaded?.agentName).toBe("child-agent");
    expect(ownerBudgetSentence(loaded!.event, loaded!.agentName)).toContain("root-agent");
  });

  it("stops a parent cycle at the hop cap", async () => {
    const cyclic = {
      a: { parentRunId: "b", agent: agent("agent-a") },
      b: { parentRunId: "a", agent: agent("agent-b") },
    };
    const { db, lookups } = fakeDb(cyclic, "run-tree", proxy());
    const loaded = await loadBudgetEvent(db, "a");
    expect(loaded?.event.details.leadAgentName).toBeDefined();
    expect(lookups()).toBeLessThanOrEqual(40);
  });

  it("stops the walk at a missing row", async () => {
    const rows = { child: { parentRunId: "gone", agent: agent("child-agent") } };
    const { db } = fakeDb(rows, "run-tree", proxy());
    const loaded = await loadBudgetEvent(db, "child");
    expect(loaded?.event.details.leadAgentName).toBe("child-agent");
  });

  it("does not walk the tree for a limit other than run-tree", async () => {
    const { db, lookups } = fakeDb(chain, "run", proxy());
    const loaded = await loadBudgetEvent(db, "child");
    expect(loaded?.event.details.leadAgentName).toBeUndefined();
    expect(lookups()).toBe(1);
  });

  it("keeps a leadAgentName already in the details", async () => {
    const { db } = fakeDb(chain, "run-tree", proxy({ leadAgentName: "preset" }));
    const loaded = await loadBudgetEvent(db, "child");
    expect(loaded?.event.details.leadAgentName).toBe("preset");
  });

  it("fills the group name, and the agent budget for a proxy refusal only", async () => {
    const proxied = await loadBudgetEvent(fakeDb(chain, "day", proxy()).db, "child");
    expect(proxied?.event.details).toMatchObject({ groupName: "team", agentBudgetUsd: 9 });
    const dispatch = { source: "dispatch", capUsd: 5, spentUsd: 5, heldUsd: 0, heldRuns: 0 };
    const dispatched = await loadBudgetEvent(fakeDb(chain, "day", dispatch).db, "child");
    expect(dispatched?.event.details).toMatchObject({ groupName: "team" });
    expect(dispatched?.event.details).not.toHaveProperty("agentBudgetUsd");
  });

  it("returns null when the database throws", async () => {
    const { db } = fakeDb(chain, "run-tree", proxy(), true);
    await expect(loadBudgetEvent(db, "child")).resolves.toBeNull();
  });
});
