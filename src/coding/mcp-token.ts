/**
 * A coding run's MCP token (remote MCP servers, phase 2): the worker's bearer for the proxy's /mcp
 * route only. The control plane mints one per run whose agent has MCP tools, stores only its hash
 * on the proxy session, keeps the value in the run capability vault for the launch, and delivers it
 * as WARDBY_MCP_TOKEN (never in a job spec, command line, or log).
 */
import { randomBytes } from "node:crypto";
import { capabilityHash } from "../providers/coding-proxy/capability-hash.js";

export const MCP_TOKEN_ENV = "WARDBY_MCP_TOKEN";

/** Exactly what mintMcpToken makes; launchers refuse to deliver anything else. */
export function isMcpToken(value: string | undefined): value is string {
  return value !== undefined && /^rmt_[A-Za-z0-9_-]{43}$/.test(value);
}

/** `rmt_` followed by 32 random bytes in base64url. */
export function mintMcpToken(): string {
  return `rmt_${randomBytes(32).toString("base64url")}`;
}

/** The token's stored form: the same SHA-256 (base64url) the run capability uses. */
export function mcpTokenHash(token: string): string {
  return capabilityHash(token);
}
