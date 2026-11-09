/**
 * Run steps from the model traffic the coding proxy relays: one extractor per wire format, one
 * output shape (ExtractedStep / ExtractedResult). Nothing here throws for any input; a frame or body
 * it can't read gives no step. A tool result's content is never kept: its status comes from its
 * first lines only. Each request resends the whole history, so results are read from the newest turn
 * only.
 */
import {
  bounded,
  CLAUDE_RESULT_TOOL,
  codingResultStepText,
  displayToolName,
  FINISHED_STEP_TEXT,
  toolStepText,
} from "./summarize.js";
import type { ExtractedResult, ExtractedStep, StepStatus } from "./types.js";
import { MAX_STEP_TEXT_CHARS } from "./types.js";

export type StepWireProtocol = "openai-responses" | "anthropic-messages";

export interface StreamStepExtractor {
  /** Reads one SSE frame (the text between blank lines). Never throws. */
  consume(frame: string): void;
  /** The steps completed since the last call. */
  take(): ExtractedStep[];
  /**
   * The steps left when the reply has ended. When it was cut (it ended without its terminal event,
   * or stopped at the output limit), its open text is kept and the last text is marked truncated; a
   * tool call still open never ran, so it is no step. Never throws.
   */
  finish(): ExtractedStep[];
}

/** Anthropic stop reasons that cut a reply off mid-output. */
const CUT_STOP_REASONS = new Set(["max_tokens", "model_context_window_exceeded"]);

/** Marks the reply's last step truncated when it was cut and that step is text being written. */
function markCut(steps: ExtractedStep[], cut: boolean): ExtractedStep[] {
  const last = steps.at(-1);
  if (cut && last?.kind === "said" && !last.truncated) steps[steps.length - 1] = { ...last, truncated: true };
  return steps;
}

export const MAX_RESULTS_PER_REQUEST = 64;
const STATUS_HEAD_CHARS = 512;
const EXIT_LINE = /^(?:exit_code=|Exit code: |Process exited with code )(-?\d{1,6})\s*$/m;
const SCRIPT_FAILED = /^\s*Script (?:failed|terminated|error)\b/;
const OUTPUT_ITEMS = new Set(["function_call_output", "custom_tool_call_output"]);
/** Items of a turn's run of tool calls (their outputs are OUTPUT_ITEMS). */
const CALL_ITEMS = new Set(["function_call", "custom_tool_call", "tool_search_call"]);

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function sseData(frame: string): Json | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return undefined;
  try {
    return obj(JSON.parse(data));
  } catch {
    return undefined;
  }
}

interface OpenBlock {
  kind: "tool" | "said";
  id: string;
  name: string;
  buffer: string;
  truncated: boolean;
}

function append(block: OpenBlock, piece: string): void {
  if (block.truncated) return;
  const room = MAX_STEP_TEXT_CHARS - block.buffer.length;
  if (piece.length > room) {
    block.buffer += piece.slice(0, room);
    block.truncated = true;
  } else block.buffer += piece;
}

/** A coding run's final answer (Claude Code's StructuredOutput call) as one said step, never its arguments. */
function resultStep(callId: string, argsJson: string, cut: boolean): ExtractedStep {
  const answer = codingResultStepText(argsJson) ?? { text: FINISHED_STEP_TEXT, truncated: false };
  return { kind: "said", callId, text: answer.text, truncated: answer.truncated || cut };
}

function closeBlock(block: OpenBlock): ExtractedStep | undefined {
  if (block.kind === "said") {
    return block.buffer.trim()
      ? { kind: "said", callId: block.id, text: block.buffer, truncated: block.truncated }
      : undefined;
  }
  if (block.name === CLAUDE_RESULT_TOOL) return resultStep(block.id, block.buffer || "{}", block.truncated);
  const tool = displayToolName(block.name);
  const text = toolStepText(tool, block.buffer || "{}");
  return { kind: "tool", callId: block.id, tool, text: text.text, truncated: text.truncated || block.truncated };
}

let streamCount = 0;
const MAX_OPEN_BLOCKS = 64;

/** Anthropic Messages streams: input_json_delta assembled per block index, emitted on content_block_stop. */
export class AnthropicStreamSteps implements StreamStepExtractor {
  private messageId = `msg${++streamCount}`;
  private readonly blocks = new Map<number, OpenBlock>();
  private done: ExtractedStep[] = [];
  private stopped = false;
  private cutStop = false;

  consume(frame: string): void {
    try {
      this.read(frame);
    } catch {
      // A step is dropped, never the relay.
    }
  }

  take(): ExtractedStep[] {
    const out = this.done;
    this.done = [];
    return out;
  }

