/**
 * The outcomes a coding agent may report for each command in its result's `tests` list, and how
 * the status comment counts them.
 *
 * `expected_failure` is a run the agent made fail on purpose: the red run of test-first work,
 * before the fix. It is shown in the pull request body like any other entry but is not a failed
 * check. Agents on an older worker image (or prompt) report that run as `failed` with a label
 * such as "(before fix, expected failure)"; those labels count as expected failures too.
 */
import { TEST_OUTCOMES, TEST_OUTCOME_DESCRIPTION, type TestOutcome } from "./protocol.js";

export { TEST_OUTCOMES, TEST_OUTCOME_DESCRIPTION, type TestOutcome };

export function isTestOutcome(value: unknown): value is TestOutcome {
  return typeof value === "string" && (TEST_OUTCOMES as readonly string[]).includes(value);
}

/** How the pull request body shows an outcome. */
export function testOutcomeLabel(outcome: TestOutcome): string {
  return outcome === "expected_failure" ? "expected failure" : outcome;
}

// Labels agents write on a deliberate red run, e.g. "(before fix, expected failure)",
// "(before implementation)", "(red run)". Matched only on entries reported as failed.
const EXPECTED_FAILURE_LABEL =
  /\bexpected[ _-]?fail|\bbefore (?:the )?(?:fix|implementation|change)|\((?:red|tdd red)\b|\bred (?:run|phase|step)\b/i;

/** Whether a failed entry's command says the failure was expected (test-first, before the fix). */
export function hasExpectedFailureLabel(command: string): boolean {
  return EXPECTED_FAILURE_LABEL.test(command);
}

export interface TestOutcomeCounts {
  /** Real failures: the only entries the status comment warns about. */
  failed: number;
  /** Deliberate red runs: reported `expected_failure`, or `failed` with an expected-failure label. */
  expectedFailures: number;
  skipped: number;
}

/** Counts a stored `tests` list; entries that are not well-formed are ignored. */
export function countTestOutcomes(tests: unknown): TestOutcomeCounts {
  const counts: TestOutcomeCounts = { failed: 0, expectedFailures: 0, skipped: 0 };
  if (!Array.isArray(tests)) return counts;
  for (const test of tests) {
    if (!test || typeof test !== "object") continue;
    const { command, outcome } = test as Record<string, unknown>;
    if (outcome === "expected_failure") counts.expectedFailures += 1;
    else if (outcome === "skipped") counts.skipped += 1;
    else if (outcome === "failed") {
      if (typeof command === "string" && hasExpectedFailureLabel(command)) counts.expectedFailures += 1;
      else counts.failed += 1;
    }
  }
  return counts;
}
