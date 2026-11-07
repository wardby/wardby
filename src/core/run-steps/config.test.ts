import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_STEP_RETENTION_DAYS,
  effectiveRunStepsLevel,
  loadRunStepRetentionDays,
  loadRunStepsLevel,
} from "./config.js";

describe("loadRunStepsLevel", () => {
  it("defaults to summary and accepts off, summary and detail", () => {
    expect(loadRunStepsLevel({})).toBe("summary");
    expect(loadRunStepsLevel({ WARDBY_RUN_STEPS: "  " })).toBe("summary");
    expect(loadRunStepsLevel({ WARDBY_RUN_STEPS: "off" })).toBe("off");
    expect(loadRunStepsLevel({ WARDBY_RUN_STEPS: " detail " })).toBe("detail");
  });

  it.each(["verbose", "SUMMARY", "on", "1"])("refuses %s, naming the variable", (value) => {
    expect(() => loadRunStepsLevel({ WARDBY_RUN_STEPS: value })).toThrow(
      "WARDBY_RUN_STEPS must be off, summary or detail.",
    );
  });

  it("records detail as summary in this release", () => {
    expect(effectiveRunStepsLevel("detail")).toBe("summary");
    expect(effectiveRunStepsLevel("summary")).toBe("summary");
    expect(effectiveRunStepsLevel("off")).toBe("off");
  });
});

describe("loadRunStepRetentionDays", () => {
  it("defaults to 30 and accepts whole days from 1 to 3650", () => {
    expect(loadRunStepRetentionDays({})).toBe(DEFAULT_RUN_STEP_RETENTION_DAYS);
    expect(DEFAULT_RUN_STEP_RETENTION_DAYS).toBe(30);
    expect(loadRunStepRetentionDays({ RUN_STEP_RETENTION_DAYS: "1" })).toBe(1);
    expect(loadRunStepRetentionDays({ RUN_STEP_RETENTION_DAYS: " 3650 " })).toBe(3650);
  });

  it.each(["0", "3651", "1.5", "-2", "ten", "1e2x"])("refuses %s, naming the variable", (value) => {
    expect(() => loadRunStepRetentionDays({ RUN_STEP_RETENTION_DAYS: value })).toThrow(
      "RUN_STEP_RETENTION_DAYS must be a whole number of days from 1 to 3650.",
    );
  });
});
