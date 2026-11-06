import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { McpClientError, McpHttpClient, type McpFetch, type McpHttpRequest, type McpHttpResponse } from "./client.js";

const version = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

function json(result: unknown, id: number, headers: Record<string, string> = {}): McpHttpResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, result }),
  };
}

function scripted(responses: (McpHttpResponse | Error)[]) {
  const calls: McpHttpRequest[] = [];
  const fetch: McpFetch = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const accepted: McpHttpResponse = { status: 202, headers: {}, body: "" };
const init = (id = 1) =>
  json({ protocolVersion: "2025-06-18", serverInfo: { name: "srv", version: "9" } }, id, {
    "mcp-session-id": "sess-1",
  });

async function code(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpClientError) return { code: error.code, message: error.message };
    throw error;
  }
  return {};
}

const live = () => new AbortController().signal;

describe("McpHttpClient.initialize", () => {
  it("sends initialize, keeps the session id, then posts initialized", async () => {
    const { fetch, calls } = scripted([init(), accepted]);
    const client = new McpHttpClient({ fetch, signal: live() });
    const info = await client.initialize();
    expect(info).toEqual({ name: "srv", version: "9", protocolVersion: "2025-06-18" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Accept).toBe("application/json, text/event-stream");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wardby", version } },
    });
    expect(JSON.parse(calls[1].body!)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(calls[1].headers["Mcp-Session-Id"]).toBe("sess-1");
    expect(calls[1].headers["MCP-Protocol-Version"]).toBe("2025-06-18");
  });
});

describe("McpHttpClient.listTools", () => {
  it("follows nextCursor and skips malformed entries", async () => {
    const { fetch, calls } = scripted([
      init(),
      accepted,
      json(
        {
          tools: [
            { name: "a", description: "A", inputSchema: { type: "object" } },
            { description: "no name", inputSchema: {} },
          ],
          nextCursor: "c2",
        },
        2,
      ),
      json(
        {
          tools: [
            { name: "b", inputSchema: { type: "object" } },
            { name: "bad", inputSchema: "x" },
          ],
        },
        3,
      ),
    ]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(tools[1].description).toBe("");
    expect(JSON.parse(calls[3].body!).params).toEqual({ cursor: "c2" });
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("sess-1");
  });

  it("stops at 20 pages", async () => {
    const script: (McpHttpResponse | Error)[] = [init(), accepted];
    for (let i = 0; i < 30; i++) {
      script.push(json({ tools: [{ name: `t${i}`, inputSchema: {} }], nextCursor: `c${i}` }, i + 2));
    }
    const { fetch, calls } = scripted(script);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    const tools = await client.listTools();
    expect(tools).toHaveLength(20);
    expect(calls).toHaveLength(22);
  });

  it("stops at 500 tools", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ name: `t${i}`, inputSchema: {} }));
    const { fetch } = scripted([
      init(),
      accepted,
      json({ tools: many, nextCursor: "c" }, 2),
      json({ tools: many.map((t) => ({ ...t, name: `u${t.name}` })) }, 3),
    ]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    expect(await client.listTools()).toHaveLength(500);
  });
});

