import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { createDocument } from "../core/documents/service.js";
import { createShareLink, revokeShareLink } from "../core/documents/share-links.js";
import { buildMcpServer } from "../mcp/server.js";
import { loggablePath, startHttpServer, type HttpServerHandle } from "../mcp/transport/streamable-http.js";
import type { AuthProvider } from "../providers/auth/types.js";
import { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import { IdentityService } from "../mcp/auth/self-hosted/credentials.js";
import { setLogLineFilter } from "../core/logger.js";
import type { OidcLogin } from "./oidc-login.js";
import { createWebSession } from "./session.js";
import type { WebDeps } from "./routes.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const JS = "documents-abc123.js";
const CSS = "documents-abc123.css";
const OWNER_EMAIL = "olive.owner@example.com";
const GUEST_EMAIL = "gus.guest@example.com";
const DEV = { secure: false };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** A tiny cookie jar: name → value, updated from Set-Cookie (Max-Age=0 removes). */
class Jar {
  readonly values = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.values.set(k, v);
  }
  header(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  take(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";", 1);
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (/Max-Age=0\b/.test(c) || v === "") this.values.delete(k);
      else this.values.set(k, v);
    }
  }
}

function bootstrapOf(html: string): Record<string, unknown> {
  const m = /<script nonce="([^"]+)">window\.__WARDBY__ = (.*?);<\/script>/s.exec(html);
  if (!m) throw new Error("no bootstrap");
  return JSON.parse(m[2]) as Record<string, unknown>;
}

