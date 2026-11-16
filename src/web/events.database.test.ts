/**
 * GET /d/api/<id>/events against real PostgreSQL: LISTEN/NOTIFY fan-out
 * through the documents bus, session and access checks at open and on every
 * heartbeat, per-document filtering, the per-session cap, and no content in
 * any frame. Skipped without DATABASE_URL.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { createThread, deleteComment, editComment, reply, setThreadStatus } from "../core/documents/comments.js";
import { createDocumentEventBus, type DocumentEventBus } from "../core/documents/events.js";
import { createDocument, publishVersion } from "../core/documents/service.js";
import { createShareLink, registerGuest, revokeShareLink } from "../core/documents/share-links.js";
import { buildMcpServer } from "../mcp/server.js";
import { startHttpServer, type HttpServerHandle } from "../mcp/transport/streamable-http.js";
import type { AuthProvider } from "../providers/auth/types.js";
import { createDocumentStreams, openDocumentStream, type DocumentStreams } from "./events.js";
import { createWebSession } from "./session.js";

const DEV = { secure: false };
const FAKE_SECRET = "sk-fake-live-events-0123456789abcdef";
const TITLE = "Quarterly plan with a private title";
const anchor = { type: "text" as const, quote: "hello world", prefix: "", suffix: "" };

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** An open event stream: everything received so far, and a way to wait for more. */
interface Stream {
  status: number;
  text(): string;
  waitFor(pattern: RegExp, ms?: number): Promise<void>;
  ended(ms?: number): Promise<boolean>;
  abort(): void;
}

