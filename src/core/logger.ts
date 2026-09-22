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
import { redactTokenShapedValues } from "../coding/protocol.js";

/**
 * Redacting `err` serializer. pino's default one walks `cause` and folds it
 * into `message`/`stack`, so any error whose cause carries a credential — a
 * transport failure quoting a git remote with a `ghs_` token in it, say —
 * would reach the log verbatim. There are ~19 `{ err }` sites; none is on such
 * a path *today*, but that is a property of the current call graph, not of the
 * errors, so redact centrally instead of auditing paths. Same patterns as
 * `describeFailure` (both go through `redactTokenShapedValues`).
 */
function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactTokenShapedValues(value);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, depth + 1)]));
}

function redactErr(error: unknown): unknown {
  // `type`/`message`/`stack` are strings (the cause chain is folded into the
  // last two); an AggregateError adds `aggregateErrors`, hence the walk.
  return redactDeep(pino.stdSerializers.err(error as Error));
}

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? "info", serializers: { err: redactErr } },
  pino.destination({ fd: 2, sync: false }),
);

export type Logger = typeof logger;
