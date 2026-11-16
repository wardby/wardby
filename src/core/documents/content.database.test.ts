import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { contentHash, markdownOf } from "./content.js";

const db = createPrismaClient();
afterAll(() => db.$disconnect());

describe("version content", () => {
  it("markdownOf refuses a design version", () => {
    expect(markdownOf({ format: "markdown", markdown: "# A" })).toBe("# A");
    expect(() => markdownOf({ format: "boards-v1", markdown: null })).toThrow("document_format_mismatch");
  });

  it("hashes a design independent of key order and sensitive to content", () => {
    const a = contentHash({ format: "boards-v1", files: { "manifest.json": "{}", "boards/a.html": "x" } });
    const b = contentHash({ format: "boards-v1", files: { "boards/a.html": "x", "manifest.json": "{}" } });
    const c = contentHash({ format: "boards-v1", files: { "boards/a.html": "y", "manifest.json": "{}" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "deletes a design's versions, files and contents with the document",
    async () => {
      const owner = await db.principal.create({ data: { subject: `content-owner-${Date.now()}` } });
      const doc = await db.document.create({ data: { kind: "design", title: "T", ownerId: owner.id } });
      const v = await db.documentVersion.create({
        data: { documentId: doc.id, number: 1, format: "boards-v1", contentHash: "h", via: "mcp" },
      });
      await db.documentContent.create({ data: { documentId: doc.id, hash: "aa", text: "x", size: 1 } });
      await db.documentFile.create({
        data: { versionId: v.id, path: "manifest.json", documentId: doc.id, hash: "aa", mime: "application/json" },
      });
      await db.document.delete({ where: { id: doc.id } });
      expect(await db.documentFile.count({ where: { documentId: doc.id } })).toBe(0);
      expect(await db.documentContent.count({ where: { documentId: doc.id } })).toBe(0);
      await db.principal.delete({ where: { id: owner.id } });
    },
  );
});
