import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "#prisma";
import { McpError } from "../mcp/errors.js";
import type { McpRequestContext } from "../mcp/context.js";
import { requireScope } from "../mcp/auth/resource-server.js";
import type { ViewerEvent, InfraInfo } from "./api-schema.js";
import type { ViewerEventBus } from "./event-bus.js";

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  loadGraph: vi.fn(),
}));
vi.mock("./run-detail.js", () => ({ loadRunDetail: vi.fn() }));
import { loadGraph } from "./graph.js";
import { loadRunDetail } from "./run-detail.js";
import { createViewerApi, type ViewerApi } from "./http.js";

const URI = "https://host/mcp";
const SNAPSHOT = { generatedAt: "2026-10-02T00:00:00.000Z", runs: [] };
const RUN_EVENT: ViewerEvent = {
  kind: "run",
  runId: "r1",
  parentRunId: null,
  agentId: "a1",
  status: "running",
  turns: 1,
  tokensIn: 1,
  tokensOut: 2,
  costUsd: 0.01,
  finishedAt: null,
};
const INFRA = {
  launcher: "kubernetes",
  kubernetes: {
    namespace: "wardby-coding",
    platform: "gke-autopilot",
    runtimeClass: "gvisor",
    proxyService: "wardby-coding-proxy",
    runLabel: "wardby.io/run-sha256",
    runLabelHashChars: 40,
    componentLabel: { "wardby.io/component": "coding-run" },
    managedByLabel: { "app.kubernetes.io/managed-by": "wardby" },
  },
  native: null,
} as const satisfies InfraInfo;

function fakeBus(initiallyLive = true) {
  const listeners = new Set<(e: ViewerEvent) => void>();
  const stateListeners = new Set<(live: boolean) => void>();
  let live = initiallyLive;
  const bus: ViewerEventBus & { emit(e: ViewerEvent): void; setLive(live: boolean): void; count(): number } = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onState(l) {
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    connected: () => live,
    close: async () => {},
    emit: (e) => listeners.forEach((l) => l(e)),
    setLive: (next) => {
      live = next;
      stateListeners.forEach((l) => l(next));
    },
    count: () => listeners.size + stateListeners.size,
  };
  return bus;
}

let server: Server | undefined;
let api: ViewerApi | undefined;
afterEach(async () => {
  api?.closeStreams();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server?.closeAllConnections();
  server = undefined;
  vi.clearAllMocks();
});

async function start(
  ctx: McpRequestContext,
  opts: { heartbeatMs?: number; authDelayMs?: number; maxBufferedBytes?: number; live?: boolean } = {},
): Promise<{ base: string; bus: ReturnType<typeof fakeBus>; api: ViewerApi }> {
  const bus = fakeBus(opts.live ?? true);
  const viewer = createViewerApi({
    db: {} as PrismaClient,
    bus,
    authenticate: async () => {
      if (opts.authDelayMs) await new Promise((r) => setTimeout(r, opts.authDelayMs));
      return ctx;
    },
    canonicalUri: URI,
    infra: INFRA,
    heartbeatMs: opts.heartbeatMs,
    maxBufferedBytes: opts.maxBufferedBytes,
  });
  api = viewer;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://host");
    viewer
      .handle(req, res, url)
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      })
      .catch((err: unknown) => {
        if (err instanceof McpError) {
          res
            .writeHead(err.httpStatus, err.wwwAuthenticate ? { "www-authenticate": err.wwwAuthenticate } : {})
            .end(JSON.stringify({ error: "invalid_token" }));
          return;
        }
        res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bus, api: viewer };
}

const admin = (): McpRequestContext =>
  ({ scopes: new Set(["admin:view"]), roles: ["admin"] }) as unknown as McpRequestContext;

describe("viewer api auth", () => {
  it("rejects a caller without the admin role (403) and one without the scope (403 + challenge)", async () => {
    const noRole = await start({ scopes: new Set(["admin:view"]), roles: [] } as unknown as McpRequestContext);
    expect((await fetch(`${noRole.base}/admin/api/graph`)).status).toBe(403);
    await new Promise<void>((r) => server!.close(() => r()));

    const noScope = await start({ scopes: new Set(), roles: ["admin"] } as unknown as McpRequestContext);
    const res = await fetch(`${noScope.base}/admin/api/graph`);
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toContain("admin:view");
    expect(loadGraph).not.toHaveBeenCalled();
    // sanity: the same check the handler uses
    expect(() => requireScope(admin(), URI, "admin:view")).not.toThrow();
  });

  it("does not subscribe or touch the db before authorization (events, runs)", async () => {
    const { base, bus } = await start({ scopes: new Set(), roles: [] } as unknown as McpRequestContext);
    expect((await fetch(`${base}/admin/api/events`)).status).toBe(403);
    expect((await fetch(`${base}/admin/api/runs/abc`)).status).toBe(403);
    expect(bus.count()).toBe(0);
    expect(loadRunDetail).not.toHaveBeenCalled();
  });

  it("serves the graph snapshot to an admin", async () => {
    vi.mocked(loadGraph).mockResolvedValue(SNAPSHOT as never);
    const { base } = await start(admin());
    const res = await fetch(`${base}/admin/api/graph`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SNAPSHOT);
  });
});

