/**
 * The native gateway's /coding-mcp route (remote MCP servers, phase 2): a stateless Streamable HTTP
 * MCP server that runs a coding run's MCP tool calls. The worker reaches it only through the coding
 * proxy's /mcp route, which forwards the request and the run's MCP token (`rmt_…`) unchanged; the
 * proxy is not trusted, so the token is checked here again: its hash must name a proxy session that
 * is active and before its deadline.
 *
 * tools/list serves the session's pins (no URLs or secrets); tools/call counts the call against the
 * run's limit (WARDBY_MCP_MAX_CALLS_PER_RUN) and runs it through phase 1's handleMcpTool, which
 * re-checks the live attachment and redacts the result against the server's secrets before it gets
 * here. Secrets: this route's own log line carries the method, status and session id only (never the
 * body, arguments, results or token), and every body it sends is either fixed text, the pins, or
 * handleMcpTool's already-redacted string.
 */
import { readFileSync } from "node:fs";
import type { PrismaClient } from "#prisma";
import { loadMcpMaxCallsPerRun } from "../config/mcp-call-limit.js";
import { MCP_TOKEN_REQUIRED_MESSAGE, mcpTokenHash, isMcpToken } from "../coding/mcp-token.js";
import { HTTP_LIMITS } from "../mcp/transport/http-limits.js";
import type { SecretCipher } from "../providers/secrets/types.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import type { Logger } from "./logger.js";
import { handleMcpTool, mcpToolDefs, type McpToolPin } from "./mcp-tools.js";
import { TOOL_STOP_POLL_MS, watchRunStop } from "./runner.js";

export const CODING_MCP_PATH = "/coding-mcp";

/** What initialize answers when the client names no protocol version. */
export const CODING_MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** The package version, reported in server info (package.json sits two levels up from src/core and dist/core). */
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export interface CodingMcpDeps {
  db: PrismaClient;
  cipher: SecretCipher;
  fetchImpl?: typeof safeFetch;
  log: Logger;
  now?: () => Date;
  /** How often a call in flight checks for stop_run; tests shorten it. */
  stopPollMs?: number;
}

export interface CodingMcpResponse {
  status: number;
  body: string;
  contentType: string;
}

type JsonRpcId = string | number | null;

const LOGGED_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "notifications/initialized",
  "notifications/cancelled",
]);

const JSON_TYPE = "application/json";

const reply = (status: number, payload: unknown): CodingMcpResponse => ({
  status,
  body: payload === undefined ? "" : JSON.stringify(payload),
  contentType: JSON_TYPE,
});
const rpcResult = (id: JsonRpcId, result: unknown) => reply(200, { jsonrpc: "2.0", id, result });
const rpcError = (status: number, id: JsonRpcId, code: number, message: string) =>
  reply(status, { jsonrpc: "2.0", id, error: { code, message } });

/** An MCP tool result: the text handleMcpTool returned, flagged when it is one of its JSON errors. */
const toolResult = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
const toolError = (code: string, message: string) => toolResult(JSON.stringify({ error: code, message }), true);

/**
 * True for handleMcpTool's error shape: exactly `{ error: <code>, message }`. A server result that
 * happens to have that very shape is flagged too; the model sees the same text either way.
 */
export function isMcpErrorText(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    const v = value as { error?: unknown; message?: unknown };
    return (
      keys.length === 2 &&
      typeof v.error === "string" &&
      /^[a-z][a-z0-9_]*$/.test(v.error) &&
      typeof v.message === "string"
    );
  } catch {
    return false;
  }
}

/** One stored pin, checked field by field: a malformed entry is left out, never served. */
export function isMcpToolPin(value: unknown): value is McpToolPin {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const definition = p.definition as Record<string, unknown> | null | undefined;
  return (
    typeof p.exposedName === "string" &&
    p.exposedName !== "" &&
    typeof p.toolName === "string" &&
    p.toolName !== "" &&
    typeof p.serverId === "string" &&
    p.serverId !== "" &&
    typeof p.serverName === "string" &&
    (p.callTimeoutMs === undefined ||
      (typeof p.callTimeoutMs === "number" && Number.isSafeInteger(p.callTimeoutMs) && p.callTimeoutMs > 0)) &&
    definition !== null &&
    typeof definition === "object" &&
    !Array.isArray(definition) &&
    typeof definition.description === "string" &&
    definition.inputSchema !== null &&
    typeof definition.inputSchema === "object" &&
    !Array.isArray(definition.inputSchema)
  );
}

/** The session's well-formed pins, first of each exposed name only. */
export function storedPins(stored: unknown): McpToolPin[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const pins: McpToolPin[] = [];
  for (const entry of stored) {
    if (!isMcpToolPin(entry) || seen.has(entry.exposedName)) continue;
    seen.add(entry.exposedName);
    pins.push(entry);
  }
  return pins;
}

interface Session {
  id: string;
  runId: string;
  deadlineAt: Date;
  mcpTools: unknown;
}