/** Sends a request with a raw, unnormalized path (fetch would collapse dot segments). */
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Declares a body length on a raw socket and reads the status line (the server answers before reading). */
function declaredLengthStatus(port: number, path: string, length: number, extra: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `PUT ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${length}\r\n${extra}\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
  });
}

describe.skipIf(!process.env.DATABASE_URL)("web routes (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const logged: string[] = [];
  let owner: Principal;
  let member: Principal;
  let outsider: Principal;
  let docId: string;
  let assets: string;
  let port: number;
  let origin: string;
  let handle: HttpServerHandle;
  const fakeOidc: OidcLogin & { finishImpl?: () => Promise<{ principalId: string; returnTo: string }> } = {
    configured: true,
    async startLogin({ returnTo }) {
      if (!returnTo.startsWith("/d/") && !returnTo.startsWith("/s/")) throw new Error("web_login_failed");
      return {
        redirectUrl: "https://idp.example/authorize?state=abc",
        stateCookie: "wardby-dev-web-login=sealed; Path=/; HttpOnly; SameSite=Lax; Max-Age=600",
      };
    },
    async finishLogin() {
      return fakeOidc.finishImpl!();
    },
  };

  async function startServer(extra: Partial<WebDeps> = {}) {
    port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    const canonicalUri = `${origin}/mcp`;
    const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri } });
    return startHttpServer({
      mcp,
      config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
      auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
      web: {
        db,
        cipher,
        canonicalUri,
        authMode: "delegating",
        oidc: fakeOidc,
        assetsRoot: assets,
        ...extra,
      },
    });
  }

  const session = async (principalId: string) => {
    const created = await createWebSession(db, { principalId }, DEV);
    return { jar: new Jar({ "wardby-dev-web": created.token }), csrf: created.csrf, token: created.token };
  };

  const call = (
    path: string,
    init: { method?: string; jar?: Jar; csrf?: string; body?: unknown; origin?: string | null; headers?: object } = {},
  ) =>
    fetch(origin + path, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        ...(init.jar ? { cookie: init.jar.header() } : {}),
        ...(init.csrf ? { "x-wardby-csrf": init.csrf } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.origin === null ? {} : init.method && init.method !== "GET" ? { origin: init.origin ?? origin } : {}),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    setLogLineFilter((line) => {
      logged.push(line);
      return line;
    });
    owner = await db.principal.create({ data: { subject: `web-owner-${s}` } });
    member = await db.principal.create({ data: { subject: `web-member-${s}` } });
    outsider = await db.principal.create({ data: { subject: `web-out-${s}` } });
    await db.principalProfile.create({
      data: { principalId: owner.id, displayName: "Olive Owner", email: OWNER_EMAIL, source: "oidc" },
    });
    await db.principalProfile.create({
      data: { principalId: member.id, displayName: "Mel Member", email: "mel@example.com", source: "oidc" },
    });
    docId = (
      await createDocument(db, cipher, {
        ownerId: owner.id,
        title: "Plan <script>alert(1)</script>",
        markdown: "hello world",
      })
    ).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "write",
      },
    });
    assets = await mkdtemp(join(tmpdir(), "wardby-web-assets-"));
    await writeFile(join(assets, JS), "console.log('app');");
    await writeFile(join(assets, CSS), "body{}");
    await writeFile(join(assets, "not-listed.js"), "secret()");
    await writeFile(join(assets, "manifest.json"), JSON.stringify({ "documents.js": JS, "documents.css": CSS }));
    handle = await startServer();
  });
  afterAll(async () => {
    await handle?.close();
    setLogLineFilter((line) => line);
    await db.webSession.deleteMany({ where: { principalId: { in: [owner.id, member.id, outsider.id] } } });
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, member.id, outsider.id] } } });
    await rm(assets, { recursive: true, force: true });
    await db.$disconnect();
  });

  describe("document page", () => {
    it("redirects a visitor without a session to the sign-in route with a return path", async () => {
      const res = await call(`/d/${docId}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/web/login?returnTo=${encodeURIComponent(`/d/${docId}`)}`);
    });

    it("serves the page shell to a member with a grant, with the strict page headers and a nonce'd bootstrap", async () => {
      const { jar, csrf } = await session(member.id);
      const res = await call(`/d/${docId}`, { jar });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("default-src 'none'");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await res.text();
      const nonce = /<script nonce="([^"]+)">/.exec(html)![1];
      expect(csp).toContain(`'nonce-${nonce}'`);
      expect(html).toContain('<div id="app"></div>');
      expect(html).toContain(`<script src="/web/static/${JS}"></script>`);
      expect(html).toContain(`<link rel="stylesheet" href="/web/static/${CSS}">`);
      // The untrusted title is escaped in the <title> and never raw anywhere.
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("Plan &lt;script&gt;alert(1)&lt;/script&gt;");
      const boot = bootstrapOf(html);
      expect(boot).toMatchObject({
        documentId: docId,
        csrf,
        viewer: { kind: "member", name: "Mel Member", access: "write" },
        loginUrl: `/web/login?returnTo=${encodeURIComponent(`/d/${docId}`)}`,
      });
      // The bootstrap JSON never carries a raw "<" (it cannot close the script element).
      const raw = /window\.__WARDBY__ = (.*?);<\/script>/s.exec(html)![1];
      expect(raw).not.toContain("<");
      expect(html).not.toContain(OWNER_EMAIL);
    });

    it("answers 404 to a signed-in principal without access", async () => {
      const { jar } = await session(outsider.id);
      const res = await call(`/d/${docId}`, { jar });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("document_not_found");
    });

    it("answers 503 web_assets_missing when the asset manifest is absent", async () => {
      const { jar } = await session(member.id);
      await rename(join(assets, "manifest.json"), join(assets, "manifest.off"));
      try {
        const res = await call(`/d/${docId}`, { jar });
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("web_assets_missing");
      } finally {
        await rename(join(assets, "manifest.off"), join(assets, "manifest.json"));
      }
    });
  });

  describe("static assets", () => {
    it("serves only files named in the manifest, immutable, with the right content type", async () => {
      const js = await call(`/web/static/${JS}`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(js.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await js.text()).toBe("console.log('app');");
      const css = await call(`/web/static/${CSS}`);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect((await call("/web/static/not-listed.js")).status).toBe(404);
      expect((await call("/web/static/manifest.json")).status).toBe(404);
    });

    it("refuses path traversal", async () => {
      expect(await rawGet(port, "/web/static/../x")).toBe(404);
      expect(await rawGet(port, "/web/static/..%2fmanifest.json")).toBe(404);
      expect(await rawGet(port, "/web/static/%2e%2e%2f%2e%2e%2fpackage.json")).toBe(404);
      expect(await rawGet(port, `/web/static/${JS}/..`)).toBe(404);
      expect(await rawGet(port, "/web/static/")).toBe(404);
    });
  });

  describe("document JSON API", () => {
    it("returns the document, current version, the viewer and threads to a member", async () => {
      const { jar } = await session(member.id);
      const res = await call(`/d/api/${docId}`, { jar });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        document: { id: docId, title: "Plan <script>alert(1)</script>" },
        version: { number: expect.any(Number), markdown: expect.any(String) },
        me: { kind: "member", name: "Mel Member", access: "write" },
        threads: expect.any(Array),
      });
    });

    it("answers 401 web_session_required without a session, and never redirects the API", async () => {
      const res = await call(`/d/api/${docId}`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "web_session_required" });
    });

    it("refuses a write without the CSRF header (403 web_csrf_failed) or with a wrong one", async () => {
      const { jar } = await session(member.id);
      const none = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        body: { markdown: "x", baseNumber: 1 },
      });
      expect(none.status).toBe(403);
      expect(await none.json()).toEqual({ error: "web_csrf_failed" });
      const other = await session(member.id);
      const wrong = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf: other.csrf,
        body: { markdown: "x", baseNumber: 1 },
      });
      expect(wrong.status).toBe(403);
    });

    it("refuses a cross-origin write and a write without an Origin header", async () => {
      const { jar, csrf } = await session(member.id);
      const cross = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf,
        origin: "https://evil.example",
        body: { anchor: { type: "text", quote: "hello", prefix: "", suffix: "" }, body: "x" },
      });
      expect(cross.status).toBe(403);
      const missing = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf,
        origin: null,
        body: { anchor: { type: "text", quote: "hello", prefix: "", suffix: "" }, body: "x" },
      });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({ error: "web_origin_rejected" });
    });

    it("saves content against the base version and answers 409 document_version_conflict to a stale one", async () => {
      const { jar, csrf } = await session(member.id);
      const current = ((await (await call(`/d/api/${docId}`, { jar })).json()) as { version: { number: number } })
        .version.number;
      const ok = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { markdown: "hello world, edited", baseNumber: current },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ version: { number: current + 1 } });
      const stale = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { markdown: "stale", baseNumber: current },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "document_version_conflict" });
      const bad = await call(`/d/api/${docId}/content`, { method: "PUT", jar, csrf, body: { markdown: 5 } });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: "invalid_request" });
    });

    it("accepts a document body over 1 MiB on /d/api/ but refuses one over 2 MiB with 413", async () => {
      const { jar, csrf } = await session(member.id);
      const big = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { markdown: "x".repeat(1_500_000), baseNumber: 1 },
      });
      // Past the transport limit; refused by the document size rule instead.
      expect(big.status).toBe(413);
      expect(await big.json()).toEqual({ error: "document_too_large" });
      const huge = await declaredLengthStatus(
        port,
        `/d/api/${docId}/content`,
        2 * 1024 * 1024 + 1,
        `Origin: ${origin}\r\nCookie: ${jar.header()}\r\nx-wardby-csrf: ${csrf}\r\n`,
      );
      expect(huge.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
      expect(huge).toContain('{"error":"payload_too_large"}');
      // Other paths keep their own limits: 2 MiB is not accepted on /web/.
      const elsewhere = await declaredLengthStatus(port, "/web/logout", 100 * 1024, `Origin: ${origin}\r\n`);
      expect(elsewhere.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
    });

    it("creates threads, replies, edits, deletes and resolves; mention candidates carry no emails", async () => {
      const { jar, csrf } = await session(member.id);
      const t = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf,
        body: { anchor: { type: "text", quote: "hello", prefix: "", suffix: " world" }, body: "first" },
      });
      expect(t.status).toBe(201);
      const { threadId } = (await t.json()) as { threadId: string };
      const r = await call(`/d/api/threads/${threadId}/replies`, {
        method: "POST",
        jar,
        csrf,
        body: { body: "second" },
      });
      expect(r.status).toBe(201);
      const { commentId } = (await r.json()) as { commentId: string };
      const e = await call(`/d/api/comments/${commentId}`, { method: "PATCH", jar, csrf, body: { body: "second!" } });
      expect(e.status).toBe(200);
      const d = await call(`/d/api/comments/${commentId}`, { method: "DELETE", jar, csrf });
      expect(d.status).toBe(200);
      const st = await call(`/d/api/threads/${threadId}/status`, {
        method: "POST",
        jar,
        csrf,
        body: { status: "resolved" },
      });
      expect(st.status).toBe(200);
      const badStatus = await call(`/d/api/threads/${threadId}/status`, {
        method: "POST",
        jar,
        csrf,
        body: { status: "outdated" },
      });
      expect(badStatus.status).toBe(400);
      const m = await call(`/d/api/${docId}/mentions`, { jar });
      expect(m.status).toBe(200);
      const text = await m.text();
      expect(text).toContain("Olive Owner");
      expect(text).not.toContain("@example.com");
      const ownerComment = await call(`/d/api/comments/${commentId}`, {
        method: "PATCH",
        jar,
        csrf,
        body: { body: "x" },
      });
      expect(ownerComment.status).toBe(404);
    });

    it("answers 501 document_send_not_available when sending is not wired", async () => {
      const { jar, csrf } = await session(member.id);
      const res = await call(`/d/api/${docId}/send`, { method: "POST", jar, csrf, body: { threadIds: [] } });
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "document_send_not_available" });
    });

    it("returns 404 for unknown web API paths", async () => {
      const { jar } = await session(member.id);
      expect((await call(`/d/api/${docId}/nope`, { jar })).status).toBe(404);
      expect((await call(`/web/nope`)).status).toBe(404);
    });
  });

  describe("share links and guests", () => {
    it("lets a visitor open a comment link, register as a guest, comment, and be shown as (guest)", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const jar = new Jar();
      const page = await call(`/s/${link.token}`, { jar });
      expect(page.status).toBe(200);
      jar.take(page);
      expect(jar.values.has("wardby-dev-web-pre")).toBe(true);
      const boot = bootstrapOf(await page.text());
      expect(boot).toMatchObject({
        documentId: docId,
        shareToken: link.token,
        viewer: { kind: "anonymous", access: "comment" },
      });
      const preCsrf = boot.csrf as string;

      // An anonymous visitor reads through the share token.
      const read = await call(`/d/api/${docId}`, { jar, headers: { "x-wardby-share": link.token } });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { me: { kind: string } }).me.kind).toBe("anonymous");

      // Registration needs Origin and the pre-session CSRF value.
      const noCsrf = await call(`/s/${link.token}/guest`, { method: "POST", jar, body: { name: "Gus" } });
      expect(noCsrf.status).toBe(403);
      expect(await noCsrf.json()).toEqual({ error: "web_csrf_failed" });
      const noOrigin = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: preCsrf,
        origin: null,
        body: { name: "Gus" },
      });
      expect(noOrigin.status).toBe(403);
      const reserved = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: preCsrf,
        body: { name: "Olive Owner" },
      });
      expect(reserved.status).toBe(400);
      expect(await reserved.json()).toEqual({ error: "guest_name_invalid" });

      const reg = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: preCsrf,
        body: { name: "Gus", email: GUEST_EMAIL },
      });
      expect(reg.status).toBe(200);
      jar.take(reg);
      const regBody = (await reg.json()) as { csrf: string; me: unknown };
      expect(regBody.me).toEqual({ kind: "guest", name: "Gus", access: "comment" });
      expect(JSON.stringify(regBody)).not.toContain(GUEST_EMAIL);
      expect(jar.values.has("wardby-dev-web")).toBe(true);
      expect(jar.values.has("wardby-dev-web-pre")).toBe(false);

      const c = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf: regBody.csrf,
        body: { anchor: { type: "text", quote: "world", prefix: "hello ", suffix: "" }, body: "guest note" },
      });
      expect(c.status).toBe(201);
      // A guest cannot write content.
      const w = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf: regBody.csrf,
        body: { markdown: "x", baseNumber: 1 },
      });
      expect(w.status).toBe(403);
      expect(await w.json()).toEqual({ error: "document_access_denied" });

      // The guest page now renders as the guest.
      const again = await call(`/s/${link.token}`, { jar });
      expect(bootstrapOf(await again.text()).viewer).toEqual({ kind: "guest", name: "Gus", access: "comment" });
      const onDoc = await call(`/d/${docId}`, { jar });
      expect(onDoc.status).toBe(200);
      expect(bootstrapOf(await onDoc.text()).viewer).toEqual({ kind: "guest", name: "Gus", access: "comment" });

      // A member sees the guest's comment as "(guest)" and never the guest's email.
      const m = await session(member.id);
      const doc = await call(`/d/api/${docId}`, { jar: m.jar });
      const text = await doc.text();
      expect(text).toContain("Gus (guest)");
      expect(text).toContain("guest note");
      expect(text).not.toContain(GUEST_EMAIL);
      expect(text).not.toContain(OWNER_EMAIL);
      const page2 = await call(`/d/${docId}`, { jar: m.jar });
      expect(await page2.text()).not.toContain(GUEST_EMAIL);

      // Revoking the link ends the guest: the session is treated as absent.
      await revokeShareLink(db, { shareLinkId: link.id, viewer: { kind: "principal", principalId: owner.id } });
      const after = await call(`/d/api/${docId}`, { jar });
      expect(after.status).toBe(401);
      expect((await call(`/s/${link.token}`, { jar })).status).toBe(404);
    });

    it("does not register guests on a view-only link, but lets them read it", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const jar = new Jar();
      const page = await call(`/s/${link.token}`, { jar });
      jar.take(page);
      const boot = bootstrapOf(await page.text());
      expect(boot.viewer).toMatchObject({ kind: "anonymous", access: "read" });
      const reg = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: boot.csrf as string,
        body: { name: "Viv" },
      });
      expect(reg.status).toBe(403);
      expect(await reg.json()).toEqual({ error: "document_access_denied" });
      // A share token for one document reads nothing else.
      const otherDoc = (await createDocument(db, cipher, { ownerId: owner.id, title: "Other", markdown: "y" })).id;
      const cross = await call(`/d/api/${otherDoc}`, { headers: { "x-wardby-share": link.token } });
      expect(cross.status).toBe(401);
      expect((await call(`/s/not-a-real-token`)).status).toBe(404);
    });

    it("gives a signed-in outsider the link's permission, and takes it away with the link", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const { jar, token: before } = await session(outsider.id);
      const page = await call(`/s/${link.token}`, { jar });
      expect(page.status).toBe(200);
      jar.take(page);
      const boot = bootstrapOf(await page.text());
      expect(boot.viewer).toMatchObject({ kind: "member", access: "comment" });
      // The session was replaced by one that carries the link (R9c), and the old one ended.
      expect(jar.values.get("wardby-dev-web")).not.toBe(before);
      expect(await db.webSession.count({ where: { tokenHash: sha(before) } })).toBe(0);
      const c = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf: boot.csrf as string,
        body: { anchor: { type: "text", quote: "hello", prefix: "", suffix: "" }, body: "outsider via link" },
      });
      expect(c.status).toBe(201);
      await revokeShareLink(db, { shareLinkId: link.id, viewer: { kind: "principal", principalId: owner.id } });
      expect((await call(`/d/api/${docId}`, { jar })).status).toBe(401);
    });

    it("keeps a member's own higher access when they open a weaker link", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const { jar, token: before } = await session(member.id);
      const page = await call(`/s/${link.token}`, { jar });
      jar.take(page);
      expect(bootstrapOf(await page.text()).viewer).toMatchObject({ kind: "member", access: "write" });
      expect(jar.values.get("wardby-dev-web")).toBe(before);
    });
  });

  describe("sign-in routes (delegating)", () => {
    it("starts the OIDC login with the state cookie, and refuses an unsafe return path", async () => {
      const res = await call(`/web/login?returnTo=${encodeURIComponent(`/d/${docId}`)}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("https://idp.example/authorize?state=abc");
      expect(res.headers.getSetCookie().join("\n")).toContain("wardby-dev-web-login=sealed");
      const bad = await call(`/web/login?returnTo=${encodeURIComponent("https://evil.example/")}`);
      expect(bad.status).toBe(400);
      expect(bad.headers.get("location")).toBeNull();
    });

    it("finishes the login: clears the state cookie, ends the old session, sets a new one and returns", async () => {
      const old = await session(member.id);
      fakeOidc.finishImpl = async () => ({ principalId: member.id, returnTo: `/d/${docId}` });
      const res = await call(`/web/callback?code=c&state=abc`, { jar: old.jar });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/d/${docId}`);
      const cookies = res.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("wardby-dev-web-login=;") && c.includes("Max-Age=0"))).toBe(true);
      const fresh = cookies.find((c) => c.startsWith("wardby-dev-web="))!;
      expect(fresh).toContain("HttpOnly");
      expect(await db.webSession.count({ where: { tokenHash: sha(old.token) } })).toBe(0);
      const jar = new Jar();
      jar.take(res);
      expect((await call(`/d/${docId}`, { jar })).status).toBe(200);
    });

    it("maps a failed login to a code, clears the state cookie, and never echoes the error message", async () => {
      fakeOidc.finishImpl = async () => {
        throw new Error("db exploded near secret-value-xyz");
      };
      const res = await call(`/web/callback?code=c&state=abc`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("web_login_failed");
      expect(text).not.toContain("secret-value-xyz");
      expect(res.headers.getSetCookie().some((c) => c.startsWith("wardby-dev-web-login=;"))).toBe(true);
      fakeOidc.finishImpl = async () => {
        throw new Error("web_login_state_invalid");
      };
      const stale = await call(`/web/callback?code=c&state=abc`);
      expect(stale.status).toBe(400);
      expect(await stale.text()).toContain("web_login_state_invalid");
      await new Promise((r) => setTimeout(r, 50));
      expect(logged.join("\n")).not.toContain("secret-value-xyz");
    });

    it("logs out only with Origin and CSRF", async () => {
      const { jar, csrf, token } = await session(member.id);
      const noCsrf = await call(`/web/logout`, { method: "POST", jar, body: {} });
      expect(noCsrf.status).toBe(403);
      expect(await db.webSession.count({ where: { tokenHash: sha(token) } })).toBe(1);
      const ok = await call(`/web/logout`, { method: "POST", jar, csrf, body: {} });
      expect(ok.status).toBe(200);
      expect(ok.headers.getSetCookie().some((c) => c.startsWith("wardby-dev-web=;"))).toBe(true);
      expect(await db.webSession.count({ where: { tokenHash: sha(token) } })).toBe(0);
    });

    it("masks share tokens in the paths the transport logs", () => {
      expect(loggablePath("/s/abcDEF123_-/guest?x=1")).toBe("/s/[token]/guest");
      expect(loggablePath("/s/abcDEF123_-")).toBe("/s/[token]");
      expect(loggablePath("/d/doc1?returnTo=/s/abc")).toBe("/d/doc1");
    });

    it("never writes a share token into the logs", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      await call(`/s/${link.token}`);
      await call(`/s/${link.token}/guest`, { method: "POST", body: { name: "x" } });
      await new Promise((r) => setTimeout(r, 50));
      expect(logged.join("\n")).not.toContain(link.token);
    });
  });

  describe("sign-in routes (self-hosted)", () => {
    it("sends /web/login to the self-hosted /login with the return path, then bridges the session", async () => {
      const sport = await freePort();
      const sorigin = `http://127.0.0.1:${sport}`;
      const canonicalUri = `${sorigin}/mcp`;
      const provider = new SelfHostedAuthProvider(
        { canonicalUri, signingKey: "a1".repeat(32), credentialHashKey: "b2".repeat(32) },
        db,
      );
      const identity = new IdentityService(db, "b2".repeat(32));
      const subject = `web-sh-${s}`;
      const user = await identity.createUser(subject, [], "Sal Self");
      const principal = await db.principal.findUniqueOrThrow({ where: { subject } });
      await db.resourceGrant.create({
        data: {
          resourceType: "document",
          resourceId: docId,
          granteeKind: "principal",
          granteePrincipalId: principal.id,
          granteeKey: `principal:${principal.id}`,
          level: "read",
        },
      });
      const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri } });
      const sh = await startHttpServer({
        mcp,
        config: { canonicalUri, httpBind: { host: "127.0.0.1", port: sport }, authProviderKind: "self-hosted" },
        auth: { authProvider: provider, db, providers: {} as never },
        selfHosted: provider,
        web: { db, cipher, canonicalUri, authMode: "self-hosted", selfHosted: provider, assetsRoot: assets },
      });
      try {
        const jar = new Jar();
        const go = (path: string, init: RequestInit = {}) =>
          fetch(sorigin + path, {
            redirect: "manual",
            ...init,
            headers: { cookie: jar.header(), ...((init.headers as Record<string, string>) ?? {}) },
          }).then((r) => {
            jar.take(r);
            return r;
          });
        const returnTo = `/d/${docId}`;
        const start = await go(`/web/login?returnTo=${encodeURIComponent(returnTo)}`);
        expect(start.status).toBe(302);
        const loginPath = start.headers.get("location")!;
        expect(loginPath).toBe(`/login?return=${encodeURIComponent(returnTo)}`);
        // The OIDC callback is not mounted in self-hosted mode.
        expect((await go(`/web/callback?code=x&state=y`)).status).toBe(404);
        const form = await (await go(loginPath)).text();
        const csrf = /name="csrf" value="([^"]+)"/.exec(form)![1];
        expect(form).toContain(`name="return" value="${returnTo}"`);
        const login = await go("/login", {
          method: "POST",
          headers: { origin: sorigin, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ login_key: user.loginKey, csrf, interaction: "", return: returnTo }).toString(),
        });
        expect(login.status).toBe(200);
        expect(await login.json()).toEqual({ redirect: returnTo });
        // The page has no web session yet: it goes back through /web/login, which bridges.
        const page = await go(returnTo);
        expect(page.status).toBe(302);
        // A leftover web session from before is ended when the bridge creates the new one (R9c).
        const stale = await createWebSession(db, { principalId: outsider.id }, DEV);
        jar.values.set("wardby-dev-web", stale.token);
        const bridged = await go(page.headers.get("location")!);
        expect(bridged.status).toBe(302);
        expect(bridged.headers.get("location")).toBe(returnTo);
        expect(await db.webSession.count({ where: { tokenHash: sha(stale.token) } })).toBe(0);
        const shown = await go(returnTo);
        expect(shown.status).toBe(200);
        expect(bootstrapOf(await shown.text()).viewer).toEqual({ kind: "member", name: "Sal Self", access: "read" });
      } finally {
        await sh.close();
        await db.webSession.deleteMany({ where: { principalId: principal.id } });
        await db.resourceGrant.deleteMany({ where: { granteePrincipalId: principal.id } });
        await db.authUser.deleteMany({ where: { principalId: principal.id } });
        await db.principal.deleteMany({ where: { id: principal.id } });
      }
    });
  });
});
