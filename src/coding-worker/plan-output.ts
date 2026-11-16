import { readdir } from "node:fs/promises";
import {
  CODING_PROTOCOL_VERSION,
  CodingPlanFilesOutputSchema,
  type CodingPlanFilesOutput,
  type CodingTaskInput,
} from "../coding/protocol.js";
import type { PlanFolderResult } from "./plan-folder.mjs";

/** Never throws: anything unexpected is the fixed plan_files_failed (an error may quote a path or content). */
export async function collectPlanOutput(
  runId: string,
  collect: () => Promise<PlanFolderResult | { status: "error"; error: "plan_tool_unavailable" | "plan_files_failed" }>,
): Promise<CodingPlanFilesOutput> {
  const failed: CodingPlanFilesOutput = {
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId,
    status: "error",
    error: "plan_files_failed",
  };
  try {
    const parsed = CodingPlanFilesOutputSchema.safeParse({
      schemaVersion: CODING_PROTOCOL_VERSION,
      runId,
      ...(await collect()),
    });
    return parsed.success ? parsed.data : failed;
  } catch {
    return failed;
  }
}

/** A plan run (input files), or a folder the agent wrote into. */
export async function shouldCollectPlan(input: Pick<CodingTaskInput, "planFiles">, root: string): Promise<boolean> {
  if (input.planFiles) return true;
  try {
    return (await readdir(root)).length > 0;
  } catch {
    return false;
  }
}

/**
 * main.ts's plan capture, after result.json is written: skipped when the run was cancelled, and a
 * write failure is only the fixed warning (never the error). Never throws.
 */
export async function capturePlanFiles(options: {
  input: CodingTaskInput | undefined;
  aborted: boolean;
  root: string;
  collect: () => Promise<PlanFolderResult | { status: "error"; error: "plan_tool_unavailable" | "plan_files_failed" }>;
  write: (output: CodingPlanFilesOutput) => Promise<void>;
  warn: () => void;
}): Promise<void> {
  const { input } = options;
  if (!input || options.aborted || !(await shouldCollectPlan(input, options.root))) return;
  const plan = await collectPlanOutput(input.runId, options.collect);
  await options.write(plan).catch(() => options.warn());
}

/**
 * main.ts's run ending: the result is written first, then the plan is captured (so a capture
 * problem never changes the outcome), and not when the run was cancelled. Never throws from capture.
 */
export async function finishRun(options: {
  writeResult: () => Promise<void>;
  capture: () => Promise<void>;
  aborted: () => boolean;
}): Promise<void> {
  await options.writeResult();
  if (options.aborted()) return;
  await options.capture().catch(() => undefined);
}
