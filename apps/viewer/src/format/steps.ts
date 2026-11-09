import type { RunDetail } from "../api/types";

export type RunStep = RunDetail["steps"][number];

/** A step as one line, worded as the server's lastStep.line: "Bash: npm test (exit 1)", "said: …". */
export function stepLine(step: Pick<RunStep, "kind" | "tool" | "summary" | "status">): string {
  const head = step.kind === "tool" ? `${step.tool ?? "tool"}: ${step.summary}` : `said: ${step.summary}`;
  return step.status && step.status !== "ok" ? `${head} (${step.status})` : head;
}
