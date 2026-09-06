/**
 * stdio transport: newline-delimited JSON-RPC over the process's standard
 * streams, no OAuth (per spec: stdio SHOULD NOT use OAuth — it retrieves
 * credentials from the environment). `serveStdio` (the real SDK's stdio
 * serving entry) owns era negotiation and per-connection instance
 * construction from `mcp.factory`; this file only wires the transport.
 *
 * Caller identity: stdio never carries per-message AuthInfo (serveStdio
 * never sets it), so the composition root (Task 15) must call
 * `mcp.setFixedContext(...)` with the resolved LOCAL_PRINCIPAL identity
 * BEFORE starting the stdio server — every tool call in the connection
 * resolves to that one fixed context, matching "the operator is trusted."
 */
import type { Readable, Writable } from "node:stream";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { ReevoMcpServer } from "../server.js";

export interface StdioIo {
  input?: Readable;
  output?: Writable;
}

export interface StdioHandle {
  close(): Promise<void>;
}

export function runStdioServer(mcp: ReevoMcpServer, io: StdioIo = {}): StdioHandle {
  const transport = new StdioServerTransport(io.input, io.output);
  const handle = serveStdio(mcp.factory, { transport });
  return { close: () => handle.close() };
}
