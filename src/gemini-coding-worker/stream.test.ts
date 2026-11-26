import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GeminiStreamReader } from "./stream.js";

const lines = (scenario: string) =>
  readFileSync(new URL(`./fixtures/stream/${scenario}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean);

function read(scenario: string) {
  const onProgress = vi.fn();
  const trace = { record: vi.fn() };
  const reader = new GeminiStreamReader("run_rec", onProgress, trace);
  for (const line of lines(scenario)) reader.line(line);
  return { reader, onProgress, trace };
}

describe("GeminiStreamReader on recorded CLI output", () => {
  it("takes the assistant text after the last tool event as the final answer", () => {
    const { reader } = read("success-tools");
    expect(JSON.parse(reader.finalText())).toMatchObject({ runId: "run_rec", outcome: "changes_ready" });
    expect(reader.result).toEqual({ status: "success" });
  });

  it("maps events to safe progress only: no text, arguments or output", () => {
    const { onProgress } = read("success-tools");
    const events = onProgress.mock.calls.map(([event]) => event);
    expect(events[0]).toEqual({ schemaVersion: 1, runId: "run_rec", type: "turn_started" });
    expect(events).toContainEqual({
      schemaVersion: 1,
      runId: "run_rec",
      type: "activity",
      kind: "file_change",
      status: "started",
    });
    expect(events).toContainEqual({
      schemaVersion: 1,
      runId: "run_rec",
      type: "activity",
      kind: "command_execution",
      status: "completed",
    });
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event.type === "activity"
          ? ["kind", "runId", "schemaVersion", "status", "type"]
          : ["runId", "schemaVersion", "type"],
      );
    }
    expect(JSON.stringify(events)).not.toContain("hello.txt");
  });

  it("reports a failed tool and keeps going", () => {
    const { reader, onProgress } = read("tool-error");
    expect(onProgress.mock.calls.map(([e]) => e)).toContainEqual(
      expect.objectContaining({ type: "activity", status: "failed" }),
    );
    expect(reader.finalText()).toBe("done");
  });

  it("reads the error result of a failed run", () => {
    expect(read("budget-limit0").reader.result).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("wardby_budget_exhausted") },
    });
    expect(read("turn-limit").reader.result).toMatchObject({
      status: "error",
      error: { type: "FatalTurnLimitedError" },
    });
  });

  it("records every event in the debug trace and ignores lines that are not JSON objects", () => {
    const { trace } = read("success-tools");
    expect(trace.record).toHaveBeenCalledWith("event", expect.objectContaining({ type: "init" }));
    const reader = new GeminiStreamReader("r");
    for (const junk of ["", "not json", "[1]", "null", '"text"']) reader.line(junk);
    expect(reader.finalText()).toBe("");
    expect(reader.result).toBeUndefined();
  });

  it("never puts a value from the CLI's events into progress", () => {
    const secret = "fake-secret-value-123";
    const onProgress = vi.fn();
    const reader = new GeminiStreamReader("run_rec", onProgress);
    for (const event of [
      { type: "init", session_id: secret, model: secret },
      { type: "message", role: "assistant", content: secret },
      { type: "tool_use", tool_name: secret, tool_id: "t1", parameters: { command: secret } },
      { type: "tool_result", tool_id: "t1", status: secret, output: secret, error: { type: secret, message: secret } },
      { type: "tool_use", tool_name: `mcp_${secret}`, tool_id: secret, parameters: {} },
    ]) {
      reader.line(JSON.stringify(event));
    }
    expect(onProgress).toHaveBeenCalled();
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(secret);
  });
});
