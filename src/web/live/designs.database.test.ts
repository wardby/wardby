/**
 * Live editing of designs on the live server: the board list, one builder per board, checkpoints written by the
 * server from the live copies, secret values refused, and a version published meanwhile resetting the live copy
 * (until merges land). The builder is scripted here (the page builds with GrapesJS; the parity test holds the two
 * to the same rules).
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import WebSocket from "ws";
import * as Y from "yjs";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { normalizeDesign } from "../../core/documents/boards/format.js";
import { BOARD_ROOT, boardMaps, F } from "../../core/documents/boards/live/model.js";
import { writeBoardFile } from "../../core/documents/boards/live/writer.js";
import type { DocumentEvent, DocumentEventBus } from "../../core/documents/events.js";
import { loadVersionFiles } from "../../core/documents/files.js";
import { issueLiveTicket } from "../../core/documents/live/store.js";
import { createThread } from "../../core/documents/comments.js";
import { createDocument, publishVersion } from "../../core/documents/service.js";
import { attachSecret, createSecret } from "../../core/secrets.js";
import { createWebSession } from "../session.js";
import { createLiveServer, LIVE_META, type LiveServer } from "./server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { buildBoard, coffee, coffeeFiles } from "./design.test-support.js";

/** A live-copy field as text. */
const text = (v: unknown): string => (typeof v === "string" ? v : v instanceof Y.Text ? v.toJSON() : "");

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
  const open: { close(): void }[] = [];
  afterAll(async () => {
    // A failed test leaves its pages open: close them all before the server, or closing it waits on them.
    for (const c of open) c.close();
    await live.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.principal.deleteMany({ where: { id: { in: [ann.id, bo.id, cy.id] } } });
    await db.$disconnect();
  }, 30_000);

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

  async function client(p: Principal, documentId: string, opts: { ticket?: string } = {}) {
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
      token: () => JSON.stringify({ epoch: ydoc.getMap(LIVE_META).get("epoch"), ticket: opts.ticket }),
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
    const handle = {
      ydoc,
      synced: () => synced,
      failed: () => failed,
      closed: () => closed,
      stateless,
      open: (board: string) => provider.sendStateless(JSON.stringify({ type: "open-board", board })),
      roleFor,
      close: () => {
        provider.destroy();
        socket.destroy();
      },
    };
    open.push(handle);
    return handle;
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

  const h1Of = (d: Y.Doc) => [...boardMaps(d, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "h1")![1];

  it("an approved design is read-only for everyone, switched live, and never built while locked; reopening restores editing", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    const b = await client(bo, id);
    b.open("home");
    expect(await b.roleFor("home")).toBe("join");
    for (let i = 0; i < 40 && !boardMaps(b.ydoc, "home").nodes.has(BOARD_ROOT); i++) await sleep(50);
    await db.document.update({ where: { id }, data: { reviewState: "approved" } });
    emit({ documentId: id, kind: "review" });
    await sleep(300);
    a.ydoc.transact(() => h1Of(a.ydoc).set(F.html, "LOCKED-EDIT"));
    await sleep(400);
    expect(String(h1Of(b.ydoc).get(F.html))).not.toContain("LOCKED-EDIT");
    // A locked page is never told to build a board nobody has built.
    b.open("menu");
    expect(await b.roleFor("menu")).toBe("wait");
    await db.document.update({ where: { id }, data: { reviewState: "draft" } });
    emit({ documentId: id, kind: "review" });
    await sleep(300);
    // On another element than the refused one: a real page cannot edit while locked (its editor is locked), so
    // Ann's refused heading edit is a test artefact that would compete with Bo's on the same field.
    const pOf = (d: Y.Doc) => [...boardMaps(d, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "p")![1];
    b.ydoc.transact(() => pOf(b.ydoc).set(F.html, "REOPENED-EDIT"));
    for (let i = 0; i < 60 && !String(pOf(a.ydoc).get(F.html)).includes("REOPENED-EDIT"); i++) await sleep(50);
    expect(String(pOf(a.ydoc).get(F.html))).toContain("REOPENED-EDIT");
    a.close();
    b.close();
  });

  it("a member with only a share link joins with a single-use ticket, watches read-only and never builds", async () => {
    const id = await design(ann);
    const without = await client(cy, id);
    expect(without.synced()).toBe(false);
    without.close();
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    const ticket = await issueLiveTicket(db, { documentId: id, principalId: cy.id, readOnly: true });
    const c = await client(cy, id, { ticket });
    expect(c.synced()).toBe(true);
    for (let i = 0; i < 40 && !boardMaps(c.ydoc, "home").nodes.has(BOARD_ROOT); i++) await sleep(50);
    c.ydoc.transact(() => h1Of(c.ydoc).set(F.html, "CY-EDIT"));
    await sleep(400);
    expect(String(h1Of(a.ydoc).get(F.html))).not.toContain("CY-EDIT");
    c.open("about");
    expect(await c.roleFor("about")).toBe("wait");
    c.close();
    a.close();
  });

  /** The latest version's files once `test` holds for them (checkpoints are timed). */
  async function savedWhen(id: string, test: (files: Record<string, string>) => boolean) {
    for (let i = 0; i < 100; i++) {
      const latest = await db.document.findUniqueOrThrow({ where: { id }, select: { currentVersionId: true } });
      const files = await loadVersionFiles(db, latest.currentVersionId!);
      if (test(files)) return files;
      await sleep(100);
    }
    throw new Error("never saved");
  }

  /** Publishes as an agent does: from the latest version (retrying when a checkpoint lands in between). */
  async function publishAsAgent(id: string, change: (files: Record<string, string>) => void): Promise<number> {
    for (let tries = 0; ; tries++) {
      const latest = await db.document.findUniqueOrThrow({
        where: { id },
        select: { currentVersion: { select: { id: true, number: true } } },
      });
      const files = await loadVersionFiles(db, latest.currentVersion!.id);
      change(files);
      try {
        const v = await publishVersion(db, cipher, {
          documentId: id,
          files,
          via: "agent",
          expectedNumber: latest.currentVersion!.number,
        });
        emit({ kind: "version", documentId: id });
        return v.number;
      } catch (err) {
        if (tries >= 5 || (err as Error).message !== "document_version_conflict") throw err;
      }
    }
  }

  it("an agent's version is merged into the live design: its changes arrive, people's edits made meanwhile stay", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    const b = await client(bo, id);
    for (let i = 0; i < 40 && !boardMaps(b.ydoc, "home").nodes.has(BOARD_ROOT); i++) await sleep(50);
    // A checkpoint saves the built board, so the agent reads a version written from the live copy.
    await savedWhen(id, (f) => f["boards/home.html"] !== normalizeDesign(coffeeFiles()).files["boards/home.html"]);
    // Bo edits the heading while the agent works on the hero paragraph and an unopened board.
    b.ydoc.transact(() => h1Of(b.ydoc).set(F.html, `${String(h1Of(b.ydoc).get(F.html))} BO-LIVE`));
    await sleep(300);
    await publishAsAgent(id, (files) => {
      files["boards/home.html"] = files["boards/home.html"].replace("small on purpose", "small, on purpose");
      files["boards/menu.html"] = files["boards/menu.html"].replace("</main>", "<p>AGENT-MENU</p></main>");
    });
    const heroP = (d: Y.Doc) =>
      [...boardMaps(d, "home").nodes.values()].find((n) => text(n.get(F.html)).includes("on purpose"));
    for (let i = 0; i < 60 && !text(heroP(a.ydoc)?.get(F.html)).includes("small, on purpose"); i++) await sleep(50);
    for (const c of [a, b]) {
      expect(c.closed()).toBe(false);
      expect(String(heroP(c.ydoc)?.get(F.html))).toContain("small, on purpose");
      expect(String(h1Of(c.ydoc).get(F.html))).toContain("BO-LIVE");
    }
    // The next checkpoint saves both: the agent's changes (the unopened board as it published it) and Bo's edit.
    const saved = await savedWhen(
      id,
      (f) => f["boards/home.html"].includes("BO-LIVE") && f["boards/home.html"].includes("small, on purpose"),
    );
    expect(saved["boards/home.html"]).toContain("small, on purpose");
    expect(saved["boards/home.html"]).toContain("BO-LIVE");
    expect(saved["boards/menu.html"]).toContain("AGENT-MENU");
    a.close();
    b.close();
  });

  it("a board added meanwhile stays when an agent's version changes the board list", async () => {
    const id = await design(ann);
    const a = await client(ann, id);
    // Ann adds a board in the page (the board list is live); the agent renames another one.
    a.ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries({ id: "events", name: "Events", file: "boards/events.html", width: 1280 }))
        m.set(k, v);
      a.ydoc.getArray<Y.Map<unknown>>("manifest").push([m]);
    });
    await sleep(300);
    await publishAsAgent(id, (files) => {
      const m = JSON.parse(files["manifest.json"]) as { boards: { id: string; name: string }[] };
      m.boards.find((x) => x.id === "menu")!.name = "Our menu";
      files["manifest.json"] = JSON.stringify(m);
    });
    const names = () =>
      a.ydoc
        .getArray<Y.Map<unknown>>("manifest")
        .toArray()
        .map((x) => String(x.get("name")));
    for (let i = 0; i < 60 && !names().includes("Our menu"); i++) await sleep(50);
    expect(names()).toContain("Our menu");
    expect(names()).toContain("Events");
    a.close();
  });

  it("a pin follows its element by live id through an agent's move, and is outdated when its element is deleted", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    await savedWhen(id, (f) => f["boards/home.html"] !== normalizeDesign(coffeeFiles()).files["boards/home.html"]);
    // Pins on the first card's heading and on the third section's heading, as the page makes them while live.
    const nodes = boardMaps(a.ydoc, "home").nodes;
    const h = (tag: string, words: string) =>
      [...nodes.entries()].find(([, n]) => n.get(F.tag) === tag && text(n.get(F.html)).includes(words))!;
    const [cardH3] = h("h3", "");
    const [nookH2] = h("h2", "This week");
    const pin = async (liveId: string, tag: string) =>
      (
        await createThread(db, cipher, {
          documentId: id,
          viewer: { kind: "principal", principalId: ann.id },
          anchor: { type: "element", board: "home", liveId, path: "body", tag, words: "", dx: 0.5, dy: 0.5 },
          body: "Look here",
        })
      ).threadId;
    const onCard = await pin(cardH3, "h3");
    const onNook = await pin(nookH2, "h2");
    // The agent moves the third section above the cards.
    await publishAsAgent(id, (files) => {
      const dom = new JSDOM(files["boards/home.html"]);
      const secs = dom.window.document.querySelectorAll("main > section");
      secs[1].before(secs[2]);
      files["boards/home.html"] = dom.serialize();
    });
    const anchorOf = async (t: string) =>
      (await db.commentThread.findUniqueOrThrow({ where: { id: t }, select: { anchor: true, status: true } })) as {
        anchor: { path: string; words: string; liveId?: string };
        status: string;
      };
    let nook = await anchorOf(onNook);
    for (let i = 0; i < 60 && !nook.anchor.words.startsWith("This week"); i++) {
      await sleep(100);
      nook = await anchorOf(onNook);
    }
    expect(nook.status).toBe("open");
    expect(nook.anchor.liveId).toBe(nookH2);
    expect(nook.anchor.words).toMatch(/^This week/);
    expect(nook.anchor.path).toContain("section:nth-of-type(2)");
    // Bo deletes the first card in the page: its pin is outdated at the next checkpoint.
    const b = await client(bo, id);
    for (let i = 0; i < 40 && !boardMaps(b.ydoc, "home").nodes.has(cardH3); i++) await sleep(50);
    const bn = boardMaps(b.ydoc, "home").nodes;
    const card = [...bn.entries()].find(([, n]) =>
      (n.get(F.children) as Y.Array<string> | undefined)?.toArray().includes(cardH3),
    )![0];
    const parent = [...bn.values()].find((n) =>
      (n.get(F.children) as Y.Array<string> | undefined)?.toArray().includes(card),
    )!;
    b.ydoc.transact(() => {
      const ch = parent.get(F.children) as Y.Array<string>;
      ch.delete(ch.toArray().indexOf(card), 1);
      bn.delete(card);
      bn.delete(cardH3);
    });
    let gone = await anchorOf(onCard);
    for (let i = 0; i < 80 && gone.status !== "outdated"; i++) {
      await sleep(100);
      gone = await anchorOf(onCard);
    }
    expect(gone.status).toBe("outdated");
    a.close();
    b.close();
  });

  it("two pages moving one element at the same moment leave it in one place, the same for both", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    const b = await client(bo, id);
    for (let i = 0; i < 40 && !boardMaps(b.ydoc, "home").nodes.has(BOARD_ROOT); i++) await sleep(50);
    const parentsOf = (d: Y.Doc, x: string) =>
      [...boardMaps(d, "home").nodes.entries()].flatMap(([pid, n]) =>
        ((n.get(F.children) as Y.Array<string> | undefined)?.toArray() ?? []).filter((c) => c === x).map(() => pid),
      );
    const [h1] = [...boardMaps(a.ydoc, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "h1")!;
    const [from] = parentsOf(a.ydoc, h1);
    const move = (d: Y.Doc, to: string) =>
      d.transact(() => {
        const nodes = boardMaps(d, "home").nodes;
        const src = nodes.get(from)!.get(F.children) as Y.Array<string>;
        src.delete(src.toArray().indexOf(h1), 1);
        (nodes.get(to)!.get(F.children) as Y.Array<string>).push([h1]);
      });
    // Both move the heading in the same tick, before either hears of the other's move.
    const footer = [...boardMaps(a.ydoc, "home").nodes.entries()].find(([, n]) => n.get(F.tag) === "footer")![0];
    move(a.ydoc, BOARD_ROOT);
    move(b.ydoc, footer);
    await sleep(800);
    const pa = parentsOf(a.ydoc, h1);
    expect(pa).toHaveLength(1);
    expect(parentsOf(b.ydoc, h1)).toEqual(pa);
    a.close();
    b.close();
  });

  it("an agent that read an older version publishes without a conflict: its change merges with everything since", async () => {
    const id = await design(ann, [bo]);
    const a = await client(ann, id);
    a.open("home");
    expect(await a.roleFor("home")).toBe("build");
    buildBoard(a.ydoc, "home", coffee("boards/home.html"));
    await savedWhen(id, (f) => f["boards/home.html"] !== normalizeDesign(coffeeFiles()).files["boards/home.html"]);
    // The agent reads this version and works on the hero paragraph and the menu board...
    const read = await db.document.findUniqueOrThrow({
      where: { id },
      select: { currentVersion: { select: { id: true, number: true } } },
    });
    const files = await loadVersionFiles(db, read.currentVersion!.id);
    // ...while Bo edits the heading and the server saves it as a newer version.
    a.ydoc.transact(() => h1Of(a.ydoc).set(F.html, `${text(h1Of(a.ydoc).get(F.html))} BO-MEANWHILE`));
    await savedWhen(id, (f) => f["boards/home.html"].includes("BO-MEANWHILE"));
    files["boards/home.html"] = files["boards/home.html"].replace("small on purpose", "small, on purpose");
    files["boards/menu.html"] = files["boards/menu.html"].replace("</main>", "<p>AGENT-OLD-BASE</p></main>");
    const v = await publishVersion(db, cipher, {
      documentId: id,
      files,
      via: "agent",
      expectedNumber: read.currentVersion!.number,
    });
    emit({ kind: "version", documentId: id });
    const saved = await loadVersionFiles(
      db,
      (
        await db.documentVersion.findUniqueOrThrow({
          where: { documentId_number: { documentId: id, number: v.number } },
        })
      ).id,
    );
    expect(saved["boards/home.html"]).toContain("small, on purpose");
    expect(saved["boards/home.html"]).toContain("BO-MEANWHILE");
    expect(saved["boards/menu.html"]).toContain("AGENT-OLD-BASE");
    const heroP = () =>
      [...boardMaps(a.ydoc, "home").nodes.values()].find((n) => text(n.get(F.html)).includes("on purpose"));
    for (let i = 0; i < 60 && !text(heroP()?.get(F.html)).includes("small, on purpose"); i++) await sleep(50);
    expect(text(heroP()?.get(F.html))).toContain("small, on purpose");
    expect(text(h1Of(a.ydoc).get(F.html))).toContain("BO-MEANWHILE");
    expect(a.closed()).toBe(false);
    a.close();
  });
});
