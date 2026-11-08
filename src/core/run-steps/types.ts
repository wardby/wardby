/**
 * Run steps: one line per tool call (with its status once the result is back) or per model
 * message. Every source (the native engine, the native gateways, the coding proxy) produces these
 * shapes; only the control plane's RunStepWriter turns them into stored rows.
 */

/** A step as an extractor saw it: `text` is what the summary is cut from (at most MAX_STEP_TEXT_CHARS). */
export type ExtractedStep =
  | { kind: "tool"; callId: string; tool: string; text: string; truncated: boolean }
  | { kind: "said"; callId: string; text: string; truncated: boolean };

export type StepStatus = "ok" | "error" | `exit ${number}`;

/** A tool call's status, matched to its step by callId. Never the result's content. */
export interface ExtractedResult {
  callId: string;
  status: StepStatus;
}

export interface RunStepBatch {
  steps: ExtractedStep[];
  results: ExtractedResult[];
}

/**
 * Where trusted code hands a run's steps: redacts by exact value, then writes. Never rejects.
 * `extraSecretValues` are values the caller knows that the agent's own secrets do not cover (the
 * native-sandbox gateway's run capability); they are redacted like the agent's.
 */
export interface RunStepSink {
  record(runId: string, batch: RunStepBatch, extraSecretValues?: readonly string[]): Promise<void>;
  /** Resolves when the writes queued so far settle (bounded; never rejects): before a shutdown disconnects. */
  flush?(): Promise<void>;
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

/** ok, error, or exit 1-999: fixed shapes only, so no free text can reach a status. */
export const STEP_STATUS = /^(?:ok|error|exit [1-9]\d{0,2})$/;
export const STEP_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Printable ASCII, as the providers' and workers' ids are. */
export const STEP_CALL_ID = /^[\x21-\x7e]{1,600}$/;

/** The control plane's run-steps listener route (WARDBY_RUN_STEPS_LISTEN). */
export const RUN_STEPS_INGRESS_PATH = "/internal/run-steps";
/** One POST's bounds; the forwarder splits larger batches. */
export const MAX_STEPS_PER_POST = 64;
export const MAX_RESULTS_PER_POST = 256;
