// A recording streamable-HTTP MCP server for the coding-agent compatibility tests: it shows how a
// pinned Codex CLI or Claude Code sends its MCP headers. It records booleans and the JSON-RPC
// method only, never a header value.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Booleans and the JSON-RPC method only: never a header value. */
export interface McpStubObservation {
  method: string;
  hasAuthorization: boolean;
  /** authorization === `Bearer ${placeholder}` */
  authorizationIsPlaceholderBearer: boolean;
  /** request.headers["x-wardby-mcp-token"] === placeholder */
  tokenHeaderIsPlaceholder: boolean;
}

const ECHO_TOOL = {
  name: "echo",
  description: "Echo the text back.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  annotations: { readOnlyHint: true },
};

/** A streamable-HTTP MCP server on 127.0.0.1:0 that answers every POST (any auth) with one read-only `echo` tool. */
export async function startRecordingMcpServer(
  placeholder: string,
): Promise<{ url: string; observed: McpStubObservation[]; close(): Promise<void> }> {
  const observed: McpStubObservation[] = [];
  const record = (request: IncomingMessage, method: string): void => {
    const authorization = request.headers.authorization;
    observed.push({
      method,
      hasAuthorization: authorization !== undefined,
      authorizationIsPlaceholderBearer: authorization === `Bearer ${placeholder}`,
      tokenHeaderIsPlaceholder: request.headers["x-wardby-mcp-token"] === placeholder,
    });
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== "POST") {
      // A GET (server-sent stream) or DELETE (session end): recorded too, so every request's headers count.
      record(request, `http:${request.method ?? "unknown"}`);
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let message: { id?: number | string; method?: string; params?: { arguments?: { text?: string } } };
    try {
      message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof message;
    } catch {
      record(request, "invalid-json");
      response.writeHead(400).end();
      return;
    }
    record(request, message.method ?? "response");
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } }
        : message.method === "tools/list"
          ? { tools: [ECHO_TOOL] }
          : message.method === "tools/call"
            ? { content: [{ type: "text", text: `ECHO:${message.params?.arguments?.text ?? ""}` }] }
            : undefined;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          result
            ? { jsonrpc: "2.0", id: message.id, result }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } },
        ),
      );
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
