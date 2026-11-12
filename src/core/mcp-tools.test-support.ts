/**
 * A fake Streamable-HTTP MCP server behind the safeFetch seam (providers.sandboxFetch): answers
 * initialize with a session id, accepts notifications and DELETE, and serves tools/call via `onCall`.
 * Records each request's method and Authorization header.
 */
import type { safeFetch } from "../sandbox/safe-fetch.js";

export type CallHandler = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => unknown;

/** A Streamable-HTTP MCP server as a safeFetch stand-in: JSON responses, a session id, tools/call via `onCall`. */
export function fakeMcpServer(
  onCall: CallHandler,
  options: { status?: number; headers?: Record<string, string> } = {},
) {
  const seen: { method?: string; authorization?: string }[] = [];
  const impl = (async (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
    policy?: { signal?: AbortSignal },
  ) => {
    const body = init?.body ? (JSON.parse(init.body) as { id?: number; method?: string; params?: any }) : {};
    seen.push({
      method: init?.method === "DELETE" ? "DELETE" : body.method,
      authorization: init?.headers?.authorization,
    });
    const reply = (status: number, payload: unknown) => ({
      ok: status < 300,
      status,
      statusText: "",
      url,
      headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1", ...options.headers },
      bodyBase64: Buffer.from(payload === undefined ? "" : JSON.stringify(payload)).toString("base64"),
    });
    if (options.status !== undefined) return reply(options.status, undefined);
    if (init?.method === "DELETE" || body.id === undefined) return reply(202, undefined);
    if (body.method === "initialize") {
      return reply(200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } },
      });
    }
    const result = await onCall(body.params.name, body.params.arguments, policy?.signal);
    return reply(200, { jsonrpc: "2.0", id: body.id, result });
  }) as unknown as typeof safeFetch;
  return { impl, seen };
}

export const textResult = (text: string) => ({ content: [{ type: "text", text }] });
