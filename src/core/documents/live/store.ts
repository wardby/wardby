/**
 * Where live documents are kept: the whole Yjs state per document (DocumentLiveState), the state of each version
 * for merging publishes (DocumentLiveVersionState), the lease naming the replica that leads a document, and
 * single-use share-link tickets. The live server is the only caller.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "#prisma";

type Db = Pick<
  PrismaClient,
  "documentLiveState" | "documentLiveVersionState" | "documentLiveTicket" | "$queryRaw" | "$executeRaw" | "$transaction"
>;

export interface StoredLive {
  epoch: string;
  state: Uint8Array;
}

const bytes = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b);

export async function loadLiveState(db: Db, documentId: string): Promise<StoredLive | null> {
  const row = await db.documentLiveState.findUnique({ where: { documentId }, select: { epoch: true, state: true } });
  return row ? { epoch: row.epoch, state: new Uint8Array(row.state) } : null;
}

/**
 * Creates a document's live state from a version, with that version's state, unless one exists already (another
 * replica got there first): either way the stored state is returned, so every caller continues from one history.
 */
export async function createLiveState(
  db: Db,
  input: { documentId: string; epoch: string; state: Uint8Array; versionNumber: number },
): Promise<StoredLive> {
  return db.$transaction(async (tx) => {
    const existing = await tx.documentLiveState.findUnique({
      where: { documentId: input.documentId },
      select: { epoch: true, state: true },
    });
    if (existing) return { epoch: existing.epoch, state: new Uint8Array(existing.state) };
    await tx.documentLiveState.create({
      data: { documentId: input.documentId, epoch: input.epoch, state: bytes(input.state) },
    });
    await tx.documentLiveVersionState.upsert({
      where: { documentId_versionNumber: { documentId: input.documentId, versionNumber: input.versionNumber } },
      create: { documentId: input.documentId, versionNumber: input.versionNumber, state: bytes(input.state) },
      update: {},
    });
    return { epoch: input.epoch, state: input.state };
  });
}

/** Saves the whole live state. Only for the history it was loaded with: a reset (new epoch) is never overwritten. */
export async function saveLiveState(
  db: Db,
  input: { documentId: string; epoch: string; state: Uint8Array },
): Promise<boolean> {
  const out = await db.documentLiveState.updateMany({
    where: { documentId: input.documentId, epoch: input.epoch },
    data: { state: bytes(input.state) },
  });
  return out.count === 1;
}

export async function putVersionState(
  db: Db,
  input: { documentId: string; versionNumber: number; state: Uint8Array },
): Promise<void> {
  await db.documentLiveVersionState.upsert({
    where: { documentId_versionNumber: { documentId: input.documentId, versionNumber: input.versionNumber } },
    create: { documentId: input.documentId, versionNumber: input.versionNumber, state: bytes(input.state) },
    update: { state: bytes(input.state) },
  });
}

export async function getVersionState(db: Db, documentId: string, versionNumber: number): Promise<Uint8Array | null> {
  const row = await db.documentLiveVersionState.findUnique({
    where: { documentId_versionNumber: { documentId, versionNumber } },
    select: { state: true },
  });
  return row ? new Uint8Array(row.state) : null;
}

/**
 * Takes or renews the lease for a document and returns the replica that holds it: `owner` when the lease was
 * free, expired or already `owner`'s, otherwise the current holder.
 */
export async function acquireLease(db: Db, documentId: string, owner: string, seconds: number): Promise<string> {
  const rows = await db.$queryRaw<{ owner: string }[]>`
    INSERT INTO "DocumentLiveLease" ("documentId", "owner", "expiresAt")
    VALUES (${documentId}, ${owner}, now() + make_interval(secs => ${seconds}))
    ON CONFLICT ("documentId") DO UPDATE SET "owner" = EXCLUDED."owner", "expiresAt" = EXCLUDED."expiresAt"
      WHERE "DocumentLiveLease"."expiresAt" < now() OR "DocumentLiveLease"."owner" = EXCLUDED."owner"
    RETURNING "owner"`;
  if (rows[0]) return rows[0].owner;
  const current = await db.$queryRaw<{ owner: string }[]>`
    SELECT "owner" FROM "DocumentLiveLease" WHERE "documentId" = ${documentId}`;
  return current[0]?.owner ?? owner;
}

export async function releaseLease(db: Db, documentId: string, owner: string): Promise<void> {
  await db.$executeRaw`DELETE FROM "DocumentLiveLease" WHERE "documentId" = ${documentId} AND "owner" = ${owner}`;
}

export const TICKET_SECONDS = 60;
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** A single-use ticket carrying `readOnly` for `principalId` on `documentId`; only its hash is stored. */
export async function issueLiveTicket(
  db: Db,
  input: { documentId: string; principalId: string; readOnly: boolean },
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.documentLiveTicket.create({
    data: {
      tokenHash: sha256(token),
      documentId: input.documentId,
      principalId: input.principalId,
      readOnly: input.readOnly,
      expiresAt: new Date(Date.now() + TICKET_SECONDS * 1000),
    },
  });
  return token;
}

/**
 * Uses a ticket: deleted whatever the outcome, and valid only for the same document and person before it
 * expires. Returns its read-only flag, or null when it is not valid.
 */
export async function redeemLiveTicket(
  db: Db,
  input: { token: string; documentId: string; principalId: string },
): Promise<{ readOnly: boolean } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) return null;
  const rows = await db.$queryRaw<{ documentId: string; principalId: string; readOnly: boolean; expiresAt: Date }[]>`
    DELETE FROM "DocumentLiveTicket" WHERE "tokenHash" = ${sha256(input.token)}
    RETURNING "documentId", "principalId", "readOnly", "expiresAt"`;
  const t = rows[0];
  if (!t || t.documentId !== input.documentId || t.principalId !== input.principalId) return null;
  if (t.expiresAt.getTime() < Date.now()) return null;
  return { readOnly: t.readOnly };
}
