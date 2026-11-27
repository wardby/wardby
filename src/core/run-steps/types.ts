/**
 * Run steps: one line per tool call (with its status once the result is back) or per model
 * message. Every source (the native engine, the native gateways, the coding proxy) produces these
 * shapes; only the control plane's RunStepWriter turns them into stored rows.
 */

/** A step as an extractor saw it: `text` is what the summary is cut from (at most MAX_STEP_TEXT_CHARS). */
export type ExtractedStep =
  | {
      kind: "tool";
      callId: string;
      tool: string;
      text: string;
      truncated: boolean;
      /** Detail level only: the tool's raw input (at most MAX_STEP_TEXT_CHARS). */
      input?: string;
      /** The input was cut (it may end in the start of a secret). */
      inputTruncated?: boolean;
      /** The workflow sub-agent whose request produced it (STEP_AGENT_REF); absent for the main session. */
      agent?: string;
    }
  | { kind: "said"; callId: string; text: string; truncated: boolean; agent?: string };

export type StepStatus = "ok" | "error" | `exit ${number}`;

/** A tool call's status, matched to its step by callId. Never the result's content below the detail level. */
export interface ExtractedResult {
  callId: string;
  status: StepStatus;
  /** Detail level only: the end of the result's text output (at most MAX_RESULT_OUTPUT_CHARS). */
  output?: string;
  /** Text before `output` was dropped (it may start with the end of a secret). */
  outputCut?: boolean;
}

export interface RunStepBatch {
  steps: ExtractedStep[];
  results: ExtractedResult[];
  /** A workflow run's phases and sub-agents as they stand (#582): replaces the stored tree. */
  workflow?: WorkflowProgress;
}

/**
 * A workflow run's tree (#582), from Claude Code's task_progress events: its phases and each
 * sub-agent (the id its model requests carry, so steps group under it). Titles and labels come from
 * the repository's script: untrusted text, redacted by exact value before it is stored.
 */
export interface WorkflowProgress {
  phases: { index: number; title: string }[];
  agents: { id: string; label: string; phaseIndex: number | null; state: string; attempt: number }[];
}

/** A workflow sub-agent's id as Claude Code sends it (x-claude-code-agent-id). */
export const STEP_AGENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
/** A sub-agent's state in the tree (start, done, failed, queued, ...). */
export const WORKFLOW_AGENT_STATE = /^[a-z_]{1,24}$/;
export const MAX_WORKFLOW_PHASES = 64;
export const MAX_WORKFLOW_AGENTS = 1_000;
/** The most of a phase title or agent label kept. */
export const MAX_WORKFLOW_LABEL_CHARS = 200;

/**
 * Where trusted code hands a run's steps: redacts by exact value, then writes. Never rejects.
 * `extraSecretValues` are values the caller knows that the agent's own secrets do not cover (the
 * native-sandbox gateway's run capability); they are redacted like the agent's.
 */
export interface RunStepSink {
  record(runId: string, batch: RunStepBatch, extraSecretValues?: readonly string[]): Promise<void>;
  /** Resolves when the writes queued so far settle (bounded; never rejects): before a shutdown disconnects. */
  flush?(): Promise<void>;
  /** A join step (RunStepWriter.recordJoin): rejects with a fixed code, unlike record(). */
  recordJoin?(
    runId: string,
    step: { kind: "join" | "leave" | "message" | "interrupt"; principalId: string; text?: string },
  ): Promise<{ seq: number; text: string }>;
}

/**
 * The coding proxy's side: queues a batch for the control plane, for the run the capability belongs
 * to (the listener refuses any other). The step text is sent unmasked: the control plane redacts it
 * by exact value (stepSummarizer) before anything is stored. Synchronous; never throws.
 */
export interface RunStepSubmitter {
  submit(capability: string, runId: string, batch: RunStepBatch): void;
}

/** The most text an extractor keeps for one step (a longer block is cut, not buffered). */
export const MAX_STEP_TEXT_CHARS = 16 * 1024;
/** The most steps one run records; later ones are counted in Run.stepsDropped. */
export const MAX_RUN_STEPS = 2_000;
export const TOOL_SUMMARY_CHARS = 100;
export const SAID_SUMMARY_CHARS = 120;
/** The summary column's bound. */
export const MAX_SUMMARY_CHARS = 300;
/** The detail level's parts: a tool's input head, its output's tail, a model message's head. */
export const DETAIL_INPUT_CHARS = 4 * 1024;
export const DETAIL_OUTPUT_CHARS = 2 * 1024;
export const DETAIL_SAID_CHARS = 8 * 1024;
/** The detail column's bound. */
export const MAX_STEP_DETAIL_CHARS = 16 * 1024;
/** The most of a tool result's output a source sends (its end): more than DETAIL_OUTPUT_CHARS, so a secret across the cut is still whole. */
export const MAX_RESULT_OUTPUT_CHARS = 4 * 1024;

/** The end of `text`, at most `max` characters, and whether anything before it was dropped. */
export function tailOf(text: string, max = MAX_RESULT_OUTPUT_CHARS): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(text.length - max), cut: true } : { text, cut: false };
}
/** Between a tool's input and its output in the detail text. */
export const DETAIL_OUTPUT_HEADING = "\n\n--- output (end) ---\n";

/** ok, error, or exit 1-999: fixed shapes only, so no free text can reach a status. */
export const STEP_STATUS = /^(?:ok|error|exit [1-9]\d{0,2})$/;
export const STEP_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Printable ASCII, as the providers' and workers' ids are. */
export const STEP_CALL_ID = /^[\x21-\x7e]{1,600}$/;

/** The control plane's run-steps listener route (WARDBY_RUN_STEPS_LISTEN). */
export const RUN_STEPS_INGRESS_PATH = "/internal/run-steps";
/** The listener's join route (phase 1): a run's worker long-polls it, through the proxy, for joined messages. */
export const RUN_JOIN_POLL_PATH = "/internal/run-join/poll";
/** One POST's bounds; the forwarder splits larger batches. */
export const MAX_STEPS_PER_POST = 64;
export const MAX_RESULTS_PER_POST = 256;
/** The most bytes one POST body may carry (the listener refuses a larger one); parts are split to fit. */
export const MAX_RUN_STEPS_POST_BYTES = 1 * 1024 * 1024;
