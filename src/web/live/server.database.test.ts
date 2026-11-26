/**
 * The live co-editing server end to end against real PostgreSQL: real WebSockets, real Hocuspocus clients,
 * signed in with real web sessions. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { DocumentEvent, DocumentEventBus } from "../../core/documents/events.js";
import { LIVE_FIELD, liveDocToMarkdown } from "../../core/documents/live/markdown.js";
import { issueLiveTicket, loadLiveState } from "../../core/documents/live/store.js";
import { createDocument } from "../../core/documents/service.js";
import { attachSecret, createSecret } from "../../core/secrets.js";
import { createWebSession } from "../session.js";
import { createLiveServer, LIVE_META, type LiveServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DATABASE_URL)("live co-editing server (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const docs: string[] = [];
  const listeners = new Set<(e: DocumentEvent) => void>();
  const bus = {
    subscribe: (l: (e: DocumentEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    connected: () => true,
    onState: () => () => undefined,
    close: async () => undefined,
  } as unknown as DocumentEventBus;
  const emit = (e: DocumentEvent) => listeners.forEach((l) => l(e));
  let ann: Principal;
  let bo: Principal;
  let cy: Principal;
  let http: Server;
  let live: LiveServer;
  let port = 0;

  async function start(): Promise<void> {
    live = createLiveServer({
      db,
      cipher,
      canonicalUri: "http://localhost/mcp",
      authMode: "self-hosted",
      bus,
      replica: "127.0.0.1:1",
      timings: { storeDebounceMs: 100, storeMaxDebounceMs: 300 },
    });
    http = createServer((_req, res) => res.writeHead(404).end());
    http.on("upgrade", (req, socket, head) => {
      if (!live.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => http.listen(port, "127.0.0.1", () => r()));
    port = (http.address() as AddressInfo).port;
  }
  async function stop(): Promise<void> {
    await live.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }

  const cookieFor = async (p: Principal) =>
    (await createWebSession(db, { principalId: p.id }, { secure: false })).cookie.split(";")[0];

  async function client(p: Principal, documentId: string, opts: { ticket?: string; initial?: Uint8Array } = {}) {
    const cookie = await cookieFor(p);
    class Socket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const ydoc = new Y.Doc();
    if (opts.initial) Y.applyUpdate(ydoc, opts.initial);
    let synced = false;
    let failed = false;
    let reason = "";
    const stateless: string[] = [];
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/d/live/${documentId}`,
      WebSocketPolyfill: Socket,
      maxAttempts: 1,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: documentId,
      document: ydoc,
      token: () => JSON.stringify({ epoch: ydoc.getMap(LIVE_META).get("epoch"), ticket: opts.ticket }),
      onSynced: ({ state }) => {
        synced ||= state;
      },
      onAuthenticationFailed: (e) => {
        failed = true;
        reason = e.reason;
      },
      onStateless: ({ payload }) => {
        stateless.push(payload);
      },
    });
    provider.attach();
    for (let i = 0; i < 40 && !synced && !failed; i++) await sleep(50);
    const paragraph = (needle: string) => {
      for (const n of ydoc.getXmlFragment(LIVE_FIELD).toArray()) {
        if (!(n instanceof Y.XmlElement)) continue;
        for (const c of n.toArray()) if (c instanceof Y.XmlText && c.toString().includes(needle)) return c;
      }
      throw new Error(`no paragraph with ${needle}`);
    };
    return {
      ydoc,
      synced: () => synced,
      failed: () => failed,
      reason: () => reason,
      stateless,
      markdown: () => liveDocToMarkdown(ydoc),
      append: (needle: string, text: string) => {
        const t = paragraph(needle);
        ydoc.transact(() => t.insert(t.length, text));
      },
      close: () => {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  const storedMarkdown = async (documentId: string) => {
    const stored = await loadLiveState(db, documentId);
    if (!stored) return null;
    const d = new Y.Doc();
    Y.applyUpdate(d, stored.state);
    return liveDocToMarkdown(d);
  };
  const newDoc = async (extra: { agentId?: string } = {}) => {
    const doc = await createDocument(db, cipher, {
      ownerId: ann.id,
      title: "Plan",
      markdown: "# Plan\n\nAnn writes here.\n\nBo writes here.\n",
      ...extra,
    });
    docs.push(doc.id);
    return doc.id;
  };
  const grant = (documentId: string, who: Principal, level: string) =>
    db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: documentId,
        granteeKind: "principal",
        granteePrincipalId: who.id,
        granteeKey: `principal:${who.id}`,
        level,
      },
    });

  beforeAll(async () => {
    [ann, bo, cy] = await Promise.all(
      ["ann", "bo", "cy"].map((n) => db.principal.create({ data: { subject: `live-${n}-${s}` } })),
    );
    await start();
  });
  afterAll(async () => {
    await stop();
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.$disconnect();
  });

  it("a writer joins from the latest version, edits, and the edit is saved", async () => {
    const id = await newDoc();
    const a = await client(ann, id);
    expect(a.synced()).toBe(true);
    expect(a.markdown()).toContain("Ann writes here.");
    expect(await db.documentLiveVersionState.count({ where: { documentId: id, versionNumber: 1 } })).toBe(1);
    a.append("Ann writes", " Edited.");
    await sleep(600);
    expect(await storedMarkdown(id)).toContain("Ann writes here. Edited.");
    a.close();
  });

  it("two people see each other's edits", async () => {
    const id = await newDoc();
    await grant(id, bo, "write");
    const a = await client(ann, id);
    const b = await client(bo, id);
    a.append("Ann writes", " A1.");
    b.append("Bo writes", " B1.");
    await sleep(300);
    expect(a.markdown()).toContain("Bo writes here. B1.");
    expect(b.markdown()).toContain("Ann writes here. A1.");
    a.close();
    b.close();
  });

  it("comment access joins read-only; no access is refused", async () => {
    const id = await newDoc();
    await grant(id, bo, "comment");
    const a = await client(ann, id);
    const b = await client(bo, id);
    expect(b.synced()).toBe(true);
    b.append("Bo writes", " READ-ONLY-EDIT");
    await sleep(600);
    expect(a.markdown()).not.toContain("READ-ONLY-EDIT");
    expect(await storedMarkdown(id)).not.toContain("READ-ONLY-EDIT");
    const c = await client(cy, id);
    expect(c.synced()).toBe(false);
    a.close();
    b.close();
    c.close();
  });

  it("an approved document is read-only for everyone, switched live; reopening restores editing", async () => {
    const id = await newDoc();
    await grant(id, bo, "write");
    const a = await client(ann, id);
    const b = await client(bo, id);
    await db.document.update({ where: { id }, data: { reviewState: "approved" } });
    emit({ documentId: id, kind: "review" });
    await sleep(300);
    a.append("Ann writes", " LOCKED-EDIT");
    await sleep(300);
    expect(b.markdown()).not.toContain("LOCKED-EDIT");
    const late = await client(bo, id);
    late.append("Bo writes", " LATE-EDIT");
    await sleep(300);
    expect(b.markdown()).not.toContain("LATE-EDIT");
    late.close();
    await db.document.update({ where: { id }, data: { reviewState: "draft" } });
    emit({ documentId: id, kind: "review" });
    await sleep(300);
    b.append("Bo writes", " REOPENED-EDIT");
    await sleep(300);
    a.close();
    const check = await client(ann, id);
    expect(check.markdown()).toContain("REOPENED-EDIT");
    expect(check.markdown()).not.toContain("LOCKED-EDIT");
    b.close();
    check.close();
  });

  it("a member with only a share link joins with a single-use ticket", async () => {
    const id = await newDoc();
    const without = await client(cy, id);
    expect(without.synced()).toBe(false);
    without.close();
    const ticket = await issueLiveTicket(db, { documentId: id, principalId: cy.id, readOnly: true });
    const a = await client(ann, id);
    const c = await client(cy, id, { ticket });
    expect(c.synced()).toBe(true);
    c.append("Bo writes", " CY-EDIT");
    await sleep(300);
    expect(a.markdown()).not.toContain("CY-EDIT");
    c.close();
    const again = await client(cy, id, { ticket });
    expect(again.synced()).toBe(false);
    expect(again.reason()).toBe("document_not_found");
    again.close();
    a.close();
  });

  it("an edit that would show a secret value is refused before anyone else gets it", async () => {
    const FAKE = `sk-fake-${randomUUID()}`;
    const agent = await db.agent.create({
      data: { name: `live-agent-${s}`, systemPrompt: "p", model: "m", budgetUsd: 1, ownerId: ann.id },
    });
    await createSecret(`live-secret-${s}`, FAKE, ann.id, cipher, db);
    await attachSecret(agent.id, `live-secret-${s}`, ann.id, db);
    const id = await newDoc({ agentId: agent.id });
    await grant(id, bo, "write");
    const a = await client(ann, id);
    const b = await client(bo, id);
    b.append("Bo writes", ` ${FAKE}`);
    await sleep(600);
    expect(a.markdown()).not.toContain(FAKE);
    expect(await storedMarkdown(id)).not.toContain(FAKE);
    expect(b.stateless.some((p) => p.includes("edit_refused"))).toBe(true);
    a.close();
    b.close();
    await db.document.deleteMany({ where: { agentId: agent.id } });
    await db.agentSecret.deleteMany({ where: { agentId: agent.id } });
    await db.secret.deleteMany({ where: { name: `live-secret-${s}`, ownerId: ann.id } });
    await db.agent.delete({ where: { id: agent.id } });
  });

  it("after a restart the saved history resumes; a browser holding a reset history is refused", async () => {
    const id = await newDoc();
    const a = await client(ann, id);
    a.append("Ann writes", " BEFORE-RESTART");
    await sleep(600);
    const held = Y.encodeStateAsUpdate(a.ydoc);
    a.close();
    await stop();
    await start();
    // The browser reconnects with the history it holds: nothing is duplicated.
    const back = await client(ann, id, { initial: held });
    expect(back.synced()).toBe(true);
    await sleep(300);
    expect(back.markdown().split("Ann writes here.").length - 1).toBe(1);
    expect(back.markdown()).toContain("BEFORE-RESTART");
    back.close();
    // The history is reset (state lost): a browser holding the old one is refused instead of merged in.
    await stop();
    await db.documentLiveState.delete({ where: { documentId: id } });
    await start();
    const stale = await client(ann, id, { initial: held });
    expect(stale.failed()).toBe(true);
    expect(stale.reason()).toBe("live_state_stale");
    expect(stale.synced()).toBe(false);
    stale.close();
    // A fresh browser starts the new history from the latest version: one copy, nothing merged from the old one.
    const fresh = await client(ann, id);
    expect(fresh.synced()).toBe(true);
    expect(fresh.markdown().split("Ann writes here.").length - 1).toBe(1);
    expect(fresh.markdown()).not.toContain("BEFORE-RESTART");
    fresh.close();
  });
});
