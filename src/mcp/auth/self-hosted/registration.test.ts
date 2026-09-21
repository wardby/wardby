import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { SelfHostedAuthProvider } from "../../../providers/auth/self-hosted.js";
import { startHttpServer, type HttpServerHandle } from "../../transport/streamable-http.js";
import { buildMcpServer } from "../../server.js";
import type { McpProviders } from "../../context.js";

describe.skipIf(!process.env.DATABASE_URL)("self-hosted dynamic client registration (database)", () => {
  const db = new PrismaClient();
  const clients: string[] = [];
  let server: HttpServerHandle | undefined;
  let origin = "";

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    origin = `http://127.0.0.1:${port}`;
    const provider = new SelfHostedAuthProvider(
      // A per-run hash key gives this file its own rate-limit buckets: the
      // limiter lives in Postgres and keys on the hashed caller IP, which is
      // 127.0.0.1 for every test file registering clients concurrently.
      {
        canonicalUri: origin + "/mcp",
        signingKey: "a1".repeat(32),
        credentialHashKey: randomBytes(32).toString("hex"),
      },
      db,
    );
    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: origin + "/mcp" } });
    server = await startHttpServer({
      mcp,
      config: { canonicalUri: origin + "/mcp", httpBind: { host: "127.0.0.1", port }, authProviderKind: "self-hosted" },
      auth: { authProvider: provider, db, providers },
      selfHosted: provider,
    });
  });
  afterAll(async () => {
    await server?.close();
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clients } } });
    await db.$disconnect();
  });

  const register = (body: unknown) =>
    fetch(origin + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("accepts Claude Code's registration request verbatim", async () => {
    // Captured from Claude Code on 2026-09-21. It adds RFC 7591 `scope`
    // whenever scopes_supported is advertised, and OIDC Dynamic Client
    // Registration's `application_type`.
    const res = await register({
      client_name: "Claude Code (wardby)",
      redirect_uris: ["http://localhost:64862/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope:
        "agents:read agents:write tools:write runs:trigger datastore:write secrets:write webhooks:write budget_groups:write agents:admin",
    });
    expect(res.status).toBe(201);
    clients.push(((await res.json()) as { client_id: string }).client_id);
  });

  it("still rejects malformed scope/application_type and unknown fields", async () => {
    const base = { redirect_uris: ["http://localhost:51234/callback"], token_endpoint_auth_method: "none" };
    expect((await register({ ...base, scope: ["agents:read"] })).status).toBe(400);
    expect((await register({ ...base, application_type: "service" })).status).toBe(400);
    expect((await register({ ...base, jwks_uri: "https://evil.example/jwks" })).status).toBe(400);
  });
});
