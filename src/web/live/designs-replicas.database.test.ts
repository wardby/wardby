/**
 * Live designs across two control-plane replicas: pinned (a page on the other replica is handed to the leader, one
 * builder, one checkpoint writer) and, with WARDBY_TEST_REDIS_URL, the Redis relay (pages on different replicas
 * opening the same unbuilt board at once: exactly one is told to build). Skipped without DATABASE_URL.
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
import { BOARD_ROOT, boardMaps, F } from "../../core/documents/boards/live/model.js";
import type { DocumentEvent, DocumentEventBus } from "../../core/documents/events.js";
import { loadVersionFiles } from "../../core/documents/files.js";
import { createDocument } from "../../core/documents/service.js";
import { createWebSession } from "../session.js";
import { buildBoard, coffee, coffeeFiles } from "./design.test-support.js";
import { createLiveServer, LIVE_META, type LiveServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!process.env.DATABASE_URL)("live designs across replicas (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const docs: string[] = [];
  const bus = {
    subscribe: () => () => undefined,
    connected: () => true,
    onState: () => () => undefined,
    close: async () => undefined,
  } as unknown as DocumentEventBus & { emit?: (e: DocumentEvent) => void };
  let ann: Principal;
  let bo: Principal;

  async function replica(redisUrl?: string): Promise<{ port: number; live: LiveServer; stop(): Promise<void> }> {
    const http: Server = createServer((_req, res) => res.writeHead(404).end());
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
      async stop() {
        await live.close();
        http.closeAllConnections();
        await new Promise<void>((r) => http.close(() => r()));
      },
    };
  }

  async function client(p: Principal, port: number, documentId: string) {
    const cookie = (await createWebSession(db, { principalId: p.id }, { secure: false })).cookie.split(";")[0];
    class Socket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const ydoc = new Y.Doc();
    let synced = false;
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
      token: () => JSON.stringify({ epoch: ydoc.getMap(LIVE_META).get("epoch") }),
      onSynced: ({ state }) => {
        synced ||= state;
      },
      onStateless: ({ payload }) => {
        stateless.push(payload);
      },
    });
    provider.attach();
    for (let i = 0; i < 60 && !synced; i++) await sleep(50);
    return {
      ydoc,
      synced: () => synced,
      open: (board: string) => provider.sendStateless(JSON.stringify({ type: "open-board", board })),
      async roleFor(board: string): Promise<string | null> {
        for (let i = 0; i < 60; i++) {
          for (const m of stateless) {
            const x = JSON.parse(m) as { type?: string; board?: string; role?: string };
            if (x.type === "board" && x.board === board) return x.role ?? null;
          }
          await sleep(50);
        }
        return null;
      },
      close: () => {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  const design = async (): Promise<string> => {
    const doc = await createDocument(db, cipher, {
      kind: "design",
      ownerId: ann.id,
      title: `Coffee ${s}`,
      files: coffeeFiles(),
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
  const h1Of = (d: Y.Doc) => [...boardMaps(d, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "h1")![1];
  const built = (d: Y.Doc, board: string) => {
    const b = d.getMap<unknown>("boards").get(board);
    const n = b instanceof Y.Map ? (b as Y.Map<unknown>).get("nodes") : undefined;
    return n instanceof Y.Map && n.has(BOARD_ROOT);
  };

  beforeAll(async () => {
    [ann, bo] = await Promise.all(
      ["ann", "bo"].map((n) => db.principal.create({ data: { subject: `design-replicas-${n}-${s}` } })),
    );
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.$disconnect();
  });

  it("pinned: a page on the other replica is handed to the leader; one builder; edits meet and are saved once", async () => {
    const a = await replica();
    const b = await replica();
    const id = await design();
    const annOnA = await client(ann, a.port, id);
    const boOnB = await client(bo, b.port, id);
    expect(boOnB.synced()).toBe(true);
    annOnA.open("home");
    boOnB.open("home");
    const roles = [await annOnA.roleFor("home"), await boOnB.roleFor("home")];
    expect(roles.sort()).toEqual(["build", "wait"]);
    const builder = (await annOnA.roleFor("home")) === "build" ? annOnA : boOnB;
    const other = builder === annOnA ? boOnB : annOnA;
    buildBoard(builder.ydoc, "home", coffee("boards/home.html"));
    for (let i = 0; i < 60 && !built(other.ydoc, "home"); i++) await sleep(50);
    other.ydoc.transact(() => h1Of(other.ydoc).set(F.html, "Pinned edit"));
    for (let i = 0; i < 60 && String(h1Of(builder.ydoc).get(F.html)) !== "Pinned edit"; i++) await sleep(50);
    expect(String(h1Of(builder.ydoc).get(F.html))).toBe("Pinned edit");
    let saved = 0;
    for (let i = 0; i < 60 && saved === 0; i++) {
      const vs = await db.documentVersion.findMany({
        where: { documentId: id, number: { gt: 1 } },
        select: { id: true },
      });
      for (const v of vs) if ((await loadVersionFiles(db, v.id))["boards/home.html"]?.includes("Pinned edit")) saved++;
      if (saved === 0) await sleep(100);
    }
    expect(saved).toBe(1);
    annOnA.close();
    boOnB.close();
    await a.stop();
    await b.stop();
  }, 30_000);

  const redisUrl = process.env.WARDBY_TEST_REDIS_URL;
  it.skipIf(!redisUrl)(
    "Redis: pages on two replicas open an unbuilt board at once; exactly one builds",
    async () => {
      const a = await replica(redisUrl);
      const b = await replica(redisUrl);
      const id = await design();
      const annOnA = await client(ann, a.port, id);
      const boOnB = await client(bo, b.port, id);
      expect(annOnA.synced() && boOnB.synced()).toBe(true);
      annOnA.open("about");
      boOnB.open("about");
      const roles = [await annOnA.roleFor("about"), await boOnB.roleFor("about")];
      expect(roles.sort()).toEqual(["build", "wait"]);
      const builder = roles[0] === "build" ? annOnA : boOnB;
      const other = builder === annOnA ? boOnB : annOnA;
      buildBoard(builder.ydoc, "about", coffee("boards/about.html"));
      for (let i = 0; i < 60 && !built(other.ydoc, "about"); i++) await sleep(50);
      expect(built(other.ydoc, "about")).toBe(true);
      annOnA.close();
      boOnB.close();
      await a.stop();
      await b.stop();
    },
    30_000,
  );
});
