import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_STEP_RETENTION_DAYS,
  dispatchRunStepsLevel,
  loadRunStepRetentionDays,
  loadRunStepsLevel,
  RUN_STEPS_LEVELS,
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

type L = "off" | "summary" | "detail";
type Setting = L | null | undefined;
const CEILINGS: readonly L[] = ["off", "summary", "detail"];
const SETTINGS: readonly Setting[] = ["off", "summary", "detail", null, undefined];
// Written out by hand: the level for [ceiling][setting]; an unset setting is summary.
const EXPECTED: Record<L, Record<"off" | "summary" | "detail" | "unset", L>> = {
  off: { off: "off", summary: "off", detail: "off", unset: "off" },
  summary: { off: "off", summary: "summary", detail: "summary", unset: "summary" },
  detail: { off: "off", summary: "summary", detail: "detail", unset: "summary" },
};
const key = (s: Setting) => s ?? "unset";

describe("runStepsLevelFor", () => {
  it("covers every ceiling and setting", () => {
    expect([...RUN_STEPS_LEVELS]).toEqual(CEILINGS);
    for (const ceiling of RUN_STEPS_LEVELS)
      for (const setting of SETTINGS)
        expect(runStepsLevelFor(ceiling, setting), `${ceiling}/${String(setting)}`).toBe(
          EXPECTED[ceiling][key(setting)],
        );
  });
});

describe("recordedRunStepsLevel", () => {
  it("is the run's level capped by the process ceiling; no recorded level is at most summary", () => {
    for (const ceiling of RUN_STEPS_LEVELS)
      for (const setting of SETTINGS)
        expect(recordedRunStepsLevel(setting, ceiling), `${ceiling}/${String(setting)}`).toBe(
          EXPECTED[ceiling][key(setting)],
        );
    expect(recordedRunStepsLevel("detail", "summary")).toBe("summary");
    expect(recordedRunStepsLevel("detail", "off")).toBe("off");
    expect(recordedRunStepsLevel(null, "detail")).toBe("summary");
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
  // Warns iff the setting is above the ceiling, by hand.
  const WARNS: Record<L, readonly L[]> = { off: ["summary", "detail"], summary: ["detail"], detail: [] };
  it("warns only when the setting asks for more than the instance allows", () => {
    for (const ceiling of RUN_STEPS_LEVELS)
      for (const setting of SETTINGS) {
        const warned = setting != null && WARNS[ceiling].includes(setting);
        const got = runStepsAboveCeilingWarning(setting, ceiling);
        expect(got !== undefined, `${ceiling}/${String(setting)}`).toBe(warned);
        if (warned) expect(got).toContain(`runSteps is ${setting} but this instance allows up to ${ceiling}`);
      }
    expect(runStepsAboveCeilingWarning("detail", "summary")).toBe(
      "runSteps is detail but this instance allows up to summary (WARDBY_RUN_STEPS), so its runs record summary. See the run-steps help article.",
    );
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
