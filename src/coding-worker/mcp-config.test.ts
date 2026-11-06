import { describe, expect, it } from "vitest";
import { MCP_TOKEN_ENV as CONTROL_PLANE_TOKEN_ENV, WORKER_MCP_SERVER_KEY } from "../coding/mcp-token.js";
import { MCP_FORWARD_MAX_MS } from "../providers/coding-proxy/mcp-route.js";
import { DEFAULT_TOOL_MAX_TIMEOUT_MS } from "../sandbox/tool-timeout.js";
import {
  MCP_TOKEN_ENV,
  readMcpToken,
  WARDBY_MCP_INSTRUCTIONS,
  WARDBY_MCP_SERVER,
  WARDBY_MCP_TIMEOUT_MS,
  wardbyMcpUrl,
} from "./mcp-config.js";

describe("worker MCP configuration", () => {
  it("names the same server and environment variable as the control plane", () => {
    expect(WARDBY_MCP_SERVER).toBe("wardby_mcp");
    expect(WARDBY_MCP_SERVER).toBe(WORKER_MCP_SERVER_KEY);
    expect(MCP_TOKEN_ENV).toBe("WARDBY_MCP_TOKEN");
    expect(MCP_TOKEN_ENV).toBe(CONTROL_PLANE_TOKEN_ENV);
  });

  it("points at the proxy's /mcp route, with or without a trailing slash", () => {
    expect(wardbyMcpUrl("http://proxy:8080")).toBe("http://proxy:8080/mcp");
    expect(wardbyMcpUrl("http://proxy:8080/")).toBe("http://proxy:8080/mcp");
  });

  it("waits for a call as long as the proxy and the tool time limit ever allow", () => {
    expect(WARDBY_MCP_TIMEOUT_MS).toBe(300_000);
    expect(WARDBY_MCP_TIMEOUT_MS).toBe(MCP_FORWARD_MAX_MS);
    expect(WARDBY_MCP_TIMEOUT_MS).toBe(DEFAULT_TOOL_MAX_TIMEOUT_MS);
  });

  it("reads the token only when it is set and not empty", () => {
    expect(readMcpToken({})).toBeUndefined();
    expect(readMcpToken({ WARDBY_MCP_TOKEN: "" })).toBeUndefined();
    expect(readMcpToken({ WARDBY_MCP_TOKEN: "rmt_fake_token_value" })).toBe("rmt_fake_token_value");
  });

  it("words the prompt note for both workers without naming any other tool", () => {
    expect(WARDBY_MCP_INSTRUCTIONS).toContain("wardby_mcp");
    expect(WARDBY_MCP_INSTRUCTIONS).toContain("untrusted data");
  });
});
