/** Live-state storage against real PostgreSQL. Skipped without DATABASE_URL. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { resolvePrincipal } from "../../../mcp/auth/principal.js";
import { createPrismaClient } from "../../db.js";
import { createDocument } from "../service.js";
import { liveDocToMarkdown, seedLiveDoc } from "./markdown.js";
import {
  acquireLease,
  createLiveState,
  getVersionState,
  issueLiveTicket,
  loadLiveState,
  putVersionState,
  redeemLiveTicket,
  releaseLease,
  saveLiveState,
} from "./store.js";

describe.skipIf(!process.env.DATABASE_URL)("live state storage (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  let documentId: string;
  let principalId: string;

  beforeAll(async () => {
    principalId = (await resolvePrincipal(`live-store-${randomUUID()}`, db)).id;
    documentId = (await createDocument(db, cipher, { ownerId: principalId, title: "Live", markdown: "# One\n" })).id;
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { id: documentId } });
    await db.$disconnect();
  });

  it("creates the live state once, keeps the first history, and saves only into that history", async () => {
    expect(await loadLiveState(db, documentId)).toBeNull();
    const seed = Y.encodeStateAsUpdate(seedLiveDoc("# One\n"));
    const first = await createLiveState(db, { documentId, epoch: "e1", state: seed, versionNumber: 1 });
    expect(first.epoch).toBe("e1");
    // A second replica racing to create it gets the first history back.
    const second = await createLiveState(db, {
      documentId,
      epoch: "e2",
      state: Y.encodeStateAsUpdate(seedLiveDoc("# Other\n")),
      versionNumber: 1,
    });
    expect(second.epoch).toBe("e1");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, second.state);
    expect(liveDocToMarkdown(doc)).toContain("# One");
    expect(await getVersionState(db, documentId, 1)).not.toBeNull();

    const edited = Y.encodeStateAsUpdate(seedLiveDoc("# One edited\n"));
    expect(await saveLiveState(db, { documentId, epoch: "e2", state: edited })).toBe(false);
    expect(await saveLiveState(db, { documentId, epoch: "e1", state: edited })).toBe(true);
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, (await loadLiveState(db, documentId))!.state);
    expect(liveDocToMarkdown(reloaded)).toContain("One edited");
  });

  it("keeps a state per version", async () => {
    const s2 = Y.encodeStateAsUpdate(seedLiveDoc("# Two\n"));
    await putVersionState(db, { documentId, versionNumber: 2, state: s2 });
    expect(Buffer.from((await getVersionState(db, documentId, 2))!)).toEqual(Buffer.from(s2));
    expect(await getVersionState(db, documentId, 9)).toBeNull();
  });

  it("gives the lease to one replica until it expires or is released", async () => {
    expect(await acquireLease(db, documentId, "10.0.0.1:3000", 30)).toBe("10.0.0.1:3000");
    expect(await acquireLease(db, documentId, "10.0.0.2:3000", 30)).toBe("10.0.0.1:3000");
    expect(await acquireLease(db, documentId, "10.0.0.1:3000", 30)).toBe("10.0.0.1:3000");
    await releaseLease(db, documentId, "10.0.0.2:3000"); // not the holder: no effect
    expect(await acquireLease(db, documentId, "10.0.0.2:3000", 30)).toBe("10.0.0.1:3000");
    await db.documentLiveLease.update({ where: { documentId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await acquireLease(db, documentId, "10.0.0.2:3000", 30)).toBe("10.0.0.2:3000");
    await releaseLease(db, documentId, "10.0.0.2:3000");
    expect(await acquireLease(db, documentId, "10.0.0.1:3000", 30)).toBe("10.0.0.1:3000");
  });

  it("redeems a ticket once, for the same document and person, before it expires", async () => {
    const other = (await resolvePrincipal(`live-store-other-${randomUUID()}`, db)).id;
    const t = await issueLiveTicket(db, { documentId, principalId, readOnly: true });
    expect(await redeemLiveTicket(db, { token: t, documentId, principalId: other })).toBeNull();
    const t2 = await issueLiveTicket(db, { documentId, principalId, readOnly: true });
    expect(await redeemLiveTicket(db, { token: t2, documentId, principalId })).toEqual({ readOnly: true });
    expect(await redeemLiveTicket(db, { token: t2, documentId, principalId })).toBeNull();
    const t3 = await issueLiveTicket(db, { documentId, principalId, readOnly: false });
    await db.documentLiveTicket.updateMany({ where: { documentId }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect(await redeemLiveTicket(db, { token: t3, documentId, principalId })).toBeNull();
    expect(await redeemLiveTicket(db, { token: "not a ticket", documentId, principalId })).toBeNull();
  });
});
