import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { setLogLineFilter } from "../../core/logger.js";
import { oauthRedirectUri } from "../../core/host-identity-links.js";
import {
  finishOAuthSecretConnect,
  OAUTH_SECRET_PURPOSE,
  oauthSecretAdapter,
  SECRET_NOT_OAUTH,
  startOAuthSecretConnect,
} from "../../core/oauth-secrets.js";
import type { OAuthLinkAdapter } from "../../core/oauth-link.js";
import { startFakeOAuthServer, type FakeOAuthServer } from "../../test-support/fake-oauth-server.test-support.js";
import type { AuthProvider } from "../../providers/auth/types.js";
import { buildMcpServer, type WardbyMcpServer } from "../server.js";
import {
  OAUTH_LOOPBACK_COMPLETE_PATH,
  OAUTH_LOOPBACK_START_PATH,
  type OAuthLoopbackLinkAudience,
  type OAuthLoopbackLinkPayload,
} from "../tools/oauth-loopback-link.js";
import { oauthLoopbackStdioRoutes, type OAuthLoopbackRouteDeps } from "../tools/oauth-loopback-routes.js";
import { startHttpServer, type HttpServerHandle } from "./streamable-http.js";
import { createStdioLinkHost } from "./stdio-link-host.js";

const db = createPrismaClient();
const HOST = "oauth.fake.test";
const OPTS = {
  privateHostAllowlist: [HOST],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
};
const LOOPBACK = "http://127.0.0.1:53111/callback";
const principalIds: string[] = [];
const logged: string[] = [];

const cipher = {
  keyId: () => "test-key",
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};

let fake: FakeOAuthServer;
let http: HttpServerHandle | undefined;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `oauth-loopback-route-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface Host {
  origin: string;
  mcp: WardbyMcpServer;
  audience: OAuthLoopbackLinkAudience;
}

function deps(): Omit<OAuthLoopbackRouteDeps, "verify" | "audience"> {
  return { db, cipher, options: OPTS };
}

async function startHost(audience: OAuthLoopbackLinkAudience): Promise<Host> {
  if (audience === "http") {
    const port = await freePort();
    const canonicalUri = `http://127.0.0.1:${port}/mcp`;
    const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri } });
    const secretAdapter = oauthSecretAdapter(cipher, OPTS) as OAuthLinkAdapter<unknown, unknown>;
    http = await startHttpServer({
      mcp,
      config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
      auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
      oauthCallback: {
        db,
        cipher,
        adapters: new Map([[OAUTH_SECRET_PURPOSE, secretAdapter]]),
        redirectUri: (purpose) => oauthRedirectUri(`http://127.0.0.1:${port}`, purpose),
      },
      oauthLoopback: deps(),
    });
    return { origin: `http://127.0.0.1:${port}`, mcp, audience };
  }
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: "stdio" } });
  const host = createStdioLinkHost({
    ...oauthLoopbackStdioRoutes({ ...deps(), verify: (t) => mcp.verifyRequestState(t), audience: "stdio" }),
  });
  return { origin: await host.origin(), mcp, audience };
}

function payload(
  host: Host,
  p: Principal,
  overrides: Partial<OAuthLoopbackLinkPayload> = {},
): OAuthLoopbackLinkPayload {
  return {
    kind: "oauth-loopback",
    principalId: p.id,
    name: "browserstack",
    resource: fake.mcpUrl,
    aud: host.audience,
    exp: Date.now() + 10 * 60_000,
    ...overrides,
  };
}

