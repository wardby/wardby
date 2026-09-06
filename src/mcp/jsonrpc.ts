/**
 * JSON-RPC 2.0 envelope types, re-exported from the real MCP SDK rather than
 * hand-rolled: @modelcontextprotocol/server already implements the
 * 2026-07-28 wire format (including the stateless per-request `_meta`
 * envelope), and hand-rolling a second, subtly-incompatible copy would be
 * pure risk for no benefit.
 */
export type { JSONRPCMessage, JSONRPCRequest, JSONRPCNotification } from "@modelcontextprotocol/server";
