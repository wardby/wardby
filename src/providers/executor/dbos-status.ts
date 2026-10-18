/**
 * Pure decision table for reconciling a stale `Run` that a DBOS workflow
 * owns. Kept free of DBOS imports so it is unit-testable without Postgres.
 */

import { DELEGATE_TOOL_PREFIX } from "../../core/tool-names.js";
import { STEPS_CHANGED_REASON } from "../engine/types.js";

export interface WorkflowStatusLike {
  status: string;
  executorId?: string;
  applicationVersion?: string;
}

/**
 * How many times the reconciler will try to adopt (resume) one orphaned
 * workflow before declaring the run lost.
 *
 * DBOS gates both recovery and dequeue on `application_version`: a workflow
 * recorded under an older version is re-`resume`d on every reconciler pass
 * and never dequeued, so without a bound the run sits `running` forever and
 * the reconciler re-drives it every pass. `recover()` also short-circuits an
 * outright version mismatch (see `versionMismatchReason`); this bound is the
 * catch-all for every other reason a resume can fail to take.
 */
export const MAX_RESUME_ATTEMPTS = 3;

export const ADOPTION_EXHAUSTED_REASON = `Durable workflow could not be re-driven after ${MAX_RESUME_ATTEMPTS} adoption attempts (executor/version mismatch).`;

/**
 * Given the number of adoption attempts already made for a run, should the
 * reconciler stop trying and declare it lost? The counter lives in the
 * executor (in memory, per process) — this is just the bound, kept pure so
 * it can be tested without Postgres.
 */
export function shouldGiveUpAdoption(attemptsAlreadyMade: number): boolean {
  return attemptsAlreadyMade >= MAX_RESUME_ATTEMPTS;
}

/**
 * Reason to give up immediately when the recorded workflow belongs to a
 * different application version than this process runs — DBOS will never
 * dequeue it here, so resuming it is pure churn. `undefined` when the two
 * agree, or when either version is unknown (nothing to compare).
 */
export function versionMismatchReason(
  workflowVersion: string | undefined,
  processVersion: string | undefined,
): string | undefined {
  if (!workflowVersion || !processVersion || workflowVersion === processVersion) return undefined;
  return `Durable workflow belongs to application version ${workflowVersion}; this process runs ${processVersion}.`;
}

export type RecoveryDecision =
  | { action: "active" }
  | { action: "resume" }
  | { action: "terminal" }
  | { action: "mark-failed"; error: string }
  | { action: "lost"; reason: string };

const LIVE = new Set(["PENDING", "ENQUEUED", "DELAYED"]);
const FINISHED = new Set(["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"]);

export function decideRecovery(
  status: WorkflowStatusLike | null,
  runIsTerminal: boolean,
  selfExecutorId: string,
): RecoveryDecision {
  if (!status) {
    return {
      action: "lost",
      reason: "Durable workflow record not found; the run was never started or its record was purged.",
    };
  }
  if (LIVE.has(status.status)) {
    // A live workflow this process owns is simply still running (its
    // heartbeat lapsed under load). One owned by another executor id whose
    // heartbeat lapsed is orphaned — that executor died — so adopt it.
    return status.status === "PENDING" && status.executorId === selfExecutorId
      ? { action: "active" }
      : { action: "resume" };
  }
  if (FINISHED.has(status.status)) {
    return runIsTerminal
      ? { action: "terminal" }
      : {
          action: "mark-failed",
          error: `Durable workflow finished (${status.status}) without persisting a terminal run state.`,
        };
  }
  return { action: "lost", reason: `Durable workflow is in unrecognised status "${status.status}".` };
}

/** One recorded step of a workflow, as `DBOS.listWorkflowSteps` reports it. */
export interface TakeoverStep {
  functionID: number;
  name: string;
  output: unknown;
}

/** A still-drivable child of the lead being taken over. */
export interface TakeoverChild {
  status: string;
  kind: "coding" | "native";
  nativeExecutionMode: string | null;
}

export type TakeoverDecision = { action: "fork"; startStep: number } | { action: "lost"; reason: string };

/** Why a forked run ends lost when its replay meets a step the new code no longer takes (defined with StepReplayMismatchError). */
export { STEPS_CHANGED_REASON };

const LLM_STEP = /^turn:(\d+):llm$/;

/**
 * The tool-call names of a recorded `turn:N:llm` step. Its output is the engine's TurnResult
 * (engine-native.ts) as DBOS deserialized it: `{ usage, text, toolCalls: [{ id, name, argsJson }],
 * budgetExceededMidStream, error? }`. Anything else yields undefined (the shape changed: lost).
 */
function recordedToolCallNames(output: unknown): string[] | undefined {
  if (typeof output !== "object" || output === null || !("toolCalls" in output)) return undefined;
  const calls = output.toolCalls;
  if (!Array.isArray(calls)) return undefined;
  const names: string[] = [];
  for (const call of calls as unknown[]) {
    if (typeof call !== "object" || call === null || !("name" in call) || typeof call.name !== "string") {
      return undefined;
    }
    names.push(call.name);
  }
  return names;
}

/**
 * Whether a workflow recorded under another application version can be forked under this one
 * (design §1): only when it is waiting inside a `delegate_to_*` call of its last recorded turn and
 * every child it may be waiting on is durable on its own (a coding run, or a sandbox-mode native
 * run). The fork starts at the first function id with no record, so every recorded step (the
 * turn's model reply above all) replays from its record and the delegate step re-attaches to its
 * child. Anything else is `lost` with the mismatch reason, as before.
 */
export function decideTakeover(
  steps: TakeoverStep[],
  children: TakeoverChild[],
  mismatchReason: string,
): TakeoverDecision {
  const lost: TakeoverDecision = { action: "lost", reason: mismatchReason };
  const sorted = [...steps].sort((a, b) => a.functionID - b.functionID);
  const llmStep = sorted.filter((s) => LLM_STEP.test(s.name)).at(-1);
  if (!llmStep) return lost;
  const turn = LLM_STEP.exec(llmStep.name)![1];
  const names = recordedToolCallNames(llmStep.output);
  if (!names) return lost;

  const recorded = new Set(sorted.map((s) => s.name));
  const firstPending = names.findIndex((_, i) => !recorded.has(`turn:${turn}:tool:${i}`));
  // Not waiting in a tool call at all, or waiting in one that is not a delegation (re-running it
  // under new code would repeat its effect).
  if (firstPending < 0 || !names[firstPending].startsWith(DELEGATE_TOOL_PREFIX)) return lost;

  const durable = (child: TakeoverChild) => child.kind === "coding" || child.nativeExecutionMode === "sandbox";
  if (!children.every(durable)) return lost;

  let startStep = 0;
  for (const step of sorted) {
    if (step.functionID > startStep) break;
    if (step.functionID === startStep) startStep += 1;
  }
  // A gap at or before the recorded reply would re-run the model turn: never fork into that.
  if (startStep <= llmStep.functionID) return lost;
  return { action: "fork", startStep };
}