function post(host: Host, path: string, token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${host.origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** Starts a sign-in through the route and approves it at the fake: the callback URL's code and state. */
async function begin(host: Host, token: string) {
  const started = await json(await post(host, OAUTH_LOOPBACK_START_PATH, token, { redirectUri: LOOPBACK }));
  expect(started.status).toBe(200);
  const callback = new URL(await fake.approve(started.body.authorizeUrl as string));
  return {
    started,
    callback,
    code: callback.searchParams.get("code")!,
    state: callback.searchParams.get("state")!,
  };
}

describe.skipIf(!process.env.DATABASE_URL).each(["http", "stdio"] as const)(
  "OAuth loopback routes on the %s host (PostgreSQL, fake OAuth server)",
  (audience) => {
    let host: Host;
    beforeEach(async () => {
      logged.length = 0;
      setLogLineFilter((line) => {
        logged.push(line);
        return line;
      });
      fake = await startFakeOAuthServer({ publicHost: HOST, checkClient: true });
      host = await startHost(audience);
    });
    afterEach(async () => {
      setLogLineFilter((line) => line);
      await http?.close();
      http = undefined;
      await fake.close();
    });
    afterAll(async () => {
      await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
      await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    });

    it("starts with the loopback URI, completes with code and state, and the code confirms the secret", async () => {
      const p = await principal();
      const token = await host.mcp.mintRequestState(payload(host, p, { scope: "read" }));
      const { started, code, state, callback } = await begin(host, token);
      expect(Object.keys(started.body).sort()).toEqual(["authorizeUrl", "expiresAt"]);
      expect(new URL(started.body.authorizeUrl as string).searchParams.get("redirect_uri")).toBe(LOOPBACK);
      expect(new URL(started.body.authorizeUrl as string).searchParams.get("scope")).toBe("read");
      expect(Date.parse(started.body.expiresAt as string)).toBeGreaterThan(Date.now() + 9 * 60_000);
      expect(callback.origin + callback.pathname).toBe(LOOPBACK);
      const request = await db.oAuthLinkRequest.findUniqueOrThrow({ where: { stateHash: stateHash(state) } });
      expect(request.context).toMatchObject({ callback: "loopback", redirectUri: LOOPBACK, name: "browserstack" });

      const done = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, token, { code, state, iss: fake.url }));
      expect(done.status).toBe(200);
      expect(Object.keys(done.body)).toEqual(["confirmationCode"]);
      expect(done.body.confirmationCode).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      await expect(
        finishOAuthSecretConnect({
          db,
          cipher,
          ownerId: p.id,
          name: "browserstack",
          confirmationCode: done.body.confirmationCode as string,
        }),
      ).resolves.toMatchObject({ status: "connected" });

      // Neither the link nor what the provider sent back reaches a log, and the complete echoes
      // none of them (the authorize URL carries the state by design; the link is in no response).
      for (const value of [token, code, state]) {
        expect(logged.join("\n")).not.toContain(value);
        expect(done.text).not.toContain(value);
      }
      expect(started.text).not.toContain(token);
    });

    it("refuses a missing, malformed, tampered, expired or other-audience link with fixed codes", async () => {
      const p = await principal();
      const good = await host.mcp.mintRequestState(payload(host, p));
      const expired = await host.mcp.mintRequestState(payload(host, p, { exp: Date.now() - 1 }));
      const other = await host.mcp.mintRequestState(payload(host, p, { aud: audience === "http" ? "stdio" : "http" }));
      const wrongKind = await host.mcp.mintRequestState({ ...payload(host, p), kind: "run-transcript" });
      for (const path of [OAUTH_LOOPBACK_START_PATH, OAUTH_LOOPBACK_COMPLETE_PATH]) {
        const body = path === OAUTH_LOOPBACK_START_PATH ? { redirectUri: LOOPBACK } : { code: "c", state: "s" };
        const missing = await post(host, path, null, body);
        expect(missing.status).toBe(401);
        expect(missing.headers.get("www-authenticate")).toBe("Bearer");
        expect(await missing.json()).toEqual({ error: "link_required" });
        // The token is read from the Authorization header only, never from a query parameter.
        const inQuery = await fetch(`${host.origin}${path}?t=${encodeURIComponent(good)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(inQuery.status).toBe(401);
        const basic = await post(host, path, null, body, { authorization: `Basic ${good}` });
        expect(basic.status).toBe(401);
        for (const bad of [`${good}x`, "garbage", expired, other, wrongKind]) {
          const res = await post(host, path, bad, body);
          expect(res.status).toBe(403);
          const text = await res.text();
          expect(JSON.parse(text)).toEqual({ error: "link_invalid" });
          expect(text).not.toContain(bad);
        }
      }
      expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
      expect(logged.join("\n")).not.toContain(good);
    });

    it("refuses any redirect URI but http://127.0.0.1:<port>/callback, and starts nothing", async () => {
      const p = await principal();
      const token = await host.mcp.mintRequestState(payload(host, p));
      for (const redirectUri of [
        "https://127.0.0.1:53111/callback",
        "http://localhost:53111/callback",
        "http://evil.example:53111/callback",
        "http://127.0.0.1:80/callback",
        "http://127.0.0.1:53111/callback?x=1",
        "http://127.0.0.1:53111/callback#f",
        "http://u@127.0.0.1:53111/callback",
        "http://127.0.0.1:53111/other",
      ]) {
        const res = await json(await post(host, OAUTH_LOOPBACK_START_PATH, token, { redirectUri }));
        expect(res).toMatchObject({ status: 400, body: { error: "redirect_uri_invalid" } });
      }
      expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
      expect(fake.tokenRequests).toBe(0);
    });

    it("refuses a wrong method, a non-JSON or malformed body, and an over-large one", async () => {
      const p = await principal();
      const token = await host.mcp.mintRequestState(payload(host, p));
      const get = await fetch(`${host.origin}${OAUTH_LOOPBACK_START_PATH}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.status).toBe(405);
      expect(get.headers.get("allow")).toBe("POST");

      const form = await post(host, OAUTH_LOOPBACK_START_PATH, token, `redirectUri=${encodeURIComponent(LOOPBACK)}`, {
        "content-type": "application/x-www-form-urlencoded",
      });
      expect(form.status).toBe(415);
      expect(await form.json()).toEqual({ error: "expected_json" });
      const text = await post(host, OAUTH_LOOPBACK_START_PATH, token, "x", { "content-type": "text/plain" });
      expect(text.status).toBe(415);
      const broken = await post(host, OAUTH_LOOPBACK_START_PATH, token, "{");
      expect(await json(broken)).toMatchObject({ status: 400, body: { error: "invalid_json" } });

      for (const [path, body] of [
        [OAUTH_LOOPBACK_START_PATH, {}],
        [OAUTH_LOOPBACK_START_PATH, { redirectUri: LOOPBACK, extra: 1 }],
        [OAUTH_LOOPBACK_START_PATH, { redirectUri: 53111 }],
        [OAUTH_LOOPBACK_START_PATH, [LOOPBACK]],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c" }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { state: "s" }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "", state: "s" }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c", state: "s", extra: "x" }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c".repeat(257), state: "s" }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c", state: "s".repeat(257) }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c", state: "s", iss: "i".repeat(2049) }],
        [OAUTH_LOOPBACK_COMPLETE_PATH, { code: "c", state: "s", iss: 1 }],
      ] as const) {
        const res = await post(host, path, token, body);
        expect(await json(res), JSON.stringify(body).slice(0, 80)).toMatchObject({
          status: 400,
          body: { error: "invalid_request" },
        });
      }
      const large = await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, token, {
        code: "c",
        state: "s",
        pad: "x".repeat(16 * 1024),
      });
      expect(large.status).toBe(413);
      expect(await large.json()).toEqual({ error: "payload_too_large" });
    });

    it("maps a refused start to create_secret's fixed code and message", async () => {
      const p = await principal();
      await db.secret.create({
        data: { ownerId: p.id, name: "taken", ciphertext: "enc:eA==", keyId: "test-key" },
      });
      const token = await host.mcp.mintRequestState(payload(host, p, { name: "taken" }));
      const res = await json(await post(host, OAUTH_LOOPBACK_START_PATH, token, { redirectUri: LOOPBACK }));
      expect(res).toEqual({
        status: 409,
        body: { error: "secret_oauth_name_taken", message: SECRET_NOT_OAUTH },
        text: expect.any(String),
      });

      const many = await host.mcp.mintRequestState(payload(host, p, { name: "many" }));
      for (let i = 0; i < 5; i += 1) {
        expect((await post(host, OAUTH_LOOPBACK_START_PATH, many, { redirectUri: LOOPBACK })).status).toBe(200);
      }
      const sixth = await json(await post(host, OAUTH_LOOPBACK_START_PATH, many, { redirectUri: LOOPBACK }));
      expect(sixth).toMatchObject({ status: 429, body: { error: "secret_oauth_too_many_pending" } });
    });

    it("treats a state of another principal, another secret name, or a web sign-in as invalid, and consumes none of them", async () => {
      const owner = await principal();
      const intruder = await principal();
      const ownerLink = await host.mcp.mintRequestState(payload(host, owner));
      const { code, state } = await begin(host, ownerLink);

      const intruderLink = await host.mcp.mintRequestState(payload(host, intruder));
      const otherName = await host.mcp.mintRequestState(payload(host, owner, { name: "other" }));
      for (const token of [intruderLink, otherName]) {
        const res = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, token, { code, state }));
        expect(res).toMatchObject({ status: 400, body: { error: "invalid" } });
        expect(res.text).not.toContain(code);
        expect(res.text).not.toContain(state);
      }
      const row = await db.oAuthLinkRequest.findUniqueOrThrow({ where: { stateHash: stateHash(state) } });
      expect(row.callbackAt).toBeNull();
      expect(fake.tokenRequests).toBe(0);

      // A web-started request (same owner and name) belongs to the web callback.
      const web = await startOAuthSecretConnect({
        db,
        cipher,
        ownerId: owner.id,
        name: "browserstack",
        resource: fake.mcpUrl,
        redirectUri: "https://wardby.example/oauth/callback",
        options: OPTS,
      });
      const webCallback = new URL(await fake.approve(web.authorizeUrl));
      const webState = webCallback.searchParams.get("state")!;
      const refused = await json(
        await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, ownerLink, {
          code: webCallback.searchParams.get("code"),
          state: webState,
        }),
      );
      expect(refused).toMatchObject({ status: 400, body: { error: "invalid" } });
      expect(
        (await db.oAuthLinkRequest.findUniqueOrThrow({ where: { stateHash: stateHash(webState) } })).callbackAt,
      ).toBeNull();

      // The owner's own link still completes its request.
      const done = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, ownerLink, { code, state }));
      expect(done.status).toBe(200);
      // And the state is single use.
      const again = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, ownerLink, { code, state }));
      expect(again).toMatchObject({ status: 400, body: { error: "invalid" } });
    });

    it("answers failed when the provider refuses the code, and logs no value", async () => {
      const p = await principal();
      const token = await host.mcp.mintRequestState(payload(host, p));
      const { state } = await begin(host, token);
      const res = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, token, { code: "fake-wrong-code", state }));
      expect(res).toEqual({ status: 502, body: { error: "failed" }, text: expect.any(String) });
      expect(logged.join("\n")).not.toContain("fake-wrong-code");
      expect(logged.join("\n")).not.toContain(state);
      expect(logged.join("\n")).not.toContain(token);
    });

    if (audience === "http") {
      it("the web callback refuses a loopback-started request and leaves it for the CLI (LB-3)", async () => {
        const p = await principal();
        const token = await host.mcp.mintRequestState(payload(host, p));
        const { code, state } = await begin(host, token);
        const page = await fetch(`${host.origin}/oauth/callback?${new URLSearchParams({ code, state }).toString()}`);
        expect(page.status).toBe(400);
        expect(await page.text()).toContain("Link not valid");
        const done = await json(await post(host, OAUTH_LOOPBACK_COMPLETE_PATH, token, { code, state }));
        expect(done.status).toBe(200);
      });
    }
  },
);
