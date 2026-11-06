import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { mcpTokenHash, mintMcpToken } from "../coding/mcp-token.js";
import { HTTP_LIMITS } from "../mcp/transport/http-limits.js";
import type { Logger } from "./logger.js";
import type { McpToolContext, McpToolPin } from "./mcp-tools.js";

const handleMcpTool = vi.fn<(pin: McpToolPin, argsJson: string, ctx: McpToolContext) => Promise<string>>();
vi.mock("./mcp-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-tools.js")>();
  return { ...actual, handleMcpTool: (...args: Parameters<typeof actual.handleMcpTool>) => handleMcpTool(...args) };
});

const { handleCodingMcpRequest, isMcpErrorText, isMcpToolPin, storedPins } = await import("./coding-mcp.js");

const TOKEN = mintMcpToken();
const PIN: McpToolPin = {
  exposedName: "datadog__search",
  toolName: "search",
  serverId: "srv-1",
  serverName: "datadog",
  definition: { description: "Searches logs.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
};

interface FakeSession {
  id: string;
  runId: string;
  status: string;
  deadlineAt: Date;
  mcpTools: unknown;
  mcpTokenHash: string;
  mcpCallCount: number;
  run: { provider: string };
}

function fakeDb(session: Partial<FakeSession> = {}) {
  const row: FakeSession = {
    id: "sess-1",
    runId: "run-1",
    status: "active",
    deadlineAt: new Date(Date.now() + 60_000),
    mcpTools: [PIN],
    mcpTokenHash: mcpTokenHash(TOKEN),
    mcpCallCount: 0,
    run: { provider: "claude-code" },
    ...session,
  };
  const counts: { sql: string; values: unknown[] }[] = [];
  const db = {
    codingProxySession: {
      findUnique: vi.fn(async ({ where }: { where: { mcpTokenHash: string } }) =>
        where.mcpTokenHash === row.mcpTokenHash ? row : null,
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      counts.push({ sql: strings.join("$"), values });
      const [id, limit] = values as [string, number];
      if (id !== row.id || row.mcpCallCount >= limit) return [];
      row.mcpCallCount += 1;
      return [{ mcpCallCount: row.mcpCallCount }];
    }),
    run: {
      findUnique: vi.fn(async () => ({ agentId: "agent-1", status: "running" })),
    },
    task: { findFirst: vi.fn(async () => null) },
  };
  return { db: db as unknown as PrismaClient, row, counts };
}

function fakeLog() {
  const info = vi.fn();
  return { log: { info, warn: vi.fn(), error: vi.fn() } as unknown as Logger, info };
}

const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };

const NO_AUTH: unique symbol = Symbol("no auth");
function call(
  db: PrismaClient,
  body: unknown,
  authorization: string | typeof NO_AUTH = `Bearer ${TOKEN}`,
  now?: () => Date,
) {
  const auth = authorization === NO_AUTH ? undefined : authorization;
  const { log, info } = fakeLog();
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return handleCodingMcpRequest(auth, raw, { db, cipher, log, now }).then((res) => ({ res, info }));
}

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });
const parsed = (body: string) => JSON.parse(body) as { id?: unknown; result?: any; error?: { code: number } };

const env = { ...process.env };
beforeEach(() => {
  handleMcpTool.mockReset();
});
afterEach(() => {
  process.env = { ...env };
});

describe("handleCodingMcpRequest: authentication", () => {
  it.each<[string, string | typeof NO_AUTH]>([
    ["missing", NO_AUTH],
    ["not a bearer", `Basic ${TOKEN}`],
    ["malformed", "Bearer rmt_short"],
    ["a run capability", `Bearer rrp_${"a".repeat(43)}`],
    ["unknown", `Bearer ${mintMcpToken()}`],
  ])("refuses a %s bearer with 401 and no WWW-Authenticate", async (_label, auth) => {
    const { db } = fakeDb();
    const { res } = await call(db, rpc("tools/list"), auth);
    expect(res.status).toBe(401);
    expect(res).not.toHaveProperty("headers");
    expect(Object.keys(res).sort()).toEqual(["body", "contentType", "status"]);
    expect(res.body).not.toContain(TOKEN);
  });

  it.each(["cancelled", "finished", "expired"])("refuses a session that is %s", async (status) => {
    const { db } = fakeDb({ status });
    expect((await call(db, rpc("tools/list"))).res.status).toBe(401);
  });

  it("refuses a session at or past its deadline", async () => {
    const deadlineAt = new Date("2026-11-06T12:00:00Z");
    const { db } = fakeDb({ deadlineAt });
    expect((await call(db, rpc("tools/list"), `Bearer ${TOKEN}`, () => deadlineAt)).res.status).toBe(401);
    const before = new Date(deadlineAt.getTime() - 1);
    expect((await call(db, rpc("tools/list"), `Bearer ${TOKEN}`, () => before)).res.status).toBe(200);
  });

  it("looks the token up by its hash only", async () => {
    const { db } = fakeDb();
    await call(db, rpc("tools/list"));
    expect(JSON.stringify((db.codingProxySession.findUnique as any).mock.calls)).not.toContain(TOKEN);
  });
});

