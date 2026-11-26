import type { DebugTracer } from "../coding-worker/debug-trace.js";
import type { WorkerProgressEvent } from "../coding-worker/types.js";

/** The CLI's last `result` event: status and, on failure, its error (type and message). */
export interface GeminiResult {
  status: "success" | "error";
  error?: { type?: string; message?: string };
}

/** Progress kinds, the Codex worker's names (driver.ts SAFE_ACTIVITY_KINDS) for the same activity. */
function activityKind(tool: string): string {
  if (tool === "run_shell_command") return "command_execution";
  if (tool === "write_file" || tool === "replace") return "file_change";
  if (tool === "google_web_search" || tool === "web_fetch") return "web_search";
  if (tool === "update_topic") return "todo_list";
  if (tool.startsWith("mcp_")) return "mcp_tool_call";
  return "other";
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The string fields of a CLI error object (`{ type, message }`), nothing else. */
export function geminiError(value: unknown): GeminiResult["error"] | undefined {
  const error = record(value);
  if (!error) return undefined;
  return {
    ...(typeof error.type === "string" ? { type: error.type } : {}),
    ...(typeof error.message === "string" ? { message: error.message } : {}),
  };
}

/**
 * Reads `--output-format stream-json` (one JSON event per line: init, message, tool_use,
 * tool_result, result). Only fixed progress fields leave the worker; the final answer is the
 * assistant's text after the last tool event (the result event has none). Every event goes to the
 * debug trace, which redacts by exact value.
 */
export class GeminiStreamReader {
  private text: string[] = [];
  private speaking = false;
  private readonly kinds = new Map<string, string>();
  private last?: GeminiResult;

  constructor(
    private readonly runId: string,
    private readonly onProgress?: (event: WorkerProgressEvent) => void,
    private readonly trace?: Pick<DebugTracer, "record">,
  ) {}

  /** The last `result` event, once the CLI wrote one. */
  get result(): GeminiResult | undefined {
    return this.last;
  }

  private activity(kind: string, status: string): void {
    this.onProgress?.({ schemaVersion: 1, runId: this.runId, type: "activity", kind, status });
  }

  line(raw: string): void {
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(raw));
    } catch {
      return;
    }
    if (!event) return;
    this.trace?.record("event", event);
    switch (event.type) {
      case "init":
        this.onProgress?.({ schemaVersion: 1, runId: this.runId, type: "turn_started" });
        return;
      case "message":
        if (event.role !== "assistant" || typeof event.content !== "string") return;
        this.text.push(event.content);
        if (!this.speaking) this.activity("agent_message", "started");
        this.speaking = true;
        return;
      case "tool_use": {
        this.text = [];
        this.speaking = false;
        const kind = activityKind(typeof event.tool_name === "string" ? event.tool_name : "");
        if (typeof event.tool_id === "string") this.kinds.set(event.tool_id, kind);
        this.activity(kind, "started");
        return;
      }
      case "tool_result":
        this.text = [];
        this.speaking = false;
        this.activity(
          (typeof event.tool_id === "string" && this.kinds.get(event.tool_id)) || "other",
          event.status === "error" ? "failed" : "completed",
        );
        return;
      case "result": {
        const error = geminiError(event.error);
        this.last = { status: event.status === "success" ? "success" : "error", ...(error ? { error } : {}) };
        return;
      }
    }
  }

  finalText(): string {
    return this.text.join("").trim();
  }
}
