import { describe, it, expect, afterEach } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { startHttpServer, type HttpServerHandle } from "./streamable-http.js";
import type { AuthProfile, AuthProvider } from "../../providers/auth/types.js";
import { SelfHostedAuthProvider } from "../../providers/auth/self-hosted.js";

const CANONICAL_URI = "https://host/mcp"; // logical resource identifier; the test server itself binds to 127.0.0.1

function fakeAuthProvider(verifyBearer: AuthProvider["verifyBearer"]): AuthProvider {
  return {
    authorizeUrl: () => "",
    exchangeCode: async () => ({ idToken: "", accessToken: "" }),
    refresh: async () => ({ idToken: "", accessToken: "" }),
    profile: async () => ({ subject: "", roles: [], scopes: [] }),
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
  } as unknown as import("@prisma/client").PrismaClient;
}

const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe("startHttpServer (delegating mode)", () => {
  async function start(profile: AuthProfile | Error) {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb(), config: { canonicalUri: CANONICAL_URI } });
    const authProvider = fakeAuthProvider(async () => {
      if (profile instanceof Error) throw profile;
      return profile;
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
      requestInit: { headers: { authorization: "Bearer good-token" } },
    });
    await client.connect(transport);
    const caps = client.getServerCapabilities();
    expect(caps?.extensions?.["io.modelcontextprotocol/tasks"]).toBeDefined();
    await client.close();
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

describe("startHttpServer (self-hosted mode)", () => {
  it("self-hosted AS metadata is reachable without auth", async () => {
    const db = fakeDb();
    const selfHosted = new SelfHostedAuthProvider({ canonicalUri: CANONICAL_URI, signingKey: "s".repeat(32) }, db);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    handle = await startHttpServer({
      mcp,
      config: { canonicalUri: CANONICAL_URI, httpBind: { host: "127.0.0.1", port: 0 }, authProviderKind: "self-hosted" },
      auth: { authProvider: selfHosted, db, providers: fakeProviders },
      selfHosted,
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { issuer: string };
    expect(body.issuer).toBe(CANONICAL_URI);
  });
});
