import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_MAX_CALLS_PER_RUN, loadMcpMaxCallsPerRun } from "./mcp-call-limit.js";

describe("loadMcpMaxCallsPerRun", () => {
  it("defaults to 100", () => {
    expect(DEFAULT_MCP_MAX_CALLS_PER_RUN).toBe(100);
    expect(loadMcpMaxCallsPerRun({})).toBe(100);
    expect(loadMcpMaxCallsPerRun({ WARDBY_MCP_MAX_CALLS_PER_RUN: "  " })).toBe(100);
  });
  it("accepts a positive whole number", () => {
    expect(loadMcpMaxCallsPerRun({ WARDBY_MCP_MAX_CALLS_PER_RUN: "250" })).toBe(250);
    expect(loadMcpMaxCallsPerRun({ WARDBY_MCP_MAX_CALLS_PER_RUN: " 1 " })).toBe(1);
  });
  it.each(["0", "-1", "x", "1.5", "1e3", "99999999999999999999"])("refuses %j, naming the variable", (value) => {
    expect(() => loadMcpMaxCallsPerRun({ WARDBY_MCP_MAX_CALLS_PER_RUN: value })).toThrow(
      `WARDBY_MCP_MAX_CALLS_PER_RUN must be a positive whole number (got "${value}").`,
    );
  });
});
