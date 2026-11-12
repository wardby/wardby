import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { resolvePrincipal } from "../mcp/auth/principal.js";
import { loadWebOidcConfig } from "../config/providers.js";
import {
  clearLoginStateCookie,
  createOidcLogin,
  isSafeReturnTo,
  loginStateCookieName,
  type OidcLoginOptions,
} from "./oidc-login.js";

const APP_KEY = "11".repeat(32);
const CLIENT_ID = "wardby-web-test";
const FAKE_SECRET = "fake-client-secret-DO-NOT-LEAK-9f3a";
const FAKE_CODE = "fake-auth-code-DO-NOT-LEAK-71c2";
const FAKE_ACCESS = "fake-access-token-DO-NOT-LEAK-55d0";
const KID = "idp-key";
const CANONICAL = "https://wardby.example.com/mcp";

interface TokenRequest {
  form: URLSearchParams;
  authorization: string;
}

interface IdTokenOverrides {
  audience?: string | string[];
  issuer?: string;
  nonce?: string | null;
  expiresIn?: string | number;
  subject?: string;
  key?: CryptoKey;
  azp?: string;
  claims?: Record<string, unknown>;
}

let server: Server;
let issuer: string;
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let tokenRequests: TokenRequest[];
let challenges: Map<string, string>; // nonce -> code_challenge
let tokenReply: (form: URLSearchParams) => { status: number; body: unknown };
let discoveryOverride: Record<string, unknown> | undefined;
let idOverrides: IdTokenOverrides;
let currentNonce = "";

async function mintIdToken(o: IdTokenOverrides): Promise<string> {
  const jwt = new SignJWT({
    ...(o.nonce === null ? {} : { nonce: o.nonce ?? currentNonce }),
    ...(o.azp ? { azp: o.azp } : {}),
    name: "Ada Lovelace",
    email: "ada@example.com",
    ...o.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(o.issuer ?? issuer)
    .setAudience(o.audience ?? CLIENT_ID)
    .setSubject(o.subject ?? "oidc-user")
    .setExpirationTime(o.expiresIn ?? "5m");
  return jwt.sign(o.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/.well-known/openid-configuration") {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          code_challenge_methods_supported: ["S256"],
          ...discoveryOverride,
        });
      }
      if (req.url === "/jwks") return send(200, { keys: [jwk] });
      if (req.url === "/token" && req.method === "POST") {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        tokenRequests.push({ form, authorization: req.headers.authorization ?? "" });
        const r = tokenReply(form);
        return send(r.status, r.body);
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  tokenRequests = [];
  challenges = new Map();
  discoveryOverride = undefined;
  idOverrides = {};
  tokenReply = (form) => {
    const verifier = form.get("code_verifier") ?? "";
    const expected = challenges.get(currentNonce);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (form.get("code") !== FAKE_CODE || challenge !== expected)
      return { status: 400, body: { error: "invalid_grant" } };
    return { status: 200, body: { access_token: FAKE_ACCESS, token_type: "Bearer", id_token: "__MINT__" } };
  };
});

function options(over: Partial<OidcLoginOptions> = {}): OidcLoginOptions {
  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    clientId: CLIENT_ID,
    clientSecret: FAKE_SECRET,
    scopes: "openid profile email",
    canonicalUri: CANONICAL,
    appKey: APP_KEY,
    fetchOptions: { privateHostAllowlist: ["127.0.0.1"] },
    ...over,
  };
}

/** Wraps the token reply so "__MINT__" becomes a freshly signed ID token with the current overrides. */
async function withMintedReply(): Promise<void> {
  const base = tokenReply;
  const minted = await mintIdToken(idOverrides);
  tokenReply = (form) => {
    const r = base(form);
    if (r.status === 200) r.body = { ...(r.body as object), id_token: minted };
    return r;
  };
}

async function begin(login: ReturnType<typeof createOidcLogin>, returnTo = "/d/doc-1") {
  const { redirectUrl, stateCookie } = await login.startLogin({ returnTo });
  const u = new URL(redirectUrl);
  currentNonce = u.searchParams.get("nonce") ?? "";
  challenges.set(currentNonce, u.searchParams.get("code_challenge") ?? "");
  return {
    redirectUrl: u,
    stateCookie,
    cookieHeader: stateCookie.split(";")[0],
    state: u.searchParams.get("state") ?? "",
  };
}

