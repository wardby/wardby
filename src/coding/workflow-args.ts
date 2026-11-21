/**
 * A workflow script's args (#582), shared by trigger_agent and delegate_to_*: a JSON object of at
 * most MAX_WORKFLOW_ARGS_BYTES serialized, valid only for a coding agent with a workflow.
 */
import { z } from "zod";

/** The most a workflow script's args may be, as JSON. */
export const MAX_WORKFLOW_ARGS_BYTES = 16 * 1024;

export const WorkflowArgsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_WORKFLOW_ARGS_BYTES,
    "workflowArgs must be at most 16 KiB as JSON",
  );

/** The refusal for workflowArgs sent to an agent without a workflow. */
export const WORKFLOW_ARGS_WITHOUT_WORKFLOW_ERROR = "workflow_args_without_workflow";
export const WORKFLOW_ARGS_WITHOUT_WORKFLOW_MESSAGE =
  "workflowArgs is only valid for a coding agent with a workflow (codingProfile.workflow).";
