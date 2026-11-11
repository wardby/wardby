import { describe, expect, it } from "vitest";
import { hookWants } from "./match.js";

const hook = (over: Partial<{ events: string[]; statuses: string[]; runs: string }> = {}) => ({
  events: [],
  statuses: [],
  runs: "top_level",
  ...over,
});

describe("hookWants", () => {
  it("takes every kind when events is empty", () => {
    expect(hookWants(hook(), "pr_opened", {})).toBe(true);
    expect(hookWants(hook(), "run_completed", { status: "succeeded", parentRunId: null })).toBe(true);
  });

  it("takes only the listed kinds", () => {
    const h = hook({ events: ["run_completed"] });
    expect(hookWants(h, "run_completed", { status: "failed", parentRunId: null })).toBe(true);
    expect(hookWants(h, "pr_opened", {})).toBe(false);
  });

  it("filters run_completed by status", () => {
    const h = hook({ statuses: ["failed", "lost"] });
    expect(hookWants(h, "run_completed", { status: "failed", parentRunId: null })).toBe(true);
    expect(hookWants(h, "run_completed", { status: "succeeded", parentRunId: null })).toBe(false);
  });

  it("takes a child run's run_completed only with runs: all", () => {
    const child = { status: "succeeded", parentRunId: "p1" };
    expect(hookWants(hook(), "run_completed", child)).toBe(false);
    expect(hookWants(hook({ runs: "all" }), "run_completed", child)).toBe(true);
  });

  it("applies statuses and runs to run_completed only", () => {
    const h = hook({ statuses: ["failed"], runs: "top_level" });
    expect(hookWants(h, "run_failed", { status: "cancelled" })).toBe(true);
    expect(hookWants(h, "review_posted", {})).toBe(true);
  });
});
