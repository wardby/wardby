import { describe, expect, it } from "vitest";
import {
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
