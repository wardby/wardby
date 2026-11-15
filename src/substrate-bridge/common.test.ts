import { describe, expect, it } from "vitest";
import { mcpWorkerEnv, withoutMcpEnv } from "./common.js";

describe("the worker's MCP env", () => {
  it("is header mode with the placeholder exactly when the input answer's flag is 1", () => {
    expect(mcpWorkerEnv({ "x-wardby-mcp-tools": "1" })).toStrictEqual({
      WARDBY_MCP_TOKEN: "rmt_placeholder_injected_by_gateway",
      WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token",
    });
  });

  it.each([
    ["no flag", {}],
    ["a flag of 0", { "x-wardby-mcp-tools": "0" }],
    ["a flag sent twice", { "x-wardby-mcp-tools": ["1"] }],
    ["a flag with spaces", { "x-wardby-mcp-tools": " 1" }],
    ["an empty flag", { "x-wardby-mcp-tools": "" }],
  ])("is empty with %s", (_label, headers) => {
    expect(mcpWorkerEnv(headers as Record<string, string>)).toStrictEqual({});
  });

  it("drops both MCP variables from an inherited env, and only those", () => {
    const env = { PATH: "/bin", WARDBY_MCP_TOKEN: "x", WARDBY_MCP_TOKEN_HEADER: "y" };
    expect(withoutMcpEnv(env)).toStrictEqual({ PATH: "/bin" });
    // The input is left as it was.
    expect(env).toStrictEqual({ PATH: "/bin", WARDBY_MCP_TOKEN: "x", WARDBY_MCP_TOKEN_HEADER: "y" });
    expect(withoutMcpEnv({ PATH: "/bin" })).toStrictEqual({ PATH: "/bin" });
  });
});