  finish(): ExtractedStep[] {
    try {
      const cut = !this.stopped || this.cutStop;
      for (const [index, open] of [...this.blocks].sort(([a], [b]) => a - b)) {
        this.blocks.delete(index);
        if (open.kind !== "said") continue;
        const step = closeBlock({ ...open, truncated: true });
        if (step) this.done.push(step);
      }
      return markCut(this.take(), cut);
    } catch {
      return [];
    }
  }

  private read(frame: string): void {
    if (!frame.includes("message_") && !frame.includes("content_block_")) return;
    const event = sseData(frame);
    if (!event) return;
    const index = typeof event.index === "number" ? event.index : undefined;
    switch (event.type) {
      case "message_stop":
        this.stopped = true;
        return;
      case "message_delta": {
        const reason = str(obj(event.delta)?.stop_reason);
        if (reason && CUT_STOP_REASONS.has(reason)) this.cutStop = true;
        return;
      }
      case "message_start":
        this.messageId = str(obj(event.message)?.id) ?? this.messageId;
        return;
      case "content_block_start": {
        const block = obj(event.content_block);
        if (index === undefined || !block) return;
        if (!this.blocks.has(index) && this.blocks.size >= MAX_OPEN_BLOCKS) return;
        const id = str(block.id);
        const name = str(block.name);
        if (block.type === "tool_use" && id && name) {
          this.blocks.set(index, { kind: "tool", id, name, buffer: "", truncated: false });
        } else if (block.type === "text") {
          const open: OpenBlock = {
            kind: "said",
            id: `said:${this.messageId}:${index}`,
            name: "",
            buffer: "",
            truncated: false,
          };
          append(open, str(block.text) ?? "");
          this.blocks.set(index, open);
        }
        return;
      }
      case "content_block_delta": {
        const open = index === undefined ? undefined : this.blocks.get(index);
        const delta = obj(event.delta);
        if (!open || !delta) return;
        const piece = open.kind === "tool" ? str(delta.partial_json) : str(delta.text);
        if (piece) append(open, piece);
        return;
      }
      case "content_block_stop": {
        const open = index === undefined ? undefined : this.blocks.get(index);
        if (!open || index === undefined) return;
        this.blocks.delete(index);
        const step = closeBlock(open);
        if (step) this.done.push(step);
        return;
      }
      default:
        return;
    }
  }
}

/** One Responses output item as a step: function_call, custom_tool_call, or an assistant message. */
export function openAiItemStep(value: unknown): ExtractedStep | undefined {
  const item = obj(value);
  if (!item) return undefined;
  const callId = str(item.call_id);
  const name = str(item.name);
  switch (item.type) {
    case "function_call": {
      if (!callId || !name) return undefined;
      const tool = displayToolName(name, str(item.namespace));
      return { kind: "tool", callId, tool, ...toolStepText(tool, str(item.arguments) ?? "{}") };
    }
    case "custom_tool_call": {
      if (!callId || !name) return undefined;
      const tool = displayToolName(name);
      const input = str(item.input) ?? "";
      // The input is free-form text: as a JSON string it takes toolStepText's free-form path, which
      // marks the step cut when later lines are dropped.
      const text = toolStepText(tool, JSON.stringify(input.slice(0, MAX_STEP_TEXT_CHARS)));
      return {
        kind: "tool",
        callId,
        tool,
        text: text.text,
        truncated: text.truncated || input.length > MAX_STEP_TEXT_CHARS,
      };
    }
    case "message": {
      const id = str(item.id);
      if (!id || (item.role !== undefined && item.role !== "assistant")) return undefined;
      const parts = Array.isArray(item.content) ? item.content : [];
      const text = parts
        .map((part) => obj(part))
        .filter((part) => part?.type === "output_text")
        .map((part) => str(part?.text) ?? "")
        .join("\n");
      if (!text.trim()) return undefined;
      // Codex's last message is its final answer as JSON: said as the answer's summary.
      const out = codingResultStepText(text) ?? bounded(text);
      return {
        kind: "said",
        callId: `said:${id}`,
        text: out.text,
        truncated: out.truncated || item.status === "incomplete",
      };
    }
    default:
      return undefined;
  }
}

/** OpenAI Responses streams: one step per response.output_item.done. */
export class OpenAiStreamSteps implements StreamStepExtractor {
  private done: ExtractedStep[] = [];
  private completed = false;

  consume(frame: string): void {
    try {
      if (!frame.includes("response.output_item.done") && !frame.includes("response.completed")) return;
      const event = sseData(frame);
      if (event?.type === "response.completed") {
        if (obj(event.response)?.status !== "incomplete") this.completed = true;
        return;
      }
      if (event?.type !== "response.output_item.done") return;
      const step = openAiItemStep(event.item);
      if (step) this.done.push(step);
    } catch {
      // A step is dropped, never the relay.
    }
  }

  take(): ExtractedStep[] {
    const out = this.done;
    this.done = [];
    return out;
  }

