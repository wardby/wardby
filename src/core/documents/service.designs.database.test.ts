import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import { createThread, listThreads } from "./comments.js";
import { anchorForElement, type ElementLike } from "./element-anchors.js";
import { createDocument, getDocument, publishVersion } from "./service.js";
import { getVersion, restoreVersion } from "./versions.js";

const SECRET = "FAKE-DESIGN-SECRET-7f3a91";
/** The same fake value with one character written as an HTML entity: the raw text never contains it. */
const ENCODED_DASH = SECRET.replace("-", "&#45;");
const ENCODED_HEX = SECRET.replace("A", "&#x41;");
const read = (p: string) => readFileSync(new URL(`./boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffee = (): Record<string, string> => ({
  "manifest.json": read("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, read(`boards/${id}.html`)]),
  ),
});
const filesOf = (c: { format: string; files?: Record<string, string> }) =>
  c.format === "boards-v1" && c.files ? c.files : {};

describe.skipIf(!process.env.DATABASE_URL)("design service (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let viewer: Viewer;
  const agent = `design-agent-${s}`;

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `design-owner-${s}` } });
    viewer = { kind: "principal", principalId: owner.id };
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(`DESIGN_KEY_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agent, `DESIGN_KEY_${s.slice(0, 8)}`, owner.id, db);
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.$disconnect();
  });

  it("creates a design, stores normalised boards, and deduplicates unchanged files", async () => {
    const { id } = await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: "Coffee",
      files: coffee(),
      via: "mcp",
    });
    const { document, version, content } = await getDocument(db, id);
    expect(document.kind).toBe("design");
    expect(version.format).toBe("boards-v1");
    expect(version.markdown).toBeNull();
    expect(Object.keys(filesOf(content)).sort()).toEqual([
      "boards/about.html",
      "boards/home.html",
      "boards/menu.html",
      "boards/visit.html",
      "manifest.json",
    ]);
    const before = await db.documentContent.count({ where: { documentId: id } });
    expect(before).toBe(5);
    const v2 = await publishVersion(db, cipher, { documentId: id, files: coffee(), via: "mcp" });
    expect(v2.number).toBe(2);
    expect(await db.documentContent.count({ where: { documentId: id } })).toBe(before);
    expect(await db.documentFile.count({ where: { documentId: id } })).toBe(10);
  });

  it("redacts the agent's secret values in board files, including entity-encoded ones", async () => {
    const files = coffee();
    files["boards/home.html"] = files["boards/home.html"].replace(
      "</body>",
      `<p>key ${SECRET}</p><p>dash ${ENCODED_DASH}</p><p title="${ENCODED_HEX}">hex</p></body>`,
    );
    const manifest = JSON.parse(files["manifest.json"]);
    manifest.title = `Coffee ${SECRET.replace("-", "\\u002d")}`;
    files["manifest.json"] = JSON.stringify(manifest).replace("\\\\u002d", "\\u002d");
    const { id } = await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: `T ${SECRET}`,
      files,
      agentId: agent,
      via: "mcp",
    });
    const { document, content } = await getDocument(db, id);
    expect(document.title).not.toContain(SECRET);
    const stored = filesOf(content);
    const home = stored["boards/home.html"];
    expect(home).not.toContain(SECRET);
    expect(home).toContain("[REDACTED]");
    expect(home).toContain("dash [REDACTED]");
    expect(stored["manifest.json"]).not.toContain(SECRET);
    // Nothing anywhere in the stored rows holds the value in clear, decoded or not.
    const rows = await db.documentContent.findMany({ where: { documentId: id }, select: { text: true } });
    for (const r of rows) {
      const decoded = new JSDOM(r.text, { virtualConsole: new VirtualConsole() }).window.document.documentElement
        .innerHTML;
      expect(r.text).not.toContain(SECRET);
      expect(decoded).not.toContain(SECRET);
    }
  });

  it("refuses external references and Markdown for a design, files for a document; stores nothing", async () => {
    const files = coffee();
    files["boards/menu.html"] = files["boards/menu.html"].replace("</body>", '<img src="https://x.test/a.png"></body>');
    const count = await db.document.count({ where: { ownerId: owner.id } });
    await expect(createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", files })).rejects.toThrow(
      "board_format_invalid",
    );
    await expect(
      createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", markdown: "# x" }),
    ).rejects.toThrow("document_format_mismatch");
    await expect(
      createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", markdown: "# x", files: coffee() }),
    ).rejects.toThrow("document_format_mismatch");
    await expect(createDocument(db, cipher, { ownerId: owner.id, title: "T", files: coffee() })).rejects.toThrow(
      "document_format_mismatch",
    );
    await expect(createDocument(db, cipher, { kind: "sheet" as never, ownerId: owner.id, title: "T" })).rejects.toThrow(
      "document_kind_unsupported",
    );
    expect(await db.document.count({ where: { ownerId: owner.id } })).toBe(count);

    const { id } = await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", files: coffee() });
    await expect(publishVersion(db, cipher, { documentId: id, markdown: "# x", via: "mcp" })).rejects.toThrow(
      "document_format_mismatch",
    );
    await expect(
      publishVersion(db, cipher, { documentId: id, files: coffee(), via: "mcp", summary: "Restored v1" }),
    ).rejects.toThrow("document_summary_invalid");
    expect(await db.documentVersion.count({ where: { documentId: id } })).toBe(1);
  });

  it("re-anchors element threads on publish: kept when the element survives, outdated when its board goes", async () => {
    const { id } = await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", files: coffee() });
    const { content } = await getDocument(db, id);
    const dom = new JSDOM(filesOf(content)["boards/menu.html"], { virtualConsole: new VirtualConsole() });
    const body = dom.window.document.body as unknown as ElementLike;
    const h1 = dom.window.document.querySelector("h1") as unknown as ElementLike;
    const anchor = anchorForElement("menu", h1, 0.5, 0.5, body, new Set());
    await createThread(db, cipher, { documentId: id, viewer, anchor, body: "Bigger prices" });
    await expect(
      createThread(db, cipher, { documentId: id, viewer, anchor: { ...anchor, board: "nope" }, body: "x" }),
    ).rejects.toThrow("comment_anchor_invalid");
    await expect(
      createThread(db, cipher, {
        documentId: id,
        viewer,
        anchor: { type: "text", quote: "x", prefix: "", suffix: "" },
        body: "x",
      }),
    ).rejects.toThrow("comment_anchor_invalid");

    // Visible content changes on the same board: the pinned heading survives.
    const edited = coffee();
    const intro = "We keep the menu small so everything on it is good.";
    expect(edited["boards/menu.html"]).toContain(intro);
    edited["boards/menu.html"] = edited["boards/menu.html"].replace(intro, "A brand new introduction paragraph.");
    const v2 = await publishVersion(db, cipher, { documentId: id, files: edited, via: "mcp" });
    expect(v2.reanchored).toEqual({ kept: 1, outdated: 0 });
    const v2Menu = filesOf((await getDocument(db, id)).content)["boards/menu.html"];
    expect(v2Menu).toContain("A brand new introduction paragraph.");

    const manifest = JSON.parse(read("manifest.json"));
    manifest.boards = manifest.boards.filter((b: { id: string }) => b.id !== "menu");
    const without = coffee();
    delete without["boards/menu.html"];
    without["manifest.json"] = JSON.stringify(manifest);
    expect((await publishVersion(db, cipher, { documentId: id, files: without, via: "mcp" })).reanchored).toEqual({
      kept: 0,
      outdated: 1,
    });
    const [t] = await listThreads(db, { documentId: id, viewer, filter: "all" });
    expect(t.status).toBe("outdated");
    expect(t.anchor).toMatchObject({ type: "element", board: "menu", tag: "h1" });
  });

  it("redacts secret values in stored anchors for both kinds", async () => {
    const design = await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: "T",
      files: coffee(),
      agentId: agent,
    });
    const { content } = await getDocument(db, design.id);
    const dom = new JSDOM(filesOf(content)["boards/menu.html"], { virtualConsole: new VirtualConsole() });
    const h1 = dom.window.document.querySelector("h1") as unknown as ElementLike;
    const anchor = anchorForElement("menu", h1, 0.2, 0.3, dom.window.document.body);
    await createThread(db, cipher, {
      documentId: design.id,
      viewer,
      anchor: { ...anchor, words: `see ${SECRET}` },
      body: "x",
    });
    const doc = await createDocument(db, cipher, {
      ownerId: owner.id,
      title: "T",
      markdown: `alpha ${SECRET} omega`,
      agentId: agent,
    });
    await createThread(db, cipher, {
      documentId: doc.id,
      viewer,
      anchor: { type: "text", quote: `alpha ${SECRET}`, prefix: SECRET, suffix: ` ${SECRET}` },
      body: "x",
    });
    const stored = await db.commentThread.findMany({
      where: { documentId: { in: [design.id, doc.id] } },
      select: { anchor: true },
    });
    expect(stored).toHaveLength(2);
    for (const t of stored) {
      expect(JSON.stringify(t.anchor)).not.toContain(SECRET);
      expect(JSON.stringify(t.anchor)).toContain("[REDACTED]");
    }
  });

  it("reads and restores design versions with their files", async () => {
    const { id } = await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "T", files: coffee() });
    const edited = coffee();
    edited["boards/home.html"] = edited["boards/home.html"].replace("</body>", "<p>second version</p></body>");
    await publishVersion(db, cipher, { documentId: id, files: edited, via: "mcp" });
    const v1 = await getVersion(db, { documentId: id, viewer, number: 1 });
    expect(v1.content.format).toBe("boards-v1");
    expect(filesOf(v1.content)["boards/home.html"]).not.toContain("second version");
    expect(v1).not.toHaveProperty("markdown");
    const r = await restoreVersion(db, cipher, { documentId: id, viewer, number: 1, baseNumber: 2, via: "editor" });
    expect(r.number).toBe(3);
    const now = await getDocument(db, id);
    expect(now.version.summary).toBe("Restored v1");
    expect(now.version.contentHash).toBe(
      (await db.documentVersion.findUnique({ where: { documentId_number: { documentId: id, number: 1 } } }))!
        .contentHash,
    );
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer, number: 3, baseNumber: 3, via: "editor" }),
    ).rejects.toThrow("document_version_is_latest");
  });
});
