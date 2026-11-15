import { describe, expect, it } from "vitest";
import { CodingTaskInputSchema, CODING_PROTOCOL_VERSION } from "./protocol.js";

describe("worker input: resumeSessionId (warm Substrate rounds)", () => {
  const input = {
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId: "run_123",
    repository: "openai/example",
    baseRef: "main",
    headRef: "wardby/run-run_123",
    task: "Fix it.",
    model: "claude-sonnet-5",
    budgetUsd: 1,
    deadlineAt: "2026-09-07T13:00:00.000Z",
  };

  it("accepts a session UUID, and an input without it is unchanged", () => {
    const id = "0b5f0d6c-4a43-4a1c-9b7e-2f6a1d2c3e4f";
    expect(CodingTaskInputSchema.parse({ ...input, resumeSessionId: id }).resumeSessionId).toBe(id);
    expect(CodingTaskInputSchema.parse(input)).not.toHaveProperty("resumeSessionId");
  });

  it("refuses anything but a UUID (it names a file under the SDK's config dir)", () => {
    for (const resumeSessionId of ["../x", "", "0b5f0d6c", 1]) {
      expect(() => CodingTaskInputSchema.parse({ ...input, resumeSessionId })).toThrow();
    }
  });
});
