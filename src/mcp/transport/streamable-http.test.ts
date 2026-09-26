import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import {
  startHttpServer as realStartHttpServer,
  type HttpServerHandle,
  type StartHttpServerOptions,
} from "./streamable-http.js";
import { createServer } from "node:http";
import type { AuthProvider, VerifiedToken } from "../../providers/auth/types.js";

vi.mock("../host-events/github-ingress.js", () => ({
  handleGitHubEventIngress: vi.fn(),
}));
import { handleGitHubEventIngress, type GitHubIngressDeps } from "../host-events/github-ingress.js";
vi.mock("../host-events/github-user-callback.js", () => ({
  handleHostUserCallback: vi.fn(async (_url: URL, res: import("node:http").ServerResponse) => {
    res.writeHead(200, { "content-type": "text/html" }).end("callback page");
  }),
}));
import { handleHostUserCallback, type HostUserCallbackDeps } from "../host-events/github-user-callback.js";

const fetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, headers: { host: "host", ...init?.headers } });
let CANONICAL_URI = "https://host/mcp";
async function startHttpServer(opts: StartHttpServerOptions): Promise<HttpServerHandle> {
  if (opts.config.authProviderKind === "self-hosted") return realStartHttpServer(opts);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  CANONICAL_URI = `http://127.0.0.1:${port}/mcp`;
  return realStartHttpServer({
    ...opts,
    config: { ...opts.config, canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port } },
  });
}

function fakeAuthProvider(verifyBearer: AuthProvider["verifyBearer"]): AuthProvider {
  return {
    authorizeUrl: () => "",
    exchangeCode: async () => ({ idToken: "", accessToken: "" }),
    refresh: async () => ({ idToken: "", accessToken: "" }),
    profile: async () => ({ subject: "", roles: [] }),
    verifyBearer,
  };
}

function fakeDb() {
  return {
    principal: {
      upsert: async ({ where }: { where: { subject: string } }) => ({
        id: `principal-${where.subject}`,
        subject: where.subject,
        createdAt: new Date(),
      }),
    },
  } as unknown as import("#prisma").PrismaClient;
}

const fakeProviders = {
  executor: { async start() {}, async stop() {} },
} as unknown as import("../../providers/index.js").ProviderRegistry;

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("startHttpServer (delegating mode)", () => {
  async function start(verified: VerifiedToken | Error) {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => {
      if (verified instanceof Error) throw verified;
      return verified;
    });
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
    });
    return `http://127.0.0.1:${handle.port}`;
  }

  it("unauthenticated POST /mcp -> 401 with a WWW-Authenticate challenge", async () => {
    const base = await start(new Error("no token"));
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("authenticated POST returns a JSON body (responseMode: json, modern era via a real Client)", async () => {
    // responseMode only shapes modern (2026-07-28) exchanges — a hand-crafted
    // legacy `initialize` request always gets an SSE-shaped response
    // regardless of this option (confirmed empirically), so this needs a
    // real modern-era client to build the correct per-request `_meta`
    // envelope rather than a hand-crafted body.
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => ({ subject: "user-1", roles: [], scopes: ["agents:read"] }));
    handle = await startHttpServer({
      mcp,
      config: {
        canonicalUri: CANONICAL_URI,
        httpBind: { host: "127.0.0.1", port: 0 },
        authProviderKind: "delegating",
        responseMode: "json",
      },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
      requestInit: { headers: { host: "host", authorization: "Bearer good-token" } },
    });
    await client.connect(transport);
    const caps = client.getServerCapabilities();
    expect(caps?.extensions?.["io.modelcontextprotocol/tasks"]).toBeDefined();
    await client.close();
  });

  it("a tool handler's ctx.clientSupportsTasks reflects the connecting client's declared capabilities", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => ({ subject: "user-1", roles: [], scopes: ["agents:read"] }));
    let seenClientSupportsTasks: boolean | undefined;
    mcp.registerTool({
      name: "report_tasks_capability",
      scope: "agents:read",
      inputSchema: { type: "object", properties: {} },
      handler: async (_args, ctx) => {
        seenClientSupportsTasks = ctx.clientSupportsTasks;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
    });

    const tasksCapableClient = new Client(
      { name: "tasks-capable-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" }, capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
    );
    await tasksCapableClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { host: "host", authorization: "Bearer good-token" } },
      }),
    );
    await tasksCapableClient.callTool({ name: "report_tasks_capability", arguments: {} });
    expect(seenClientSupportsTasks).toBe(true);
    await tasksCapableClient.close();

    const plainClient = new Client(
      { name: "plain-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await plainClient.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`), {
        requestInit: { headers: { host: "host", authorization: "Bearer good-token" } },
      }),
    );
    await plainClient.callTool({ name: "report_tasks_capability", arguments: {} });
    expect(seenClientSupportsTasks).toBe(false);
    await plainClient.close();
  });

  it("bad Origin is rejected with 403", async () => {
    const base = await start({ subject: "user-1", roles: [], scopes: [] });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("PRM is reachable without auth", async () => {
    const base = await start(new Error("should not be called for PRM"));
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(CANONICAL_URI);
  });

  it("delegating mode does not expose /authorize", async () => {
    const base = await start({ subject: "user-1", roles: [], scopes: [] });
    const res = await fetch(`${base}/authorize?client_id=x`, { redirect: "manual" });
    expect(res.status).toBe(404);
  });

  it("/elicit/secret is reachable unauthenticated and rejects an invalid token", async () => {
    const base = await start({ subject: "user-1", roles: [], scopes: [] });
    const res = await fetch(`${base}/elicit/secret?t=not-a-real-token`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|invalid/i);
  });
});

