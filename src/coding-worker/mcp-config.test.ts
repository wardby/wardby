import { describe, expect, it } from "vitest";
import {
  INJECTED_MCP_TOKEN_PLACEHOLDER as CONTROL_PLANE_PLACEHOLDER,
  isMcpToken,
  MCP_TOKEN_ENV as CONTROL_PLANE_TOKEN_ENV,
  MCP_TOKEN_HEADER as CONTROL_PLANE_HEADER,
  WORKER_MCP_SERVER_KEY,
} from "../coding/mcp-token.js";
import { MCP_FORWARD_MAX_MS } from "../providers/coding-proxy/mcp-route.js";
import { DEFAULT_TOOL_MAX_TIMEOUT_MS } from "../sandbox/tool-timeout.js";
import {
  INJECTED_MCP_TOKEN_PLACEHOLDER,
  MCP_TOKEN_ENV,
  MCP_TOKEN_HEADER,
  readMcpConfig,
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
    expect(readMcpConfig({})).toBeUndefined();
    expect(readMcpConfig({ WARDBY_MCP_TOKEN: "" })).toBeUndefined();
    expect(readMcpConfig({ WARDBY_MCP_TOKEN: "rmt_fake_token_value" })).toStrictEqual({
      token: "rmt_fake_token_value",
    });
  });

  it("reads header mode only with the placeholder token", () => {
    expect(
      readMcpConfig({
        WARDBY_MCP_TOKEN: "rmt_placeholder_injected_by_gateway",
        WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token",
      }),
    ).toStrictEqual({ token: "rmt_placeholder_injected_by_gateway", header: "x-wardby-mcp-token" });
  });

  const realToken = "rmt_" + "A".repeat(43);
  it.each([
    ["a real token", { WARDBY_MCP_TOKEN: realToken, WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token" }],
    ["no token", { WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token" }],
    [
      "the authorization header",
      { WARDBY_MCP_TOKEN: "rmt_placeholder_injected_by_gateway", WARDBY_MCP_TOKEN_HEADER: "authorization" },
    ],
    [
      "a header not in lower case",
      { WARDBY_MCP_TOKEN: "rmt_placeholder_injected_by_gateway", WARDBY_MCP_TOKEN_HEADER: "X-Wardby-Mcp-Token" },
    ],
  ])("refuses header mode with %s, naming no value", (_label, env) => {
    let error: unknown;
    try {
      readMcpConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("worker_mcp_header_needs_placeholder");
    expect(String(error)).not.toContain(realToken);
  });

  it("matches the control plane's header and placeholder", () => {
    expect(MCP_TOKEN_HEADER).toBe(CONTROL_PLANE_HEADER);
    expect(INJECTED_MCP_TOKEN_PLACEHOLDER).toBe(CONTROL_PLANE_PLACEHOLDER);
    expect(isMcpToken(INJECTED_MCP_TOKEN_PLACEHOLDER)).toBe(false);
  });

  it("words the prompt note for both workers without naming any other tool", () => {
    expect(WARDBY_MCP_INSTRUCTIONS).toContain("wardby_mcp");
    expect(WARDBY_MCP_INSTRUCTIONS).toContain("untrusted data");
  });
});
