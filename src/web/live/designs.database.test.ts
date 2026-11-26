/**
 * Live editing of designs on the live server: the board list, one builder per board, checkpoints written by the
 * server from the live copies, secret values refused, and a version published meanwhile resetting the live copy
 * (until merges land). The builder is scripted here (the page builds with GrapesJS; the parity test holds the two
 * to the same rules).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { putNodes, nodesFromHtml } from "../../core/documents/boards/live/elements.js";
import { normalizeDesign } from "../../core/documents/boards/format.js";
import { BOARD_ROOT, boardMaps, F } from "../../core/documents/boards/live/model.js";
import { writeBoardFile } from "../../core/documents/boards/live/writer.js";
import type { DocumentEvent, DocumentEventBus } from "../../core/documents/events.js";
import { loadVersionFiles } from "../../core/documents/files.js";
import { createDocument, publishVersion } from "../../core/documents/service.js";
import { attachSecret, createSecret } from "../../core/secrets.js";
import { createWebSession } from "../session.js";
import { createLiveServer, LIVE_META, type LiveServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const coffee = (p: string) =>
  readFileSync(new URL(`../../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffeeFiles = (): Record<string, string> => ({
  "manifest.json": coffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, coffee(`boards/${id}.html`)]),
  ),
});

/** What a builder page does: the board's live copy from its file (GrapesJS in the page; Part 1's rules here). */
function buildBoard(ydoc: Y.Doc, board: string, file: string): void {
  const dom = new JSDOM(file).window.document;
  const baseCss = Array.from(dom.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  for (const s of Array.from(dom.querySelectorAll("style"))) s.remove();
  let n = 0;
  const parsed = nodesFromHtml(dom.body.innerHTML.replace(/\s+$/, ""), () => `ib${board}${++n}`);
  ydoc.transact(() => {
    const maps = boardMaps(ydoc, board);
    const root = new Y.Map<unknown>();
    maps.nodes.set(BOARD_ROOT, root);
    root.set(F.gid, "wrapper");
    const ch = new Y.Array<string>();
    ch.push(parsed.roots);
    root.set(F.children, ch);
    putNodes(maps, parsed);
    maps.meta.set("baseCss", baseCss);
    maps.meta.set("parts", JSON.stringify({ lang: dom.documentElement.lang || "en", title: dom.title, bodyAttrs: {} }));
  });
}

describe.skipIf(!process.env.DATABASE_URL)("live editing of designs (database)", () => {
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

  beforeAll(async () => {
    [ann, bo, cy] = await Promise.all(
      ["ann", "bo", "cy"].map((n) => db.principal.create({ data: { subject: `live-design-${n}-${s}` } })),
    );
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
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  });
  afterAll(async () => {
    await live.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.principal.deleteMany({ where: { id: { in: [ann.id, bo.id, cy.id] } } });
    await db.$disconnect();
  });

  async function design(owner: Principal, writers: Principal[] = [], agentId?: string): Promise<string> {
    const doc = await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: `Coffee ${s}`,
      files: coffeeFiles(),
      ...(agentId ? { agentId } : {}),
    });
    docs.push(doc.id);
    for (const w of writers) {
      await db.resourceGrant.create({
        data: {
          resourceType: "document",
          resourceId: doc.id,
          granteeKind: "principal",
          granteePrincipalId: w.id,
          granteeKey: `principal:${w.id}`,
          level: "write",
        },
      });
    }
    return doc.id;
  }

  async function client(p: Principal, documentId: string) {
    const cookie = (await createWebSession(db, { principalId: p.id }, { secure: false })).cookie.split(";")[0];
    class Socket extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    const ydoc = new Y.Doc();
    let synced = false;
    let failed = false;
    let closed = false;
    const stateless: string[] = [];
    const port = (http.address() as AddressInfo).port;
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
      onAuthenticationFailed: () => {
        failed = true;
      },
      onClose: () => {
        closed = true;
      },
      onStateless: ({ payload }) => {
        stateless.push(payload);
      },
    });
    provider.attach();
    for (let i = 0; i < 40 && !synced && !failed; i++) await sleep(50);
    const roleFor = async (board: string): Promise<string | null> => {
      for (let i = 0; i < 40; i++) {
        for (const m of stateless) {
          const x = JSON.parse(m) as { type?: string; board?: string; role?: string };
          if (x.type === "board" && x.board === board) return x.role ?? null;
        }
        await sleep(50);
      }
      return null;
    };
    return {
      ydoc,
      synced: () => synced,
      closed: () => closed,
      stateless,
      open: (board: string) => provider.sendStateless(JSON.stringify({ type: "open-board", board })),
      roleFor,
      close: () => {
        provider.destroy();
        socket.destroy();
      },
    };
  }

  it("a design goes live with its board list; nothing is built until a page opens a board", async () => {
    const id = await design(ann);
    const a = await client(ann, id);
    expect(a.synced()).toBe(true);
    const boards = a.ydoc
      .getArray<Y.Map<unknown>>("manifest")
      .toArray()
      .map((m) => m.get("id"));
    expect(boards).toEqual(["home", "menu", "about", "visit"]);
    expect(a.ydoc.getMap("boards").size).toBe(0);
    a.close();
  });

  it("one page builds a board; the others wait for it, and later pages join it", async () => {
    const id = await design(ann, [bo, cy]);
    const [a, b] = await Promise.all([client(ann, id), client(bo, id)]);
    a.open("home");
    b.open("home");
    const roles = [await a.roleFor("home"), await b.roleFor("home")];
    expect(roles.sort()).toEqual(["build", "wait"]);
    const builder = roles[0] === "build" ? a : b;
    const waiter = builder === a ? b : a;
    buildBoard(builder.ydoc, "home", coffee("boards/home.html"));
    const has = (d: Y.Doc) => {
      const b = d.getMap<unknown>("boards").get("home");
      const n = b instanceof Y.Map ? b.get("nodes") : undefined;
      return n instanceof Y.Map && n.has(BOARD_ROOT);
    };
    for (let i = 0; i < 60 && !has(waiter.ydoc); i++) await sleep(50);
    if (process.env.DEBUG_LIVE)
      console.log(
        "builder has",
        has(builder.ydoc),
        "waiter boards",
        JSON.stringify([...waiter.ydoc.getMap("boards").keys()]),
        "stateless",
        builder.stateless,
        waiter.stateless,
      );
    expect(has(waiter.ydoc)).toBe(true);
    const c = await client(cy, id);
    c.open("home");
    expect(await c.roleFor("home")).toBe("join");
    for (const x of [a, b, c]) x.close();
  });

  it("when the builder leaves before building, the next waiting page builds", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("menu");
    expect(await a.roleFor("menu")).toBe("build");
    const b = await client(bo, id);
    b.open("menu");
    expect(await b.roleFor("menu")).toBe("wait");
    b.stateless.length = 0;
    a.close();
    expect(await b.roleFor("menu")).toBe("build");
    b.close();
  });

  it("checkpoints save the whole file set: built boards from their live copy, the others as they were", async () => {
    const id = await design(ann);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    // An edit after the build: the heading's text box.
    const maps = boardMaps(a.ydoc, "home");
    const h1 = [...maps.nodes.entries()].find(([, n]) => n.get(F.tag) === "h1")!;
    a.ydoc.transact(() => h1[1].set(F.html, "Great coffee, a quiet corner."));
    // The first checkpoint may save the build alone; wait for the one with the edit.
    let v: { number: number; id: string } | null = null;
    for (let i = 0; i < 80; i++) {
      const latest = await db.documentVersion.findFirst({
        where: { documentId: id, number: { gt: 1 } },
        orderBy: { number: "desc" },
        select: { number: true, id: true },
      });
      if (
        latest &&
        (await loadVersionFiles(db, latest.id))["boards/home.html"]?.includes("Great coffee, a quiet corner.")
      ) {
        v = latest;
        break;
      }
      await sleep(100);
    }
    expect(v).not.toBeNull();
    const files = await loadVersionFiles(db, v!.id);
    expect(Object.keys(files).sort()).toEqual(Object.keys(coffeeFiles()).sort());
    // Saved in the board sanitizer's form, as every design file is.
    const mine = normalizeDesign({
      ...coffeeFiles(),
      "boards/home.html": writeBoardFile(boardMaps(a.ydoc, "home")),
    }).files;
    expect(files["boards/home.html"]).toBe(mine["boards/home.html"]);
    expect(files["boards/home.html"]).toContain("Great coffee, a quiet corner.");
    // Boards nobody opened are exactly what version 1 stored.
    const v1 = await db.documentVersion.findUniqueOrThrow({
      where: { documentId_number: { documentId: id, number: 1 } },
      select: { id: true },
    });
    const first = await loadVersionFiles(db, v1.id);
    for (const other of ["menu", "about", "visit"])
      expect(files[`boards/${other}.html`]).toBe(first[`boards/${other}.html`]);
    const row = await db.documentVersion.findUnique({ where: { id: v!.id }, select: { createdById: true } });
    expect(row?.createdById).toBe(ann.id);
    // With no further edit, no further version (the comparison is in the saved form).
    await sleep(1200);
    const after = await db.documentVersion.count({ where: { documentId: id, number: { gt: v!.number } } });
    expect(after).toBe(0);
    a.close();
  });

  it("an edit that would show the design agent's secret value is refused and never saved", async () => {
    const FAKE = `sk-fake-${randomUUID()}`;
    const agent = await db.agent.create({
      data: { name: `live-design-agent-${s}`, systemPrompt: "p", model: "m", budgetUsd: 1, ownerId: ann.id },
    });
    await createSecret(`live-design-secret-${s}`, FAKE, ann.id, cipher, db);
    await attachSecret(agent.id, `live-design-secret-${s}`, ann.id, db);
    const id = await design(ann, [], agent.id);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    await sleep(300);
    const h1 = [...boardMaps(a.ydoc, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "h1")!;
    a.ydoc.transact(() => h1[1].set(F.html, `the key is ${FAKE}`));
    for (let i = 0; i < 40 && !a.stateless.some((m) => m.includes("edit_refused")); i++) await sleep(50);
    expect(a.stateless.some((m) => m.includes("edit_refused") && m.includes("secret_value"))).toBe(true);
    const state = await db.documentLiveState.findUnique({ where: { documentId: id }, select: { state: true } });
    const stored = new Y.Doc();
    if (state) Y.applyUpdate(stored, state.state);
    expect(JSON.stringify(stored.getMap("boards").toJSON())).not.toContain(FAKE);
    a.close();
    await db.document.deleteMany({ where: { agentId: agent.id } });
    await db.agentSecret.deleteMany({ where: { agentId: agent.id } });
    await db.secret.deleteMany({ where: { name: `live-design-secret-${s}`, ownerId: ann.id } });
    await db.agent.delete({ where: { id: agent.id } });
  });

  it("a version published by someone else meanwhile starts the design's live copy again (until merges land)", async () => {
    const id = await design(ann);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    await sleep(400);
    const files = coffeeFiles();
    files["boards/menu.html"] = files["boards/menu.html"].replace("</main>", "<p>New</p></main>");
    const latest = await db.document.findUniqueOrThrow({
      where: { id },
      select: { currentVersion: { select: { number: true } } },
    });
    await publishVersion(db, cipher, {
      documentId: id,
      files,
      via: "agent",
      expectedNumber: latest.currentVersion!.number,
    });
    emit({ kind: "version", documentId: id });
    for (let i = 0; i < 40 && !a.closed(); i++) await sleep(50);
    expect(a.closed()).toBe(true);
    expect(await db.documentLiveState.findUnique({ where: { documentId: id } })).toBeNull();
    a.close();
  });
});