describe("handleCodingMcpRequest: protocol", () => {
  it("answers initialize with the client's protocol version, tools capability and server info", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} }));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/json");
    const body = parsed(res.body);
    expect(body.id).toBe(1);
    expect(body.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "wardby", version: expect.any(String) },
    });
    expect(res.body).not.toMatch(/mcp-session-id/i);
  });

  it("defaults the protocol version to 2025-06-18", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, rpc("initialize", {}));
    expect(parsed(res.body).result.protocolVersion).toBe("2025-06-18");
  });

  it("accepts a notification with 202 and an empty body", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.body).toBe("");
  });

  it("lists the session's pins as MCP tools, the same description a native run sees", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, rpc("tools/list"));
    expect(parsed(res.body).result).toEqual({
      tools: [
        {
          name: "datadog__search",
          description: "From MCP server datadog: Searches logs.",
          inputSchema: PIN.definition.inputSchema,
        },
      ],
    });
  });

  it("leaves malformed stored pins out of the list", async () => {
    const { db } = fakeDb({
      mcpTools: [PIN, { exposedName: "bad", toolName: "x", serverId: "s" }, "junk", { ...PIN }],
    });
    const { res } = await call(db, rpc("tools/list"));
    expect(parsed(res.body).result.tools.map((t: { name: string }) => t.name)).toEqual(["datadog__search"]);
  });

  it("lists nothing when the session has no pins", async () => {
    const { db } = fakeDb({ mcpTools: null });
    const { res } = await call(db, rpc("tools/list"));
    expect(parsed(res.body).result).toEqual({ tools: [] });
  });

  it.each(["server/discover", "resources/list", "prompts/list"])(
    "answers the unknown method %s with -32601",
    async (method) => {
      const { db } = fakeDb();
      const { res } = await call(db, rpc(method));
      expect(parsed(res.body).error?.code).toBe(-32601);
    },
  );

  it("answers unparseable JSON with -32700", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, "{not json");
    expect(res.status).toBe(400);
    expect(parsed(res.body).error?.code).toBe(-32700);
  });

  it("refuses a batch and a message without a method", async () => {
    const { db } = fakeDb();
    expect(parsed((await call(db, [rpc("tools/list")])).res.body).error?.code).toBe(-32600);
    expect(parsed((await call(db, { jsonrpc: "2.0", id: 1 })).res.body).error?.code).toBe(-32600);
  });

  it("refuses a body over the JSON limit with 413", async () => {
    const { db } = fakeDb();
    const { res } = await call(db, "x".repeat(HTTP_LIMITS.json + 1));
    expect(res.status).toBe(413);
  });

  it("logs the method, status and session id only", async () => {
    const { db } = fakeDb();
    handleMcpTool.mockResolvedValue("ok");
    const { info } = await call(db, rpc("tools/call", { name: "datadog__search", arguments: { q: "arg-value" } }));
    const routeLines = info.mock.calls.filter((c) => c[1] === "coding mcp request");
    expect(routeLines).toHaveLength(1);
    expect(routeLines[0][0]).toEqual({ method: "tools/call", status: 200, sessionId: "sess-1" });
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(info.mock.calls)).not.toContain("arg-value");
  });

  it("logs an unknown method as other, never the client's own text", async () => {
    const { db } = fakeDb();
    const { info } = await call(db, rpc(`x/${TOKEN}`));
    expect(info.mock.calls[0][0]).toEqual({ method: "other", status: 200, sessionId: "sess-1" });
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
  });

  it("answers an unexpected failure with a generic -32603 and logs no detail", async () => {
    const { db } = fakeDb();
    (db.codingProxySession.findUnique as any).mockRejectedValue(new Error(`boom ${TOKEN}`));
    const { res, info } = await call(db, rpc("tools/list"));
    expect(res.status).toBe(500);
    expect(parsed(res.body).error?.code).toBe(-32603);
    expect(res.body).not.toContain("boom");
    expect(JSON.stringify(info.mock.calls)).not.toContain(TOKEN);
  });
});

