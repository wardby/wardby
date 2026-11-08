/**
 * The run-steps listener's request body: the run it is for, and the batch. Strict, bounded,
 * fixed-shape statuses only (the forwarder's split keeps every POST within these bounds).
 */
import { z } from "zod";
import {
  MAX_RESULTS_PER_POST,
  MAX_STEP_TEXT_CHARS,
  MAX_STEPS_PER_POST,
  STEP_CALL_ID,
  STEP_STATUS,
  STEP_TOOL_NAME,
  type RunStepBatch,
} from "./types.js";

const callId = z.string().regex(STEP_CALL_ID);
const text = z.string().max(MAX_STEP_TEXT_CHARS);

export const RunStepPostSchema = z
  .object({
    runId: z.string().min(1).max(200),
    steps: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("tool"),
              callId,
              tool: z.string().regex(STEP_TOOL_NAME),
              text,
              truncated: z.boolean(),
            })
            .strict(),
          z.object({ kind: z.literal("said"), callId, text, truncated: z.boolean() }).strict(),
        ]),
      )
      .max(MAX_STEPS_PER_POST),
    results: z.array(z.object({ callId, status: z.string().regex(STEP_STATUS) }).strict()).max(MAX_RESULTS_PER_POST),
  })
  .strict();

export interface RunStepPost {
  runId: string;
  batch: RunStepBatch;
}

/** The POST's run and batch; undefined for any body outside the schema (never an error's text). */
export function parseRunStepPost(value: unknown): RunStepPost | undefined {
  const parsed = RunStepPostSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { runId, steps, results } = parsed.data;
  return { runId, batch: { steps, results } as RunStepBatch };
}
