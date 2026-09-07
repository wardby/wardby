import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../providers/index.js";
import { applyPreflightSafetyMargin, checkTokenCalibration, estimateInputCost, isOverBudget } from "./budget.js";

function fakeLlm(opts: { tokens: number; inputPerMTok: number; outputPerMTok: number }): LlmProvider {
  return {
    async *stream() {},
    async countTokens() {
      return opts.tokens;
    },
    priceUsd(_model, usage) {
      return (
        (usage.inputTokens / 1_000_000) * opts.inputPerMTok + (usage.outputTokens / 1_000_000) * opts.outputPerMTok
      );
    },
  };
}

describe("estimateInputCost", () => {
  it("prices the counted tokens as input-only, zero output", async () => {
    const llm = fakeLlm({ tokens: 1000, inputPerMTok: 10, outputPerMTok: 20 });
    const estimate = await estimateInputCost(
      { model: "fake-model", budgetUsd: 1 },
      [{ role: "user", content: "hi" }],
      llm,
    );
    expect(estimate.tokens).toBe(1000);
    expect(estimate.costUsd).toBeCloseTo(0.01, 6);
  });
});

describe("isOverBudget", () => {
  it("is false just under budget", () => {
    expect(isOverBudget(0.999999, 1)).toBe(false);
  });

  it("is true exactly at budget", () => {
    expect(isOverBudget(1, 1)).toBe(true);
  });

  it("is true over budget", () => {
    expect(isOverBudget(1.5, 1)).toBe(true);
  });
});

describe("applyPreflightSafetyMargin", () => {
  it("pads the cost upward by the fixed margin", () => {
    expect(applyPreflightSafetyMargin(1)).toBeCloseTo(1.1, 6);
    expect(applyPreflightSafetyMargin(0)).toBe(0);
  });

  it("can turn a just-under-budget estimate into a refuse", () => {
    // Raw estimate is under budget, but padding it pushes it over —
    // exactly the case a naive under-count should not be able to sneak past.
    const raw = 0.95;
    const budget = 1;
    expect(isOverBudget(raw, budget)).toBe(false);
    expect(isOverBudget(applyPreflightSafetyMargin(raw), budget)).toBe(true);
  });
});

describe("checkTokenCalibration", () => {
  it("does not flag small divergence", () => {
    // 40 vs 38 ≈ 5.3%, under the default 10% threshold.
    const calibration = checkTokenCalibration(40, 38);
    expect(calibration.diverged).toBe(false);
    expect(calibration.deltaRatio).toBeGreaterThan(0);
  });

  it("flags a large overestimate as diverged but reports the safe direction", () => {
    const calibration = checkTokenCalibration(200, 100);
    expect(calibration.diverged).toBe(true);
    expect(calibration.deltaRatio).toBeCloseTo(1, 6);
  });

  it("flags a large underestimate as diverged with a negative ratio", () => {
    const calibration = checkTokenCalibration(50, 100);
    expect(calibration.diverged).toBe(true);
    expect(calibration.deltaRatio).toBeCloseTo(-0.5, 6);
  });

  it("does not divide by zero when actual usage is zero", () => {
    const calibration = checkTokenCalibration(5, 0);
    expect(calibration.diverged).toBe(false);
    expect(calibration.deltaRatio).toBe(0);
  });
});

function llmStub(): LlmProvider {
  return {
    async *stream() {},
    async countTokens() {
      return 1000;
    },
    // fresh input $10/Mtok, cached $1/Mtok
    priceUsd(_m, u) {
      const cached = u.cachedInputTokens ?? 0;
      return ((u.inputTokens - cached) / 1e6) * 10 + (cached / 1e6) * 1;
    },
  };
}

describe("estimateInputCost cache-aware", () => {
  it("with no cacheRatio prices all input fresh", async () => {
    const est = await estimateInputCost({ model: "m", budgetUsd: 1 }, [], llmStub());
    expect(est.costUsd).toBeCloseTo((1000 / 1e6) * 10, 9);
  });

  it("with a cacheRatio prices the cached share at the cached rate (cheaper)", async () => {
    const full = await estimateInputCost({ model: "m", budgetUsd: 1 }, [], llmStub());
    const cached = await estimateInputCost({ model: "m", budgetUsd: 1 }, [], llmStub(), undefined, 0.9);
    expect(cached.costUsd).toBeLessThan(full.costUsd);
    // 100 fresh @ $10/M + 900 cached @ $1/M
    expect(cached.costUsd).toBeCloseTo((100 / 1e6) * 10 + (900 / 1e6) * 1, 9);
  });
});
