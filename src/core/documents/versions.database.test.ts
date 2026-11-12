import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { attachSecret, createSecret } from "../secrets.js";
import { createDocument, getDocument, publishVersion } from "./service.js";
import { getVersion, listVersions, restoreVersion } from "./versions.js";
import type { Viewer } from "./access.js";

const SECRET = "fake-versions-secret-4711";

describe.skipIf(!process.env.DATABASE_URL)("document versions (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let sender: Principal;
  let stranger: Principal;
  const agent = `docver-agent-${s}`;
  const as = (p: Principal): Viewer => ({ kind: "principal", principalId: p.id });

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `docver-owner-${s}` } });
    sender = await db.principal.create({ data: { subject: `docver-sender-${s}` } });
    stranger = await db.principal.create({ data: { subject: `docver-stranger-${s}` } });
    await db.principalProfile.create({
      data: { principalId: owner.id, displayName: "Olive Owner", source: "operator" },
    });
    await db.principalProfile.create({
      data: { principalId: sender.id, displayName: "Sam Sender", source: "operator" },
    });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
    });
    await createSecret(`DOCVER_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agent, `DOCVER_${s.slice(0, 8)}`, owner.id, db);
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner.id } });
    await db.$disconnect();
  });

  it("lists versions newest first with names, runs and answered threads, and pages", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "one" });
    await publishVersion(db, cipher, { documentId: id, markdown: "two", via: "editor", createdById: owner.id });
    const doc = await getDocument(db, id);
    const runId = `run-${s}`;
    for (const number of [1, 2]) {
      await db.commentThread.create({
        data: {
          documentId: id,
          number,
          versionId: doc.version.id,
          anchor: { type: "text", quote: "two", prefix: "", suffix: "" },
          sentRunId: number === 1 ? runId : `other-${s}`,
          answeredRunId: number === 2 ? runId : null,
          sentById: number === 1 ? sender.id : null,
        },
      });
    }
    await publishVersion(db, cipher, { documentId: id, markdown: "three", via: "agent", runId, summary: "Agent edit" });

    const list = await listVersions(db, { documentId: id, viewer: as(owner) });
    expect(list.versions.map((v) => v.number)).toEqual([3, 2, 1]);
    expect(list.nextBefore).toBeUndefined();
    expect(list.versions[0]).toMatchObject({
      via: "agent",
      author: { kind: "agent", name: "Agent", viaName: "Sam Sender" },
      runId,
      summary: "Agent edit",
      answeredThreads: [1, 2],
    });
    expect(list.versions[1]).toMatchObject({ via: "editor", author: { kind: "member", name: "Olive Owner" } });
    expect(JSON.stringify(list)).not.toContain("three");
    expect(list.versions[1].authorKey).toMatch(/^[0-9a-f]{16}$/);
    expect(list.versions[0].authorKey).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain(owner.id);

    const first = await listVersions(db, { documentId: id, viewer: as(owner), limit: 2 });
    expect(first.versions.map((v) => v.number)).toEqual([3, 2]);
    expect(first.nextBefore).toBe(2);
    const rest = await listVersions(db, { documentId: id, viewer: as(owner), before: 2, limit: 2 });
    expect(rest.versions.map((v) => v.number)).toEqual([1]);
    expect(rest.nextBefore).toBeUndefined();

    expect((await getVersion(db, { documentId: id, viewer: as(owner), number: 1 })).markdown).toBe("one");
    await expect(getVersion(db, { documentId: id, viewer: as(owner), number: 9 })).rejects.toThrow(
      "document_version_not_found",
    );
    await expect(listVersions(db, { documentId: id, viewer: as(stranger) })).rejects.toThrow("document_not_found");
    await expect(getVersion(db, { documentId: id, viewer: as(stranger), number: 1 })).rejects.toThrow(
      "document_not_found",
    );
  });

  it("restores as a new version with the conflict check, re-anchoring and write access", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "alpha beta" });
    await publishVersion(db, cipher, { documentId: id, markdown: "gamma", via: "editor", createdById: owner.id });
    const doc = await getDocument(db, id);
    await db.commentThread.create({
      data: {
        documentId: id,
        number: 1,
        versionId: doc.version.id,
        anchor: { type: "text", quote: "gamma", prefix: "", suffix: "" },
      },
    });
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 1, baseNumber: 1, via: "editor" }),
    ).rejects.toThrow("document_version_conflict");
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: as(stranger), number: 1, baseNumber: 2, via: "editor" }),
    ).rejects.toThrow("document_not_found");
    const guest: Viewer = { kind: "guest", guestId: "g", shareLinkId: "nope", permission: "comment" };
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: guest, number: 1, baseNumber: 2, via: "editor" }),
    ).rejects.toThrow("document_not_found");
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 7, baseNumber: 2, via: "editor" }),
    ).rejects.toThrow("document_version_not_found");

    const out = await restoreVersion(db, cipher, {
      documentId: id,
      viewer: as(owner),
      number: 1,
      baseNumber: 2,
      via: "editor",
    });
    expect(out).toEqual({ number: 3, reanchored: { kept: 0, outdated: 1 } });
    const now = await getDocument(db, id);
    expect(now.version).toMatchObject({ number: 3, markdown: "alpha beta", via: "editor", summary: "Restored v1" });
    expect(now.version.createdById).toBe(owner.id);
    expect((await db.documentVersion.count({ where: { documentId: id } })) === 3).toBe(true);
  });

  it("gives each saving principal its own authorKey, even under the same display name", async () => {
    const twin = await db.principal.create({ data: { subject: `docver-twin-${s}` } });
    await db.principalProfile.create({
      data: { principalId: twin.id, displayName: "Olive Owner", source: "operator" },
    });
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "a" });
    await publishVersion(db, cipher, { documentId: id, markdown: "b", via: "editor", createdById: owner.id });
    await publishVersion(db, cipher, { documentId: id, markdown: "c", via: "editor", createdById: twin.id });
    await publishVersion(db, cipher, { documentId: id, markdown: "d", via: "editor", createdById: owner.id });
    const keys = (await listVersions(db, { documentId: id, viewer: as(owner) })).versions.map((v) => v.authorKey);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[3]).toBe(keys[0]);
    const other = await createDocument(db, cipher, { ownerId: owner.id, title: "T2", markdown: "a" });
    await publishVersion(db, cipher, { documentId: other.id, markdown: "b", via: "editor", createdById: owner.id });
    const otherKey = (await listVersions(db, { documentId: other.id, viewer: as(owner) })).versions[0].authorKey;
    expect(otherKey).not.toBe(keys[0]);
  });

  it("refuses restoring the latest version, and reserves the Restored summary", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: "one" });
    await publishVersion(db, cipher, { documentId: id, markdown: "two", via: "editor", createdById: owner.id });
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 2, baseNumber: 2, via: "editor" }),
    ).rejects.toThrow("document_version_is_latest");
    await expect(
      restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 1, baseNumber: 1, via: "editor" }),
    ).rejects.toThrow("document_version_conflict");
    for (const summary of ["Restored v1", "restored v12 by me", "  Restored v3"]) {
      await expect(
        publishVersion(db, cipher, { documentId: id, markdown: "x", via: "mcp", createdById: owner.id, summary }),
      ).rejects.toThrow("document_summary_invalid");
    }
    await publishVersion(db, cipher, { documentId: id, markdown: "x", via: "mcp", summary: "Reverted the intro" });
    expect((await db.documentVersion.count({ where: { documentId: id } })) === 3).toBe(true);
  });

  it("restores through publishVersion's redaction (a version stored before the agent link)", async () => {
    const { id } = await createDocument(db, cipher, { ownerId: owner.id, title: "T", markdown: `key ${SECRET} x` });
    await db.document.update({ where: { id }, data: { agentId: agent } });
    await publishVersion(db, cipher, { documentId: id, markdown: "later", via: "editor", createdById: owner.id });
    await restoreVersion(db, cipher, { documentId: id, viewer: as(owner), number: 1, baseNumber: 2, via: "mcp" });
    const now = await getDocument(db, id);
    expect(now.version.number).toBe(3);
    expect(now.version.markdown).not.toContain(SECRET);
    expect(now.version.via).toBe("mcp");
  });
});