describe("startHttpServer (forced SSE)", () => {
  it("a streaming handler upgrades to text/event-stream with SSE frames", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => ({ subject: "user-1", roles: [], scopes: [] }));
    handle = await startHttpServer({
      mcp,
      config: {
        canonicalUri: CANONICAL_URI,
        httpBind: { host: "127.0.0.1", port: 0 },
        authProviderKind: "delegating",
        responseMode: "sse",
      },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer good-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1.0.0" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
  });
});

describe("startHttpServer (webhook ingress)", () => {
  it("POST /webhooks/:id with a valid secret enqueues a run without any OAuth token", async () => {
    const { createWebhook } = await import("../../core/webhooks.js");

    interface FakeWebhookRow {
      id: string;
      agentId: string;
      secretHash: string;
      status: "enabled" | "disabled";
      ownerId: string | null;
      createdAt: Date;
      lastFiredAt: Date | null;
    }
    const webhooks = new Map<string, FakeWebhookRow>();
    let webhookCounter = 0;
    let runCounter = 0;
    const webhookDb: any = {
      webhook: {
        create: async ({ data }: { data: Partial<FakeWebhookRow> & { agentId: string; secretHash: string } }) => {
          const row: FakeWebhookRow = {
            id: `webhook_${++webhookCounter}`,
            status: "enabled",
            ownerId: null,
            createdAt: new Date(),
            lastFiredAt: null,
            ...data,
          };
          webhooks.set(row.id, row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) => webhooks.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<FakeWebhookRow> }) => {
          const row = webhooks.get(where.id)!;
          const updated = { ...row, ...data };
          webhooks.set(where.id, updated);
          return updated;
        },
      },
      agent: {
        findUnique: async ({ where }: { where: { id?: string; name?: string } }) =>
          where.id === "a1" || where.name === "greeter"
            ? // Owned by the webhook's creator, so the fire-time creator check passes.
              {
                id: "a1",
                name: "greeter",
                kind: "native",
                codingProfile: null,
                budgetUsd: 1,
                model: "m",
                ownerId: "p1",
              }
            : null,
      },
      run: {
        create: async ({ data }: { data: { agentId: string; trigger: string } }) => ({
          id: `run_${++runCounter}`,
          status: "pending",
          startedAt: new Date(),
          ...data,
        }),
        updateMany: async () => ({ count: 1 }),
      },
      codingRun: { create: async ({ data }: { data: unknown }) => data },
      task: { create: async ({ data }: { data: unknown }) => data },
    };
    webhookDb.$transaction = async (callback: (tx: unknown) => Promise<unknown>) => callback(webhookDb);

    const { id, secret } = await createWebhook("a1", "p1", webhookDb);

    const mcp = buildMcpServer({ providers: fakeProviders, db: webhookDb, config: { canonicalUri: CANONICAL_URI } });
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: {
        authProvider: fakeAuthProvider(async () => ({ subject: "x", roles: [], scopes: [] })),
        db: webhookDb,
        providers: fakeProviders,
      },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/webhooks/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": secret },
      body: "{}",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toBeTruthy();
  });

  it("POST /webhooks/:id with a wrong secret -> 401", async () => {
    const { createWebhook } = await import("../../core/webhooks.js");
    const webhooks = new Map<string, { id: string; secretHash: string; status: string }>();
    let counter = 0;
    const webhookDb = {
      webhook: {
        create: async ({ data }: { data: { agentId: string; secretHash: string } }) => {
          const row = { id: `webhook_${++counter}`, status: "enabled", ...data };
          webhooks.set(row.id, row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) => webhooks.get(where.id) ?? null,
      },
      agent: { findUnique: async () => null },
    } as unknown as import("#prisma").PrismaClient;
    const { id } = await createWebhook("a1", "p1", webhookDb);

    const mcp = buildMcpServer({ providers: fakeProviders, db: webhookDb, config: { canonicalUri: CANONICAL_URI } });
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: {
        authProvider: fakeAuthProvider(async () => ({ subject: "x", roles: [], scopes: [] })),
        db: webhookDb,
        providers: fakeProviders,
      },
    });

    const res = await fetch(`http://127.0.0.1:${handle.port}/webhooks/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": "wrong" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("startHttpServer (github events ingress)", () => {
  beforeEach(() => vi.mocked(handleGitHubEventIngress).mockReset());
  afterEach(() => vi.mocked(handleGitHubEventIngress).mockReset());

  async function start(hostEvents?: StartHttpServerOptions["hostEvents"]) {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => ({ subject: "user-1", roles: [], scopes: [] }));
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
      hostEvents,
    });
    return `http://127.0.0.1:${handle.port}`;
  }

  it("serves /hosts/github/events from the raw body and runs follow-ups after responding", async () => {
    const afterSpy = vi.fn(async () => undefined);
    vi.mocked(handleGitHubEventIngress).mockImplementation(async (req) => {
      expect(req.rawBody).toBe('{"a": 1}'); // exact bytes, not re-serialised
      return { status: 202, body: { ok: true }, afterResponse: afterSpy };
    });
    const base = await start({ github: {} as unknown as GitHubIngressDeps });

    const res = await fetch(`${base}/hosts/github/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a": 1}',
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(afterSpy).toHaveBeenCalled());
  });

  it("returns 404 for /hosts/github/events when no ingress is configured", async () => {
    const base = await start(undefined);
    const res = await fetch(`${base}/hosts/github/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(handleGitHubEventIngress).not.toHaveBeenCalled();
  });
});

describe("startHttpServer (GitHub user callback)", () => {
  async function start(hostUserAuth?: StartHttpServerOptions["hostUserAuth"]) {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => ({ subject: "user-1", roles: [], scopes: [] }));
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "delegating" },
      auth: { authProvider, db: fakeDb(), providers: fakeProviders },
      hostUserAuth,
    });
    return `http://127.0.0.1:${handle.port}`;
  }

  it("serves GET /hosts/github/user-callback, unauthenticated, with the full query", async () => {
    vi.mocked(handleHostUserCallback).mockClear();
    const deps = { redirectUri: "x" } as unknown as HostUserCallbackDeps;
    const base = await start({ github: deps });
    const res = await fetch(`${base}/hosts/github/user-callback?code=c&state=s`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("callback page");
    const [url, , passed] = vi.mocked(handleHostUserCallback).mock.calls[0];
    expect(url.searchParams.get("state")).toBe("s");
    expect(passed).toBe(deps);
    expect(
      (
        await fetch(`${base}/hosts/github/user-callback?code=c&state=s`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });

  it("returns 404 when linking is not configured", async () => {
    vi.mocked(handleHostUserCallback).mockClear();
    const base = await start(undefined);
    expect((await fetch(`${base}/hosts/github/user-callback?code=c&state=s`)).status).toBe(404);
    expect(handleHostUserCallback).not.toHaveBeenCalled();
  });
});
