import { describe, expect, it, vi } from "vitest";
import { budgetSentence, loadBudgetSentence } from "./budget-wording.js";

describe("budgetSentence", () => {
  it("names the run's budget with two decimals", () => {
    expect(budgetSentence({ runBudgetUsd: 3, agentBudgetUsd: 3 })).toBe(
      "Out of budget: this run's $3.00 budget was used up.",
    );
  });

  it("blames the budget group when it cut the run below the agent's own budget", () => {
    expect(budgetSentence({ runBudgetUsd: 0.5234, agentBudgetUsd: 3, budgetGroupName: "reviewers" })).toBe(
      'Out of budget: this run\'s $0.52 budget was used up (the "reviewers" budget group had only that much left of its limit).',
    );
  });

  it("does not blame a group when the run had the agent's full budget", () => {
    expect(budgetSentence({ runBudgetUsd: 3, agentBudgetUsd: 3, budgetGroupName: "reviewers" })).toBe(
      "Out of budget: this run's $3.00 budget was used up.",
    );
  });

  it("does not blame a group when the agent is in none", () => {
    expect(budgetSentence({ runBudgetUsd: 0.5, agentBudgetUsd: 3 })).toBe(
      "Out of budget: this run's $0.50 budget was used up.",
    );
  });

  it("uses the agent's budget when the run has none of its own", () => {
    expect(budgetSentence({ runBudgetUsd: null, agentBudgetUsd: 2 })).toBe(
      "Out of budget: this run's $2.00 budget was used up.",
    );
  });

  it("says a refused run could not start", () => {
    expect(budgetSentence({ agentBudgetUsd: 2, refused: true })).toBe(
      "Out of budget: this run could not start within its $2.00 budget.",
    );
    expect(budgetSentence({ agentBudgetUsd: 2, budgetGroupName: "reviewers", refused: true })).toBe(
      'Out of budget: this run could not start within its $2.00 budget or what the "reviewers" budget group had left of its limit.',
    );
  });

  it("strips quotes and line breaks from a group name", () => {
    expect(budgetSentence({ runBudgetUsd: 0.1, agentBudgetUsd: 1, budgetGroupName: 'a"b\nc' })).toContain(
      '(the "ab c" budget group',
    );
  });
});

describe("loadBudgetSentence", () => {
  it("reads the run's reserved budget, the agent's budget, and its group", async () => {
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          agent: { budgetUsd: "3", budgetGroup: { name: "reviewers" } },
          codingRun: { budgetReservedUsd: "0.52" },
        })),
      },
    };
    await expect(loadBudgetSentence(db as never, "r1", "budget_exhausted")).resolves.toBe(
      'Out of budget: this run\'s $0.52 budget was used up (the "reviewers" budget group had only that much left of its limit).',
    );
    expect(db.run.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1" } }));
  });

  it("uses the recorded budget refusal when the run has one", async () => {
    const db = {
      run: {
        findUnique: vi.fn(async () => ({
          parentRunId: null,
          agent: { name: "builder", budgetUsd: "3", budgetGroup: { name: "reviewers" } },
        })),
      },
      runBudgetEvent: {
        findFirst: vi.fn(async () => ({
          limit: "day",
          at: new Date(0),
          details: {
            source: "proxy",
            budgetUsd: 0.5,
            spentUsd: 0.4,
            heldReservedUsd: 0,
            heldUncertainUsd: 0,
            refusedHoldUsd: 0.2,
            model: "m",
            turn: 3,
          },
        })),
      },
    };
    const sentence = await loadBudgetSentence(db as never, "r1", "budget_exhausted");
    expect(sentence).toContain('The "reviewers" group');
    expect(sentence).toContain("$0.20 hold");
    expect(sentence).not.toContain("builder");
    expect(sentence).not.toContain("turn");
  });

  it("uses the agent's budget for a native run", async () => {
    const db = {
      run: { findUnique: vi.fn(async () => ({ agent: { budgetUsd: 1.5, budgetGroup: null }, codingRun: null })) },
    };
    await expect(loadBudgetSentence(db as never, "r1", "refused")).resolves.toBe(
      "Out of budget: this run could not start within its $1.50 budget.",
    );
  });

  it("falls back to a plain sentence when the numbers cannot be read", async () => {
    const failing = { run: { findUnique: vi.fn(async () => Promise.reject(new Error("db down"))) } };
    await expect(loadBudgetSentence(failing as never, "r1", "budget_exhausted")).resolves.toBe(
      "Out of budget: this run's budget was used up.",
    );
    const missing = { run: { findUnique: vi.fn(async () => null) } };
    await expect(loadBudgetSentence(missing as never, "r1", "refused")).resolves.toBe(
      "Out of budget: this run could not start within its budget.",
    );
  });
});
