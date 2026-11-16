import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { RateLimitError, type RateLimiter } from "../../mcp/auth/self-hosted/rate-limit.js";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import {
  EXPORT_STALE_MS,
  EXPORT_TTL_MS,
  exportBytes,
  exportFile,
  exportStatus,
  MAX_EXPORT_BYTES,
  RENDERER_WAKE_TIMEOUT_MS,
  requestRenderedExport,
  runExport,
  sweepExports,
  type ExportDeps,
  type Renderer,
} from "./exports.js";
import { DEFAULT_RENDERER_TIMEOUT_MS } from "./renderer-client.js";
import { createDocument } from "./service.js";
import { createShareLink, registerGuest } from "./share-links.js";

const SECRET = "FAKE-EXPORT-SECRET-5c1e88";
/** A second fake value holding the characters an HTML serialiser escapes. */
const SPECIAL = 'Ex"p&o<r>t\\42zz';
const SPECIAL_HTML = "Ex&quot;p&amp;o&lt;r&gt;t\\42zz";

const read = (p: string) => readFileSync(new URL(`./boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffee = (): Record<string, string> => ({
  "manifest.json": read("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, read(`boards/${id}.html`)]),
  ),
});

describe("renderer wake timeout", () => {
  it("allows a cold node 5 minutes, and the wait plus one render stays inside the stale sweep", () => {
    expect(RENDERER_WAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(RENDERER_WAKE_TIMEOUT_MS + DEFAULT_RENDERER_TIMEOUT_MS).toBeLessThan(EXPORT_STALE_MS);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("exports (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const agent = `export-agent-${s}`;
  const secretNames = [`EXPORT_KEY_${s.slice(0, 8)}`, `EXPORT_SPECIAL_${s.slice(0, 8)}`];
  let owner: Principal;
  let reader: Principal;
  let ownerV: Viewer;
  let readerV: Viewer;
  let designId: string;
  let mdId: string;
  let sent: { html: string; width: number }[] = [];
  let paginated: (boolean | undefined)[] = [];
  const fake: Renderer = {
    png: async (i) => {
      sent.push({ html: i.html, width: i.width });
      return Buffer.from("PNG");
    },
    pdf: async (i) => {
      sent.push(...i.boards);
      paginated.push(i.paginate);
      return Buffer.from("PDF");
    },
  };
  const deps = (over: Partial<ExportDeps> = {}): ExportDeps => ({ db, renderer: fake, ...over });
  const allow: RateLimiter = { check: async () => {} };
  const full = (over: Partial<ExportDeps> = {}) => deps({ rateLimiter: allow, ...over });

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `export-owner-${s}` } });
    reader = await db.principal.create({ data: { subject: `export-reader-${s}` } });
    ownerV = { kind: "principal", principalId: owner.id };
    readerV = { kind: "principal", principalId: reader.id };
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(secretNames[0], SECRET, owner.id, cipher, db);
    await attachSecret(agent, secretNames[0], owner.id, db);
    await createSecret(secretNames[1], SPECIAL, owner.id, cipher, db);
    await attachSecret(agent, secretNames[1], owner.id, db);
    const files = coffee();
    files["boards/home.html"] = files["boards/home.html"].replace(
      "</body>",
      `<p>key ${SECRET}</p><p>sp ${SPECIAL_HTML}</p></body>`,
    );
    designId = (
      await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Coffee", files, agentId: agent })
    ).id;
    mdId = (
      await createDocument(db, cipher, {
        ownerId: owner.id,
        title: "Plan",
        markdown: `# Heading One\n\n<script>alert(1)</script>\n\n![x](https://evil.example/p.png)\n\nkey ${SECRET}\n`,
        agentId: agent,
      })
    ).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: designId,
        granteeKind: "principal",
        granteePrincipalId: reader.id,
        granteeKey: `principal:${reader.id}`,
        level: "comment",
      },
    });
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.agentSecret.deleteMany({ where: { agentId: agent } });
    await db.secret.deleteMany({ where: { name: { in: secretNames } } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: { in: [owner.id, reader.id] } } });
    await db.$disconnect();
  });

  const noSecrets = (text: string) => {
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SPECIAL);
    expect(text).not.toContain(SPECIAL_HTML);
  };
  const run = async (input: Parameters<typeof requestRenderedExport>[1], d = full()) => {
    const { exportId } = await requestRenderedExport(d, input);
    await runExport(d, exportId);
    return exportId;
  };

  it("exports one board, or the whole prototype, without any secret value", async () => {
    const board = await exportFile(db, { documentId: designId, viewer: ownerV, format: "board-html", board: "menu" });
    expect(board).toMatchObject({ filename: "coffee-menu.html", mime: "text/html" });
    expect(board.body).toContain("<html");
    const home = await exportFile(db, { documentId: designId, viewer: ownerV, format: "board-html", board: "home" });
    noSecrets(home.body);
    const proto = await exportFile(db, { documentId: designId, viewer: readerV, format: "prototype" });
    expect(proto.filename).toBe("coffee-prototype.html");
    const json = /<script type="application\/json" id="boards">(.*?)<\/script>/s.exec(proto.body)![1];
    expect((JSON.parse(json) as unknown[]).length).toBe(4);
    noSecrets(proto.body);
    // Board links became fragment links; nothing links out.
    expect(proto.body).toContain("#board-menu");
    expect(proto.body).not.toContain("#board:");
    // Ruling T9-1 on the downloaded file: no allow-scripts beside allow-same-origin, and the CSP's
    // script-src is the switcher's hash alone (boards/export.test.ts checks the full policy).
    expect(proto.body).toContain('sandbox="allow-same-origin allow-top-navigation-by-user-activation"');
    expect(proto.body).not.toContain("allow-scripts");
    const csp = new JSDOM(proto.body).window.document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!;
    expect(csp).toMatch(/(?:^|; )script-src 'sha256-[A-Za-z0-9+/]+=*';/);
    await expect(
      exportFile(db, { documentId: designId, viewer: ownerV, format: "board-html", board: "nope" }),
    ).rejects.toThrow("export_not_found");
    await expect(
      exportFile(db, { documentId: designId, viewer: ownerV, format: "board-html", board: "menu", versionNumber: 9 }),
    ).rejects.toThrow("document_not_found");
  });

  it("refuses file formats on a Markdown document", async () => {
    for (const format of ["board-html", "prototype"] as const) {
      await expect(exportFile(db, { documentId: mdId, viewer: ownerV, format })).rejects.toThrow(
        "export_format_unsupported",
      );
    }
    await expect(requestRenderedExport(full(), { documentId: mdId, viewer: ownerV, format: "png" })).rejects.toThrow(
      "export_format_unsupported",
    );
    await expect(
      requestRenderedExport(full(), { documentId: designId, viewer: ownerV, format: "png" }),
    ).rejects.toThrow("export_format_unsupported");
  });

  it("renders a PNG job, only for its requester, and never for an anonymous reader", async () => {
    sent = [];
    const id = await run({ documentId: designId, viewer: ownerV, format: "png", board: "home" });
    expect(await exportStatus(db, { exportId: id, viewer: ownerV })).toMatchObject({
      status: "done",
      errorCode: null,
      format: "png",
    });
    const bytes = await exportBytes(db, { exportId: id, viewer: ownerV });
    expect(bytes.body.toString()).toBe("PNG");
    expect(bytes).toMatchObject({ mime: "image/png", filename: "coffee-home.png" });
    // The renderer got the board with no links and none of the secret values.
    expect(sent).toHaveLength(1);
    expect(sent[0].width).toBe(1280);
    expect(sent[0].html).not.toMatch(/href=/);
    noSecrets(sent[0].html);
    await expect(exportStatus(db, { exportId: id, viewer: readerV })).rejects.toThrow("export_not_found");
    await expect(exportBytes(db, { exportId: id, viewer: readerV })).rejects.toThrow("export_not_found");

    const link = await createShareLink(db, { documentId: designId, viewer: ownerV, permission: "comment" });
    const anon: Viewer = { kind: "guest", guestId: "", shareLinkId: link.id, permission: "comment" };
    await expect(
      requestRenderedExport(full(), { documentId: designId, viewer: anon, format: "png", board: "home" }),
    ).rejects.toThrow("export_sign_in_required");
    // A registered guest may ask, and is the only one to read the result.
    const { guestId } = await registerGuest(db, { shareLinkId: link.id, name: `Gus ${s.slice(0, 6)}` });
    const guest: Viewer = { kind: "guest", guestId, shareLinkId: link.id, permission: "comment" };
    const gid = await run({ documentId: designId, viewer: guest, format: "png", board: "menu" });
    expect((await exportBytes(db, { exportId: gid, viewer: guest })).body.toString()).toBe("PNG");
    await expect(exportStatus(db, { exportId: gid, viewer: anon })).rejects.toThrow("export_not_found");
    // Losing access ends the download.
    await db.documentShareLink.update({ where: { id: link.id }, data: { revokedAt: new Date() } });
    await expect(exportStatus(db, { exportId: gid, viewer: guest })).rejects.toThrow("export_not_found");
  });

  it("renders a PDF of all boards in manifest order, and a Markdown PDF", async () => {
    sent = [];
    paginated = [];
    const id = await run({ documentId: designId, viewer: ownerV, format: "pdf" });
    expect(sent).toHaveLength(4);
    // Designs: one page per board; Markdown: paginated (ruling T10-1).
    expect(paginated).toEqual([undefined]);
    sent.forEach((b) => noSecrets(b.html));
    expect(await exportBytes(db, { exportId: id, viewer: ownerV })).toMatchObject({
      mime: "application/pdf",
      filename: "coffee-boards.pdf",
    });

    sent = [];
    paginated = [];
    const md = await run({ documentId: mdId, viewer: ownerV, format: "pdf" });
    expect(sent).toHaveLength(1);
    expect(paginated).toEqual([true]);
    expect(sent[0].width).toBe(794);
    expect(sent[0].html).toContain("Heading One");
    expect(sent[0].html).not.toContain("<script");
    expect(sent[0].html).not.toMatch(/https?:/);
    noSecrets(sent[0].html);
    expect(await exportBytes(db, { exportId: md, viewer: ownerV })).toMatchObject({
      mime: "application/pdf",
      filename: "plan.pdf",
    });
  });

  it("fails with a fixed code: no renderer, a throwing renderer, an oversized result", async () => {
    const codeOf = async (d: ExportDeps) => {
      const id = await run({ documentId: designId, viewer: ownerV, format: "png", board: "home" }, d);
      return exportStatus(db, { exportId: id, viewer: ownerV });
    };
    // No renderer: refused when asked (503), after access and format checks, before any row.
    const rows = await db.documentExport.count();
    await expect(
      requestRenderedExport(full({ renderer: null }), {
        documentId: designId,
        viewer: ownerV,
        format: "png",
        board: "home",
      }),
    ).rejects.toThrow("export_renderer_unavailable");
    await expect(
      requestRenderedExport(full({ renderer: null }), { documentId: designId, viewer: ownerV, format: "png" }),
    ).rejects.toThrow("export_format_unsupported");
    expect(await db.documentExport.count()).toBe(rows);
    const boom = { ...fake, png: async () => Promise.reject(new Error(`boom ${SECRET}`)) };
    expect(await codeOf(full({ renderer: boom }))).toMatchObject({ status: "failed", errorCode: "export_failed" });
    const big = { ...fake, png: async () => Buffer.alloc(MAX_EXPORT_BYTES + 1024 * 1024) };
    expect(await codeOf(full({ renderer: big }))).toMatchObject({ status: "failed", errorCode: "export_too_large" });
    const coded = { ...fake, png: async () => Promise.reject(new Error("export_renderer_unavailable")) };
    expect((await codeOf(full({ renderer: coded }))).errorCode).toBe("export_renderer_unavailable");
  });

  it("wakes the renderer once with the export id; a failing wake means unavailable", async () => {
    const calls: string[] = [];
    const id = await run(
      { documentId: designId, viewer: ownerV, format: "png", board: "home" },
      full({ wake: async (e) => void calls.push(e) }),
    );
    expect(calls).toEqual([id]);
    const bad = await run(
      { documentId: designId, viewer: ownerV, format: "png", board: "home" },
      full({
        wake: async () => {
          throw new Error(`wake ${SECRET}`);
        },
      }),
    );
    expect(await exportStatus(db, { exportId: bad, viewer: ownerV })).toMatchObject({
      status: "failed",
      errorCode: "export_renderer_unavailable",
    });
  });

  it("does not resurrect a job that was swept or deleted while rendering", async () => {
    const d = full();
    const { exportId } = await requestRenderedExport(d, { documentId: designId, viewer: ownerV, format: "pdf" });
    const slow = {
      ...fake,
      pdf: async () => {
        await db.documentExport.delete({ where: { id: exportId } });
        return Buffer.from("PDF");
      },
    };
    await expect(runExport({ ...d, renderer: slow }, exportId)).resolves.toBeUndefined();
    expect(await db.documentExport.findUnique({ where: { id: exportId } })).toBeNull();
    const second = await requestRenderedExport(d, { documentId: designId, viewer: ownerV, format: "pdf" });
    const swept = {
      ...fake,
      pdf: async () => {
        await sweepExports(db, new Date(Date.now() + 2 * EXPORT_STALE_MS));
        return Buffer.from("PDF");
      },
    };
    await runExport({ ...d, renderer: swept }, second.exportId);
    expect(await exportStatus(db, { exportId: second.exportId, viewer: ownerV })).toMatchObject({
      status: "failed",
      errorCode: "export_failed",
    });
  });

  it("runs a job once", async () => {
    const d = full();
    const { exportId } = await requestRenderedExport(d, {
      documentId: designId,
      viewer: ownerV,
      format: "png",
      board: "home",
    });
    sent = [];
    await Promise.all([runExport(d, exportId), runExport(d, exportId)]);
    expect(sent).toHaveLength(1);
  });

  it("counts requests per document and refuses the one over the limit", async () => {
    const seen: [string, string, number][] = [];
    let hits = 0;
    const limiter: RateLimiter = {
      check: async (bucket, identity, limit) => {
        seen.push([bucket, identity, limit]);
        if (++hits > 2) throw new RateLimitError("Rate limited.");
      },
    };
    const input = { documentId: designId, viewer: ownerV, format: "pdf" as const };
    await requestRenderedExport(deps({ rateLimiter: limiter }), input);
    await requestRenderedExport(deps({ rateLimiter: limiter }), input);
    await expect(requestRenderedExport(deps({ rateLimiter: limiter }), input)).rejects.toThrow("export_rate_limited");
    expect(seen[0]).toEqual(["document-export", designId, 30]);
  });

  it("the default limiter allows 30 requests an hour and refuses the 31st", async () => {
    const doc = (
      await createDocument(db, cipher, { kind: "design", ownerId: owner.id, title: "Limit", files: coffee() })
    ).id;
    const input = { documentId: doc, viewer: ownerV, format: "pdf" as const };
    for (let i = 0; i < 30; i++) await requestRenderedExport(deps(), input);
    await expect(requestRenderedExport(deps(), input)).rejects.toThrow("export_rate_limited");
  });

  it("sweeps old rows and fails stuck jobs", async () => {
    const now = new Date();
    const mk = async (status: string, ageMs: number) => {
      const version = await db.document.findUniqueOrThrow({
        where: { id: designId },
        select: { currentVersionId: true },
      });
      return db.documentExport.create({
        data: {
          documentId: designId,
          versionId: version.currentVersionId!,
          format: "pdf",
          status,
          requestedById: owner.id,
          createdAt: new Date(now.getTime() - ageMs),
        },
      });
    };
    const old = await mk("done", EXPORT_TTL_MS + 60_000);
    const stuck = await mk("running", EXPORT_STALE_MS + 60_000);
    const fresh = await mk("running", 60_000);
    const out = await sweepExports(db, now);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(out.failed).toBeGreaterThanOrEqual(1);
    expect(await db.documentExport.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await db.documentExport.findUnique({ where: { id: stuck.id } })).toMatchObject({
      status: "failed",
      errorCode: "export_failed",
    });
    expect(await db.documentExport.findUnique({ where: { id: fresh.id } })).toMatchObject({ status: "running" });
    // Two hours on, the fresh and the failed rows are gone too.
    await sweepExports(db, new Date(now.getTime() + 2 * 3_600_000));
    expect(await db.documentExport.findUnique({ where: { id: stuck.id } })).toBeNull();
  });
});