describe("handleCodingMcpRequest: tools/call", () => {
  it("refuses an unknown tool name as an isError result, without counting it", async () => {
    const { db, row } = fakeDb();
    const { res } = await call(db, rpc("tools/call", { name: "other__tool", arguments: {} }));
    const result = parsed(res.body).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: "mcp_tool_not_allowed" });
    expect(handleMcpTool).not.toHaveBeenCalled();
    expect(row.mcpCallCount).toBe(0);
  });

  it("runs a pinned tool through handleMcpTool with the run's agent, run, deadline and stop signal", async () => {
    const { db, row } = fakeDb();
    handleMcpTool.mockResolvedValue("found 3 errors");
    const { res } = await call(db, rpc("tools/call", { name: "datadog__search", arguments: { q: "errors" } }));
    expect(parsed(res.body).result).toEqual({ content: [{ type: "text", text: "found 3 errors" }] });
    expect(handleMcpTool).toHaveBeenCalledTimes(1);
    const [pin, argsJson, ctx] = handleMcpTool.mock.calls[0];
    expect(pin).toEqual(PIN);
    expect(JSON.parse(argsJson)).toEqual({ q: "errors" });
    expect(ctx).toMatchObject({ agentId: "agent-1", runId: "run-1", deadlineAt: row.deadlineAt, cipher });
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(row.mcpCallCount).toBe(1);
  });

  it("passes no arguments as an empty string, which handleMcpTool reads as {}", async () => {
    const { db } = fakeDb();
    handleMcpTool.mockResolvedValue("ok");
    await call(db, rpc("tools/call", { name: "datadog__search" }));
    expect(handleMcpTool.mock.calls[0][1]).toBe("");
  });

  it("flags handleMcpTool's JSON error as an isError result", async () => {
    const { db } = fakeDb();
    const text = JSON.stringify({ error: "mcp_call_timeout", message: "The call was stopped." });
    handleMcpTool.mockResolvedValue(text);
    const { res } = await call(db, rpc("tools/call", { name: "datadog__search", arguments: {} }));
    expect(parsed(res.body).result).toEqual({ content: [{ type: "text", text }], isError: true });
  });

  it("counts calls atomically and refuses past the limit with mcp_call_limit", async () => {
    process.env.WARDBY_MCP_MAX_CALLS_PER_RUN = "2";
    const { db, row, counts } = fakeDb();
    handleMcpTool.mockResolvedValue("ok");
    for (let i = 0; i < 2; i++) {
      const { res } = await call(db, rpc("tools/call", { name: "datadog__search", arguments: {} }));
      expect(parsed(res.body).result.isError).toBeUndefined();
    }
    const { res } = await call(db, rpc("tools/call", { name: "datadog__search", arguments: {} }));
    const result = parsed(res.body).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: "mcp_call_limit",
      message: "This run reached its limit of 2 MCP tool calls.",
    });
    expect(handleMcpTool).toHaveBeenCalledTimes(2);
    expect(row.mcpCallCount).toBe(2);
    expect(counts[0].sql).toMatch(/"mcpCallCount" = "mcpCallCount" \+ 1/);
    expect(counts[0].sql).toMatch(/"mcpCallCount" < \$/);
    expect(counts[0].sql).toMatch(/RETURNING/);
  });
});

describe("helpers", () => {
  it("isMcpErrorText recognises only the { error, message } shape", () => {
    expect(isMcpErrorText(JSON.stringify({ error: "mcp_server_error", message: "x" }))).toBe(true);
    expect(isMcpErrorText(JSON.stringify({ error: "x", message: "y", extra: 1 }))).toBe(false);
    expect(isMcpErrorText(JSON.stringify({ error: "Not A Code", message: "y" }))).toBe(false);
    expect(isMcpErrorText("plain text")).toBe(false);
    expect(isMcpErrorText("{broken")).toBe(false);
  });

  it("isMcpToolPin checks every field", () => {
    expect(isMcpToolPin(PIN)).toBe(true);
    expect(isMcpToolPin({ ...PIN, callTimeoutMs: 5000 })).toBe(true);
    expect(isMcpToolPin({ ...PIN, callTimeoutMs: -1 })).toBe(false);
    expect(isMcpToolPin({ ...PIN, definition: { description: "x" } })).toBe(false);
    expect(isMcpToolPin({ ...PIN, definition: { description: "x", inputSchema: [] } })).toBe(false);
    expect(isMcpToolPin({ ...PIN, serverName: 3 })).toBe(false);
    expect(isMcpToolPin(null)).toBe(false);
  });

  it("storedPins keeps the first of each exposed name", () => {
    expect(storedPins([PIN, { ...PIN, toolName: "other" }])).toEqual([PIN]);
    expect(storedPins({})).toEqual([]);
  });
});