describe("viewer api infra", () => {
  it("serves the deployment's infra description to an admin", async () => {
    const { base } = await start(admin());
    const res = await fetch(`${base}/admin/api/infra`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(INFRA);
  });

  it("requires admin:view and GET", async () => {
    const denied = await start({ scopes: new Set(), roles: [] } as unknown as McpRequestContext);
    expect((await fetch(`${denied.base}/admin/api/infra`)).status).toBe(403);
    await new Promise<void>((r) => server!.close(() => r()));
    const { base } = await start(admin());
    const res = await fetch(`${base}/admin/api/infra`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("viewer api validation", () => {
  it("rejects a bad since or limit with 400", async () => {
    const { base } = await start(admin());
    const since = await fetch(`${base}/admin/api/graph?since=5y`);
    expect(since.status).toBe(400);
    expect(await since.json()).toEqual({ error: "invalid_since" });
    for (const limit of ["0", "2001", "abc", "1.5"]) {
      const res = await fetch(`${base}/admin/api/graph?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_limit" });
    }
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("run detail: 200, unknown 404, malformed id 404, other methods 405", async () => {
    vi.mocked(loadRunDetail).mockImplementation((async (_db: unknown, id: string) =>
      id === "abc" ? { id } : null) as never);
    const { base } = await start(admin());
    expect((await fetch(`${base}/admin/api/runs/abc`)).status).toBe(200);
    const unknown = await fetch(`${base}/admin/api/runs/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    expect((await fetch(`${base}/admin/api/runs/..%2F`)).status).toBe(404);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    const post = await fetch(`${base}/admin/api/graph`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await post.json()).toEqual({ error: "method_not_allowed" });
  });

  it("returns false for an unknown /admin/api path", async () => {
    const { base } = await start(admin());
    expect((await fetch(`${base}/admin/api/other`)).status).toBe(404);
  });
});

describe("viewer api event stream", () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, buf: { text: string }, needle: string) {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 2000;
    while (!buf.text.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got ${buf.text}`);
      const { value, done } = await reader.read();
      if (done) break;
      buf.text += decoder.decode(value);
    }
  }

  it("streams hello, events, status, resync and heartbeats; cleans up on disconnect", async () => {
    const { base, bus } = await start(admin(), { heartbeatMs: 20 });
    const ac = new AbortController();
    const res = await fetch(`${base}/admin/api/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reader = res.body!.getReader();
    const buf = { text: "" };
    await readUntil(reader, buf, "event: hello");
    expect(buf.text).toContain("retry: 3000");
    expect(buf.text).toContain('data: {"connected":true}');

    bus.emit(RUN_EVENT);
    await readUntil(reader, buf, `data: ${JSON.stringify(RUN_EVENT)}`);
    expect(buf.text).toMatch(/id: \d+\nevent: run\ndata: /);

    bus.setLive(false);
    await readUntil(reader, buf, 'event: status\ndata: {"connected":false}\n\n');
    expect(buf.text).not.toContain("event: resync");
    bus.setLive(true);
    await readUntil(reader, buf, 'event: status\ndata: {"connected":true}\n\nevent: resync\ndata: {}\n\n');
    await readUntil(reader, buf, ": ping");

    ac.abort();
    await vi.waitFor(() => expect(bus.count()).toBe(0));
  });

  it("tells the first subscriber when live events start (status + resync)", async () => {
    const { base, bus } = await start(admin(), { live: false });
    const ac = new AbortController();
    const res = await fetch(`${base}/admin/api/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const buf = { text: "" };
    await readUntil(reader, buf, 'event: hello\ndata: {"connected":false}\n\n');
    await vi.waitFor(() => expect(bus.count()).toBe(2));
    bus.setLive(true);
    await readUntil(reader, buf, 'event: status\ndata: {"connected":true}\n\nevent: resync\ndata: {}\n\n');
    bus.setLive(false);
    await readUntil(reader, buf, 'event: status\ndata: {"connected":false}\n\n');
    ac.abort();
    await vi.waitFor(() => expect(bus.count()).toBe(0));
  });

  it("ends a stream whose unsent backlog exceeds the limit", async () => {
    const { base, bus } = await start(admin(), { maxBufferedBytes: 64 * 1024 });
    const res = await fetch(`${base}/admin/api/events`);
    const reader = res.body!.getReader();
    await reader.read(); // the stream is open; now stop reading
    const big = { ...RUN_EVENT, agentId: "a".repeat(16 * 1024) };
    for (let i = 0; i < 2000 && bus.count() > 0; i++) {
      bus.emit(big);
      await new Promise((r) => setImmediate(r));
    }
    expect(bus.count()).toBe(0);
    await reader.cancel().catch(() => {});
  });

  it("opens no stream when the client disconnects during authentication", async () => {
    const { base, bus } = await start(admin(), { heartbeatMs: 20, authDelayMs: 150 });
    const ac = new AbortController();
    const pending = fetch(`${base}/admin/api/events`, { signal: ac.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    expect(bus.count()).toBe(0);
  });

  it("closeStreams() ends an open stream and unsubscribes", async () => {
    const { base, bus, api: viewer } = await start(admin());
    const res = await fetch(`${base}/admin/api/events`);
    const reader = res.body!.getReader();
    await reader.read();
    viewer.closeStreams();
    const deadline = Date.now() + 2000;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      if (Date.now() > deadline) throw new Error("stream did not end");
    }
    await vi.waitFor(() => expect(bus.count()).toBe(0));
  });

  it("closeStreams() lets the server shut down without waiting for keep-alive", async () => {
    const { base, api: viewer } = await start(admin());
    server!.keepAliveTimeout = 30_000;
    const res = await fetch(`${base}/admin/api/events`);
    const reader = res.body!.getReader();
    await reader.read();
    const started = Date.now();
    viewer.closeStreams();
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
      server!.closeIdleConnections();
    });
    expect(Date.now() - started).toBeLessThan(2000);
    server = undefined;
  });
});
