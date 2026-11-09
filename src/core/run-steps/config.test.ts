import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_STEP_RETENTION_DAYS,
  dispatchRunStepsLevel,
  loadRunStepRetentionDays,
  loadRunStepsLevel,
  recordedRunStepsLevel,
  runStepsAboveCeilingWarning,
  runStepsLevelFor,
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
});

describe("runStepsLevelFor", () => {
  it("is the lower of the ceiling and the agent setting; unset agents are at summary", () => {
    expect(runStepsLevelFor("detail", "detail")).toBe("detail");
    expect(runStepsLevelFor("summary", "detail")).toBe("summary");
    expect(runStepsLevelFor("off", "detail")).toBe("off");
    expect(runStepsLevelFor("detail", "off")).toBe("off");
    expect(runStepsLevelFor("detail", null)).toBe("summary");
    expect(runStepsLevelFor("detail", undefined)).toBe("summary");
    expect(runStepsLevelFor("off", null)).toBe("off");
  });
});

describe("recordedRunStepsLevel", () => {
  it("is the run's level capped by the process ceiling; a run from before the field records at most summary", () => {
    expect(recordedRunStepsLevel("detail", "detail")).toBe("detail");
    expect(recordedRunStepsLevel("detail", "summary")).toBe("summary");
    expect(recordedRunStepsLevel("detail", "off")).toBe("off");
    expect(recordedRunStepsLevel("summary", "detail")).toBe("summary");
    expect(recordedRunStepsLevel(null, "detail")).toBe("summary");
    expect(recordedRunStepsLevel(null, "off")).toBe("off");
  });
});

describe("dispatchRunStepsLevel", () => {
  it("reads the ceiling from the environment", () => {
    expect(dispatchRunStepsLevel({ runSteps: "detail" }, { WARDBY_RUN_STEPS: "detail" })).toBe("detail");
    expect(dispatchRunStepsLevel({ runSteps: "detail" }, {})).toBe("summary");
    expect(dispatchRunStepsLevel({ runSteps: null }, { WARDBY_RUN_STEPS: "detail" })).toBe("summary");
  });
});

describe("runStepsAboveCeilingWarning", () => {
  it("warns only when the setting asks for more than the instance allows", () => {
    expect(runStepsAboveCeilingWarning("detail", "summary")).toBe(
      "runSteps is detail but this instance allows up to summary (WARDBY_RUN_STEPS), so its runs record summary. See the run-steps help article.",
    );
    expect(runStepsAboveCeilingWarning("summary", "off")).toMatch(/allows up to off/);
    expect(runStepsAboveCeilingWarning("detail", "detail")).toBeUndefined();
    expect(runStepsAboveCeilingWarning(null, "off")).toBeUndefined();
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