describe.skipIf(!process.env.DATABASE_URL)("document event stream (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let outsider: Principal;
  let docId: string;
  let otherDocId: string;
  let bus: DocumentEventBus;
  let streams: DocumentStreams;
  let handle: HttpServerHandle;
  let base: string;
  const open: Stream[] = [];

  async function stream(
    cookie: string | null,
    docPath = docId,
    headers: Record<string, string> = {},
    origin = base,
  ): Promise<Stream> {
    const controller = new AbortController();
    const res = await fetch(`${origin}/d/api/${docPath}/events`, {
      headers: { accept: "text/event-stream", ...(cookie ? { cookie } : {}), ...headers },
      signal: controller.signal,
    });
    let buf = "";
    let done = false;
    const waiters = new Set<() => void>();
    const wake = () => {
      for (const w of [...waiters]) w();
    };
    if (res.body) {
      void (async () => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { value, done: d } = await reader.read();
            if (d) break;
            buf += dec.decode(value, { stream: true });
            wake();
          }
        } catch {
          /* aborted */
        }
        done = true;
        wake();
      })();
    } else done = true;
    const until = (ok: () => boolean, ms: number) =>
      new Promise<boolean>((resolve) => {
        if (ok()) return resolve(true);
        const timer = setTimeout(() => {
          waiters.delete(check);
          resolve(false);
        }, ms);
        const check = () => {
          if (!ok()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(true);
        };
        waiters.add(check);
      });
    const st: Stream = {
      status: res.status,
      text: () => buf,
      async waitFor(pattern, ms = 5000) {
        if (!(await until(() => pattern.test(buf), ms))) throw new Error(`timed out waiting for ${pattern}: ${buf}`);
      },
      ended: (ms = 5000) => until(() => done, ms),
      abort: () => controller.abort(),
    };
    open.push(st);
    return st;
  }

  /** A stream that is live: the bus is LISTENing, so a notify from now on reaches it. */
  async function liveStream(cookie: string, docPath = docId, headers: Record<string, string> = {}) {
    const st = await stream(cookie, docPath, headers);
    expect(st.status).toBe(200);
    await st.waitFor(/event: hello\ndata: \{"connected":true\}|event: resync/);
    return st;
  }

  const memberCookie = async (principalId: string) =>
    `wardby-dev-web=${(await createWebSession(db, { principalId }, DEV)).token}`;

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `events-owner-${s}` } });
    outsider = await db.principal.create({ data: { subject: `events-out-${s}` } });
    docId = (await createDocument(db, cipher, { ownerId: owner.id, title: TITLE, markdown: "hello world" })).id;
    otherDocId = (await createDocument(db, cipher, { ownerId: owner.id, title: "Other", markdown: "hello world" })).id;
    bus = createDocumentEventBus({ connectionString: process.env.DATABASE_URL! });
    streams = createDocumentStreams({ bus, heartbeatMs: 150, maxPerSession: 2 });
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const canonicalUri = `${base}/mcp`;
    handle = await startHttpServer({
      mcp: buildMcpServer({ providers: {} as never, db, config: { canonicalUri } }),
      config: { canonicalUri, httpBind: { host: "127.0.0.1", port }, authProviderKind: "delegating" },
      auth: { authProvider: {} as AuthProvider, db, providers: {} as never },
      web: { db, cipher, canonicalUri, authMode: "delegating", events: streams },
    });
  });

  afterAll(async () => {
    for (const st of open) st.abort();
    await handle?.close();
    await bus?.close();
    await db.webSession.deleteMany({ where: { principalId: { in: [owner.id, outsider.id] } } });
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, outsider.id] } } });
    await db.$disconnect();
  });

  it("refuses a visitor without a session (401) and a member without access", async () => {
    const none = await stream(null);
    expect(none.status).toBe(401);
    expect(await none.ended()).toBe(true);
    expect(none.text()).toContain("web_session_required");
    const out = await stream(await memberCookie(outsider.id));
    expect(out.status).toBe(404);
  });

  it("forwards every kind of change as ids and a kind, never content", async () => {
    const viewer = { kind: "principal" as const, principalId: owner.id };
    const st = await liveStream(await memberCookie(owner.id));
    const t = await createThread(db, cipher, { documentId: docId, viewer, anchor, body: `token ${FAKE_SECRET}` });
    await st.waitFor(/event: thread\n/);
    const r = await reply(db, cipher, { threadId: t.threadId, viewer, body: `again ${FAKE_SECRET}` });
    await editComment(db, cipher, { commentId: r.commentId, viewer, body: `edited ${FAKE_SECRET}` });
    await deleteComment(db, { commentId: r.commentId, viewer });
    await setThreadStatus(db, { threadId: t.threadId, viewer, status: "resolved" });
    await publishVersion(db, cipher, { documentId: docId, markdown: `hello world ${FAKE_SECRET}`, via: "editor" });
    await st.waitFor(/event: version\n/);
    const comments = st.text().match(/event: comment\n/g) ?? [];
    expect(comments.length).toBe(3);
    const frames = [...st.text().matchAll(/event: (thread|comment|version|share)\ndata: (.*)\n/g)];
    for (const [, kind, data] of frames) expect(JSON.parse(data)).toEqual({ documentId: docId, kind });
    expect(st.text()).not.toContain(FAKE_SECRET);
    expect(st.text()).not.toContain(TITLE);
    expect(st.text()).toMatch(/^retry: 3000\n\n/);
  });

  it("filters events to the stream's own document", async () => {
    const st = await liveStream(await memberCookie(owner.id));
    await publishVersion(db, cipher, { documentId: otherDocId, markdown: "hello world 2", via: "mcp" });
    await publishVersion(db, cipher, { documentId: docId, markdown: "hello world 3", via: "mcp" });
    await st.waitFor(/event: version\n/);
    expect(st.text()).not.toContain(otherDocId);
  });

  it("lets a guest stream, and ends the stream when the link is revoked", async () => {
    const ownerViewer = { kind: "principal" as const, principalId: owner.id };
    const link = await createShareLink(db, { documentId: docId, viewer: ownerViewer, permission: "comment" });
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: `Gus ${s.slice(0, 8)}` });
    const session = await createWebSession(db, { guestId, shareLinkId: link.id }, DEV);
    const st = await liveStream(`wardby-dev-web=${session.token}`);
    await revokeShareLink(db, { shareLinkId: link.id, viewer: ownerViewer });
    expect(await st.ended()).toBe(true);
  });

  it("ends the stream at the next heartbeat once the session has expired", async () => {
    const created = await createWebSession(db, { principalId: owner.id }, DEV);
    const st = await liveStream(`wardby-dev-web=${created.token}`);
    await st.waitFor(/: ping\n/);
    await db.webSession.updateMany({ where: { principalId: owner.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await st.ended()).toBe(true);
  });

  it("ends the stream at the next heartbeat when a self-hosted user is disabled", async () => {
    const user = await db.principal.create({ data: { subject: `events-sh-${s}` } });
    await db.authUser.create({ data: { principalId: user.id } });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: user.id,
        granteeKey: `principal:${user.id}`,
        level: "read",
      },
    });
    const deps = {
      db,
      cipher,
      canonicalUri: base,
      authMode: "self-hosted" as const,
      events: streams,
    };
    const server: Server = createServer((req, res) => {
      openDocumentStream(req, res, docId, deps).catch(() => res.destroy());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const st = await stream(await memberCookie(user.id), docId, {}, origin);
      expect(st.status).toBe(200);
      await st.waitFor(/: ping\n/);
      await db.authUser.update({ where: { principalId: user.id }, data: { status: "disabled" } });
      expect(await st.ended()).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await db.webSession.deleteMany({ where: { principalId: user.id } });
      await db.resourceGrant.deleteMany({ where: { granteePrincipalId: user.id } });
      await db.authUser.deleteMany({ where: { principalId: user.id } });
      await db.principal.delete({ where: { id: user.id } });
    }
  });

  it("ends the stream at the next heartbeat when a member loses their grant", async () => {
    const member = await db.principal.create({ data: { subject: `events-mem-${s}` } });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: member.id,
        granteeKey: `principal:${member.id}`,
        level: "read",
      },
    });
    try {
      const st = await liveStream(await memberCookie(member.id));
      await st.waitFor(/: ping\n/);
      await db.resourceGrant.deleteMany({ where: { granteePrincipalId: member.id } });
      expect(await st.ended()).toBe(true);
    } finally {
      await db.webSession.deleteMany({ where: { principalId: member.id } });
      await db.resourceGrant.deleteMany({ where: { granteePrincipalId: member.id } });
      await db.principal.delete({ where: { id: member.id } });
    }
  });

  it("does not refresh the session on heartbeats", async () => {
    const created = await createWebSession(db, { principalId: owner.id }, DEV);
    const st = await liveStream(`wardby-dev-web=${created.token}`);
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    const seen = async () => (await db.webSession.findUniqueOrThrow({ where: { tokenHash } })).lastSeenAt;
    const before = await seen();
    await st.waitFor(/(: ping\n[\s\S]*){3}/);
    expect((await seen()).getTime()).toBe(before.getTime());
    st.abort();
  });

  it("caps open streams per session and frees the slot when one closes", async () => {
    const cookie = await memberCookie(owner.id);
    const a = await liveStream(cookie);
    await liveStream(cookie);
    const third = await stream(cookie);
    expect(third.status).toBe(429);
    a.abort();
    await new Promise((r) => setTimeout(r, 200));
    const again = await stream(cookie);
    expect(again.status).toBe(200);
  });

  it("closeStreams ends every open stream", async () => {
    const st = await liveStream(await memberCookie(owner.id));
    streams.closeStreams();
    expect(await st.ended()).toBe(true);
  });
});
