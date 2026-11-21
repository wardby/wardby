/**
 * The run-steps listener's request body: the run it is for, and the batch. Strict, bounded,
 * fixed-shape statuses only (the forwarder's split keeps every POST within these bounds).
 */
import { z } from "zod";
import {
  MAX_RESULT_OUTPUT_CHARS,
  MAX_RESULTS_PER_POST,
  MAX_STEP_TEXT_CHARS,
  MAX_STEPS_PER_POST,
  STEP_CALL_ID,
  STEP_STATUS,
  STEP_TOOL_NAME,
  STEP_AGENT_REF,
  WORKFLOW_AGENT_STATE,
  MAX_WORKFLOW_PHASES,
  MAX_WORKFLOW_AGENTS,
  MAX_WORKFLOW_LABEL_CHARS,
  type RunStepBatch,
} from "./types.js";

const callId = z.string().regex(STEP_CALL_ID);
const text = z.string().max(MAX_STEP_TEXT_CHARS);
const agent = z.string().regex(STEP_AGENT_REF).optional();
const label = z.string().max(MAX_WORKFLOW_LABEL_CHARS * 4);

/** A workflow run's tree as the worker reports it and the proxy relays it (#582). */
export const WorkflowProgressSchema = z
  .object({
    phases: z
      .array(z.object({ index: z.number().int().min(0).max(10_000), title: label }).strict())
      .max(MAX_WORKFLOW_PHASES),
    agents: z
      .array(
        z
          .object({
            id: z.string().regex(STEP_AGENT_REF),
            label,
            phaseIndex: z.number().int().min(0).max(10_000).nullable(),
            state: z.string().regex(WORKFLOW_AGENT_STATE),
            attempt: z.number().int().min(0).max(1_000),
          })
          .strict(),
      )
      .max(MAX_WORKFLOW_AGENTS),
  })
  .strict();

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
              input: text.optional(),
              inputTruncated: z.boolean().optional(),
              agent,
            })
            .strict(),
          z.object({ kind: z.literal("said"), callId, text, truncated: z.boolean(), agent }).strict(),
        ]),
      )
      .max(MAX_STEPS_PER_POST),
    results: z
      .array(
        z
          .object({
            callId,
            status: z.string().regex(STEP_STATUS),
            output: z.string().max(MAX_RESULT_OUTPUT_CHARS).optional(),
            outputCut: z.boolean().optional(),
          })
          .strict(),
      )
      .max(MAX_RESULTS_PER_POST),
    workflow: WorkflowProgressSchema.optional(),
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
  const { runId, steps, results, workflow } = parsed.data;
  return { runId, batch: { steps, results, ...(workflow ? { workflow } : {}) } as RunStepBatch };
}
