import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mcpTokenHash, mintMcpToken } from "../../coding/mcp-token.js";
import { HTTP_LIMITS } from "../../mcp/transport/http-limits.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { createMcpRoute, MCP_FORWARD_MAX_MS, mcpLogMethod } from "./mcp-route.js";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const GATEWAY = "http://gateway.test:8790";
const PIN = {
  exposedName: "github__list_issues",
  toolName: "list_issues",
  serverId: "server-1",
  serverName: "github",
  definition: { description: "List issues", inputSchema: { type: "object" } },
};

interface Recorded {
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as { mcp: Recorded[] };

/** A request as the route sees it: headers, method and a body stream. */
function request(
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): IncomingMessage {
  const body = init.body === undefined ? [] : [Buffer.from(init.body)];
  const stream = Readable.from(body) as unknown as IncomingMessage;
  return Object.assign(stream, {
    method: init.method ?? "POST",
    url: "/mcp",
    headers: { "content-type": "application/json", ...init.headers },
  });
}

/** Collects what the route writes. */
class Response extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);
  writableFinished = false;
  headersSent = false;
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  writeHead(status: number, headers: Record<string, string> = {}) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    return this;
  }
  end(chunk?: Buffer | string) {
    if (chunk !== undefined) this.body = Buffer.from(chunk);
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }
  json() {
    return JSON.parse(this.body.toString("utf8"));
  }
}

