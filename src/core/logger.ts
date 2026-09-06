/**
 * Structured logging (pino) for server-side/background code — the
 * scheduler, reconciler, engine, HTTP transport, and the sandbox's tool
 * console bridge. Writes to fd 2 (stderr) unconditionally: stdout is the
 * JSON-RPC wire in stdio MCP mode (see mcp/transport/stdio.ts), and the
 * scheduler/reconciler/engine can run inside that same process — a log
 * line on stdout there would corrupt every connected client's protocol
 * stream (this repo has already fixed exactly that class of bug once,
 * for the CLI's own output — see cli.ts's stdout/stderr split).
 */
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" }, pino.destination({ fd: 2, sync: false }));

export type Logger = typeof logger;
