import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { safeFetch } from "../../sandbox/safe-fetch.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test-support/fake-oauth-server.test-support.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import {
  parseOAuthLoopbackLink,
  verifyOAuthLoopbackLink,
  type OAuthLoopbackLinkAudience,
} from "./oauth-loopback-link.js";
import { registerSecretsTools } from "./secrets.js";

const logged = vi.hoisted(() => vi.fn());
vi.mock("../../core/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/logger.js")>();
  const child = real.logger.child.bind(real.logger);
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(real.logger, level).mockImplementation(logged);
  }
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      vi.spyOn(log, level).mockImplementation(logged);
    }
    return log;
  });
  return real;
});

const db = createPrismaClient();
const HOST = "oauth.fake.test";
const OPTS = {
  privateHostAllowlist: [HOST],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
};
const CANONICAL = "https://wardby.example/mcp";
const ORIGIN = "https://wardby.example";
const STDIO_ORIGIN = "http://127.0.0.1:4321";
const NOW = new Date("2026-11-12T10:00:00Z");
const TEN_MIN = 10 * 60_000;
const principalIds: string[] = [];
const COMMAND = /^npx @wardby\/cli@latest secret connect '([^']+)'$/;

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

let fake: FakeOAuthServer;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `secret-oauth-loopback-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function connect(p: Principal, opts: { audience?: OAuthLoopbackLinkAudience | "none"; operator?: boolean } = {}) {
  const audience = opts.audience ?? "http";
  const requests: string[] = [];
  const recordingFetch: typeof safeFetch = async (url, init, options) => {
    requests.push(url);
    return safeFetch(url, init, options);
  };
  const providers = {
    secrets: cipher,
    sandboxFetchOptions: OPTS,
    sandboxFetch: recordingFetch,
  } as unknown as McpProviders;
  const canonicalUri = audience === "stdio" ? "stdio" : CANONICAL;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(["secrets:write"]),
    roles: [],
    ...(opts.operator ? { operator: true } : {}),
    canonicalUri,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerSecretsTools(mcp, {
    buildElicitationUrl: async (t) => `${ORIGIN}/x?t=${t}`,
    protocolElicitation: false,
    ...(audience === "none"
      ? {}
      : {
          oauthLoopback: {
            origin: async () => (audience === "stdio" ? STDIO_ORIGIN : ORIGIN),
            audience,
            now: () => NOW,
          },
        }),
  });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
  const verify = (token: string, aud: OAuthLoopbackLinkAudience, now = NOW) =>
    verifyOAuthLoopbackLink(token, { verify: (t) => mcp.verifyRequestState(t), audience: aud, now: () => now });
  return { call, verify, requests, close: () => client.close() };
}

function linkOf(text: string): { link: string; origin: string; token: string } {
  const body = JSON.parse(text) as { command: string };
  const link = COMMAND.exec(body.command)?.[1] ?? "";
  const parsed = parseOAuthLoopbackLink(link);
  if (!parsed) throw new Error("not a loopback link");
  return { link, ...parsed };
}

describe.skipIf(!process.env.DATABASE_URL)("create_secret with oauth.callback loopback (PostgreSQL)", () => {
  beforeEach(async () => {
    logged.mockClear();
    fake = await startFakeOAuthServer({ publicHost: HOST });
  });
  afterEach(async () => {
    await fake.close();
  });
  afterAll(async () => {
    await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("returns a command with a signed link naming the principal, secret and resource; no discovery yet", async () => {
    const p = await principal();
    const { call, verify, requests, close } = await connect(p);
    const r = await call("create_secret", {
      name: "browserstack",
      oauth: { resource: fake.mcpUrl, scope: "read", clientId: "client-1", callback: "loopback" },
    });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["command", "expiresAt", "message", "status"]);
    expect(body.status).toBe("pending");
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + TEN_MIN).toISOString());
    expect(body.message).toContain("confirmationCode");

    const { link, origin, token } = linkOf(r.text);
    expect(origin).toBe(ORIGIN);
    expect(link).toBe(`${ORIGIN}/oauth/loopback#${token}`);
    expect(new URL(link).search).toBe("");

    const verified = await verify(token, "http");
    expect(verified).toEqual({
      ok: true,
      payload: {
        kind: "oauth-loopback",
        principalId: p.id,
        name: "browserstack",
        resource: fake.mcpUrl,
        scope: "read",
        clientId: "client-1",
        aud: "http",
        exp: NOW.getTime() + TEN_MIN,
      },
    });
    // Audience-bound and short-lived.
    expect(await verify(token, "stdio")).toEqual({ ok: false, error: "link_invalid" });
    expect(await verify(token, "http", new Date(NOW.getTime() + TEN_MIN))).toEqual({
      ok: false,
      error: "link_invalid",
    });
    // Nothing asked of the provider, nothing stored.
    expect(requests).toEqual([]);
    expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
    // The token never reaches a log line.
    expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
    await close();
  });

  it("omits scope and clientId when not given; the web callback stays the default", async () => {
    const p = await principal();
    const { call, verify, close } = await connect(p);
    const r = await call("create_secret", { name: "bs", oauth: { resource: fake.mcpUrl, callback: "loopback" } });
    const verified = await verify(linkOf(r.text).token, "http");
    if (!verified.ok) throw new Error("expected a valid link");
    expect(verified.payload).not.toHaveProperty("scope");
    expect(verified.payload).not.toHaveProperty("clientId");
    expect(verified.payload).not.toHaveProperty("operator");

    const web = await call("create_secret", { name: "bs-web", oauth: { resource: fake.mcpUrl } });
    expect(web.isError).toBe(false);
    expect(Object.keys(JSON.parse(web.text) as object).sort()).toEqual(["message", "status", "url"]);
    await close();
  });

  it("over stdio, the link names the loopback link host and carries the operator flag", async () => {
    const p = await principal();
    const { call, verify, close } = await connect(p, { audience: "stdio", operator: true });
    const r = await call("create_secret", { name: "bs", oauth: { resource: fake.mcpUrl, callback: "loopback" } });
    expect(r.isError).toBe(false);
    const { origin, token } = linkOf(r.text);
    expect(origin).toBe(STDIO_ORIGIN);
    const verified = await verify(token, "stdio");
    expect(verified).toMatchObject({ ok: true, payload: { aud: "stdio", operator: true, principalId: p.id } });
    expect(await verify(token, "http")).toEqual({ ok: false, error: "link_invalid" });
    expect(JSON.stringify(logged.mock.calls)).not.toContain(token);
    await close();
  });

  it("refuses loopback with value, broker or confirmationCode, with fixed messages and no link", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    const oauth = { resource: fake.mcpUrl, callback: "loopback" };
    const cases: [Record<string, unknown>, string][] = [
      [{ value: "fake-secret-value" }, "Pass either value or oauth, not both."],
      [
        { broker: { hosts: ["a.example"], placement: { kind: "query", name: "k" } } },
        "An OAuth secret's broker is set by wardby; do not pass broker with oauth.",
      ],
      [{ confirmationCode: "AAAA-AAAA" }, "Pass confirmationCode on its own"],
    ];
    for (const [extra, message] of cases) {
      const r = await call("create_secret", { name: "bs", oauth, ...extra });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(message);
      expect(r.text).not.toContain("/oauth/loopback");
      expect(r.text).not.toContain("fake-secret-value");
    }
    await close();
  });

  it("applies the same name guards and input checks as the web flow, before minting", async () => {
    const p = await principal();
    const { call, close } = await connect(p);
    await call("create_secret", { name: "plain", value: "v" });
    const taken = await call("create_secret", {
      name: "plain",
      oauth: { resource: fake.mcpUrl, callback: "loopback" },
    });
    expect(taken.isError).toBe(true);
    expect(taken.text).toContain("secret_oauth_name_taken");
    expect(taken.text).not.toContain("/oauth/loopback");

    const ip = await call("create_secret", {
      name: "bs",
      oauth: { resource: "https://10.1.2.3/mcp", callback: "loopback" },
    });
    expect(ip.text).toContain("secret_oauth_resource_invalid");
    const long = await call("create_secret", {
      name: "n".repeat(2000),
      oauth: { resource: fake.mcpUrl, callback: "loopback" },
    });
    expect(long.text).toContain("secret_oauth_input_too_long");
    const badCallback = await call("create_secret", {
      name: "bs",
      oauth: { resource: fake.mcpUrl, callback: "device" },
    });
    expect(badCallback.isError).toBe(true);
    await close();
  });

  it("refuses loopback when the server offers no loopback links", async () => {
    const p = await principal();
    const { call, close } = await connect(p, { audience: "none" });
    const r = await call("create_secret", { name: "bs", oauth: { resource: fake.mcpUrl, callback: "loopback" } });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("secret_oauth_loopback_unavailable");
    await close();
  });
});