describe("McpHttpClient.callTool", () => {
  it("sends tools/call and returns the raw result", async () => {
    const { fetch, calls } = scripted([init(), accepted, json({ content: [{ type: "text", text: "hi" }] }, 2)]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    const result = await client.callTool("echo", { q: 1 });
    expect(result).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(JSON.parse(calls[2].body!)).toMatchObject({
      method: "tools/call",
      params: { name: "echo", arguments: { q: 1 } },
    });
  });

  it("reads an SSE response", async () => {
    const sse: McpHttpResponse = {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":1}}\n\n',
    };
    const { fetch } = scripted([init(), accepted, sse]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    expect(await client.callTool("t", {})).toEqual({ ok: 1 });
  });
});

describe("McpHttpClient errors", () => {
  it.each([401, 403])("maps HTTP %i to mcp_server_auth_failed", async (status) => {
    const { fetch } = scripted([{ status, headers: {}, body: "secret-body" }]);
    const client = new McpHttpClient({ fetch, signal: live() });
    expect(await code(client.initialize())).toEqual({
      code: "mcp_server_auth_failed",
      message: `The MCP server refused the credentials (HTTP ${status}).`,
    });
  });

  it("maps other non-2xx to mcp_server_error without the body", async () => {
    const { fetch } = scripted([{ status: 500, headers: {}, body: "secret-body" }]);
    const client = new McpHttpClient({ fetch, signal: live() });
    const result = await code(client.initialize());
    expect(result.code).toBe("mcp_server_error");
    expect(result.message).toContain("HTTP 500");
    expect(result.message).not.toContain("secret-body");
  });

  it("maps a JSON-RPC error, truncating the message to 500 chars", async () => {
    const error: McpHttpResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "e".repeat(900) } }),
    };
    const { fetch } = scripted([error]);
    const client = new McpHttpClient({ fetch, signal: live() });
    const result = await code(client.initialize());
    expect(result.code).toBe("mcp_server_error");
    expect(result.message).toContain("e".repeat(500));
    expect(result.message).not.toContain("e".repeat(501));
  });

  it.each([null, "boom", 42])(
    "maps a malformed JSON-RPC error member (%j) to mcp_server_error, never a TypeError",
    async (value) => {
      const reply: McpHttpResponse = {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: value, result: {} }),
      };
      const { fetch } = scripted([reply]);
      const client = new McpHttpClient({ fetch, signal: live() });
      const result = await code(client.initialize());
      expect(result).toEqual({ code: "mcp_server_error", message: "The MCP server returned an error: unknown error" });
    },
  );

  it("maps a throwing fetch to mcp_server_unreachable without echoing the error", async () => {
    const { fetch } = scripted([new Error("ECONNREFUSED with-secret")]);
    const client = new McpHttpClient({ fetch, signal: live() });
    const result = await code(client.initialize());
    expect(result.code).toBe("mcp_server_unreachable");
    expect(result.message).not.toContain("with-secret");
  });

  it("maps a missing response to mcp_server_unreachable", async () => {
    const { fetch } = scripted([json({}, 99)]);
    const client = new McpHttpClient({ fetch, signal: live() });
    expect((await code(client.initialize())).code).toBe("mcp_server_unreachable");
  });

  it("maps fetch_cancelled_or_timeout to mcp_call_timeout", async () => {
    const { fetch } = scripted([new Error("fetch_cancelled_or_timeout")]);
    const client = new McpHttpClient({ fetch, signal: live() });
    expect((await code(client.initialize())).code).toBe("mcp_call_timeout");
  });

  it("maps an aborted signal to mcp_call_timeout", async () => {
    const controller = new AbortController();
    const fetch: McpFetch = (_request, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const client = new McpHttpClient({ fetch, signal: controller.signal });
    const pending = code(client.initialize());
    controller.abort();
    expect((await pending).code).toBe("mcp_call_timeout");
  });

  it("refuses a body that only carries a server request", async () => {
    const body: McpHttpResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":7,"method":"sampling/createMessage"}',
    };
    const { fetch } = scripted([body]);
    const client = new McpHttpClient({ fetch, signal: live() });
    expect(await code(client.initialize())).toEqual({
      code: "mcp_server_error",
      message: "The MCP server asked for something Wardby doesn't support (sampling, elicitation or roots).",
    });
  });
});

describe("McpHttpClient.close", () => {
  it("sends DELETE with the session id and swallows errors", async () => {
    const { fetch, calls } = scripted([init(), accepted, new Error("down")]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.initialize();
    await expect(client.close()).resolves.toBeUndefined();
    expect(calls[2].method).toBe("DELETE");
    expect(calls[2].headers["Mcp-Session-Id"]).toBe("sess-1");
  });

  it("does nothing without a session id", async () => {
    const { fetch, calls } = scripted([]);
    const client = new McpHttpClient({ fetch, signal: live() });
    await client.close();
    expect(calls).toHaveLength(0);
  });
});