async function setup(
  options: {
    gatewayUrl?: string | undefined;
    deadlineAt?: Date;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  } = {},
) {
  const ledger = new MemoryProxyLedger({ now: () => NOW });
  const token = mintMcpToken();
  await ledger.createSession({
    id: "session-1",
    runId: "run-1",
    capabilityHash: "cap-hash",
    credentialRef: "anthropic/test",
    protocol: "anthropic-messages",
    allowedModels: ["claude-sonnet-5"],
    deadlineAt: options.deadlineAt ?? new Date(NOW.getTime() + 60 * 60_000),
    budgetUsd: 1,
    registryTokenHash: "registry-hash",
    mcpTools: [PIN],
    mcpTokenHash: mcpTokenHash(token),
  });
  const gateway = vi.fn(
    options.fetchImpl ??
      (async () =>
        new globalThis.Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })),
  );
  const logs: Record<string, unknown>[] = [];
  const route = createMcpRoute({
    ledger,
    gatewayUrl: "gatewayUrl" in options ? options.gatewayUrl : GATEWAY,
    fetchImpl: gateway,
    now: options.now ?? (() => NOW),
    log: { info: (fields: Record<string, unknown>) => void logs.push(fields) },
  });
  const call = async (init: Parameters<typeof request>[0] = {}) => {
    const res = new Response();
    await route(request(init), res as unknown as ServerResponse);
    return res;
  };
  const authorized = (body: string, headers: Record<string, string> = {}) =>
    call({ body, headers: { authorization: `Bearer ${token}`, ...headers } });
  return { ledger, token, gateway, logs, call, authorized };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("coding proxy /mcp route", () => {
  it("answers 503 mcp_unavailable when no gateway URL is configured", async () => {
    const h = await setup({ gatewayUrl: undefined });
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "mcp_unavailable", message: "MCP tools aren't available on this server." });
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["a capability instead of an MCP token", { authorization: "Bearer rrp_abc" }],
    ["an unknown MCP token", { authorization: `Bearer ${mintMcpToken()}` }],
    ["a basic credential", { authorization: "Basic dXNlcjpwYXNz" }],
  ])("refuses %s with 401 and no WWW-Authenticate, without calling the gateway", async (_label, headers) => {
    const h = await setup();
    const res = await h.call({ body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', headers });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "A valid MCP token for an active run is required." },
    });
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("refuses the token of a cancelled session", async () => {
    const h = await setup();
    await h.ledger.cancelSession("session-1");
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.statusCode).toBe(401);
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("refuses the token of a session at or past its deadline", async () => {
    const h = await setup({ deadlineAt: NOW });
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.statusCode).toBe(401);
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("forwards every recorded Claude Code and Codex MCP request byte for byte with the same Authorization", async () => {
    const recorded = [
      ...(await fixture("claude-code-2.1.286-mcp-requests.json")).mcp,
      ...(await fixture("codex-0.160.1-mcp-requests.json")).mcp,
    ].filter((entry) => entry.method === "POST");
    expect(recorded.length).toBeGreaterThanOrEqual(8);
    for (const { headers, body } of recorded) {
      const h = await setup();
      const res = await h.authorized(body!, headers);
      expect(res.statusCode).toBe(200);
      expect(h.gateway).toHaveBeenCalledTimes(1);
      const [url, init] = h.gateway.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${GATEWAY}/coding-mcp`);
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${h.token}`);
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(init.redirect).toBe("error");
      expect(Buffer.from(init.body as Uint8Array).toString("utf8")).toBe(body);
    }
  });

  it("forwards bytes that are not valid UTF-8 unchanged", async () => {
    const h = await setup();
    const raw = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"x","params":"'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}'),
    ]);
    await h.call({ body: raw, headers: { authorization: `Bearer ${h.token}` } });
    const init = h.gateway.mock.calls[0][1] as RequestInit;
    expect(Buffer.compare(Buffer.from(init.body as Uint8Array), raw)).toBe(0);
  });

  it("returns the gateway's status, body and content-type", async () => {
    const answer =
      '{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found."}}';
    const h = await setup({
      fetchImpl: async () =>
        new globalThis.Response(answer, {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    });
    const res = await h.authorized('{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover"}');
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.body.toString("utf8")).toBe(answer);
  });

  it("relays a 202 with no body for a notification", async () => {
    const h = await setup({ fetchImpl: async () => new globalThis.Response(null, { status: 202 }) });
    const res = await h.authorized('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(res.statusCode).toBe(202);
    expect(res.body.length).toBe(0);
  });

  it("relays the gateway's own 401 unchanged", async () => {
    const answer = '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"no"}}';
    const h = await setup({
      fetchImpl: async () =>
        new globalThis.Response(answer, { status: 401, headers: { "content-type": "application/json" } }),
    });
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBeUndefined();
    expect(res.body.toString("utf8")).toBe(answer);
  });

  it("caps the request body at HTTP_LIMITS.json", async () => {
    const h = await setup();
    const over = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":"${"x".repeat(HTTP_LIMITS.json)}"}`;
    const res = await h.authorized(over);
    expect(res.statusCode).toBe(413);
    expect(h.gateway).not.toHaveBeenCalled();
    const declared = await h.authorized("{}", { "content-length": String(HTTP_LIMITS.json + 1) });
    expect(declared.statusCode).toBe(413);
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("refuses a body that is not application/json with a clean 415", async () => {
    const h = await setup();
    const res = await h.authorized("hello", { "content-type": "text/plain" });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it.each(["GET", "DELETE", "HEAD", "PUT"])("answers %s with 405 and Allow: POST", async (method) => {
    const h = await setup();
    const res = await h.call({ method, headers: { authorization: `Bearer ${h.token}` } });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    if (method === "HEAD") expect(res.body.length).toBe(0);
    else expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    expect(h.gateway).not.toHaveBeenCalled();
  });

  it("answers 502 mcp_unavailable when the gateway can't be reached", async () => {
    const h = await setup({
      fetchImpl: async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED gateway.test");
      },
    });
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "mcp_unavailable" });
    expect(res.body.toString("utf8")).not.toContain("ECONNREFUSED");
  });

  it("answers 502 when the gateway's answer is larger than the proxy relays", async () => {
    const h = await setup({
      fetchImpl: async () => new globalThis.Response("x".repeat(8 * 1024 * 1024 + 1), { status: 200 }),
    });
    const res = await h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "mcp_unavailable" });
  });

  describe("forward timeout", () => {
    /** A gateway that answers after `delayMs`, or fails when the forward is aborted first. */
    const slowGateway =
      (delayMs: number): typeof fetch =>
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new globalThis.Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 })),
            delayMs,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(init.signal!.reason as Error);
          });
        });

    it("lets a call take longer than the 15 s request window (a 20 s gateway)", async () => {
      vi.useFakeTimers();
      const h = await setup({ fetchImpl: slowGateway(20_000) });
      const pending = h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
      await vi.advanceTimersByTimeAsync(20_000);
      const res = await pending;
      expect(HTTP_LIMITS.requestMs).toBeLessThan(20_000);
      expect(res.statusCode).toBe(200);
    });

    it("gives up at 5 minutes when the deadline is later", async () => {
      vi.useFakeTimers();
      const h = await setup({ fetchImpl: slowGateway(60 * 60_000) });
      const pending = h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
      await vi.advanceTimersByTimeAsync(MCP_FORWARD_MAX_MS - 1);
      expect(h.gateway).toHaveBeenCalledTimes(1);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const res = await pending;
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: "mcp_unavailable" });
      expect(h.logs.at(-1)).toMatchObject({ status: 502, reason: "gateway_timeout" });
    });

    it("gives up at the session deadline when that comes first", async () => {
      vi.useFakeTimers();
      const h = await setup({ deadlineAt: new Date(NOW.getTime() + 30_000), fetchImpl: slowGateway(60_000) });
      const pending = h.authorized('{"jsonrpc":"2.0","id":1,"method":"tools/call"}');
      await vi.advanceTimersByTimeAsync(30_000);
      const res = await pending;
      expect(res.statusCode).toBe(502);
      expect(h.logs.at(-1)).toMatchObject({ status: 502, reason: "gateway_timeout" });
    });
  });

  describe("logging", () => {
    it("logs the session id, method and status only", async () => {
      const h = await setup();
      await h.authorized(
        '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x","arguments":{"q":"secret-arg"}}}',
      );
      expect(h.logs).toEqual([
        expect.objectContaining({ event: "mcp.request", sessionId: "session-1", method: "tools/call", status: 200 }),
      ]);
      expect(Object.keys(h.logs[0]).sort()).toEqual(["durationMs", "event", "method", "sessionId", "status"]);
    });

    it("never logs the token or the body, on any path", async () => {
      const fake = "rmt_FAKEtokenFAKEtokenFAKEtokenFAKEtokenFAKEtok";
      expect(fake).toHaveLength(47);
      const secretBody =
        '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{"token":"rmt_FAKEtokenFAKEtokenFAKEtokenFAKEtokenFAKEtok"}}}';
      const h = await setup();
      const paths = [
        await h.call({ body: secretBody, headers: { authorization: `Bearer ${fake}` } }),
        await h.call({ method: "GET", headers: { authorization: `Bearer ${fake}` } }),
        await h.authorized(secretBody),
        await h.authorized(secretBody, { "content-type": "text/plain" }),
      ];
      const failing = await setup({
        fetchImpl: async () => {
          throw new Error(`gateway said ${fake} and ${secretBody}`);
        },
      });
      paths.push(await failing.authorized(secretBody));
      expect(paths.map((res) => res.statusCode)).toEqual([401, 405, 200, 415, 502]);
      const logged = JSON.stringify([...h.logs, ...failing.logs]);
      expect(logged).not.toContain("rmt_");
      expect(logged).not.toContain(h.token);
      expect(logged).not.toContain(failing.token);
      expect(logged).not.toContain("FAKEtoken");
      expect(logged).not.toContain("arguments");
    });

    it.each([
      ["tools/call", "tools/call"],
      ["notifications/initialized", "notifications/initialized"],
      ["server/discover", "server/discover"],
      ["tools/call\nforged", "other"],
      ["rmt_abc", "other"],
      ["a".repeat(70), "a".repeat(64)],
      [42, "other"],
      ["", "other"],
    ])("logs the method %j as %j", (method, logged) => {
      expect(mcpLogMethod(method)).toBe(logged);
    });
  });
});
