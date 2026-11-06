import { describe, expect, it } from "vitest";
import { loadMcpServersMode } from "./mcp-servers.js";

describe("loadMcpServersMode", () => {
  it("defaults to owners", () => {
    expect(loadMcpServersMode({})).toBe("owners");
    expect(loadMcpServersMode({ WARDBY_MCP_SERVERS: "  " })).toBe("owners");
  });
  it("accepts off, admins and owners, case-insensitively", () => {
    expect(loadMcpServersMode({ WARDBY_MCP_SERVERS: "off" })).toBe("off");
    expect(loadMcpServersMode({ WARDBY_MCP_SERVERS: "ADMINS" })).toBe("admins");
    expect(loadMcpServersMode({ WARDBY_MCP_SERVERS: " owners " })).toBe("owners");
  });
  it("refuses anything else, naming the variable", () => {
    expect(() => loadMcpServersMode({ WARDBY_MCP_SERVERS: "everyone" })).toThrow(
      'WARDBY_MCP_SERVERS must be off, admins or owners (got "everyone").',
    );
  });
});