/** Handles one JSON-RPC request body for /coding-mcp. Never throws. */
export async function handleCodingMcpRequest(
  authorization: string | undefined,
  body: string,
  deps: CodingMcpDeps,
): Promise<CodingMcpResponse> {
  const seen: { method?: string; sessionId?: string } = {};
  let response: CodingMcpResponse;
  try {
    response = await handle(authorization, body, deps, seen);
  } catch {
    // Nothing of the error leaves: its message could carry anything the call touched.
    response = rpcError(500, null, -32603, "Internal error.");
  }
  // Method, status and session id only: never the body, the arguments, the result, or the token.
  deps.log.info({ method: seen.method, status: response.status, sessionId: seen.sessionId }, "coding mcp request");
  return response;
}

async function handle(
  authorization: string | undefined,
  body: string,
  deps: CodingMcpDeps,
  seen: { method?: string; sessionId?: string },
): Promise<CodingMcpResponse> {
  if (Buffer.byteLength(body, "utf8") > HTTP_LIMITS.json) {
    return rpcError(413, null, -32600, "The request body is too large.");
  }
  const session = await authenticate(authorization, deps);
  // No WWW-Authenticate: a client must not start OAuth discovery against this route.
  if (!session) return rpcError(401, null, -32001, MCP_TOKEN_REQUIRED_MESSAGE);
  seen.sessionId = session.id;

  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return rpcError(400, null, -32700, "Parse error.");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(400, null, -32600, "Invalid request: one JSON-RPC message per request.");
  }
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id: JsonRpcId = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return rpcError(400, id, -32600, "Invalid request.");
  }
  // The method is the client's own text: only a known one is logged, anything else as "other".
  seen.method = LOGGED_METHODS.has(m.method) ? m.method : "other";
  // A notification (no id) has no reply.
  if (m.id === undefined) return reply(202, undefined);
  if (id === null) return rpcError(400, null, -32600, "Invalid request: id must be a string or number.");

  switch (m.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: protocolVersionOf(m.params),
        capabilities: { tools: {} },
        serverInfo: { name: "wardby", version: SERVER_VERSION },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: mcpToolDefs(storedPins(session.mcpTools)).map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: def.jsonSchema,
        })),
      });
    case "tools/call":
      return rpcResult(id, await callTool(session, m.params, deps));
    default:
      return rpcError(200, id, -32601, "Method not found.");
  }
}

function protocolVersionOf(params: unknown): string {
  const requested = (params as { protocolVersion?: unknown } | null | undefined)?.protocolVersion;
  return typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested)
    ? requested
    : CODING_MCP_DEFAULT_PROTOCOL_VERSION;
}

async function authenticate(authorization: string | undefined, deps: CodingMcpDeps): Promise<Session | undefined> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!isMcpToken(token)) return undefined;
  const session = await deps.db.codingProxySession.findUnique({
    where: { mcpTokenHash: mcpTokenHash(token) },
    select: { id: true, runId: true, status: true, deadlineAt: true, mcpTools: true },
  });
  if (!session || session.status !== "active") return undefined;
  if ((deps.now?.() ?? new Date()).getTime() >= session.deadlineAt.getTime()) return undefined;
  return session;
}

async function callTool(session: Session, params: unknown, deps: CodingMcpDeps) {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof p.name === "string" ? p.name : "";
  const pin = storedPins(session.mcpTools).find((candidate) => candidate.exposedName === name);
  if (!pin) {
    return toolError("mcp_tool_not_allowed", `The tool "${name.slice(0, 128)}" is not one of this run's MCP tools.`);
  }
  const limit = loadMcpMaxCallsPerRun();
  const counted = await deps.db.$queryRaw<{ mcpCallCount: number }[]>`
    UPDATE "CodingProxySession" SET "mcpCallCount" = "mcpCallCount" + 1
    WHERE "id" = ${session.id} AND "mcpCallCount" < ${limit}
    RETURNING "mcpCallCount"
  `;
  if (counted.length === 0) {
    return toolError("mcp_call_limit", `This run reached its limit of ${limit} MCP tool calls.`);
  }
  const run = await deps.db.run.findUnique({ where: { id: session.runId }, select: { agentId: true } });
  if (!run) return toolError("mcp_tool_not_allowed", "This run no longer exists.");
  // As for a native run's call: a stop_run aborts the call in flight.
  const stop = watchRunStop(deps.db, session.runId, deps.stopPollMs ?? TOOL_STOP_POLL_MS);
  try {
    const text = await handleMcpTool(pin, p.arguments === undefined ? "" : JSON.stringify(p.arguments), {
      db: deps.db,
      cipher: deps.cipher,
      agentId: run.agentId,
      runId: session.runId,
      signal: stop.signal,
      deadlineAt: session.deadlineAt,
      fetchImpl: deps.fetchImpl,
      log: deps.log,
    });
    return toolResult(text, isMcpErrorText(text));
  } finally {
    stop.done();
  }
}
