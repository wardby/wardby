import { describe, expect, it } from "vitest";
import { stepLine } from "./steps";

describe("stepLine (worded as the server's lastStep.line)", () => {
  it.each([
    [{ kind: "tool", tool: "Bash", summary: "npm test", status: "exit 1" }, "Bash: npm test (exit 1)"],
    [{ kind: "tool", tool: "Bash", summary: "npm test", status: "ok" }, "Bash: npm test"],
    [{ kind: "tool", tool: null, summary: "x", status: null }, "tool: x"],
    [{ kind: "said", tool: null, summary: "Running the tests.", status: null }, "said: Running the tests."],
  ] as const)("%o → %s", (step, line) => {
    expect(stepLine(step)).toBe(line);
  });
});