const callback = (state: string, code = FAKE_CODE) =>
  `/web/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const text = String(err) + JSON.stringify(err) + ((err as Error).stack ?? "");
    for (const secret of [FAKE_SECRET, FAKE_CODE, FAKE_ACCESS]) expect(text).not.toContain(secret);
    return (err as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("isSafeReturnTo", () => {
  it.each(["/d/doc-1", "/s/abc_DEF-123", "/d/doc-1?thread=t1", "/d/doc-1#c"])("accepts %s", (p) => {
    expect(isSafeReturnTo(p)).toBe(true);
  });
  it.each([
    "https://evil.example/d/x",
    "//evil.example/d/x",
    "/d//evil.example",
    "/\\evil.example",
    "/d\\x",
    "/d/../admin",
    "/d/%2e%2e/admin",
    "/x/doc",
    "/d",
    "d/doc",
    "javascript:alert(1)",
    "/d/a b",
    "/d/a\nb",
    "",
    `/d/${"a".repeat(2100)}`,
  ])("rejects %j", (p) => {
    expect(isSafeReturnTo(p)).toBe(false);
  });
});

describe("loadWebOidcConfig", () => {
  it("reads the client and defaults the scopes", () => {
    expect(loadWebOidcConfig({ WEB_OIDC_CLIENT_ID: "c" })).toEqual({
      clientId: "c",
      clientSecret: undefined,
      scopes: "openid profile email",
    });
    expect(
      loadWebOidcConfig({ WEB_OIDC_CLIENT_ID: " c ", WEB_OIDC_CLIENT_SECRET: "s", WEB_OIDC_SCOPES: "openid email" }),
    ).toEqual({ clientId: "c", clientSecret: "s", scopes: "openid email" });
    expect(loadWebOidcConfig({}).clientId).toBeUndefined();
  });
});

describe("startLogin", () => {
  it("redirects to the IdP with state, nonce and an S256 challenge, and keeps the verifier out of the URL", async () => {
    const login = createOidcLogin(options());
    const { redirectUrl, stateCookie, cookieHeader, state } = await begin(login);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(`${issuer}/authorize`);
    const q = redirectUrl.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe("https://wardby.example.com/web/callback");
    expect(q.get("scope")).toBe("openid profile email");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...q.keys()].sort()).toEqual(
      [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
    expect(redirectUrl.href).not.toContain(FAKE_SECRET);
    expect(stateCookie).toMatch(
      /^__Host-wardby-web-login=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
    );
    // The cookie is opaque: neither the state, the nonce nor the readable JSON appears in it, even decoded.
    const value = cookieHeader.split("=").slice(1).join("=");
    const decoded = Buffer.from(value.replace(/^v1\./, ""), "base64url").toString("latin1");
    for (const v of [state, q.get("nonce") ?? "", "/d/doc-1"]) {
      expect(value).not.toContain(v);
      expect(decoded).not.toContain(v);
    }
  });

  it("adds openid when the configured scopes leave it out", async () => {
    const { redirectUrl } = await begin(createOidcLogin(options({ scopes: "profile email" })));
    expect(redirectUrl.searchParams.get("scope")).toBe("openid profile email");
  });

  it("uses dev cookie names on http", async () => {
    const { stateCookie } = await createOidcLogin(options({ canonicalUri: "http://localhost:8080/mcp" })).startLogin({
      returnTo: "/d/x",
    });
    expect(stateCookie).toMatch(/^wardby-dev-web-login=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
    expect(loginStateCookieName("http://localhost:8080/mcp")).toBe("wardby-dev-web-login");
    expect(clearLoginStateCookie(CANONICAL)).toBe(
      "__Host-wardby-web-login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
  });

  it.each(["https://evil.example/d/x", "//evil.example/d/x", "/admin"])("rejects returnTo %j", async (returnTo) => {
    expect(await codeOf(createOidcLogin(options()).startLogin({ returnTo }))).toBe("web_login_failed");
  });

  it.each([
    ["clientId", { clientId: undefined }],
    ["issuer", { issuer: undefined }],
    ["appKey", { appKey: undefined }],
    ["short appKey", { appKey: "ab" }],
  ])("is not configured without %s", async (_name, over) => {
    const login = createOidcLogin(options(over));
    expect(login.configured).toBe(false);
    expect(await codeOf(login.startLogin({ returnTo: "/d/x" }))).toBe("web_login_not_configured");
    expect(await codeOf(login.finishLogin({} as PrismaClient, { url: "/web/callback", cookieHeader: "" }))).toBe(
      "web_login_not_configured",
    );
  });

  it("fails when discovery names another issuer", async () => {
    discoveryOverride = { issuer: "https://other.example" };
    expect(await codeOf(createOidcLogin(options()).startLogin({ returnTo: "/d/x" }))).toBe("web_login_failed");
  });

  it("fails when the IdP does not support S256", async () => {
    discoveryOverride = { code_challenge_methods_supported: ["plain"] };
    expect(await codeOf(createOidcLogin(options()).startLogin({ returnTo: "/d/x" }))).toBe("web_login_failed");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("finishLogin (database)", () => {
  const db = createPrismaClient();
  const run = randomUUID();
  const subject = `oidc-${run}`;
  afterAll(async () => {
    const p = await db.principal.findUnique({ where: { subject } });
    if (p) await db.principalProfile.deleteMany({ where: { principalId: p.id } });
    await db.principal.deleteMany({ where: { subject: { startsWith: `oidc-${run}` } } });
    await db.$disconnect();
  });

  it("returns the same principal the bearer path maps the subject to, and stores the profile", async () => {
    const mcpPrincipal = await resolvePrincipal(subject, db);
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login, "/s/share-token?x=1");
    idOverrides = { subject };
    await withMintedReply();
    const result = await login.finishLogin(db, { url: callback(state), cookieHeader });
    expect(result).toEqual({ principalId: mcpPrincipal.id, returnTo: "/s/share-token?x=1" });
    const profile = await db.principalProfile.findUnique({ where: { principalId: mcpPrincipal.id } });
    expect(profile).toMatchObject({ displayName: "Ada Lovelace", email: "ada@example.com", source: "oidc" });
    // The token request: PKCE verifier, redirect URI, Basic client auth; the secret is not in the form.
    expect(tokenRequests).toHaveLength(1);
    const { form, authorization } = tokenRequests[0];
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("https://wardby.example.com/web/callback");
    expect(form.get("client_secret")).toBeNull();
    expect(authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${FAKE_SECRET}`).toString("base64")}`);
  });

  it("uses preferred_username when the ID token has no name, and a public client sends only client_id", async () => {
    const login = createOidcLogin(options({ clientSecret: undefined }));
    const { cookieHeader, state } = await begin(login);
    idOverrides = { subject: `${subject}-pub`, claims: { name: undefined, preferred_username: "ada" } };
    await withMintedReply();
    const { principalId } = await login.finishLogin(db, { url: callback(state), cookieHeader });
    expect((await db.principalProfile.findUnique({ where: { principalId } }))?.displayName).toBe("ada");
    expect(tokenRequests[0].form.get("client_id")).toBe(CLIENT_ID);
    expect(tokenRequests[0].authorization).toBe("");
    await db.principalProfile.deleteMany({ where: { principalId } });
  });

  it("uses client_secret_post when that is the only method the IdP lists", async () => {
    discoveryOverride = { token_endpoint_auth_methods_supported: ["client_secret_post"] };
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    idOverrides = { subject };
    await withMintedReply();
    await login.finishLogin(db, { url: callback(state), cookieHeader });
    expect(tokenRequests[0].form.get("client_secret")).toBe(FAKE_SECRET);
    expect(tokenRequests[0].authorization).toBe("");
  });

  it.each<[string, () => IdTokenOverrides]>([
    ["wrong aud", () => ({ audience: "someone-else" })],
    ["wrong nonce", () => ({ nonce: "not-the-nonce" })],
    ["missing nonce", () => ({ nonce: null })],
    ["wrong iss", () => ({ issuer: "https://evil.example" })],
    ["expired", () => ({ expiresIn: Math.floor(Date.now() / 1000) - 600 })],
    ["another key", () => ({ key: otherKey })],
    ["multiple aud without azp", () => ({ audience: [CLIENT_ID, "other"] })],
    ["azp of another client", () => ({ azp: "other" })],
    ["empty subject", () => ({ subject: " " })],
  ])("refuses an ID token with %s", async (_name, over) => {
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    idOverrides = { subject, ...over() };
    await withMintedReply();
    expect(await codeOf(login.finishLogin(db, { url: callback(state), cookieHeader }))).toBe("web_login_failed");
  });

  it("fails when the token endpoint refuses the code, without echoing the code or secret", async () => {
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    tokenReply = () => ({ status: 400, body: { error: "invalid_grant", error_description: `bad ${FAKE_CODE}` } });
    expect(await codeOf(login.finishLogin(db, { url: callback(state), cookieHeader }))).toBe("web_login_failed");
  });

  it("fails when the token response has no ID token", async () => {
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    tokenReply = () => ({ status: 200, body: { access_token: FAKE_ACCESS, token_type: "Bearer" } });
    expect(await codeOf(login.finishLogin(db, { url: callback(state), cookieHeader }))).toBe("web_login_failed");
  });

  it("fails when the IdP returned an error instead of a code", async () => {
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    const url = `/web/callback?error=access_denied&state=${state}`;
    expect(await codeOf(login.finishLogin(db, { url, cookieHeader }))).toBe("web_login_failed");
    expect(tokenRequests).toHaveLength(0);
  });

  it("rejects a tampered, missing, foreign, expired or mismatched state cookie", async () => {
    const login = createOidcLogin(options());
    const { cookieHeader, state } = await begin(login);
    const name = "__Host-wardby-web-login";
    const value = cookieHeader.slice(name.length + 1);
    const flipped = value.slice(0, -2) + (value.at(-2) === "A" ? "B" : "A") + value.at(-1);
    const cases: Array<[string, string]> = [
      [`${name}=${flipped}`, callback(state)],
      ["", callback(state)],
      [`${cookieHeader}; ${cookieHeader}`, callback(state)],
      [cookieHeader, callback("another-state")],
      [cookieHeader, `/web/callback?code=${FAKE_CODE}`],
    ];
    const foreign = await begin(createOidcLogin(options({ appKey: "22".repeat(32) })));
    cases.push([foreign.cookieHeader, callback(foreign.state)]);
    for (const [header, url] of cases) {
      expect(await codeOf(login.finishLogin(db, { url, cookieHeader: header }))).toBe("web_login_state_invalid");
    }
    const later = createOidcLogin(options({ now: () => Date.now() + 11 * 60 * 1000 }));
    expect(await codeOf(later.finishLogin(db, { url: callback(state), cookieHeader }))).toBe("web_login_state_invalid");
    expect(tokenRequests).toHaveLength(0);
  });
});
