import { describe, expect, it } from "vitest";
import { workerDebugTracer } from "../coding-worker/debug-trace.js";
import { GeminiStreamReader } from "./stream.js";

describe("Gemini debug trace", () => {
  it("redacts the capability and the MCP token from events and the stderr tail", () => {
    const capability = "rrp_FAKEcapability0123456789";
    const mcp = "rmt_FAKEmcp0123456789abcdefABCDEF";
    const out: string[] = [];
    const trace = workerDebugTracer({ runId: "r", debugTrace: true }, capability, (line) => out.push(line), [mcp])!;
    const reader = new GeminiStreamReader("r", undefined, trace);
    reader.line(
      JSON.stringify({
        type: "tool_result",
        tool_id: "t",
        status: "success",
        output: `key ${capability} token ${mcp}`,
      }),
    );
    trace.record("cli_stderr", `Error: {"cause": {"message": "bad key ${capability}"}}`);
    const text = out.join("");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(capability);
    expect(text).not.toContain(mcp);
  });
});
