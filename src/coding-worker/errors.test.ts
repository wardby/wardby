import { describe, expect, it } from "vitest";
import { safeWorkerErrorCode } from "./errors.js";

describe("safeWorkerErrorCode", () => {
  it("preserves only fixed worker-owned codes", () => {
    expect(safeWorkerErrorCode(new Error("coding_turn_failed"))).toBe("coding_turn_failed");
    expect(safeWorkerErrorCode(new Error("provider_secret_value"))).toBe("worker_failed");
  });

  it("removes an attacker-controlled duplicate-key suffix", () => {
    expect(safeWorkerErrorCode(new Error("coding_artifact_duplicate_key:DO_NOT_LEAK"))).toBe(
      "coding_artifact_duplicate_key",
    );
  });
});
