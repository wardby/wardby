import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SelfHostedAuthProvider } from "../../../providers/auth/self-hosted.js";
import { IdentityService } from "./credentials.js";
import { startHttpServer, type HttpServerHandle } from "../../transport/streamable-http.js";
import { buildMcpServer } from "../../server.js";
import type { McpProviders } from "../../context.js";
import { chromium } from "playwright";

describe.skipIf(!process.env.DATABASE_URL)("browser HTTP OAuth flow (database)", () => {
  const db = new PrismaClient();
  const subjects: string[] = [];
  const clients: string[] = [];
  let server: HttpServerHandle | undefined;
  afterAll(async () => {
    await server?.close();
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clients } } });
    await db.authUser.deleteMany({ where: { principal: { subject: { in: subjects } } } });
    await db.principal.deleteMany({ where: { subject: { in: subjects } } });
    await db.$disconnect();
  });
  it("performs login, consent, exchange, authenticated MCP, refresh/reuse, revocation, and logout over HTTP", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const origin = `http://127.0.0.1:${port}`;
    const provider = new SelfHostedAuthProvider(
      { canonicalUri: origin + "/mcp", signingKey: "a1".repeat(32), credentialHashKey: "b2".repeat(32) },
      db,
    );
    const identity = new IdentityService(db, "b2".repeat(32));
    const subject = "browser-" + randomUUID();
    subjects.push(subject);
    const user = await identity.createUser(subject);
    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: origin + "/mcp" } });
    mcp.registerTool({
      name: "identity",
      scope: "agents:read",
      inputSchema: { type: "object" },
      handler: async (_, ctx) => ({ content: [{ type: "text", text: ctx.principal.subject }] }),
    });
    server = await startHttpServer({
      mcp,
      config: { canonicalUri: origin + "/mcp", httpBind: { host: "127.0.0.1", port }, authProviderKind: "self-hosted" },
      auth: { authProvider: provider, db, providers },
      selfHosted: provider,
    });
    const jar = new Map<string, string>();
    async function visit(path: string, form?: Record<string, string>, extra: Record<string, string> = {}) {
      const res = await fetch(origin + path, {
        redirect: "manual",
        method: form ? "POST" : "GET",
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
          ...(form ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}),
          ...extra,
        },
        body: form ? new URLSearchParams(form) : undefined,
      });
      for (const value of res.headers.getSetCookie()) {
        const [key, token] = value.split(";", 1)[0].split("=");
        jar.set(key, token);
      }
      return res;
    }
    const registration = await fetch(origin + "/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }),
    });
    expect(registration.status).toBe(201);
    const clientId = ((await registration.json()) as { client_id: string }).client_id;
    clients.push(clientId);
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://client.example/callback",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      scope: "agents:read",
      state: "state",
      resource: origin + "/mcp",
    });
    const browser = await chromium.launch({
      headless: true,
      timeout: 10_000,
      channel: process.env.SECURITY_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      page.setDefaultNavigationTimeout(5_000);
      await page.route("https://client.example/**", (route) => route.fulfill({ body: "Callback received" }));
      await page.goto(origin + "/authorize?" + query.toString());
      await page.locator('input[name="login_key"]').fill(user.loginKey);
      const [loginResponse] = await Promise.all([
        page.waitForResponse((r) => r.url() === origin + "/login" && r.request().method() === "POST"),
        page.getByRole("button", { name: "Sign in" }).click(),
      ]);
      expect(loginResponse.status()).toBe(200);
      expect(await loginResponse.request().headerValue("origin")).toBe(origin);
      await page.getByRole("heading", { name: /Authorize/ }).waitFor();
      const cookies = await context.cookies();
      expect(cookies.find((c) => c.name === "wardby-dev-session")).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
      });
      await page.getByRole("button", { name: "Approve" }).click();
      await page.waitForURL("https://client.example/**");
      const browserCode = new URL(page.url()).searchParams.get("code")!;
      const browserToken = await provider.handleToken({
        grantType: "authorization_code",
        clientId,
        code: browserCode,
        codeVerifier: verifier,
        redirectUri: "https://client.example/callback",
      });
      expect((await provider.verifyBearer(browserToken.accessToken)).subject).toBe(subject);
      await page.goto(origin + "/logout");
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("heading", { name: "Sign in to wardby" }).waitFor();
      expect((await context.cookies()).find((c) => c.name === "wardby-dev-session")).toBeUndefined();
    } finally {
      await browser.close();
    }
    expect((await visit("/authorize?" + query.toString() + "&subject=victim")).status).toBe(400);
    const authorized = await visit("/authorize?" + query.toString());
    expect(authorized.status).toBe(303);
    expect(authorized.headers.get("location")).toMatch(/^\/login\?interaction=/);
    const login = await visit(authorized.headers.get("location")!);
    expect(login.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    const page = await login.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1];
    const interaction = /name="interaction" value="([^"]*)"/.exec(page)![1];
    const form = { login_key: user.loginKey, csrf, interaction };
    expect((await visit("/login", form, { origin: "https://evil.example" })).status).toBe(403);
    const signedIn = await visit("/login", form);
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
    expect((await visit("/login", form)).status).toBe(400);
    const consent = await visit(signedIn.headers.get("location")!);
    const consentPage = await consent.text();
    expect(consentPage).toContain("agents:read");
    const consentCsrf = /name="csrf" value="([^"]+)"/.exec(consentPage)![1];
    const approval = await visit("/consent", { interaction, csrf: consentCsrf, decision: "approve" });
    expect(approval.status).toBe(303);
    const code = new URL(approval.headers.get("location")!).searchParams.get("code")!;
    const exchange = {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: "https://client.example/callback",
    };
    const response = await visit("/token", exchange);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { access_token: string; refresh_token: string };
    expect((await visit("/token", exchange)).status).toBe(400);
    const client = new Client({ name: "security-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + token.access_token } },
      }),
    );
    expect(JSON.stringify(await client.callTool({ name: "identity", arguments: {} }))).toContain(subject);
    await client.close();
    const refresh = { grant_type: "refresh_token", client_id: clientId, refresh_token: token.refresh_token };
    const rotated = await visit("/token", refresh);
    expect(rotated.status).toBe(200);
    const replacement = (await rotated.json()) as { refresh_token: string; access_token: string };
    expect((await visit("/token", refresh)).status).toBe(400);
    await expect(provider.verifyBearer(replacement.access_token)).rejects.toThrow();
    expect((await visit("/revoke", { client_id: clientId, token: replacement.refresh_token })).status).toBe(200);
    const logout = await visit("/logout");
    const logoutCsrf = /name="csrf" value="([^"]+)"/.exec(await logout.text())![1];
    const session = jar.get("wardby-dev-session")!;
    expect((await visit("/logout", { csrf: logoutCsrf })).status).toBe(303);
    await expect(provider.sessions.get(session)).rejects.toThrow();
  }, 30_000);
});
