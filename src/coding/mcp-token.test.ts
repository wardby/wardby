import { describe, expect, it } from "vitest";
import { capabilityHash } from "../providers/coding-proxy/proxy.js";
import { isMcpToken, MCP_TOKEN_ENV, mcpTokenHash, mintMcpToken } from "./mcp-token.js";

describe("MCP token", () => {
  it("mints rmt_ followed by 32 random bytes in base64url", () => {
    expect(mintMcpToken()).toMatch(/^rmt_[A-Za-z0-9_-]{43}$/);
  });

  it("recognizes only the minted shape", () => {
    expect(isMcpToken(mintMcpToken())).toBe(true);
    for (const value of [
      undefined,
      "",
      "rmt_short",
      `rrp_${"a".repeat(43)}`,
      `rmt_${"a".repeat(44)}`,
      `rmt_${"a".repeat(42)}!`,
    ]) {
      expect(isMcpToken(value)).toBe(false);
    }
  });

  it("mints a different token each time", () => {
    expect(mintMcpToken()).not.toBe(mintMcpToken());
  });

  it("hashes deterministically, the same way as the run capability", () => {
    const token = `rmt_${"a".repeat(43)}`;
    expect(mcpTokenHash(token)).toBe(mcpTokenHash(token));
    expect(mcpTokenHash(token)).toBe(capabilityHash(token));
    expect(mcpTokenHash(token)).not.toContain(token);
  });

  it("is delivered as WARDBY_MCP_TOKEN", () => {
    expect(MCP_TOKEN_ENV).toBe("WARDBY_MCP_TOKEN");
  });
});
