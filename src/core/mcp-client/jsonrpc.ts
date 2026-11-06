/** JSON-RPC framing for MCP's Streamable HTTP transport: reads a JSON or SSE response body. */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcResponse {
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Every JSON-RPC message in a body: a JSON value (object or batch array) or the `data:` frames of an SSE stream. */
function messages(body: string, contentType: string | undefined): Record<string, unknown>[] {
  const parsed: unknown[] = [];
  const isSse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (isSse) {
    for (const frame of body.split(/\r?\n\r?\n/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => {
          const value = line.slice(5);
          return value.startsWith(" ") ? value.slice(1) : value;
        });
      if (data.length === 0) continue;
      try {
        parsed.push(JSON.parse(data.join("\n")));
      } catch {
        // A malformed frame is skipped.
      }
    }
  } else {
    try {
      parsed.push(JSON.parse(body));
    } catch {
      // Not JSON: no messages.
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const value of parsed) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/** Finds the response to `id` in a JSON body or an SSE body. Ignores notifications and server requests. */
export function findResponse(body: string, contentType: string | undefined, id: number): JsonRpcResponse | undefined {
  for (const message of messages(body, contentType)) {
    if (message.id === id && !("method" in message)) return message as unknown as JsonRpcResponse;
  }
  return undefined;
}

/** True when the body carried a server-to-client request (has `method` and `id`): we answer none of them. */
export function hasServerRequest(body: string, contentType: string | undefined): boolean {
  return messages(body, contentType).some(
    (message) => typeof message.method === "string" && message.id !== undefined && message.id !== null,
  );
}
