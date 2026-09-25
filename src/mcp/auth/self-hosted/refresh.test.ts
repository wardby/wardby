import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { SelfHostedAuthProvider } from "../../../providers/auth/self-hosted.js";
import { IdentityService } from "./credentials.js";
import { startHttpServer, type HttpServerHandle } from "../../transport/streamable-http.js";
import { buildMcpServer } from "../../server.js";
import type { McpProviders } from "../../context.js";

// The token requests the MCP SDK (as bundled in Claude Code) sends: form
// bodies that always carry `resource`, with client_id as the only client
// authentication. wardby's browser.test.ts refresh omits `resource`.
describe.skipIf(!process.env.DATABASE_URL)("self-hosted token refresh, MCP SDK shape (database)", () => {
  const db = createPrismaClient();
  const subject = "refresh-" + randomUUID();
  const clients: string[] = [];
  let server: HttpServerHandle | undefined;
  let origin = "";
  let provider: SelfHostedAuthProvider;
  const hashKey = randomBytes(32).toString("hex");

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    origin = `http://127.0.0.1:${port}`;
    // Canonical URI at the root, as deploy/gcp's domainless deployment has it.
    provider = new SelfHostedAuthProvider(
      { canonicalUri: origin + "/", signingKey: "a1".repeat(32), credentialHashKey: hashKey },
      db,
    );
    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: origin + "/" } });
    server = await startHttpServer({
      mcp,
      config: { canonicalUri: origin + "/", httpBind: { host: "127.0.0.1", port }, authProviderKind: "self-hosted" },
      auth: { authProvider: provider, db, providers },
      selfHosted: provider,
    });
  });
  afterAll(async () => {
    await server?.close();
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clients } } });
    await db.authUser.deleteMany({ where: { principal: { subject } } });
    await db.principal.deleteMany({ where: { subject } });
    await db.$disconnect();
  });

  const token = (params: Record<string, string>) =>
    fetch(origin + "/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params),
    });

  it("exchanges a code and then refreshes it", async () => {
    const redirectUri = "http://localhost:64862/callback";
    const registered = await fetch(origin + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code (wardby)",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: "agents:read agents:write",
      }),
    });
    expect(registered.status).toBe(201);
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    clients.push(clientId);

    // Log in and consent through the provider directly (browser.test.ts covers the HTML forms).
    const { loginKey } = await new IdentityService(db, hashKey).createUser(subject);
    const binding = randomUUID();
    const session = await provider.sessions.login(
      loginKey,
      await provider.sessions.challenge("login", null, binding),
      binding,
    );
    const verifier = randomBytes(32).toString("base64url");
    const resource = origin + "/";
    const { interactionId } = await provider.handleAuthorize({
      clientId,
      redirectUri,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      scope: "agents:read agents:write",
      resource,
      state: "s",
    });
    const { challenge } = await provider.consentPage(session, interactionId);
    const code = new URL(await provider.consent(session, interactionId, challenge, true)).searchParams.get("code")!;

    const exchanged = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
      resource,
    });
    expect(exchanged.status).toBe(200);
    const first = (await exchanged.json()) as { refresh_token: string };

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: clientId,
      // On refresh the SDK falls back to the MCP endpoint URL for `resource`
      // rather than the metadata's canonical root (captured from Claude Code
      // against deploy/gcp, 2026-09-21).
      resource: origin + "/mcp",
    });
    expect(await refreshed.json()).toMatchObject({ token_type: "Bearer" });
  });

  it("still refuses a resource on another origin", async () => {
    const res = await token({
      grant_type: "refresh_token",
      refresh_token: "rvr_unused",
      client_id: "unused",
      resource: "https://elsewhere.example/mcp",
    });
    expect(res.status).toBe(400);
  });
});
