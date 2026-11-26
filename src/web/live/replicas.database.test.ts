/**
 * Live co-editing across two control-plane replicas on one database: pinned (the lease holder serves a document,
 * the other replica hands connections to it, failover from the saved state) and, when WARDBY_TEST_REDIS_URL is
 * set, the Redis relay (every replica serves, one leader saves versions). Skipped without DATABASE_URL.
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
import { createDocument, publishVersion } from "../../core/documents/service.js";
import { createWebSession } from "../session.js";
import { createLiveServer, LIVE_META, type LiveServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DATABASE_URL)("live co-editing across replicas (database)", () => {
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

  interface Replica {
    port: number;
    live: LiveServer;
    http: Server;
    stop(): Promise<void>;
  }
  async function replica(redisUrl?: string): Promise<Replica> {
    const http = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as AddressInfo).port;
    const live = createLiveServer({
      db,
      cipher,
      canonicalUri: "http://localhost/mcp",
      authMode: "self-hosted",
      bus,
      replica: `127.0.0.1:${port}`,
      ...(redisUrl ? { redisUrl } : {}),
      timings: { storeDebounceMs: 100, storeMaxDebounceMs: 300, leaseSeconds: 2, leaseRenewMs: 500 },
    });
    http.on("upgrade", (req, socket, head) => {
      if (!live.handleUpgrade(req, socket, head)) socket.destroy();
    });
    return {
      port,
      live,
      http,
      async stop() {
        await live.close();
        http.closeAllConnections();
        await new Promise<void>((r) => http.close(() => r()));
      },
    };
  }

  async function client(p: Principal, port: number, documentId: string, initial?: Uint8Array) {
    const cookie = (await createWebSession(db, { principalId: p.id }, { secure: false })).cookie.split(";")[0];
    class Socket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const ydoc = new Y.Doc();
    if (initial) Y.applyUpdate(ydoc, initial);
    let synced = false;
    const socket = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/d/live/${documentId}`,
      WebSocketPolyfill: Socket,
      maxAttempts: 1,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: documentId,
      document: ydoc,
      token: () => JSON.stringify({ epoch: ydoc.getMap(LIVE_META).get("epoch") }),
      onSynced: ({ state }) => {
        synced ||= state;
      },
    });
    provider.attach();
    for (let i = 0; i < 60 && !synced; i++) await sleep(50);
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

  const newDoc = async () => {
    const doc = await createDocument(db, cipher, {
      ownerId: ann.id,
      title: "Plan",
      markdown: "# Plan\n\nAnn writes here.\n\nBo writes here.\n",
    });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: doc.id,
        granteeKind: "principal",
        granteePrincipalId: bo.id,
        granteeKey: `principal:${bo.id}`,
        level: "write",
      },
    });
    docs.push(doc.id);
    return doc.id;
  };
  const versions = (documentId: string) =>
    db.documentVersion.findMany({ where: { documentId }, orderBy: { number: "asc" }, select: { markdown: true } });

  beforeAll(async () => {
    [ann, bo] = await Promise.all(
      ["ann", "bo"].map((n) => db.principal.create({ data: { subject: `replicas-${n}-${s}` } })),
    );
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.$disconnect();
  });

  it("pinned: one replica serves a document; a connection to another is handed to it", async () => {
    const a = await replica();
    const b = await replica();
    const id = await newDoc();
    const annOnA = await client(ann, a.port, id);
    const boOnB = await client(bo, b.port, id);
    expect(boOnB.synced()).toBe(true);
    annOnA.append("Ann writes", " A1.");
    boOnB.append("Bo writes", " B1.");
    await sleep(400);
    for (const c of [annOnA, boOnB]) {
      expect(c.markdown()).toContain("Ann writes here. A1.");
      expect(c.markdown()).toContain("Bo writes here. B1.");
    }
    expect((await db.documentLiveLease.findUniqueOrThrow({ where: { documentId: id } })).owner).toBe(
      `127.0.0.1:${a.port}`,
    );
    annOnA.close();
    boOnB.close();
    await a.stop();
    await b.stop();
  });

  it("pinned: when the leading replica dies, another takes over from the saved state once its lease expires", async () => {
    const a = await replica();
    const b = await replica();
    const id = await newDoc();
    const annOnA = await client(ann, a.port, id);
    const boOnB = await client(bo, b.port, id);
    boOnB.append("Bo writes", " SAVED.");
    await sleep(500); // stored
    boOnB.append("Bo writes", " UNSAVED.");
    await sleep(30);
    const held = Y.encodeStateAsUpdate(boOnB.ydoc);
    annOnA.close();
    boOnB.close();
    await a.stop();
    // A crash leaves A's lease behind (a clean stop releases it): put it back, as A had renewed it last.
    await db.documentLiveLease.upsert({
      where: { documentId: id },
      create: { documentId: id, owner: `127.0.0.1:${a.port}`, expiresAt: new Date(Date.now() + 2000) },
      update: { owner: `127.0.0.1:${a.port}`, expiresAt: new Date(Date.now() + 2000) },
    });
    // While it holds, B hands Bo's page to A, which is gone: no connection.
    const early = await client(bo, b.port, id, held);
    expect(early.synced()).toBe(false);
    early.close();
    await sleep(2200);
    // Bo's page reconnects (to B) with what it holds: B now leads, resumes the saved state, takes the rest back.
    const back = await client(bo, b.port, id, held);
    expect(back.synced()).toBe(true);
    await sleep(400);
    expect(back.markdown()).toContain("Bo writes here. SAVED. UNSAVED.");
    expect(back.markdown().split("Bo writes here.").length - 1).toBe(1);
    expect((await db.documentLiveLease.findUniqueOrThrow({ where: { documentId: id } })).owner).toBe(
      `127.0.0.1:${b.port}`,
    );
    back.close();
    await b.stop();
  }, 30_000);

  const redisUrl = process.env.WARDBY_TEST_REDIS_URL;
  it.skipIf(!redisUrl)("Redis: every replica serves; edits meet; a publish merges once; one leader saves", async () => {
    const a = await replica(redisUrl);
    const b = await replica(redisUrl);
    const id = await newDoc();
    const annOnA = await client(ann, a.port, id);
    const boOnB = await client(bo, b.port, id);
    annOnA.append("Ann writes", " A1.");
    boOnB.append("Bo writes", " B1.");
    await sleep(800);
    for (const c of [annOnA, boOnB]) expect(c.markdown()).toMatch(/A1\.[\s\S]*B1\./);
    const latest = await db.documentVersion.findFirstOrThrow({
      where: { documentId: id },
      orderBy: { number: "desc" },
    });
    await publishVersion(db, cipher, {
      documentId: id,
      markdown: latest.markdown!.replace("Bo writes here.", "Bo writes here. AGENT."),
      via: "agent",
      expectedNumber: latest.number,
    });
    emit({ documentId: id, kind: "version" });
    await sleep(1000);
    for (const c of [annOnA, boOnB]) expect(c.markdown().split("AGENT.").length - 1).toBe(1);
    const saved = await versions(id);
    expect(saved.filter((v) => (v.markdown ?? "").includes("AGENT.")).length).toBeGreaterThan(0);
    expect(saved.every((v) => (v.markdown ?? "").split("AGENT.").length - 1 <= 1)).toBe(true);
    annOnA.close();
    boOnB.close();
    await a.stop();
    await b.stop();
  });
});
