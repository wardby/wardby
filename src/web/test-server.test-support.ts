/**
 * Test support (never shipped: tsconfig.build.json excludes *.test-support.ts): the real HTTP server
 * with the web routes, for route tests (routes.database.test.ts) and headless-browser page tests
 * (pages.browser.database.test.ts). It binds an ephemeral 127.0.0.1 port, signs browsers in with web
 * sessions created directly in the database (no IdP), and removes what it created on close().
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { createDocumentEventBus, type DocumentEventBus } from "../core/documents/events.js";
import type { ExportDeps } from "../core/documents/exports.js";
import { createDocument } from "../core/documents/service.js";
import { createShareLink } from "../core/documents/share-links.js";
import type { RateLimiter } from "../mcp/auth/self-hosted/rate-limit.js";
import { buildMcpServer } from "../mcp/server.js";
import { startHttpServer, type HttpServerHandle } from "../mcp/transport/streamable-http.js";
import type { AuthProvider } from "../providers/auth/types.js";
import { createDocumentStreams, type DocumentStreams } from "./events.js";
import { createLiveServer } from "./live/server.js";
import type { WebDeps } from "./routes.js";
import { createWebSession } from "./session.js";

export const TEST_CIPHER = {
  keyId: () => "test",
  encrypt: async (s: string) => s,
  decrypt: async (s: string) => s,
};

/** Dev (http) cookies: the session cookie is `wardby-dev-web`. */
export const DEV_COOKIES = { secure: false };
export const SESSION_COOKIE = "wardby-dev-web";

