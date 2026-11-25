import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { createDocument } from "../core/documents/service.js";
import { attachSecret, createSecret } from "../core/secrets.js";
import { createShareLink, revokeShareLink } from "../core/documents/share-links.js";
import { sendThreadsToAgent } from "../core/documents/agent-loop.js";
import { RateLimitError, type RateLimiter } from "../mcp/auth/self-hosted/rate-limit.js";
import { buildMcpServer } from "../mcp/server.js";
import { loggablePath, startHttpServer, type HttpServerHandle } from "../mcp/transport/streamable-http.js";
import { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import { IdentityService } from "../mcp/auth/self-hosted/credentials.js";
import { setLogLineFilter } from "../core/logger.js";
import type { OidcLogin } from "./oidc-login.js";
import { GUEST_RATE_LIMITS, WEB_RATE_WINDOW_MS } from "./rate-limits.js";
import { createWebSession } from "./session.js";
import type { WebDeps } from "./routes.js";
import { freePort, Jar, startWebHttpServer } from "./test-server.test-support.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const JS = "documents-abc123.js";
const CSS = "documents-abc123.css";
const DJS = "designs-def456.js";
const DCSS = "designs-def456.css";
const ASSET_TEXT: Record<string, string> = {
  [JS]: "console.log('app');",
  [CSS]: "body{}",
  [DJS]: "console.log('designs');",
  [DCSS]: ".board{}",
};
const sri = (text: string) => `sha384-${createHash("sha384").update(text).digest("base64")}`;
const SECRET = "FAKE-WEB-DESIGN-SECRET-5d21c7";
/** A second fake value holding the characters HTML escapes: the stored board only ever has its escaped form. */
const SPECIAL = 'Pa"ss&w<rd99';
const SPECIAL_HTML = "Pa&quot;ss&amp;w&lt;rd99";
const readCoffee = (p: string) =>
  readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffee = (): Record<string, string> => ({
  "manifest.json": readCoffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, readCoffee(`boards/${id}.html`)]),
  ),
});
/** Every string a reader gets from a JSON response once decoded: each JSON string, and inside HTML its text and attributes. */
function decodedStrings(text: string): string[] {
  const out = [text];
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(text));
  for (const s of strings) {
    out.push(s);
    if (!s.includes("<")) continue;
    const dom = new JSDOM(s, { virtualConsole: new VirtualConsole() });
    const doc = dom.window.document;
    out.push(doc.documentElement.textContent ?? "");
    for (const el of Array.from(doc.querySelectorAll("*")))
      for (const a of Array.from(el.attributes)) out.push(a.value);
    dom.window.close();
  }
  return out;
}
const OWNER_EMAIL = "olive.owner@example.com";
const GUEST_EMAIL = "gus.guest@example.com";
const DEV = { secure: false };

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
    return startServerAt(port, extra);
  }

  async function startServerAt(atPort: number, extra: Partial<WebDeps> = {}) {
    return startWebHttpServer(db, atPort, { cipher, oidc: fakeOidc, assetsRoot: assets, ...extra });
  }

  const session = async (principalId: string) => {
    const created = await createWebSession(db, { principalId }, DEV);
    return { jar: new Jar({ "wardby-dev-web": created.token }), csrf: created.csrf, token: created.token };
  };

  type CallInit = {
    method?: string;
    jar?: Jar;
    csrf?: string;
    body?: unknown;
    origin?: string | null;
    headers?: object;
  };
  const call = (path: string, init: CallInit = {}) => callAt(origin, path, init);
  const callAt = (base: string, path: string, init: CallInit = {}) =>
    fetch(base + path, {
      method: init.method ?? "GET",
      redirect: "manual",
      headers: {
        ...(init.jar ? { cookie: init.jar.header() } : {}),
        ...(init.csrf ? { "x-wardby-csrf": init.csrf } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.origin === null ? {} : init.method && init.method !== "GET" ? { origin: init.origin ?? base } : {}),
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
    for (const [name, text] of Object.entries(ASSET_TEXT)) await writeFile(join(assets, name), text);
    await writeFile(join(assets, "not-listed.js"), "secret()");
    await writeFile(
      join(assets, "manifest.json"),
      JSON.stringify({ "documents.js": JS, "documents.css": CSS, "designs.js": DJS, "designs.css": DCSS }),
    );
    await writeFile(
      join(assets, "integrity.json"),
      JSON.stringify({
        "documents.js": sri(ASSET_TEXT[JS]),
        "documents.css": sri(ASSET_TEXT[CSS]),
        "designs.js": sri(ASSET_TEXT[DJS]),
        "designs.css": sri(ASSET_TEXT[DCSS]),
      }),
    );
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
      expect(html).toContain(
        `<script src="/web/static/${JS}" integrity="${sri(ASSET_TEXT[JS])}" crossorigin="anonymous"></script>`,
      );
      expect(html).toContain(
        `<link rel="stylesheet" href="/web/static/${CSS}" integrity="${sri(ASSET_TEXT[CSS])}" crossorigin="anonymous">`,
      );
      expect(html).not.toContain(DJS);
      // A document page keeps the phase 1 policy exactly.
      expect(csp).toBe(
        `default-src 'none'; script-src 'self' 'nonce-${/'nonce-([^']+)'/.exec(csp)![1]}'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      );
      // The untrusted title is escaped in the <title> and never raw anywhere.
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("Plan &lt;script&gt;alert(1)&lt;/script&gt;");
      const boot = bootstrapOf(html);
      expect(boot).toMatchObject({
        documentId: docId,
        kind: "document",
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

    it("puts integrity values on the bundle tags that match the served bytes", async () => {
      const { jar } = await session(member.id);
      const html = await (await call(`/d/${docId}`, { jar })).text();
      const tags = [...html.matchAll(/(?:src|href)="\/web\/static\/([^"]+)" integrity="(sha384-[^"]+)"/g)];
      expect(tags.length).toBe(2);
      for (const [, file, integrity] of tags) {
        const served = Buffer.from(await (await call(`/web/static/${file}`)).arrayBuffer());
        expect(integrity).toBe(`sha384-${createHash("sha384").update(served).digest("base64")}`);
      }
    });

    it("serves the page without integrity attributes, and logs the warning once, when integrity.json is missing or malformed", async () => {
      const { jar } = await session(member.id);
      const original = readFileSync(join(assets, "integrity.json"), "utf8");
      try {
        let first = true;
        for (const text of [null, "{not json", JSON.stringify({ "documents.js": "sha256-abc", "documents.css": 5 })]) {
          if (text === null) await rm(join(assets, "integrity.json"));
          else await writeFile(join(assets, "integrity.json"), text);
          const before = logged.length;
          const res = await call(`/d/${docId}`, { jar });
          expect(res.status).toBe(200);
          const html = await res.text();
          expect(html).toContain(`<script src="/web/static/${JS}"></script>`);
          expect(html).not.toContain("integrity=");
          const warnings = logged.slice(before).filter((l) => l.includes("web asset integrity"));
          // Logged once per process per bundle: the first render warns, later renders stay quiet.
          expect(warnings.length).toBe(first ? 1 : 0);
          first = false;
          for (const w of warnings) {
            expect(w).not.toContain("not json");
            expect(w).not.toContain("sha256-abc");
          }
        }
      } finally {
        await writeFile(join(assets, "integrity.json"), original);
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

    it("lists versions without content, reads one, and restores one as a new version", async () => {
      const own = (await createDocument(db, cipher, { ownerId: owner.id, title: "V", markdown: "version one" })).id;
      await db.resourceGrant.create({
        data: {
          resourceType: "document",
          resourceId: own,
          granteeKind: "principal",
          granteePrincipalId: outsider.id,
          granteeKey: `principal:${outsider.id}`,
          level: "read",
        },
      });
      const { jar, csrf } = await session(owner.id);
      const saved = await call(`/d/api/${own}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { markdown: "version two", baseNumber: 1 },
      });
      expect(saved.status).toBe(200);

      const list = await call(`/d/api/${own}/versions`, { jar });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { versions: Record<string, unknown>[]; nextBefore?: number };
      expect(listed.versions.map((v) => v.number)).toEqual([2, 1]);
      expect(listed.versions[0]).toMatchObject({
        via: "editor",
        author: { kind: "member", name: "Olive Owner" },
        answeredThreads: [],
      });
      expect(JSON.stringify(listed)).not.toContain("version one");
      expect(JSON.stringify(listed)).not.toContain(OWNER_EMAIL);
      const paged = (await (await call(`/d/api/${own}/versions?limit=1`, { jar })).json()) as { nextBefore: number };
      expect(paged.nextBefore).toBe(2);
      const older = (await (await call(`/d/api/${own}/versions?before=2`, { jar })).json()) as { versions: unknown[] };
      expect(older.versions).toHaveLength(1);
      for (const bad of ["limit=0", "limit=x", "before=-1", "before=1.5"]) {
        const r = await call(`/d/api/${own}/versions?${bad}`, { jar });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: "invalid_request" });
      }

      const one = await call(`/d/api/${own}/versions/1`, { jar });
      expect(await one.json()).toMatchObject({ version: { number: 1, markdown: "version one" } });
      const missing = await call(`/d/api/${own}/versions/9`, { jar });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "document_version_not_found" });

      // A design version comes back as its files, never as a null Markdown.
      const coffee = (p: string) =>
        readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
      const design = await createDocument(db, cipher, {
        kind: "design",
        ownerId: owner.id,
        title: "Design",
        files: {
          "manifest.json": coffee("manifest.json"),
          ...Object.fromEntries(
            ["home", "menu", "about", "visit"].map((b) => [`boards/${b}.html`, coffee(`boards/${b}.html`)]),
          ),
        },
      });
      const dv = (await (await call(`/d/api/${design.id}/versions/1`, { jar })).json()) as {
        version: Record<string, unknown>;
      };
      expect(dv.version).toMatchObject({ number: 1, format: "boards-v1" });
      expect(dv.version).not.toHaveProperty("markdown");
      expect(Object.keys(dv.version.files as object)).toContain("boards/menu.html");
      const dd = (await (await call(`/d/api/${design.id}`, { jar })).json()) as { version: Record<string, unknown> };
      expect(dd.version).toMatchObject({ number: 1, format: "boards-v1" });
      expect(dd.version).not.toHaveProperty("markdown");

      const restore = (init: CallInit) => call(`/d/api/${own}/versions/1/restore`, { method: "POST", ...init });
      expect((await restore({ jar, body: { baseNumber: 2 } })).status).toBe(403); // no CSRF
      expect((await restore({ jar, csrf, origin: "https://evil.example", body: { baseNumber: 2 } })).status).toBe(403);
      const noBase = await restore({ jar, csrf, body: {} });
      expect(await noBase.json()).toEqual({ error: "invalid_request" });
      const stale = await restore({ jar, csrf, body: { baseNumber: 1 } });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "document_version_conflict" });
      const reader = await session(outsider.id);
      expect((await call(`/d/api/${own}/versions`, { jar: reader.jar })).status).toBe(200);
      const denied = await restore({ jar: reader.jar, csrf: reader.csrf, body: { baseNumber: 2 } });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "document_access_denied" });

      const ok = await restore({ jar, csrf, body: { baseNumber: 2 } });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ version: { number: 3 } });
      const doc = (await (await call(`/d/api/${own}`, { jar })).json()) as { version: { markdown: string } };
      expect(doc.version.markdown).toBe("version one");
      const after = (await (await call(`/d/api/${own}/versions`, { jar })).json()) as {
        versions: { number: number; summary?: string; via: string }[];
      };
      expect(after.versions[0]).toMatchObject({ number: 3, summary: "Restored v1", via: "editor" });

      // A view-only share link reads the history without a session, but cannot restore.
      const link = await createShareLink(db, {
        documentId: own,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const viaLink = await call(`/d/api/${own}/versions`, { headers: { "x-wardby-share": link.token } });
      expect(viaLink.status).toBe(200);
      const v1 = await call(`/d/api/${own}/versions/1`, { headers: { "x-wardby-share": link.token } });
      expect(v1.status).toBe(200);
      const anon = await call(`/d/api/${own}/versions/1/restore`, {
        method: "POST",
        headers: { "x-wardby-share": link.token },
        body: { baseNumber: 3 },
      });
      expect(anon.status).toBe(401);
      expect((await call(`/d/api/${docId}/versions`, { headers: { "x-wardby-share": link.token } })).status).toBe(401);
    });

    it("accepts a document body over 1 MiB on /d/api/ but refuses one over 3 MiB with 413", async () => {
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
        3 * 1024 * 1024 + 1,
        `Origin: ${origin}\r\nCookie: ${jar.header()}\r\nx-wardby-csrf: ${csrf}\r\n`,
      );
      expect(huge.split("\r\n")[0]).toBe("HTTP/1.1 413 Payload Too Large");
      expect(huge).toContain('{"error":"payload_too_large"}');
      // Other paths keep their own limits: 100 KB is not accepted on /web/.
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
      // A guest never sees the member directory: no mention candidates, even with an everyone grant.
      await db.resourceGrant.create({
        data: {
          resourceType: "document",
          resourceId: docId,
          granteeKind: "everyone",
          granteeKey: "everyone",
          level: "comment",
        },
      });
      try {
        const mentions = await call(`/d/api/${docId}/mentions`, { jar });
        expect(mentions.status).toBe(200);
        expect(await mentions.json()).toEqual({ candidates: [] });
      } finally {
        await db.resourceGrant.deleteMany({
          where: { resourceType: "document", resourceId: docId, granteeKind: "everyone" },
        });
      }

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

      // A member can mention the guest who commented here (never their email); the mention resolves.
      const gus = await db.documentGuest.findFirstOrThrow({ where: { shareLinkId: link.id } });
      const cands = await call(`/d/api/${docId}/mentions`, { jar: m.jar });
      const candText = await cands.text();
      expect(JSON.parse(candText).candidates).toContainEqual({ guestId: gus.id, name: "Gus" });
      expect(candText).not.toContain(GUEST_EMAIL);
      const mentioned = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar: m.jar,
        csrf: m.csrf,
        body: {
          anchor: { type: "text", quote: "hello", prefix: "", suffix: " world" },
          body: `@[guest:${gus.id}] ok?`,
        },
      });
      expect(mentioned.status).toBe(201);
      const withMention = (await (await call(`/d/api/${docId}`, { jar: m.jar })).json()) as {
        mentionedGuests: unknown;
      };
      expect(withMention.mentionedGuests).toEqual([{ guestId: gus.id, name: "Gus" }]);

      // Changing the name renames this guest: the same guest, so earlier comments show the new name.
      const rename = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: regBody.csrf,
        body: { name: "Gustav" },
      });
      expect(rename.status).toBe(200);
      jar.take(rename);
      const renamed = (await rename.json()) as { csrf: string; me: unknown };
      expect(renamed.me).toEqual({ kind: "guest", name: "Gustav", access: "comment" });
      expect(await db.documentGuest.count({ where: { shareLinkId: link.id } })).toBe(1);
      const afterRename = await (await call(`/d/api/${docId}`, { jar: m.jar })).text();
      expect(afterRename).toContain("Gustav (guest)");
      expect(afterRename).not.toContain("Gus (guest)");
      // The email given at registration is kept when a rename leaves it out, and still never shown.
      expect((await db.documentGuest.findUniqueOrThrow({ where: { id: gus.id } })).email).toBe(GUEST_EMAIL);
      // A rename is held to the same rules as a registration.
      const reservedRename = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: renamed.csrf,
        body: { name: "Olive Owner" },
      });
      expect(reservedRename.status).toBe(400);
      // The guest is still signed in and can comment under the new name.
      const c2 = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf: renamed.csrf,
        body: { anchor: { type: "text", quote: "world", prefix: "hello ", suffix: "" }, body: "second note" },
      });
      expect(c2.status).toBe(201);

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

    it("gives a signed-in outsider the link's permission per request, without touching their session", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const { jar, csrf, token: before } = await session(outsider.id);
      const sessionsBefore = await db.webSession.count({ where: { principalId: outsider.id } });
      const page = await call(`/s/${link.token}`, { jar });
      expect(page.status).toBe(200);
      jar.take(page);
      const boot = bootstrapOf(await page.text());
      expect(boot.viewer).toMatchObject({ kind: "member", access: "comment" });
      expect(boot).toMatchObject({ shareToken: link.token, csrf });
      // No new session, no rotation: the member's session stays principal-only.
      expect(jar.values.get("wardby-dev-web")).toBe(before);
      expect(page.headers.getSetCookie().some((c) => c.startsWith("wardby-dev-web="))).toBe(false);
      expect(await db.webSession.count({ where: { principalId: outsider.id } })).toBe(sessionsBefore);
      const row = await db.webSession.findUniqueOrThrow({ where: { tokenHash: sha(before) } });
      expect(row.shareLinkId).toBeNull();

      const share = { "x-wardby-share": link.token };
      const anchor = { type: "text", quote: "hello", prefix: "", suffix: "" };
      // With the header: the link's permission. Without it: only their own (none).
      const read = await call(`/d/api/${docId}`, { jar, headers: share });
      expect(read.status).toBe(200);
      expect(((await read.json()) as { me: { access: string } }).me.access).toBe("comment");
      expect((await call(`/d/api/${docId}`, { jar })).status).toBe(404);
      const c = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf,
        headers: share,
        body: { anchor, body: "outsider via link" },
      });
      expect(c.status).toBe(201);
      const noHeader = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar,
        csrf,
        body: { anchor, body: "outsider without link" },
      });
      expect(noHeader.status).toBe(404);
      // A link never lifts a member past its own permission (comment, not write).
      const w = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf,
        headers: share,
        body: { markdown: "x", baseNumber: 1 },
      });
      expect(w.status).toBe(403);
      // A token for this document confers nothing on another one.
      const otherDoc = (await createDocument(db, cipher, { ownerId: owner.id, title: "Other2", markdown: "z" })).id;
      expect((await call(`/d/api/${otherDoc}`, { jar, headers: share })).status).toBe(404);

      // Opening a second link does not drop the first.
      const linkB = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      expect((await call(`/s/${linkB.token}`, { jar })).status).toBe(200);
      const afterB = await call(`/d/api/${docId}`, { jar, headers: share });
      expect(((await afterB.json()) as { me: { access: string } }).me.access).toBe("comment");

      // Revoking the link takes the access away but never signs the member out.
      await revokeShareLink(db, { shareLinkId: link.id, viewer: { kind: "principal", principalId: owner.id } });
      expect(await db.webSession.count({ where: { tokenHash: sha(before) } })).toBe(1);
      const revoked = await call(`/d/api/${docId}`, { jar, headers: share });
      expect(revoked.status).toBe(404);
      expect(await revoked.json()).toEqual({ error: "document_not_found" });
      const stillB = await call(`/d/api/${docId}`, { jar, headers: { "x-wardby-share": linkB.token } });
      expect(((await stillB.json()) as { me: { access: string } }).me.access).toBe("read");
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

  describe("guest rate limits and sending from a new thread", () => {
    /** Runs `fn` against a second server built with extra web deps (lower limits, a wired sender). */
    async function withServer(extra: Partial<WebDeps>, fn: (base: string) => Promise<void>) {
      const p = await freePort();
      const h = await startServerAt(p, extra);
      try {
        await fn(`http://127.0.0.1:${p}`);
      } finally {
        await h.close();
      }
    }
    const commentLink = () =>
      createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
    async function registerAt(base: string, token: string, name: string) {
      const jar = new Jar();
      const page = await callAt(base, `/s/${token}`, { jar });
      jar.take(page);
      const pre = bootstrapOf(await page.text()).csrf as string;
      const res = await callAt(base, `/s/${token}/guest`, { method: "POST", jar, csrf: pre, body: { name } });
      jar.take(res);
      return { res, jar };
    }
    const anchor = { type: "text", quote: "hello", prefix: "", suffix: "" };

    it("ships the documented hourly guest limits", () => {
      expect(GUEST_RATE_LIMITS).toEqual({
        registrationsPerLink: 20,
        commentsPerGuest: 30,
      });
      expect(WEB_RATE_WINDOW_MS).toBe(60 * 60 * 1000);
    });

    it("answers 429 web_rate_limited past the per-link registration limit; other links are unaffected", async () => {
      const link = await commentLink();
      const other = await commentLink();
      await withServer({ guestLimits: { registrationsPerLink: 2 } }, async (base) => {
        expect((await registerAt(base, link.token, "Eve")).res.status).toBe(200);
        expect((await registerAt(base, link.token, "Fay")).res.status).toBe(200);
        const third = (await registerAt(base, link.token, "Gil")).res;
        expect(third.status).toBe(429);
        expect(await third.json()).toEqual({ error: "web_rate_limited" });
        expect((await registerAt(base, other.token, "Hal")).res.status).toBe(200);
      });
      expect(await db.documentGuest.count({ where: { shareLinkId: link.id } })).toBe(2);
    });

    it("limits a guest's threads and replies together, and never limits members", async () => {
      const link = await commentLink();
      await withServer({ guestLimits: { commentsPerGuest: 2 } }, async (base) => {
        const { res, jar } = await registerAt(base, link.token, "Ida");
        const { csrf } = (await res.json()) as { csrf: string };
        const t = await callAt(base, `/d/api/${docId}/threads`, {
          method: "POST",
          jar,
          csrf,
          body: { anchor, body: "g1" },
        });
        expect(t.status).toBe(201);
        const { threadId } = (await t.json()) as { threadId: string };
        const r1 = await callAt(base, `/d/api/threads/${threadId}/replies`, {
          method: "POST",
          jar,
          csrf,
          body: { body: "g2" },
        });
        expect(r1.status).toBe(201);
        const r2 = await callAt(base, `/d/api/threads/${threadId}/replies`, {
          method: "POST",
          jar,
          csrf,
          body: { body: "g3" },
        });
        expect(r2.status).toBe(429);
        expect(await r2.json()).toEqual({ error: "web_rate_limited" });
        const t2 = await callAt(base, `/d/api/${docId}/threads`, {
          method: "POST",
          jar,
          csrf,
          body: { anchor, body: "g4" },
        });
        expect(t2.status).toBe(429);
        expect(await db.comment.count({ where: { body: { in: ["g3", "g4"] } } })).toBe(0);

        const m = await session(member.id);
        for (const body of ["m1", "m2", "m3", "m4"]) {
          const res2 = await callAt(base, `/d/api/threads/${threadId}/replies`, {
            method: "POST",
            jar: m.jar,
            csrf: m.csrf,
            body: { body },
          });
          expect(res2.status).toBe(201);
        }
      });
    });

    it("refuses a new thread with sendToAgent from a viewer below write (403), and stores nothing", async () => {
      const link = await commentLink();
      const sends: unknown[] = [];
      const sendThreads = async (input: unknown) => {
        sends.push(input);
        return { runId: "run-1" };
      };
      await withServer({ sendThreads }, async (base) => {
        // A guest (comment at most).
        const { res, jar } = await registerAt(base, link.token, "Jo");
        const { csrf } = (await res.json()) as { csrf: string };
        const g = await callAt(base, `/d/api/${docId}/threads`, {
          method: "POST",
          jar,
          csrf,
          body: { anchor, body: "guest send", sendToAgent: true },
        });
        expect(g.status).toBe(403);
        expect(await g.json()).toEqual({ error: "document_access_denied" });
        // A member at comment level through the link.
        const o = await session(outsider.id);
        const viaLink = await callAt(base, `/d/api/${docId}/threads`, {
          method: "POST",
          jar: o.jar,
          csrf: o.csrf,
          headers: { "x-wardby-share": link.token },
          body: { anchor, body: "outsider send", sendToAgent: true },
        });
        expect(viaLink.status).toBe(403);
        expect(await viaLink.json()).toEqual({ error: "document_access_denied" });
        expect(await db.comment.count({ where: { body: { in: ["guest send", "outsider send"] } } })).toBe(0);
        expect(sends).toEqual([]);
        // A writer creates the thread and sends it.
        const m = await session(member.id);
        const ok = await callAt(base, `/d/api/${docId}/threads`, {
          method: "POST",
          jar: m.jar,
          csrf: m.csrf,
          body: { anchor, body: "writer send", sendToAgent: true },
        });
        expect(ok.status).toBe(201);
        expect(await ok.json()).toMatchObject({ sent: { runId: "run-1" } });
        expect(sends).toHaveLength(1);
      });
      // Not wired: the whole request is refused with 501 and nothing is stored.
      const m = await session(member.id);
      const unwired = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar: m.jar,
        csrf: m.csrf,
        body: { anchor, body: "unwired send", sendToAgent: true },
      });
      expect(unwired.status).toBe(501);
      expect(await db.comment.count({ where: { body: "unwired send" } })).toBe(0);
    });
  });

  describe("sending with the real sender (agent loop)", () => {
    const anchor = { type: "text", quote: "hello", prefix: "", suffix: "" };
    it("answers the agent loop's codes: not linked 400, rate limited 429, too many threads 400", async () => {
      const executor = { start: async () => {}, stop: async () => {} };
      const limited = {
        check: async () => {
          throw new RateLimitError("Rate limited.");
        },
      };
      const p = await freePort();
      const real =
        (rateLimiter?: RateLimiter): NonNullable<WebDeps["sendThreads"]> =>
        (input) =>
          sendThreadsToAgent(db, { executor, cipher, ...(rateLimiter ? { rateLimiter } : {}) }, input);
      const m = await session(member.id);
      const created = await call(`/d/api/${docId}/threads`, {
        method: "POST",
        jar: m.jar,
        csrf: m.csrf,
        body: { anchor, body: "real send" },
      });
      const { threadId } = (await created.json()) as { threadId: string };
      const h = await startServerAt(p, { sendThreads: real() });
      try {
        const base = `http://127.0.0.1:${p}`;
        const res = await callAt(base, `/d/api/${docId}/send`, {
          method: "POST",
          jar: m.jar,
          csrf: m.csrf,
          body: { threadIds: [threadId] },
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "document_not_agent_linked" });
        const many = await callAt(base, `/d/api/${docId}/send`, {
          method: "POST",
          jar: m.jar,
          csrf: m.csrf,
          body: { threadIds: Array.from({ length: 51 }, (_, i) => `t${i}`) },
        });
        expect(many.status).toBe(400);
      } finally {
        await h.close();
      }
      // The rate limit is checked only for a send that could start a run, so link the document for it.
      const agent = await db.agent.create({
        data: {
          name: `web-coding-${s}`,
          systemPrompt: "p",
          model: "gpt-5.6-luna",
          budgetUsd: 1,
          kind: "coding",
          ownerId: owner.id,
          codingProfile: {
            create: {
              provider: "codex",
              repository: "acme/web-docs",
              repositoryAuthorizedVia: "admin",
              protectedPaths: [],
            },
          },
        },
      });
      await db.document.update({
        where: { id: docId },
        data: { agentId: agent.id, repository: "acme/web-docs", path: "docs/plan.md" },
      });
      const p2 = await freePort();
      const h2 = await startServerAt(p2, { sendThreads: real(limited) });
      try {
        const res = await callAt(`http://127.0.0.1:${p2}`, `/d/api/${docId}/send`, {
          method: "POST",
          jar: m.jar,
          csrf: m.csrf,
          body: { threadIds: [threadId] },
        });
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "comment_send_rate_limited" });
      } finally {
        await h2.close();
        await db.document.update({ where: { id: docId }, data: { agentId: null, repository: null, path: null } });
        await db.codingAgentProfile.deleteMany({ where: { agentId: agent.id } });
        await db.agent.delete({ where: { id: agent.id } });
      }
    });
  });

  describe("designs", () => {
    const agentId = `web-design-agent-${s}`;
    const secretNames = [`WEB_DESIGN_KEY_${s.slice(0, 8)}`, `WEB_DESIGN_SPECIAL_${s.slice(0, 8)}`];
    let commenter: Principal;
    let designId: string;

    beforeAll(async () => {
      commenter = await db.principal.create({ data: { subject: `web-commenter-${s}` } });
      designId = (
        await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Coffee", files: coffee() })
      ).id;
      for (const [principal, level] of [
        [member, "write"],
        [commenter, "comment"],
      ] as const) {
        await db.resourceGrant.create({
          data: {
            resourceType: "document",
            resourceId: designId,
            granteeKind: "principal",
            granteePrincipalId: principal.id,
            granteeKey: `principal:${principal.id}`,
            level,
          },
        });
      }
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
      });
      await createSecret(secretNames[0], SECRET, owner.id, cipher, db);
      await attachSecret(agentId, secretNames[0], owner.id, db);
      await createSecret(secretNames[1], SPECIAL, owner.id, cipher, db);
      await attachSecret(agentId, secretNames[1], owner.id, db);
    });
    afterAll(async () => {
      await db.webSession.deleteMany({ where: { principalId: commenter.id } });
      await db.document.deleteMany({ where: { agentId } });
      await db.agentSecret.deleteMany({ where: { agentId } });
      await db.secret.deleteMany({ where: { name: { in: secretNames } } });
      await db.agent.deleteMany({ where: { id: agentId } });
      await db.resourceGrant.deleteMany({ where: { granteePrincipalId: commenter.id } });
      await db.principal.deleteMany({ where: { id: commenter.id } });
    });

    const currentNumber = async (id: string, jar: Jar) =>
      ((await (await call(`/d/api/${id}`, { jar })).json()) as { version: { number: number } }).version.number;
    const fileHashes = async (id: string, number: number) => {
      const v = await db.documentVersion.findUniqueOrThrow({
        where: { documentId_number: { documentId: id, number } },
        select: { files: { select: { path: true, hash: true } } },
      });
      return Object.fromEntries(v.files.map((f) => [f.path, f.hash]));
    };

    it("serves the design page with the designs bundle and the board-style CSP", async () => {
      const { jar } = await session(member.id);
      const res = await call(`/d/${designId}`, { jar });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `<script src="/web/static/${DJS}" integrity="${sri(ASSET_TEXT[DJS])}" crossorigin="anonymous"></script>`,
      );
      expect(html).toContain(
        `<link rel="stylesheet" href="/web/static/${DCSS}" integrity="${sri(ASSET_TEXT[DCSS])}" crossorigin="anonymous">`,
      );
      expect(html).not.toContain(JS);
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("font-src 'self' data:");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
      expect(csp).toContain("form-action 'self'");
      expect(/script-src ([^;]*)/.exec(csp)![1]).not.toContain("unsafe");
      expect(csp).not.toContain("unsafe-eval");
      expect(bootstrapOf(html)).toMatchObject({ documentId: designId, kind: "design" });
      // The share page of a design is a design page too.
      const link = await createShareLink(db, {
        documentId: designId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const share = await call(`/s/${link.token}`);
      expect(share.status).toBe(200);
      expect(share.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
      const shareHtml = await share.text();
      expect(shareHtml).toContain(DJS);
      expect(bootstrapOf(shareHtml)).toMatchObject({ kind: "design" });
    });

    it("returns a design's files, format, warnings and canRender", async () => {
      const { jar } = await session(member.id);
      const res = await call(`/d/api/${designId}`, { jar });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        document: { kind: string; canSend: boolean; canRender: boolean };
        version: { format: string; files: Record<string, string>; warnings: unknown[]; markdown?: string };
      };
      expect(body.document.kind).toBe("design");
      expect(body.document.canSend).toBe(false);
      expect(body.version.format).toBe("boards-v1");
      expect(body.version.files["boards/home.html"]).toContain("<html");
      expect(body.version.markdown).toBeUndefined();
      expect(Array.isArray(body.version.warnings)).toBe(true);
      expect(body.document.canRender).toBe(false);
      // A Markdown document carries its format and warnings too.
      const doc = (await (await call(`/d/api/${docId}`, { jar })).json()) as {
        document: { kind: string; canRender: boolean };
        version: { format: string; warnings: unknown[]; markdown: string };
      };
      expect(doc.document.kind).toBe("document");
      expect(doc.document.canRender).toBe(false);
      expect(doc.version).toMatchObject({ format: "markdown", warnings: [], markdown: expect.any(String) });
    });

    it("saves changed files over the base version; conflicts, format problems and commenters are refused", async () => {
      const { jar, csrf } = await session(member.id);
      const base = await currentNumber(designId, jar);
      const before = await fileHashes(designId, base);
      const menu = coffee()["boards/menu.html"].replace("</body>", "<p>edited</p></body>");
      const ok = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { files: { "boards/menu.html": menu }, baseNumber: base },
      });
      expect(ok.status).toBe(200);
      const saved = (await ok.json()) as { version: { number: number }; reanchored: unknown; warnings: unknown[] };
      expect(saved.version.number).toBe(base + 1);
      expect(saved.reanchored).toMatchObject({ kept: expect.any(Number), outdated: expect.any(Number) });
      expect(Array.isArray(saved.warnings)).toBe(true);
      const after = await fileHashes(designId, base + 1);
      expect(after["boards/menu.html"]).not.toBe(before["boards/menu.html"]);
      for (const p of ["manifest.json", "boards/home.html", "boards/about.html", "boards/visit.html"]) {
        expect(after[p]).toBe(before[p]);
      }

      const stale = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { files: { "boards/menu.html": menu }, baseNumber: base },
      });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "document_version_conflict" });

      const external = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: {
          files: { "boards/home.html": menu.replace("<p>edited</p>", '<img src="https://x.example/a.png">') },
          baseNumber: base + 1,
        },
      });
      expect(external.status).toBe(400);
      const refused = (await external.json()) as { error: string; problems: string[] };
      expect(refused.error).toBe("board_format_invalid");
      expect(refused.problems.length).toBeGreaterThan(0);
      expect(refused.problems.join(" ")).toContain("board home");
      expect(refused.problems.join(" ")).not.toContain("x.example");

      // null deletes a file: removing a board the manifest still lists is a format problem.
      const missing = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { files: { "boards/about.html": null }, baseNumber: base + 1 },
      });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as { error: string }).error).toBe("board_format_invalid");

      for (const bad of [
        { files: { "boards/menu.html": 5 }, baseNumber: base + 1 },
        { files: ["x"], baseNumber: base + 1 },
        { files: Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`f${i}`, "x"])), baseNumber: base + 1 },
      ]) {
        const r = await call(`/d/api/${designId}/content`, { method: "PUT", jar, csrf, body: bad });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: "invalid_request" });
      }
      // Markdown for a design and files for a document are format mismatches.
      const md = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { markdown: "x", baseNumber: base + 1 },
      });
      expect(md.status).toBe(400);
      expect(await md.json()).toEqual({ error: "document_format_mismatch" });
      const docBase = await currentNumber(docId, jar);
      const filesForDoc = await call(`/d/api/${docId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { files: { "a.md": "x" }, baseNumber: docBase },
      });
      expect(filesForDoc.status).toBe(400);
      expect(await filesForDoc.json()).toEqual({ error: "document_format_mismatch" });

      // A guest with comment access cannot save.
      const link = await createShareLink(db, {
        documentId: designId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const guestJar = new Jar();
      const page = await call(`/s/${link.token}`, { jar: guestJar });
      guestJar.take(page);
      const pre = bootstrapOf(await page.text()).csrf as string;
      const reg = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar: guestJar,
        csrf: pre,
        body: { name: "Gail Guest" },
      });
      expect(reg.status).toBe(200);
      guestJar.take(reg);
      const guestCsrf = ((await reg.json()) as { csrf: string }).csrf;
      const guestPut = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar: guestJar,
        csrf: guestCsrf,
        body: { files: { "boards/menu.html": menu }, baseNumber: base + 1 },
      });
      expect(guestPut.status).toBe(403);
      expect(await guestPut.json()).toEqual({ error: "document_access_denied" });
      expect(await currentNumber(designId, jar)).toBe(base + 1);
    });

    it("a save can delete a board and update the manifest in the same PUT", async () => {
      const { jar, csrf } = await session(member.id);
      const files = coffee();
      type Manifest = { boards: Array<{ id: string; name: string; file: string; width: number }> };
      const original = JSON.parse(files["manifest.json"]) as Manifest;
      // Add a throwaway board first, so later tests keep the four-board fixture.
      const withExtra: Manifest = {
        ...original,
        boards: [...original.boards, { id: "extra", name: "Extra", file: "boards/extra.html", width: 1280 }],
      };
      const add = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: {
          files: { "boards/extra.html": files["boards/menu.html"], "manifest.json": JSON.stringify(withExtra) },
          baseNumber: await currentNumber(designId, jar),
        },
      });
      expect(add.status).toBe(200);
      const base = await currentNumber(designId, jar);
      const before = await fileHashes(designId, base);
      expect(before).toHaveProperty(["boards/extra.html"]);
      const res = await call(`/d/api/${designId}/content`, {
        method: "PUT",
        jar,
        csrf,
        body: { files: { "boards/extra.html": null, "manifest.json": JSON.stringify(original) }, baseNumber: base },
      });
      expect(res.status).toBe(200);
      const after = await fileHashes(designId, base + 1);
      expect(after).not.toHaveProperty(["boards/extra.html"]);
      expect(after["boards/home.html"]).toBe(before["boards/home.html"]);
      expect(after["manifest.json"]).not.toBe(before["manifest.json"]);
    });

    it("stores fidelity warnings once per version, from a writer only", async () => {
      const { jar, csrf } = await session(member.id);
      const n = await currentNumber(designId, jar);
      const warningsOf = async () =>
        (
          (await (await call(`/d/api/${designId}`, { jar })).json()) as {
            version: { warnings: Array<{ kind: string; board?: string; mismatches?: number; samples?: string[] }> };
          }
        ).version.warnings;
      const nonFidelity = (await warningsOf()).filter((w) => w.kind !== "fidelity");
      const c = await session(commenter.id);
      const byCommenter = await call(`/d/api/${designId}/fidelity`, {
        method: "POST",
        jar: c.jar,
        csrf: c.csrf,
        body: { versionNumber: n, boards: [{ board: "home", mismatches: 1, samples: [] }] },
      });
      expect(byCommenter.status).toBe(403);
      expect(await byCommenter.json()).toEqual({ error: "document_access_denied" });

      for (const bad of [
        { versionNumber: 0, boards: [] },
        { versionNumber: n, boards: [{ board: "Home!", mismatches: 1, samples: [] }] },
        { versionNumber: n, boards: [{ board: "home", mismatches: 10_001, samples: [] }] },
        { versionNumber: n, boards: [{ board: "home", mismatches: 1.5, samples: [] }] },
        { versionNumber: n, boards: [{ board: "home", mismatches: 1, samples: ["x".repeat(161)] }] },
        { versionNumber: n, boards: [{ board: "home", mismatches: 1, samples: Array(7).fill("x") }] },
        { versionNumber: n, boards: [{ board: "home", mismatches: 1, samples: [5] }] },
        {
          versionNumber: n,
          boards: Array.from({ length: 51 }, (_, i) => ({ board: `b${i}`, mismatches: 0, samples: [] })),
        },
        {
          versionNumber: n,
          boards: [
            { board: "home", mismatches: 0, samples: [] },
            { board: "home", mismatches: 1, samples: [] },
          ],
        },
      ]) {
        const r = await call(`/d/api/${designId}/fidelity`, { method: "POST", jar, csrf, body: bad });
        expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
        expect(await r.json()).toEqual({ error: "invalid_request" });
      }
      const missingVersion = await call(`/d/api/${designId}/fidelity`, {
        method: "POST",
        jar,
        csrf,
        body: { versionNumber: n + 50, boards: [] },
      });
      expect(missingVersion.status).toBe(404);

      const first = await call(`/d/api/${designId}/fidelity`, {
        method: "POST",
        jar,
        csrf,
        body: {
          versionNumber: n,
          boards: [
            { board: "home", mismatches: 0, samples: [] },
            { board: "menu", mismatches: 2, samples: [".hero background-color: red / blue"] },
            { board: "nope", mismatches: 3, samples: [] },
          ],
        },
      });
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      const stored = await warningsOf();
      expect(stored.filter((w) => w.kind !== "fidelity")).toEqual(nonFidelity);
      expect(stored.filter((w) => w.kind === "fidelity")).toEqual([
        { kind: "fidelity", board: "home", mismatches: 0, samples: [] },
        { kind: "fidelity", board: "menu", mismatches: 2, samples: [".hero background-color: red / blue"] },
      ]);
      const hashBefore = (
        await db.documentVersion.findUniqueOrThrow({
          where: { documentId_number: { documentId: designId, number: n } },
          select: { contentHash: true },
        })
      ).contentHash;
      const second = await call(`/d/api/${designId}/fidelity`, {
        method: "POST",
        jar,
        csrf,
        body: { versionNumber: n, boards: [{ board: "home", mismatches: 9, samples: ["other"] }] },
      });
      expect(second.status).toBe(204);
      expect(await warningsOf()).toEqual(stored);
      const v = await db.documentVersion.findUniqueOrThrow({
        where: { documentId_number: { documentId: designId, number: n } },
        select: { contentHash: true },
      });
      expect(v.contentHash).toBe(hashBefore);

      // A Markdown document has no boards to measure.
      const onDoc = await call(`/d/api/${docId}/fidelity`, {
        method: "POST",
        jar,
        csrf,
        body: { versionNumber: 1, boards: [] },
      });
      expect(onDoc.status).toBe(400);
      expect(await onDoc.json()).toEqual({ error: "document_format_mismatch" });
    });

    it("serves frames to an anonymous share-link reader, with links rewritten per mode", async () => {
      const link = await createShareLink(db, {
        documentId: designId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const headers = { "x-wardby-share": link.token };
      const play = await call(`/d/api/${designId}/frames?mode=play`, { headers });
      expect(play.status).toBe(200);
      const body = (await play.json()) as { boards: Array<{ id: string; name: string; width: number; html: string }> };
      expect(body.boards.map((b) => b.id)).toEqual(["home", "menu", "about", "visit"]);
      expect(body.boards[0]).toMatchObject({ name: "Home", width: 1280 });
      const home = new JSDOM(body.boards[0].html, { virtualConsole: new VirtualConsole() }).window.document;
      const hrefs = Array.from(home.querySelectorAll("a[href]")).map((a) => [
        a.getAttribute("href"),
        a.getAttribute("target"),
      ]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const [href, target] of hrefs) {
        expect(href).toMatch(/^#board-(home|menu|about|visit)$/);
        expect(target).toBe("_top");
      }
      const overview = (await (
        await call(`/d/api/${designId}/frames?mode=overview&version=1`, { headers })
      ).json()) as {
        boards: Array<{ html: string }>;
      };
      for (const b of overview.boards) expect(b.html).not.toMatch(/<a[^>]*\shref=/);

      const other = await call(`/d/api/${designId}/frames?mode=other`, { headers });
      expect(other.status).toBe(400);
      expect(await other.json()).toEqual({ error: "invalid_request" });
      expect((await call(`/d/api/${designId}/frames?mode=play&version=99`, { headers })).status).toBe(404);
      expect((await call(`/d/api/${designId}/frames?mode=play`)).status).toBe(401);
      const { jar } = await session(member.id);
      const onDoc = await call(`/d/api/${docId}/frames?mode=play`, { jar });
      expect(onDoc.status).toBe(400);
      expect(await onDoc.json()).toEqual({ error: "document_format_mismatch" });
    });

    it("never returns the agent's secret values, raw or decoded, from the design API, frames or fidelity samples", async () => {
      const files = coffee();
      files["boards/home.html"] = files["boards/home.html"].replace(
        "</body>",
        `<p>key ${SECRET}</p><p>dash ${SECRET.replace("-", "&#45;")}</p>` +
          `<p title="${SPECIAL_HTML}" class="sp">t ${SPECIAL_HTML}</p>` +
          `<a href="#board:menu" title="${SECRET}">m</a></body>`,
      );
      for (const text of Object.values(files)) expect(text).not.toContain(SPECIAL);
      const id = (
        await createDocument(db, cipher, {
          kind: "design",
          ownerId: owner.id,
          title: `Secret ${SECRET}`,
          files,
          agentId,
        })
      ).id;
      const { jar, csrf } = await session(owner.id);
      const fidelity = await call(`/d/api/${id}/fidelity`, {
        method: "POST",
        jar,
        csrf,
        body: {
          versionNumber: 1,
          boards: [{ board: "home", mismatches: 2, samples: [`.a content: ${SECRET}`, `.b title: ${SPECIAL}`] }],
        },
      });
      expect(fidelity.status).toBe(204);
      const responses = [
        await (await call(`/d/api/${id}`, { jar })).text(),
        await (await call(`/d/api/${id}/frames?mode=play`, { jar })).text(),
        await (await call(`/d/api/${id}/frames?mode=overview`, { jar })).text(),
        await (await call(`/d/api/${id}/versions/1`, { jar })).text(),
      ];
      const api = JSON.parse(responses[0]) as { version: { warnings: Array<{ kind: string; samples?: string[] }> } };
      expect(api.version.warnings.find((w) => w.kind === "fidelity")?.samples).toEqual([
        ".a content: [REDACTED]",
        ".b title: [REDACTED]",
      ]);
      expect(responses[1]).toContain("[REDACTED]");
      for (const text of responses) {
        for (const decoded of decodedStrings(text)) {
          expect(decoded).not.toContain(SECRET);
          expect(decoded).not.toContain(SPECIAL);
        }
      }
    });
  });

  describe("document review", () => {
    const secretName = `RV_WEB_${s.slice(0, 8)}`;
    const reviewAgentId = `rv-web-${s}`;
    afterAll(async () => {
      await db.document.deleteMany({ where: { agentId: reviewAgentId } });
      await db.agentSecret.deleteMany({ where: { agentId: reviewAgentId } });
      await db.secret.deleteMany({ where: { name: secretName } });
      await db.agent.deleteMany({ where: { id: reviewAgentId } });
    });

    const newDoc = async () =>
      (await createDocument(db, cipher, { ownerId: owner.id, title: "Review me", markdown: "hello world" })).id;
    const post = (id: string, who: { jar: Jar; csrf: string }, body: object) =>
      call(`/d/api/${id}/review`, { method: "POST", jar: who.jar, csrf: who.csrf, body });
    /** Names a reviewer, which gives them comment access. */
    const submitAs = (id: string, who: { jar: Jar; csrf: string }, reviewer: string) =>
      post(id, who, { action: "submit", reviewers: [reviewer] });

    it("adds the review to the page payload and runs the review actions", async () => {
      const id = await newDoc();
      // A linked document is send-capable, so the lock is what turns canSend off.
      await db.document.update({ where: { id }, data: { repository: "acme/web-docs", path: "docs/plan.md" } });
      const o = await session(owner.id);
      const m = await session(member.id);
      const page = (await (await call(`/d/api/${id}`, { jar: o.jar })).json()) as any;
      expect(page.document.canSend).toBe(true);
      expect(page.review).toMatchObject({ state: "draft", currentVersion: 1, can: { submit: true, review: false } });
      const cands = (await (await call(`/d/api/${id}/review-candidates`, { jar: o.jar })).json()) as any;
      expect(cands.members.map((x: any) => x.principalId)).toContain(owner.id);
      const sub = await post(id, o, { action: "submit", reviewers: [member.id] });
      expect(sub.status).toBe(200);
      const subbed = ((await sub.json()) as any).review;
      expect(subbed.state).toBe("in_review");
      expect(((await (await call(`/d/api/${id}`, { jar: o.jar })).json()) as any).document.canSend).toBe(true);
      expect(subbed.reviewers[0]).toMatchObject({ ref: member.id, verdict: "none" });
      // The member was granted comment access by being named; their view hides refs and offers the verdict.
      const asMember = ((await (await call(`/d/api/${id}`, { jar: m.jar })).json()) as any).review;
      expect(asMember.can.review).toBe(true);
      expect(asMember.reviewers[0]).not.toHaveProperty("ref");
      const stale = await post(id, m, { action: "verdict", verdict: "approve", versionNumber: 9 });
      expect([stale.status, await stale.json()]).toEqual([409, { error: "document_version_conflict" }]);
      const ok = await post(id, m, { action: "verdict", verdict: "approve", versionNumber: 1, note: "Good" });
      expect(((await ok.json()) as any).review.state).toBe("approved");
      // Locked: an editor save answers 409 document_locked; send is not offered.
      const save = await call(`/d/api/${id}/content`, {
        method: "PUT",
        jar: o.jar,
        csrf: o.csrf,
        body: { markdown: "x", baseNumber: 1 },
      });
      expect([save.status, await save.json()]).toEqual([409, { error: "document_locked" }]);
      const locked = (await (await call(`/d/api/${id}`, { jar: o.jar })).json()) as any;
      expect(locked.document.canSend).toBe(false);
      const reopened = await post(id, o, { action: "reopen" });
      const back = ((await reopened.json()) as any).review;
      expect([back.state, back.currentVersion]).toEqual(["in_review", 2]);
    });

    it("offers send on a wardby plan document and design, but not when removed, locked or to a commenter", async () => {
      const planner = await db.agent.create({
        data: {
          name: `rv-web-planner-${s}`,
          systemPrompt: "p",
          model: "m",
          budgetUsd: 1,
          ownerId: owner.id,
        },
      });
      const set = await db.planSet.create({
        data: { agentId: planner.id, repository: `acme/plan-${s}`, number: 7, store: "wardby", createdByRunId: "run" },
      });
      try {
        const doc = await newDoc();
        const design = (
          await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Board", files: coffee() })
        ).id;
        const removed = await newDoc();
        for (const [id, planPath] of [
          [doc, "plan.md"],
          [design, "boards"],
          [removed, "old.md"],
        ] as const) {
          await db.document.update({ where: { id }, data: { planSetId: set.id, planPath, agentId: planner.id } });
        }
        await db.document.update({ where: { id: removed }, data: { removedFromPlan: true } });
        const o = await session(owner.id);
        const canSend = async (id: string, jar = o.jar) =>
          ((await (await call(`/d/api/${id}`, { jar })).json()) as any).document.canSend;
        expect(await canSend(doc)).toBe(true);
        expect(await canSend(design)).toBe(true);
        expect(await canSend(removed)).toBe(false);
        // A commenter (named as a reviewer) is not offered send.
        const m = await session(member.id);
        await submitAs(doc, o, member.id);
        expect(await canSend(doc, m.jar)).toBe(false);
        // Approved: locked, so not offered to the owner either.
        await post(doc, m, { action: "verdict", verdict: "approve", versionNumber: 1 });
        expect(await canSend(doc)).toBe(false);
      } finally {
        await db.document.deleteMany({ where: { planSetId: set.id } });
        await db.planSet.delete({ where: { id: set.id } });
        await db.agent.delete({ where: { id: planner.id } });
      }
    });

    it("shows an anonymous share-link reader a review with no actions and no reviewer refs", async () => {
      const id = await newDoc();
      const o = await session(owner.id);
      await post(id, o, { action: "submit", reviewers: [member.id] });
      const link = await createShareLink(db, {
        documentId: id,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const res = await call(`/d/api/${id}`, { headers: { "x-wardby-share": link.token } });
      expect(res.status).toBe(200);
      const review = ((await res.json()) as any).review;
      expect(review.state).toBe("in_review");
      expect(Object.values(review.can).every((v) => v === false)).toBe(true);
      expect(review.reviewers[0]).not.toHaveProperty("ref");
      expect(review.reviewers[0].me).toBe(false);
      expect(JSON.stringify(review)).not.toContain(member.id);
    });

    it("lets only the owner make a comment link from the page; its path is answered once and works", async () => {
      const id = await newDoc();
      const o = await session(owner.id);
      const m = await session(member.id);
      const res = await call(`/d/api/${id}/share-links`, { method: "POST", jar: o.jar, csrf: o.csrf, body: {} });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const made = (await res.json()) as any;
      expect(made.path).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/);
      const row = await db.documentShareLink.findUniqueOrThrow({ where: { id: made.id } });
      expect([row.documentId, row.permission, row.createdById]).toEqual([id, "comment", owner.id]);
      // Only the hash is stored.
      expect(JSON.stringify(row)).not.toContain(made.path.slice(3));
      // A member without ownership, an outsider and a request without CSRF are refused.
      await submitAs(id, o, member.id);
      expect(
        (await call(`/d/api/${id}/share-links`, { method: "POST", jar: m.jar, csrf: m.csrf, body: {} })).status,
      ).toBe(403);
      const out = await session(outsider.id);
      expect(
        (await call(`/d/api/${id}/share-links`, { method: "POST", jar: out.jar, csrf: out.csrf, body: {} })).status,
      ).toBe(404);
      expect((await call(`/d/api/${id}/share-links`, { method: "POST", jar: o.jar, body: {} })).status).toBe(403);
      expect(await db.documentShareLink.count({ where: { documentId: id } })).toBe(1);
    });

    it("answers the review codes with their statuses and refuses malformed bodies", async () => {
      const id = await newDoc();
      const o = await session(owner.id);
      const out = await session(outsider.id);
      expect((await post(id, o, { action: "submit", reviewers: [] })).status).toBe(409);
      expect((await post(id, o, { action: "nope" })).status).toBe(400);
      expect((await post(id, o, { action: "verdict", verdict: "approve" })).status).toBe(400);
      expect((await post(id, o, { action: "force", note: "  " })).status).toBe(400);
      expect((await post(id, out, { action: "archive", archived: true })).status).toBe(404);
      await post(id, o, { action: "submit", reviewers: [member.id] });
      const forbidden = await post(id, o, { action: "verdict", verdict: "approve", versionNumber: 1 });
      expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: "document_review_forbidden" }]);
      expect((await call(`/d/api/${id}/review-candidates`, { jar: (await session(member.id)).jar })).status).toBe(403);
      // CSRF still guards the write.
      expect(
        (await call(`/d/api/${id}/review`, { method: "POST", jar: o.jar, body: { action: "reopen" } })).status,
      ).toBe(403);
    });

    it("rejects a plan option through the page API; a blank note is 400, a loose document 409", async () => {
      const id = await newDoc();
      const o = await session(owner.id);
      await post(id, o, { action: "submit", reviewers: [member.id] });
      expect((await post(id, o, { action: "reject", note: "  " })).status).toBe(400);
      const loose = await post(id, o, { action: "reject", note: "no" });
      expect([loose.status, await loose.json()]).toEqual([409, { error: "document_reject_not_plan_document" }]);
      const planner = await db.agent.create({
        data: {
          name: `reject-web-${randomUUID().slice(0, 8)}`,
          systemPrompt: "p",
          model: "m",
          budgetUsd: 1,
          ownerId: owner.id,
        },
      });
      const set = await db.planSet.create({
        data: {
          agentId: planner.id,
          repository: "o/reject-web",
          number: 1,
          store: "wardby",
          createdByRunId: "fixture",
        },
      });
      try {
        await db.document.update({ where: { id }, data: { planSetId: set.id, planPath: "option-c.md" } });
        const before = ((await (await call(`/d/api/${id}`, { jar: o.jar })).json()) as any).review;
        expect(before.can.reject).toBe(true);
        const res = await post(id, o, { action: "reject", note: "Option B was chosen" });
        expect(res.status).toBe(200);
        const review = ((await res.json()) as any).review;
        expect(review.state).toBe("rejected");
        expect(review.can).toMatchObject({ reject: false, reopen: true });
        expect((await db.document.findUniqueOrThrow({ where: { id } })).removedFromPlan).toBe(true);
      } finally {
        await db.document.update({ where: { id }, data: { planSetId: null } });
        await db.planSet.delete({ where: { id: set.id } });
        await db.agent.delete({ where: { id: planner.id } });
      }
    });

    it("chooses a plan option through the page API: one approved, the listed ones rejected", async () => {
      const o = await session(owner.id);
      const planner = await db.agent.create({
        data: {
          name: `choose-web-${randomUUID().slice(0, 8)}`,
          systemPrompt: "p",
          model: "m",
          budgetUsd: 1,
          ownerId: owner.id,
        },
      });
      const set = await db.planSet.create({
        data: {
          agentId: planner.id,
          repository: "o/choose-web",
          number: 1,
          store: "wardby",
          createdByRunId: "fixture",
        },
      });
      const option = async (planPath: string) => {
        const id = await newDoc();
        await db.document.update({ where: { id }, data: { planSetId: set.id, planPath } });
        await post(id, o, { action: "submit", reviewers: [owner.id] });
        return id;
      };
      const [a, b, c] = [await option("option-a.md"), await option("option-b.md"), await option("option-c.md")];
      try {
        // Malformed: no list, a non-string entry, no version.
        expect((await post(a, o, { action: "choose", versionNumber: 1 })).status).toBe(400);
        expect((await post(a, o, { action: "choose", versionNumber: 1, reject: [b, 7] })).status).toBe(400);
        expect((await post(a, o, { action: "choose", reject: [b] })).status).toBe(400);
        const before = ((await (await call(`/d/api/${a}`, { jar: o.jar })).json()) as any).review;
        expect(before.can.choose).toBe(true);
        const res = await post(a, o, { action: "choose", versionNumber: 1, reject: [b, c] });
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).review.state).toBe("approved");
        for (const id of [b, c]) {
          expect(await db.document.findUniqueOrThrow({ where: { id } })).toMatchObject({
            reviewState: "rejected",
            removedFromPlan: true,
          });
        }
      } finally {
        await db.document.updateMany({ where: { planSetId: set.id }, data: { planSetId: null } });
        await db.planSet.delete({ where: { id: set.id } });
        await db.agent.delete({ where: { id: planner.id } });
      }
    });

    it("lets a guest reviewer on a comment link approve through the page API", async () => {
      const id = await newDoc();
      const o = await session(owner.id);
      const link = await createShareLink(db, {
        documentId: id,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const jar = new Jar();
      const page = await call(`/s/${link.token}`, { jar });
      jar.take(page);
      const pre = bootstrapOf(await page.text()).csrf as string;
      const reg = await call(`/s/${link.token}/guest`, { method: "POST", jar, csrf: pre, body: { name: "Gus" } });
      jar.take(reg);
      const { csrf } = (await reg.json()) as { csrf: string };
      const guestId = (await db.documentGuest.findFirstOrThrow({ where: { shareLinkId: link.id } })).id;
      await post(id, o, { action: "submit", reviewers: [`guest:${guestId}`] });
      const res = await post(id, { jar, csrf }, { action: "verdict", verdict: "approve", versionNumber: 1 });
      expect(res.status).toBe(200);
      const review = ((await res.json()) as any).review;
      expect(review.state).toBe("approved");
      expect(review.reviewers[0]).toMatchObject({ kind: "guest", name: "Gus (guest)", me: true });
      expect(JSON.stringify(review)).not.toContain(guestId);
    });

    it("never returns an agent secret value in a review note", async () => {
      const id = await newDoc();
      await db.agent.create({
        data: {
          id: reviewAgentId,
          name: reviewAgentId,
          systemPrompt: "t",
          model: "t",
          budgetUsd: 1,
          ownerId: owner.id,
        },
      });
      const value = `fake-web-review-${s}`;
      await createSecret(secretName, value, owner.id, cipher, db);
      await attachSecret(reviewAgentId, secretName, owner.id, db);
      await db.document.update({ where: { id }, data: { agentId: reviewAgentId } });
      const o = await session(owner.id);
      const m = await session(member.id);
      await post(id, o, { action: "submit", reviewers: [member.id] });
      const res = await post(id, m, {
        action: "verdict",
        verdict: "request_changes",
        versionNumber: 1,
        note: `key ${value}`,
      });
      const text = await res.text();
      expect(text).not.toContain(value);
      expect(text).toContain("[REDACTED]");
      expect(await (await call(`/d/api/${id}`, { jar: o.jar })).text()).not.toContain(value);
    });
  });

  describe("exports", () => {
    let exportDesignId: string;
    const allow: RateLimiter = { check: async () => {} };
    const fakeRenderer = { png: async () => Buffer.from("PNG"), pdf: async () => Buffer.from("PDF") };
    const exportDeps = (over: object = {}): WebDeps["exports"] => ({
      db,
      renderer: fakeRenderer,
      rateLimiter: allow,
      ...over,
    });
    async function withServer(extra: Partial<WebDeps>, fn: (base: string) => Promise<void>) {
      const p = await freePort();
      const h = await startServerAt(p, extra);
      try {
        await fn(`http://127.0.0.1:${p}`);
      } finally {
        await h.close();
      }
    }
    // Polls until the export finishes or a 15 s deadline (a loaded test run can be slow).
    const waitDone = async (base: string, id: string, jar: Jar) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const st = (await (await callAt(base, `/d/api/exports/${id}`, { jar })).json()) as {
          status: string;
          errorCode: string | null;
        };
        if (st.status === "done" || st.status === "failed") return st;
        if (Date.now() > deadline) throw new Error(`export did not finish (status ${st.status})`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    beforeAll(async () => {
      exportDesignId = (
        await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Coffee", files: coffee() })
      ).id;
      await db.resourceGrant.create({
        data: {
          resourceType: "document",
          resourceId: exportDesignId,
          granteeKind: "principal",
          granteePrincipalId: member.id,
          granteeKey: `principal:${member.id}`,
          level: "write",
        },
      });
    });

    it("serves a board and the prototype as sandboxed attachments", async () => {
      const { jar } = await session(member.id);
      const res = await call(`/d/api/${exportDesignId}/export?format=prototype`, { jar });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="coffee-prototype.html"');
      expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain('id="boards"');
      const board = await call(`/d/api/${exportDesignId}/export?format=board-html&board=menu&version=1`, { jar });
      expect(board.headers.get("content-disposition")).toBe('attachment; filename="coffee-menu.html"');
      for (const bad of ["format=png", "format=board-html&board=nope", "format=prototype&version=0"]) {
        const r = await call(`/d/api/${exportDesignId}/export?${bad}`, { jar });
        expect(r.status).toBe(bad.includes("nope") ? 404 : 400);
      }
      const md = await call(`/d/api/${docId}/export?format=prototype`, { jar });
      expect(md.status).toBe(400);
      expect(await md.json()).toEqual({ error: "export_format_unsupported" });
      expect((await call(`/d/api/${exportDesignId}/export?format=prototype`)).status).toBe(401);
    });

    it("lets a share-link reader without a session download a board, not request a render", async () => {
      const link = await createShareLink(db, {
        documentId: exportDesignId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "view",
      });
      const res = await call(`/d/api/${exportDesignId}/export?format=board-html&board=home`, {
        headers: { "x-wardby-share": link.token },
      });
      expect(res.status).toBe(200);
      // Without the share header: no session, no access.
      expect((await call(`/d/api/${exportDesignId}/exports`, { method: "POST", body: { format: "pdf" } })).status).toBe(
        401,
      );
      // With it: refused as export_sign_in_required, before anything is written.
      const before = await db.documentExport.count({ where: { documentId: exportDesignId } });
      const post = await call(`/d/api/${exportDesignId}/exports`, {
        method: "POST",
        body: { format: "pdf" },
        headers: { "x-wardby-share": link.token },
      });
      expect(post.status).toBe(403);
      expect(await post.json()).toEqual({ error: "export_sign_in_required" });
      expect(await db.documentExport.count({ where: { documentId: exportDesignId } })).toBe(before);
    });

    it("runs a PNG and a PDF job for the requester, and a Markdown PDF", async () => {
      await withServer({ exports: exportDeps() }, async (base) => {
        const m = await session(member.id);
        const o = await session(owner.id);
        const bad = await callAt(base, `/d/api/${exportDesignId}/exports`, {
          method: "POST",
          jar: m.jar,
          body: { format: "png", board: "home" },
        });
        expect(bad.status).toBe(403);
        const post = (body: unknown, id = exportDesignId) =>
          callAt(base, `/d/api/${id}/exports`, { method: "POST", jar: m.jar, csrf: m.csrf, body });
        for (const body of [
          { format: "gif" },
          { format: "png" },
          { format: "pdf", versionNumber: "x" },
          { format: "pdf", versionNumber: "1" },
        ]) {
          expect((await post(body)).status).toBe(400);
        }
        const res = await post({ format: "png", board: "home" });
        expect(res.status).toBe(202);
        const { exportId } = (await res.json()) as { exportId: string };
        expect(await waitDone(base, exportId, m.jar)).toEqual({ status: "done", errorCode: null });
        const file = await callAt(base, `/d/api/exports/${exportId}/file`, { jar: m.jar });
        expect(file.status).toBe(200);
        expect(file.headers.get("content-type")).toBe("image/png");
        expect(file.headers.get("content-disposition")).toBe('attachment; filename="coffee-home.png"');
        expect(file.headers.get("content-security-policy")).toMatch(/^sandbox;/);
        expect(await file.text()).toBe("PNG");
        // Someone else with read access cannot see it.
        const other = await callAt(base, `/d/api/exports/${exportId}`, { jar: o.jar });
        expect(other.status).toBe(404);
        expect(await other.json()).toEqual({ error: "export_not_found" });

        const pdf = (await (await post({ format: "pdf" })).json()) as { exportId: string };
        await waitDone(base, pdf.exportId, m.jar);
        const pdfFile = await callAt(base, `/d/api/exports/${pdf.exportId}/file`, { jar: m.jar });
        expect(pdfFile.headers.get("content-disposition")).toBe('attachment; filename="coffee-boards.pdf"');
        const md = (await (await post({ format: "pdf" }, docId)).json()) as { exportId: string };
        expect((await waitDone(base, md.exportId, m.jar)).status).toBe("done");
        expect((await post({ format: "png", board: "home" }, docId)).status).toBe(400);
      });
    }, 60_000);

    it("reports canRender from the renderer, and an unavailable renderer as a failed job", async () => {
      const { jar, csrf } = await session(member.id);
      const canRender = async (base: string) =>
        (
          (await (await callAt(base, `/d/api/${exportDesignId}`, { jar })).json()) as {
            document: { canRender: boolean };
          }
        ).document.canRender;
      await withServer({ exports: exportDeps() }, async (base) => expect(await canRender(base)).toBe(true));
      await withServer({ exports: exportDeps({ renderer: null }) }, async (base) => {
        expect(await canRender(base)).toBe(false);
        const before = await db.documentExport.count({ where: { documentId: exportDesignId } });
        const res = await callAt(base, `/d/api/${exportDesignId}/exports`, {
          method: "POST",
          jar,
          csrf,
          body: { format: "pdf" },
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "export_renderer_unavailable" });
        expect(await db.documentExport.count({ where: { documentId: exportDesignId } })).toBe(before);
      });
      await withServer({}, async (base) => {
        const res = await callAt(base, `/d/api/${exportDesignId}/exports`, {
          method: "POST",
          jar,
          csrf,
          body: { format: "pdf" },
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "export_renderer_unavailable" });
        // The access check comes first: a document the caller cannot read is not found.
        const other = await callAt(base, `/d/api/${docId}x/exports`, {
          method: "POST",
          jar,
          csrf,
          body: { format: "pdf" },
        });
        expect(other.status).not.toBe(503);
      });
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

  describe("whoami", () => {
    it("needs a live session", async () => {
      const res = await call(`/web/whoami`);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "web_session_required" });
      const stale = await call(`/web/whoami`, { jar: new Jar({ "wardby-dev-web": "not-a-session" }) });
      expect(stale.status).toBe(401);
    });

    it("shows a member their principal and where the subject came from, never the session values", async () => {
      await db.principalProfile.upsert({
        where: { principalId: member.id },
        create: { principalId: member.id, displayName: "Mel Member", email: "mel@example.com", source: "oidc" },
        update: { displayName: "Mel Member", email: "mel@example.com" },
      });
      const { jar, csrf, token } = await session(member.id);
      const res = await call(`/web/whoami`, { jar });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({
        kind: "member",
        principal: { id: member.id, subject: member.subject, name: "Mel Member", email: "mel@example.com" },
        // The test double carries no subjectSource: whoami reports the default, the ID token's sub.
        signIn: { mode: "delegating", subjectFrom: { claim: "sub" } },
      });
      expect(JSON.parse(text).session.expiresAt).toEqual(expect.any(String));
      for (const value of [token, csrf]) expect(text).not.toContain(value);
      await db.principalProfile.delete({ where: { principalId: member.id } });
    });

    it("reports a configured subject source", async () => {
      const p = await freePort();
      const h = await startServerAt(p, { oidc: { ...fakeOidc, subjectSource: { emailDomain: "example.com" } } });
      try {
        const { jar } = await session(member.id);
        const res = await callAt(`http://127.0.0.1:${p}`, `/web/whoami`, { jar });
        expect(((await res.json()) as { signIn: unknown }).signIn).toEqual({
          mode: "delegating",
          subjectFrom: { emailDomain: "example.com" },
        });
      } finally {
        await h.close();
      }
    });

    it("shows a guest only their own name and link scope", async () => {
      const link = await createShareLink(db, {
        documentId: docId,
        viewer: { kind: "principal", principalId: owner.id },
        permission: "comment",
      });
      const jar = new Jar();
      const page = await call(`/s/${link.token}`, { jar });
      jar.take(page);
      const preCsrf = bootstrapOf(await page.text()).csrf as string;
      const reg = await call(`/s/${link.token}/guest`, {
        method: "POST",
        jar,
        csrf: preCsrf,
        body: { name: "Gwen", email: GUEST_EMAIL },
      });
      expect(reg.status).toBe(200);
      jar.take(reg);
      const res = await call(`/web/whoami`, { jar });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ kind: "guest", name: "Gwen", documentId: docId, permission: "comment" });
      for (const value of [link.token, GUEST_EMAIL, owner.subject]) expect(text).not.toContain(value);
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

    it("ends a disabled user's page sessions, and refuses a disabled user's leftover session", async () => {
      const sport = await freePort();
      const sorigin = `http://127.0.0.1:${sport}`;
      const canonicalUri = `${sorigin}/mcp`;
      const provider = new SelfHostedAuthProvider(
        { canonicalUri, signingKey: "a1".repeat(32), credentialHashKey: "b2".repeat(32) },
        db,
      );
      const identity = new IdentityService(db, "b2".repeat(32));
      const subject = `web-sh-off-${s}`;
      await identity.createUser(subject, [], "Dee Disabled");
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
        const live = await session(principal.id);
        expect((await callAt(sorigin, `/d/api/${docId}`, { jar: live.jar })).status).toBe(200);

        // A role change signs the user out of the pages too.
        await identity.changeRoles(subject, ["model-manager"], []);
        expect(await db.webSession.count({ where: { principalId: principal.id } })).toBe(0);
        expect((await callAt(sorigin, `/d/api/${docId}`, { jar: live.jar })).status).toBe(401);
        // A no-op change keeps the session.
        const kept = await session(principal.id);
        await identity.changeRoles(subject, ["model-manager"], []);
        expect(await db.webSession.count({ where: { principalId: principal.id } })).toBe(1);

        // Disabling deletes the page sessions in the same transaction.
        await identity.disableUser(subject);
        expect(await db.webSession.count({ where: { principalId: principal.id } })).toBe(0);
        expect((await callAt(sorigin, `/d/api/${docId}`, { jar: kept.jar })).status).toBe(401);

        // A session that survived anyway (created after the disable) still counts as absent.
        const leftover = await session(principal.id);
        expect((await callAt(sorigin, `/d/api/${docId}`, { jar: leftover.jar })).status).toBe(401);
      } finally {
        await sh.close();
        await db.webSession.deleteMany({ where: { principalId: principal.id } });
        await db.resourceGrant.deleteMany({ where: { granteePrincipalId: principal.id } });
        await db.authLoginKey.deleteMany({ where: { user: { principalId: principal.id } } });
        await db.authUser.deleteMany({ where: { principalId: principal.id } });
        await db.principalProfile.deleteMany({ where: { principalId: principal.id } });
        await db.principal.deleteMany({ where: { id: principal.id } });
      }
    });
  });
});
