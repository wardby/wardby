import { describe, expect, it } from "vitest";
import { countTestOutcomes, hasExpectedFailureLabel, testOutcomeLabel } from "./test-outcomes.js";

describe("countTestOutcomes", () => {
  it("counts real failures, expected failures and skipped entries apart", () => {
    expect(
      countTestOutcomes([
        { command: "npm run lint", outcome: "failed" },
        { command: "npx jest a.test.ts", outcome: "expected_failure" },
        { command: "npx jest b.test.ts (before fix, expected failure)", outcome: "failed" },
        { command: "npm audit", outcome: "skipped" },
        { command: "npm test", outcome: "passed" },
      ]),
    ).toEqual({ failed: 1, expectedFailures: 2, skipped: 1 });
  });

  it("ignores a missing or malformed list", () => {
    expect(countTestOutcomes(undefined)).toEqual({ failed: 0, expectedFailures: 0, skipped: 0 });
    expect(countTestOutcomes([null, "x", { outcome: "weird" }])).toEqual({
      failed: 0,
      expectedFailures: 0,
      skipped: 0,
    });
  });

  it("only reads the label of an entry reported as failed", () => {
    expect(countTestOutcomes([{ command: "npm test (before fix)", outcome: "passed" }]).expectedFailures).toBe(0);
  });
});

describe("hasExpectedFailureLabel", () => {
  it.each([
    "npx jest __tests__/runs/detail.test.tsx -t 'inset below' (before fix, expected failure)",
    "npx jest __tests__/live (stepStore + useLiveGraph step tests, before implementation)",
    "npx jest steps.test.ts (new tests, before the fix)",
    "npm test (red run)",
    "npm test (red)",
    "pytest -k new_case (expected-fail)",
  ])("matches %s", (command) => expect(hasExpectedFailureLabel(command)).toBe(true));

  it.each([
    "npm test",
    "npx expo-doctor@latest",
    "npm run build:redis",
    "pytest tests/test_red_team.py",
    "npm run lint",
  ])("does not match %s", (command) => expect(hasExpectedFailureLabel(command)).toBe(false));
});

describe("testOutcomeLabel", () => {
  it("spells expected_failure out for the pull request body", () => {
    expect(testOutcomeLabel("expected_failure")).toBe("expected failure");
    expect(testOutcomeLabel("failed")).toBe("failed");
  });
});
