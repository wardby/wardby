import { describe, expect, it } from "vitest";
import {
  loadBudgetEvent,
  loadBudgetEvents,
  hostBudgetSentence,
  proxyRefusalDetails,
  ownerBudgetSentence,
  type BudgetEventView,
  type BudgetLimit,
  type ProxyRefusalDetails,
  type TopUpRefusalDetails,
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
  it("proxy, run, with an allowed overrun", () => {
    const e = event("run", proxy({ budgetUsd: 3.3, baseBudgetUsd: 3 }));
    expect(ownerBudgetSentence(e, "mobile-builder")).toContain(
      "To continue, raise budgetUsd or allowedOverrunPercent on mobile-builder.",
    );
  });

  it("names the base budget and overrun in both sentences when the run had one", () => {
    const e = event("run", proxy({ budgetUsd: 1.1, baseBudgetUsd: 1, spentUsd: 1.05, refusedHoldUsd: 0.2 }));
    const facts =
      "needed a $0.20 hold, but only $0.05 of this run's $1.00 budget and its 10% allowed overrun ($1.10 in all) was left ($1.05 spent).";
    expect(hostBudgetSentence(e)).toBe(`Out of budget: the next model request ${facts}`);
    expect(ownerBudgetSentence(e, "a")).toContain(`the next request ${facts}`);
  });

  describe("overrun from available room", () => {
    const topUp = (extra: Partial<TopUpRefusalDetails> = {}): TopUpRefusalDetails => ({
      source: "top-up",
      capUsd: 20,
      spentUsd: 6,
      heldUsd: 14,
      leftUsd: 0,
      baseBudgetUsd: 10,
      grantedUsd: 10,
      limitUsd: 11,
      groupName: "team",
      ...extra,
    });
    const refused = (
      details: Partial<ProxyRefusalDetails>,
      overrun: TopUpRefusalDetails,
      limit: BudgetLimit = "day",
    ) => ({
      ...event(
        "run",
        proxy({ budgetUsd: 10, spentUsd: 9.95, refusedHoldUsd: 0.2, baseBudgetUsd: 10, limitUsd: 11, ...details }),
      ),
      overrun: { limit, details: overrun },
    });

    it("stopped at its base: says the overrun wasn't available and which cap to raise", () => {
      const e = refused({}, topUp({ leftUsd: 0.4 }));
      const why = `Its 10% allowed overrun wasn't available because the "team" group had nothing left of its daily cap.`;
      expect(ownerBudgetSentence(e, "builder")).toBe(
        `Stopped before turn 41: the next request needed a $0.20 hold, but only $0.05 of this run's $10.00 budget was left ($9.95 spent). ${why} To continue, raise the group's daily cap.`,
      );
      expect(hostBudgetSentence(e)).toBe(
        `Out of budget: the next model request needed a $0.20 hold, but only $0.05 of this run's $10.00 budget was left ($9.95 spent). ${why}`,
      );
    });

    it("topped up partly: names the part of the overrun it got", () => {
      const e = refused({ budgetUsd: 10.4, spentUsd: 10.35 }, topUp({ grantedUsd: 10.4 }));
      const owner = ownerBudgetSentence(e, "builder");
      expect(owner).toContain(
        "of this run's $10.00 budget and $0.40 of its 10% allowed overrun ($10.40 in all) was left",
      );
      expect(owner).toContain(
        `Only $0.40 of its 10% allowed overrun was available because the "team" group had no more left of its daily cap.`,
      );
    });

    it("a full run tree names the lead to the owner, and only the tree to a host", () => {
      const e = refused({}, topUp({ groupName: undefined, leadAgentName: "lead", capUsd: 15 }), "run-tree");
      expect(ownerBudgetSentence(e, "builder")).toContain(
        "Its 10% allowed overrun wasn't available because the lead's (lead) run tree had nothing left of its $15.00 budget. To continue, raise budgetUsd on lead.",
      );
      expect(hostBudgetSentence(e)).toContain("because the lead's run tree had nothing left of its $15.00 budget.");
      expect(hostBudgetSentence(e)).not.toContain("(lead)");
    });

    it("an overrun_unavailable event on its own reads as the overrun sentence", () => {
      const e: BudgetEventView = {
        kind: "overrun_unavailable",
        limit: "week",
        at: "2026-10-16T00:00:00.000Z",
        details: topUp(),
      };
      expect(hostBudgetSentence(e)).toBe(
        `Out of budget: Its 10% allowed overrun wasn't available because the "team" group had nothing left of its weekly cap.`,
      );
    });
  });

  it("keeps today's text without a base, with base == limit, or when the overrun rounds to 0%", () => {
    const today = hostBudgetSentence(event("run", proxy()));
    expect(hostBudgetSentence(event("run", proxy({ baseBudgetUsd: 3 })))).toBe(today);
    expect(hostBudgetSentence(event("run", proxy({ baseBudgetUsd: 2.999 })))).toBe(today);
    expect(ownerBudgetSentence(event("run", proxy({ baseBudgetUsd: 2.999 })), "a")).toBe(
      ownerBudgetSentence(event("run", proxy()), "a"),
    );
  });

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

  it("proxy: spent plus held above the budget leaves $0.00, never a negative amount", () => {
    const e = event("run", proxy({ budgetUsd: 3, spentUsd: 2.999, heldReservedUsd: 0.004 }));
    expect(ownerBudgetSentence(e, "mobile-builder")).toContain("but only $0.00 of this run's $3.00 budget was left");
    expect(hostBudgetSentence(e)).toContain("but only $0.00 of this run's $3.00 budget was left");
    expect(hostBudgetSentence(e)).not.toContain("-");
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
        findFirst: async ({ where }: { where: { kind?: string } }) =>
          where.kind === undefined || where.kind === "refused"
            ? { kind: "refused", limit, at: new Date(0), details }
            : null,
        findMany: async () => [
          { kind: "refused", limit, at: new Date(0), details },
          { kind: "refused", limit: "run", at: new Date(1), details },
        ],
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

  it("ignores names stored in the details: they always come from the database", async () => {
    const stored = proxy({ leadAgentName: "preset", groupName: "forged" });
    const tree = await loadBudgetEvent(fakeDb(chain, "run-tree", stored).db, "child");
    expect(tree?.event.details).toMatchObject({ leadAgentName: "root-agent", groupName: "team" });
    const rows = { solo: { parentRunId: null, agent: agent("solo-agent") } };
    const period = await loadBudgetEvent(fakeDb(rows, "week", stored).db, "solo");
    expect(period?.event.details).not.toHaveProperty("groupName");
    expect(period?.event.details).not.toHaveProperty("leadAgentName");
  });

  it("returns null for a stored row whose details or limit fail the shape check", async () => {
    const { refusedHoldUsd: _dropped, ...missing } = proxy();
    const malformed: Array<[BudgetLimit, unknown]> = [
      ["run", missing],
      ["run", proxy({ spentUsd: Number.NaN })],
      ["run", { ...proxy(), budgetUsd: "3" }],
      ["run", proxy({ turn: 1.5 })],
      ["run", proxy({ model: "gpt 6; <b>" })],
      ["run", { source: "dispatch", capUsd: 5, spentUsd: 5, heldUsd: 0 }],
      ["run", { source: "other" }],
      ["run", null],
      ["forever" as BudgetLimit, proxy()],
    ];
    for (const [limit, details] of malformed) {
      await expect(loadBudgetEvent(fakeDb(chain, limit, details).db, "child")).resolves.toBeNull();
    }
  });

  it("fills the group name, and the agent budget for a proxy refusal only", async () => {
    const proxied = await loadBudgetEvent(fakeDb(chain, "day", proxy()).db, "child");
    expect(proxied?.event.details).toMatchObject({ groupName: "team", agentBudgetUsd: 9 });
    const dispatch = { source: "dispatch", capUsd: 5, spentUsd: 5, heldUsd: 0, heldRuns: 0 };
    const dispatched = await loadBudgetEvent(fakeDb(chain, "day", dispatch).db, "child");
    expect(dispatched?.event.details).toMatchObject({ groupName: "team" });
    expect(dispatched?.event.details).not.toHaveProperty("agentBudgetUsd");
  });

  it("loadBudgetEvents fills every event, reading the run and walking the tree once", async () => {
    const { db, lookups } = fakeDb(chain, "run-tree", proxy({ groupName: "forged" }));
    const events = await loadBudgetEvents(db, "child");
    expect(events.map((e) => e.limit)).toEqual(["run-tree", "run"]);
    expect(events[0].details).toMatchObject({ groupName: "team", agentBudgetUsd: 9, leadAgentName: "root-agent" });
    expect(events[1].details).toMatchObject({ groupName: "team", agentBudgetUsd: 9 });
    expect(events[1].details).not.toHaveProperty("leadAgentName");
    expect(lookups()).toBe(3);
  });

  it("loadBudgetEvents drops malformed rows and returns the events unnamed when the names cannot be read", async () => {
    expect(await loadBudgetEvents(fakeDb(chain, "run", { source: "proxy" }).db, "child")).toEqual([]);
    const events = await loadBudgetEvents(fakeDb(chain, "run", proxy(), true).db, "child");
    expect(events).toHaveLength(2);
    expect(events[0].details).not.toHaveProperty("groupName");
  });

  it("returns null when the database throws", async () => {
    const { db } = fakeDb(chain, "run-tree", proxy(), true);
    await expect(loadBudgetEvent(db, "child")).resolves.toBeNull();
  });
});

describe("proxyRefusalDetails", () => {
  it("keeps only the amounts, model and turn, and marks the source", () => {
    const raw = { ...proxy(), source: "dispatch", groupName: "forged", leadAgentName: "forged", note: "x" };
    expect(proxyRefusalDetails(raw)).toEqual(proxy());
  });

  it("refuses a model outside the allowed characters or over 128 characters", () => {
    expect(proxyRefusalDetails(proxy({ model: "us.anthropic.claude-sonnet-5-5:0/v1_x" }))).not.toBeNull();
    expect(proxyRefusalDetails(proxy({ model: "a".repeat(129) }))).toBeNull();
    expect(proxyRefusalDetails(proxy({ model: "" }))).toBeNull();
    expect(proxyRefusalDetails(proxy({ turn: -1 }))).toBeNull();
    expect(proxyRefusalDetails(proxy({ heldUncertainUsd: Number.POSITIVE_INFINITY }))).toBeNull();
  });
  it("keeps a valid refused hold basis and ceiling and drops malformed ones", () => {
    const kept = proxy({ refusedHoldBasis: "cached", refusedHoldCeilingUsd: 0.44 });
    expect(proxyRefusalDetails(kept)).toEqual(kept);
    expect(proxyRefusalDetails({ ...proxy(), refusedHoldBasis: "bogus", refusedHoldCeilingUsd: "1" })).toEqual(proxy());
  });
});
