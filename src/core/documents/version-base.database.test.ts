/** DocumentVersion.baseNumber against real PostgreSQL. Skipped without DATABASE_URL. */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resolvePrincipal } from "../../mcp/auth/principal.js";
import { createPrismaClient } from "../db.js";
import { createDocument, publishVersion } from "./service.js";
import { restoreVersion } from "./versions.js";

describe.skipIf(!process.env.DATABASE_URL)("version base numbers (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const docs: string[] = [];
  afterAll(async () => {
    await db.document.deleteMany({ where: { id: { in: docs } } });
    await db.$disconnect();
  });

  it("stores the base a writer gave, and none for version 1 or a write without one", async () => {
    const owner = await resolvePrincipal(`base-${randomUUID()}`, db);
    const doc = await createDocument(db, cipher, { ownerId: owner.id, title: "Base", markdown: "# One\n" });
    docs.push(doc.id);
    await publishVersion(db, cipher, { documentId: doc.id, markdown: "# Two\n", via: "mcp", expectedNumber: 1 });
    await publishVersion(db, cipher, { documentId: doc.id, markdown: "# Three\n", via: "agent" });
    await restoreVersion(db, cipher, {
      documentId: doc.id,
      number: 1,
      baseNumber: 3,
      viewer: { kind: "principal", principalId: owner.id },
      via: "mcp",
    });
    const rows = await db.documentVersion.findMany({
      where: { documentId: doc.id },
      orderBy: { number: "asc" },
      select: { number: true, baseNumber: true },
    });
    expect(rows).toEqual([
      { number: 1, baseNumber: null },
      { number: 2, baseNumber: 1 },
      { number: 3, baseNumber: null },
      { number: 4, baseNumber: 3 },
    ]);
  });
});