export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** A tiny cookie jar: name → value, updated from Set-Cookie (Max-Age=0 removes). */
export class Jar {
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

/** The MCP HTTP server with the web routes on 127.0.0.1:`port`, in delegating mode. */
export function startWebHttpServer(
  db: PrismaClient,
  port: number,
  web: Omit<WebDeps, "db" | "canonicalUri" | "authMode"> & Partial<Pick<WebDeps, "authMode">>,
  /** Live co-editing on /d/live/<id> (it needs the documents bus); omitted, the page saves the usual way. */
  liveBus?: DocumentEventBus,
): Promise<HttpServerHandle> {
  const canonicalUri = `http://127.0.0.1:${port}/mcp`;
  const live = liveBus
    ? createLiveServer({
        db,
        canonicalUri,
        authMode: "delegating",
        ...web,
        bus: liveBus,
        replica: `127.0.0.1:${port}`,
        timings: { storeDebounceMs: 300, storeMaxDebounceMs: 1000 },
      })
    : undefined;
  return startHttpServer({
    mcp: buildMcpServer({ providers: {} as never, db, config: { canonicalUri } }),
    config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
    auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
    web: { db, canonicalUri, authMode: "delegating", ...web },
    ...(live ? { live } : {}),
  });
}

/** A cookie in the shape Playwright's `context.addCookies` takes. */
export interface BrowserCookie {
  name: string;
  value: string;
  url: string;
}

export type DesignAccess = "owner" | "write" | "comment" | "read";

export interface TestDesign {
  documentId: string;
  /** A signed-in member with `access` (the owner for "owner"). */
  cookie: BrowserCookie;
  /** A second member with the same access, in another browser context. */
  secondCookie: BrowserCookie;
  /** The owner's cookie (whatever `access` is). */
  ownerCookie: BrowserCookie;
  principalIds: { owner: string; first: string; second: string };
  /** Present with `share`: the link's token and its page path (/s/<token>). */
  shareToken?: string;
  sharePath?: string;
}

export interface TestWebServer {
  origin: string;
  db: PrismaClient;
  close(): Promise<void>;
  design(input: {
    title: string;
    files?: Record<string, string>;
    /** A Markdown document instead of a design (with `markdown`). */
    kind?: "document";
    markdown?: string;
    access: DesignAccess;
    /** Also create a share link with this permission (for guests and anonymous visitors). */
    share?: "view" | "comment";
  }): Promise<TestDesign>;
  /** A web session for another member with no grant (tests that need an outsider). */
  memberCookie(): Promise<BrowserCookie>;
}

const allowAll: RateLimiter = { check: async () => {} };
/** A renderer that answers without Chromium: fixed PNG and PDF bytes. */
export const FAKE_RENDERER = {
  png: async () => Buffer.from("FAKE-PNG"),
  pdf: async () => Buffer.from("%PDF-FAKE"),
};

/**
 * Starts the server. `exports`: "fake" wires PNG/PDF exports to FAKE_RENDERER, null wires exports
 * with no renderer (export_renderer_unavailable), omitted leaves exports out. Live events are on.
 */
export async function startTestWebServer(opts: {
  assetsRoot: string;
  exports?: "fake" | null;
  /** Live co-editing on (documents are edited together); off, pages save versions the usual way. */
  live?: boolean;
  extra?: Partial<WebDeps>;
}): Promise<TestWebServer> {
  const db = createPrismaClient();
  const run = randomUUID();
  const principals: string[] = [];
  const bus: DocumentEventBus = createDocumentEventBus({ connectionString: process.env.DATABASE_URL! });
  const events: DocumentStreams = createDocumentStreams({ bus });
  const exportDeps: ExportDeps | undefined =
    opts.exports === undefined
      ? undefined
      : { db, renderer: opts.exports === "fake" ? FAKE_RENDERER : null, rateLimiter: allowAll };
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const handle = await startWebHttpServer(
    db,
    port,
    {
      cipher: TEST_CIPHER,
      assetsRoot: opts.assetsRoot,
      events,
      ...(exportDeps ? { exports: exportDeps } : {}),
      ...opts.extra,
    },
    opts.live ? bus : undefined,
  );

  const principal = async (label: string) => {
    const p = await db.principal.create({ data: { subject: `pages-${label}-${run}-${principals.length}` } });
    principals.push(p.id);
    await db.principalProfile.create({
      data: { principalId: p.id, displayName: label, email: `${p.id}@example.com`, source: "oidc" },
    });
    return p.id;
  };
  const cookieFor = async (principalId: string): Promise<BrowserCookie> => {
    const s = await createWebSession(db, { principalId }, DEV_COOKIES);
    return { name: SESSION_COOKIE, value: s.token, url: origin };
  };
  const grant = (documentId: string, principalId: string, level: string) =>
    db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: documentId,
        granteeKind: "principal",
        granteePrincipalId: principalId,
        granteeKey: `principal:${principalId}`,
        level,
      },
    });

  return {
    origin,
    db,
    async design(input) {
      const owner = await principal("Olive Owner");
      const doc = await createDocument(db, TEST_CIPHER, {
        kind: input.kind ?? "design",
        ownerId: owner,
        title: input.title,
        ...(input.kind === "document" ? { markdown: input.markdown ?? "# Notes\n" } : { files: input.files }),
      });
      let first = owner;
      let second: string;
      if (input.access === "owner") {
        second = await principal("Mel Member");
        await grant(doc.id, second, "write");
      } else {
        first = await principal("Ada Member");
        second = await principal("Bo Member");
        await grant(doc.id, first, input.access);
        await grant(doc.id, second, input.access);
      }
      const link = input.share
        ? await createShareLink(db, {
            documentId: doc.id,
            viewer: { kind: "principal", principalId: owner },
            permission: input.share,
          })
        : null;
      return {
        documentId: doc.id,
        cookie: await cookieFor(first),
        secondCookie: await cookieFor(second),
        ownerCookie: await cookieFor(owner),
        principalIds: { owner, first, second },
        ...(link ? { shareToken: link.token, sharePath: `/s/${link.token}` } : {}),
      };
    },
    async memberCookie() {
      return cookieFor(await principal("Otto Outsider"));
    },
    async close() {
      events.closeStreams();
      await handle.close();
      await bus.close();
      await db.webSession.deleteMany({ where: { principalId: { in: principals } } });
      await db.document.deleteMany({ where: { ownerId: { in: principals } } });
      await db.principal.deleteMany({ where: { id: { in: principals } } });
      await db.$disconnect();
    },
  };
}
