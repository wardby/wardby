import { readFileSync } from "node:fs";
import { MCP_PROTOCOL_VERSION, findResponse, hasServerRequest } from "./jsonrpc.js";
import { McpServerInputError } from "../resource-url.js";

/** The package version, sent as the client version (package.json sits three levels up from src/core/mcp-client and dist/core/mcp-client). */
const CLIENT_VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const MAX_PAGES = 20;
const MAX_TOOLS = 500;
const MAX_ERROR_MESSAGE_CHARS = 500;

export interface McpHttpRequest {
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}
export interface McpHttpResponse {
  status: number;
  /** Header names are lower-case. */
  headers: Record<string, string>;
  body: string;
}
/** The transport: in production brokeredFetch + safeFetch; in tests a fake. Throws only for network-level failures. */
export type McpFetch = (request: McpHttpRequest, signal: AbortSignal) => Promise<McpHttpResponse>;

export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion: string;
}

export class McpClientError extends Error {
  constructor(
    readonly code: "mcp_server_unreachable" | "mcp_server_auth_failed" | "mcp_server_error" | "mcp_call_timeout",
    message: string,
  ) {
    super(message);
    this.name = "McpClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class McpHttpClient {
  private readonly fetchImpl: McpFetch;
  private readonly signal: AbortSignal;
  private nextId = 1;
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  constructor(options: { fetch: McpFetch; signal: AbortSignal }) {
    this.fetchImpl = options.fetch;
    this.signal = options.signal;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId !== undefined) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion !== undefined) headers["MCP-Protocol-Version"] = this.protocolVersion;
    return headers;
  }

  /** One POST. Maps transport failures and HTTP errors to McpClientError; never puts a body or header value in a message. */
  private async post(payload: Record<string, unknown>): Promise<McpHttpResponse> {
    let response: McpHttpResponse;
    try {
      response = await this.fetchImpl(
        { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", ...payload }) },
        this.signal,
      );
    } catch (error) {
      // Wardby's own fixed-message input error (an OAuth secret that needs connecting again, say):
      // the caller maps it, hiding the owner's detail from a grantee.
      if (error instanceof McpServerInputError) throw error;
      const message = error instanceof Error ? error.message : "";
      if (this.signal.aborted || message.startsWith("fetch_cancelled_or_timeout")) {
        throw new McpClientError("mcp_call_timeout", "The MCP server call timed out or was cancelled.");
      }
      throw new McpClientError("mcp_server_unreachable", "The MCP server could not be reached.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new McpClientError(
        "mcp_server_auth_failed",
        `The MCP server refused the credentials (HTTP ${response.status}).`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new McpClientError("mcp_server_error", `The MCP server answered with HTTP ${response.status}.`);
    }
    return response;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ result: unknown; response: McpHttpResponse }> {
    const id = this.nextId++;
    const response = await this.post({ id, method, params });
    const contentType = response.headers["content-type"];
    const found = findResponse(response.body, contentType, id);
    if (found === undefined) {
      if (hasServerRequest(response.body, contentType)) {
        throw new McpClientError(
          "mcp_server_error",
          "The MCP server asked for something Wardby doesn't support (sampling, elicitation or roots).",
        );
      }
      throw new McpClientError("mcp_server_unreachable", "The MCP server sent no response to the request.");
    }
    // Any error member, even a malformed one ("error": null, a string), fails the call: never a TypeError.
    const replyError: unknown = found.error;
    if (replyError !== undefined) {
      const text =
        isRecord(replyError) && typeof replyError.message === "string" ? replyError.message : "unknown error";
      throw new McpClientError(
        "mcp_server_error",
        `The MCP server returned an error: ${text.slice(0, MAX_ERROR_MESSAGE_CHARS)}`,
      );
    }
    return { result: found.result, response };
  }

  async initialize(): Promise<McpServerInfo> {
    const { result, response } = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wardby", version: CLIENT_VERSION },
    });
    const sessionId = response.headers["mcp-session-id"];
    if (sessionId !== undefined && sessionId !== "") this.sessionId = sessionId;
    const body = isRecord(result) ? result : {};
    const protocolVersion = typeof body.protocolVersion === "string" ? body.protocolVersion : MCP_PROTOCOL_VERSION;
    this.protocolVersion = protocolVersion;
    await this.post({ method: "notifications/initialized" });
    const serverInfo = isRecord(body.serverInfo) ? body.serverInfo : {};
    const info: McpServerInfo = { protocolVersion };
    if (typeof serverInfo.name === "string") info.name = serverInfo.name;
    if (typeof serverInfo.version === "string") info.version = serverInfo.version;
    return info;
  }

  async listTools(): Promise<McpToolEntry[]> {
    const tools: McpToolEntry[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { result } = await this.request("tools/list", cursor === undefined ? {} : { cursor });
      const body = isRecord(result) ? result : {};
      for (const entry of Array.isArray(body.tools) ? body.tools : []) {
        if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.inputSchema)) continue;
        const tool: McpToolEntry = {
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
          inputSchema: entry.inputSchema,
        };
        if (isRecord(entry.annotations)) tool.annotations = entry.annotations;
        tools.push(tool);
      }
      if (tools.length >= MAX_TOOLS) return tools.slice(0, MAX_TOOLS);
      cursor = typeof body.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { result } = await this.request("tools/call", { name, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    if (this.sessionId === undefined) return;
    try {
      await this.fetchImpl({ method: "DELETE", headers: this.headers() }, this.signal);
    } catch {
      // Closing is best effort.
    }
  }
}