  finish(): ExtractedStep[] {
    try {
      // Anything but response.completed (incomplete, failed, an error or a cut stream) ended it early.
      return markCut(this.take(), !this.completed);
    } catch {
      return [];
    }
  }
}

export function streamStepExtractor(protocol: StepWireProtocol): StreamStepExtractor {
  return protocol === "anthropic-messages" ? new AnthropicStreamSteps() : new OpenAiStreamSteps();
}

/** A whole (non-stream) reply's steps. */
export function stepsFromJson(protocol: StepWireProtocol, value: unknown): ExtractedStep[] {
  try {
    const body = obj(value);
    if (!body) return [];
    if (protocol === "openai-responses") {
      const steps = (Array.isArray(body.output) ? body.output : []).flatMap((item) => openAiItemStep(item) ?? []);
      return markCut(steps, body.status === "incomplete" || obj(body.incomplete_details) !== undefined);
    }
    const messageId = str(body.id) ?? "msg";
    const steps: ExtractedStep[] = [];
    (Array.isArray(body.content) ? body.content : []).forEach((value, index) => {
      const block = obj(value);
      const id = str(block?.id);
      const name = str(block?.name);
      const text = str(block?.text);
      if (block?.type === "tool_use" && id && name === CLAUDE_RESULT_TOOL) {
        steps.push(resultStep(id, JSON.stringify(block.input ?? {}), false));
      } else if (block?.type === "tool_use" && id && name) {
        const tool = displayToolName(name);
        steps.push({ kind: "tool", callId: id, tool, ...toolStepText(tool, JSON.stringify(block.input ?? {})) });
      } else if (block?.type === "text" && text?.trim()) {
        steps.push({ kind: "said", callId: `said:${messageId}:${index}`, ...bounded(text) });
      }
    });
    const reason = str(body.stop_reason);
    return markCut(steps, reason !== undefined && CUT_STOP_REASONS.has(reason));
  } catch {
    return [];
  }
}

/** A result's status from its first lines: an exit line wins, else the error flag. */
export function statusFromOutput(head: string, isError: boolean): StepStatus {
  const lines = head.slice(0, STATUS_HEAD_CHARS).split("\n").slice(0, 8).join("\n");
  const match = EXIT_LINE.exec(lines);
  if (!match) return isError || SCRIPT_FAILED.test(lines) ? "error" : "ok";
  const code = Number(match[1]);
  if (code === 0) return "ok";
  return code > 0 && code < 1000 ? `exit ${code}` : "error";
}

/** The first STATUS_HEAD_CHARS of a result's text parts; images and other parts are skipped. */
function contentHead(content: unknown): string {
  if (typeof content === "string") return content.slice(0, STATUS_HEAD_CHARS);
  if (!Array.isArray(content)) return "";
  let head = "";
  for (const part of content) {
    const text = str(obj(part)?.text);
    if (text === undefined) continue;
    head += head ? `\n${text}` : text;
    if (head.length >= STATUS_HEAD_CHARS) break;
  }
  return head.slice(0, STATUS_HEAD_CHARS);
}

/** The results a request carries for the turn before it: the newest part of the history only. */
export function resultsFromRequest(protocol: StepWireProtocol, value: unknown): ExtractedResult[] {
  try {
    const body = obj(value);
    if (!body) return [];
    if (protocol === "anthropic-messages") {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const results: ExtractedResult[] = [];
      // Every user message after the last assistant message: results may be split from a following text.
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = obj(messages[index]);
        if (message?.role === "system") continue;
        if (message?.role !== "user") break;
        if (!Array.isArray(message.content)) continue;
        for (let at = message.content.length - 1; at >= 0; at--) {
          const block = obj(message.content[at]);
          const callId = str(block?.tool_use_id);
          if (block?.type !== "tool_result" || !callId) continue;
          results.push({ callId, status: statusFromOutput(contentHead(block.content), block.is_error === true) });
        }
      }
      return results.slice(0, MAX_RESULTS_PER_REQUEST).reverse();
    }
    const input = Array.isArray(body.input) ? body.input : [];
    // The newest turn: past trailing user/developer messages, the run of calls and their outputs
    // (they interleave), back to a reasoning item, an assistant message or anything else.
    let end = input.length;
    while (end > 0) {
      const item = obj(input[end - 1]);
      if (item?.type === "message" && (item.role === "user" || item.role === "developer")) end--;
      else break;
    }
    const results: ExtractedResult[] = [];
    for (let index = end - 1; index >= 0 && results.length < MAX_RESULTS_PER_REQUEST; index--) {
      const item = obj(input[index]);
      const type = str(item?.type);
      if (type && OUTPUT_ITEMS.has(type)) {
        const callId = str(item?.call_id);
        if (callId) results.push({ callId, status: statusFromOutput(contentHead(item?.output), false) });
      } else if (!type || !CALL_ITEMS.has(type)) break;
    }
    return results.reverse();
  } catch {
    return [];
  }
}
