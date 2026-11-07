/**
 * Steps of native runs. The in-process engine knows each call's result; the native gateways see
 * the model's events and, in the next request, the trailing `role: "tool"` messages. A tool
 * result's content is never kept: its status is whether it starts as the runner's JSON error.
 */
import type { LlmMessage, LlmStreamEvent } from "../../providers/llm/types.js";
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

/** Collects one model call's steps from its events; `key` makes the said step's id (the call's own id). */
export class NativeStreamSteps {
  private text = "";
  private truncated = false;
  private readonly calls: { id: string; name: string; argsJson: string }[] = [];

  constructor(private readonly key: string) {}

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

/** The engine's `onSteps` for a run: hands each batch to the writer and does not wait for it. */
export function runStepsHook(
  sink: RunStepSink | undefined,
  runId: string,
): ((batch: RunStepBatch) => void) | undefined {
  return sink ? (batch) => void sink.record(runId, batch) : undefined;
}
