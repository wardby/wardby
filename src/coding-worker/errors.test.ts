import { describe, expect, it } from "vitest";
import { MAX_CODING_OUTPUT_ISSUES, parseCodingAgentOutputJson } from "../coding/protocol.js";
import { safeOutputIssues, safeWorkerErrorCode } from "./errors.js";

describe("safeWorkerErrorCode", () => {
  it("preserves only fixed worker-owned codes", () => {
    expect(safeWorkerErrorCode(new Error("coding_turn_failed"))).toBe("coding_turn_failed");
    expect(safeWorkerErrorCode(new Error("coding_stream_failed"))).toBe("coding_stream_failed");
    expect(safeWorkerErrorCode(new Error("coding_output_invalid"))).toBe("coding_output_invalid");
    expect(safeWorkerErrorCode(new Error("provider_secret_value"))).toBe("worker_failed");
  });

  it("removes an attacker-controlled duplicate-key suffix", () => {
    expect(safeWorkerErrorCode(new Error("coding_artifact_duplicate_key:DO_NOT_LEAK"))).toBe(
      "coding_artifact_duplicate_key",
    );
  });
});

describe("safeOutputIssues", () => {
  const RUN_ID = "run_1";
  const valid = { schemaVersion: 1, runId: RUN_ID, outcome: "changes_ready", summary: "Added jokes.", tests: [] };

  function outputFailure(output: unknown): Error {
    try {
      parseCodingAgentOutputJson(JSON.stringify(output));
    } catch (cause) {
      return new Error("coding_output_invalid", { cause });
    }
    throw new Error("expected the output to be rejected");
  }

  it("names the failing schema paths and codes", () => {
    const error = outputFailure({
      ...valid,
      summary: "   ",
      tests: [{ command: "python -m pytest\npython -m ruff check .", outcome: "passed" }],
    });
    expect(safeOutputIssues(error)?.sort()).toEqual(["summary:custom", "tests.0.command:custom"]);
  });

  it("never carries the model's values or invented key names", () => {
    const error = outputFailure({ ...valid, summary: "SECRET VALUE\u0000", SECRETKEY: "SECRET VALUE" });
    const issues = safeOutputIssues(error);
    expect(issues).toContain("$:unrecognized_keys");
    expect(JSON.stringify(issues)).not.toMatch(/SECRET/);
  });

  it("caps the list", () => {
    const tests = Array.from({ length: 20 }, () => ({ command: "", outcome: "passed" }));
    expect(safeOutputIssues(outputFailure({ ...valid, tests }))).toHaveLength(MAX_CODING_OUTPUT_ISSUES);
  });

  it("is undefined for anything but a schema failure", () => {
    expect(safeOutputIssues(new Error("coding_output_invalid"))).toBeUndefined();
    expect(safeOutputIssues(new Error("coding_output_invalid", { cause: new Error("x") }))).toBeUndefined();
    expect(safeOutputIssues("coding_output_invalid")).toBeUndefined();
  });
});
