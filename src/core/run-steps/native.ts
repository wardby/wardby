/**
 * Steps of native runs. The in-process engine knows each call's result; the native gateways see
 * the model's events and, in the next request, the trailing `role: "tool"` messages. A tool
 * result's content is never kept: its status is whether it starts as the runner's JSON error.
 */
import { createHash } from "node:crypto";
import type { EngineTurnEvent } from "../../providers/engine/types.js";
import type { LlmMessage, LlmStreamEvent } from "../../providers/llm/types.js";
import { logger } from "../logger.js";
import { UNTRUSTED_TOOL_OUTPUT_TAG } from "../untrusted-content.js";
import { bounded, displayToolName, toolStepText } from "./summarize.js";
import {
  MAX_STEP_TEXT_CHARS,
  type ExtractedResult,
  type ExtractedStep,
  type RunStepBatch,
  type RunStepSink,
  type StepStatus,
} from "./types.js";

const stepsLog = logger.child({ module: "run-steps" });
const UNTRUSTED_OPEN = `<${UNTRUSTED_TOOL_OUTPUT_TAG}>\n`;
/** runSandboxTool's failure shape: `{"error": ...}` (src/providers/engine/types.ts). */
const ERROR_RESULT = /^\s*\{\s*"error"\s*:/;

export function nativeToolStatus(content: string): StepStatus {
  const raw = content.startsWith(UNTRUSTED_OPEN) ? content.slice(UNTRUSTED_OPEN.length) : content;
  return ERROR_RESULT.test(raw.slice(0, 64)) ? "error" : "ok";
}

export function nativeTurnSteps(
  turnKey: string,
  text: string,
  toolCalls: readonly { id: string; name: string; argsJson: string }[],
): ExtractedStep[] {
  const steps: ExtractedStep[] = [];
  if (text.trim()) steps.push({ kind: "said", callId: `said:${turnKey}`, ...bounded(text) });
  for (const call of toolCalls) {
    const tool = displayToolName(call.name);
    steps.push({ kind: "tool", callId: call.id, tool, ...toolStepText(tool, call.argsJson) });
  }
  return steps;
}

export function nativeToolResults(toolCalls: readonly { id: string }[], results: readonly string[]): ExtractedResult[] {
  return toolCalls.map((call, index) => ({ callId: call.id, status: nativeToolStatus(results[index] ?? "") }));
}

/** The results a model request carries for the previous turn: the `tool` messages after the last assistant one. */
export function nativeRequestResults(messages: readonly LlmMessage[]): ExtractedResult[] {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  const results: ExtractedResult[] = [];
  // A trailing non-tool message (the engine's wind-down `user` message) does not hide the results.
  for (const message of messages.slice(lastAssistant + 1)) {
    if (message.role === "tool" && message.toolCallId) {
      results.push({ callId: message.toolCallId, status: nativeToolStatus(message.content) });
    }
  }
  return results;
}

/** How long a gateway's stream end waits for its steps to be written; past it the write goes on alone. */
export const STREAM_STEPS_BOUND_MS = 2_000;

/**
 * Collects one model call's steps from its events. The said step's id is a hash of `callId` (the
 * worker-chosen request id), so no worker text is stored as an id.
 */
export class NativeStreamSteps {
  private text = "";
  private truncated = false;
  private readonly calls: { id: string; name: string; argsJson: string }[] = [];
  private readonly key: string;

  constructor(callId: string) {
    this.key = createHash("sha256").update(callId).digest("hex").slice(0, 32);
  }

  observe(event: LlmStreamEvent): void {
    try {
      if (event.type === "text") {
        if (this.text.length + event.delta.length > MAX_STEP_TEXT_CHARS) {
          this.text = (this.text + event.delta).slice(0, MAX_STEP_TEXT_CHARS);
          this.truncated = true;
        } else this.text += event.delta;
      } else if (event.type === "tool_call") {
        this.calls.push({ id: event.id, name: event.name, argsJson: event.argsJson });
      }
    } catch {
      // A step is dropped, never the stream.
    }
  }

  steps(): ExtractedStep[] {
    const steps = nativeTurnSteps(this.key, this.text, this.calls);
    if (this.truncated && steps[0]?.kind === "said") steps[0] = { ...steps[0], truncated: true };
    return steps;
  }
}

/**
 * A native gateway's stream end: records the call's steps and the results its request carries for
 * the previous turn, so the next call's results find these steps. Never throws, and waits at most
 * `boundMs`: past it the stream ends and the write finishes in the background (the writer logs its
 * own failures, name only).
 */
export async function recordStreamSteps(
  sink: RunStepSink | undefined,
  runId: string,
  tap: Pick<NativeStreamSteps, "steps"> | undefined,
  messages: readonly LlmMessage[],
  extraSecretValues: readonly string[] = [],
  boundMs = STREAM_STEPS_BOUND_MS,
): Promise<void> {
  if (!sink || !tap) return;
  let write: Promise<void>;
  try {
    const batch = { steps: tap.steps(), results: nativeRequestResults(messages) };
    write = Promise.resolve(sink.record(runId, batch, extraSecretValues)).catch(() => undefined);
  } catch (err) {
    stepsLog.warn(
      { runId, event: "run_steps_write_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not record a run's steps; they were dropped",
    );
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, boundMs);
  });
  try {
    await Promise.race([write, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** One engine turn event's batch: a turn's said and tool steps, or its tool calls' results. */
export function nativeTurnBatch(event: EngineTurnEvent): RunStepBatch {
  return event.kind === "turn"
    ? { steps: nativeTurnSteps(`turn:${event.turn}`, event.text, event.toolCalls), results: [] }
    : { steps: [], results: nativeToolResults(event.toolCalls, event.results) };
}

/**
 * The engine's `onTurn` for a run: hands each non-empty batch to the writer and does not wait for
 * it. A throw here reaches the engine, which logs it by name and goes on.
 */
export function runStepsHook(
  sink: RunStepSink | undefined,
  runId: string,
): ((event: EngineTurnEvent) => void) | undefined {
  if (!sink) return undefined;
  return (event) => {
    const batch = nativeTurnBatch(event);
    if (batch.steps.length === 0 && batch.results.length === 0) return;
    void sink.record(runId, batch);
  };
}
