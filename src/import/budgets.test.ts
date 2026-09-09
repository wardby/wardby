import { describe, it, expect } from "vitest";
import { mapBudget } from "./budgets.js";

const base = { name: "cap", ownerEmail: null, alertEmails: [], attachedAgentNames: ["a", "b"] };

describe("mapBudget", () => {
  it("maps a monthly budget to monthlyBudgetUsd with the other periods null", () => {
    const r = mapBudget({ ...base, period: "monthly", alertThreshold: "80.00", blockThreshold: "100.00", enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.group.monthlyBudgetUsd).toBe("100.00");
      expect(r.group.dailyBudgetUsd).toBeNull();
      expect(r.group.warnThresholdRatio).toBe("0.80");
      expect(r.agentNames).toEqual(["a", "b"]);
    }
  });

  it("maps daily and weekly", () => {
    expect((mapBudget({ ...base, period: "daily", alertThreshold: "5", blockThreshold: "10", enabled: true }) as any).group.dailyBudgetUsd).toBe("10");
    expect((mapBudget({ ...base, period: "weekly", alertThreshold: "5", blockThreshold: "10", enabled: true }) as any).group.weeklyBudgetUsd).toBe("10");
  });

  it("skips a disabled budget", () => {
    const r = mapBudget({ ...base, period: "monthly", alertThreshold: "80", blockThreshold: "100", enabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disabled");
  });

  it("falls back to 0.8 when block is zero or ratio unusable", () => {
    const r = mapBudget({ ...base, period: "monthly", alertThreshold: "80", blockThreshold: "0", enabled: true });
    expect((r as any).group.warnThresholdRatio).toBe("0.8");
  });

  it("clamps a ratio above 1 down to 1.00", () => {
    const r = mapBudget({ ...base, period: "monthly", alertThreshold: "150", blockThreshold: "100", enabled: true });
    expect((r as any).group.warnThresholdRatio).toBe("1.00");
  });
});
