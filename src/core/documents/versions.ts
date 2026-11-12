/**
 * A document's version history: the list the page's Edits tray and
 * list_document_versions show, one version's Markdown, and restore.
 *
 * Output: list items carry no content — numbers, how and when, a display
 * name, the run id and the summary (redacted at write by publishVersion) and
 * the numbers of the comment threads the run answered. A version's Markdown
 * was redacted against the document agent's secret values when it was
 * published (service.ts), so reading it back opens no new secret path.
 *
 * Restore publishes the chosen version's Markdown as a NEW version through
 * publishVersion (redaction, size limit, re-anchoring, events and the
 * version-conflict check), with the summary "Restored v<N>". Nothing is
 * rewritten in place.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { requireDocumentAccess, type Viewer } from "./access.js";
import { principalNames } from "./comments.js";
import { publishVersion, type PublishVia } from "./service.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];

export const DEFAULT_VERSIONS_PAGE = 50;
export const MAX_VERSIONS_PAGE = 200;

/** The summary a restore is stored with; the page and MCP recognise restores by it. */
export const restoredSummary = (number: number) => `Restored v${number}`;
export const RESTORED_SUMMARY = /^Restored v(\d+)$/;

/** First 16 hex characters of sha256(documentId:subject); a principal id never leaves the server. */
const authorKeyOf = (documentId: string, subject: string) =>
  createHash("sha256").update(`${documentId}:${subject}`).digest("hex").slice(0, 16);

const FORMER_MEMBER = "Former member";

export interface VersionListItem {
  number: number;
  via: string;
  createdAt: Date;
  /** member: the principal who saved it; agent: "Agent", via the person who sent the threads when known. */
  author: { kind: "member" | "agent"; name: string; viaName?: string };
  /**
   * Opaque per-document key of who made the version (the page groups saves by it, never by name):
   * a hash of the document and the saving principal. Absent when the author is unknown. Not a principal id.
   */
  authorKey?: string;
  runId?: string;
  summary?: string;
  /** Threads the version's run was sent or answered, by display number. */
  answeredThreads: number[];
}

export interface VersionList {
  versions: VersionListItem[];
  /** Pass as `before` for the next (older) page; absent on the last page. */
  nextBefore?: number;
}

export async function listVersions(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer; before?: number; limit?: number },
): Promise<VersionList> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "read");
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_VERSIONS_PAGE), MAX_VERSIONS_PAGE);
  const rows = await db.documentVersion.findMany({
    where: { documentId: input.documentId, ...(input.before !== undefined ? { number: { lt: input.before } } : {}) },
    orderBy: { number: "desc" },
    take: limit + 1,
    // Never the Markdown: list items carry no content.
    select: { number: true, via: true, createdAt: true, createdById: true, runId: true, summary: true },
  });
  const page = rows.slice(0, limit);
  const runIds = [...new Set(page.flatMap((v) => (v.runId ? [v.runId] : [])))];
  const threads = runIds.length
    ? await db.commentThread.findMany({
        where: {
          documentId: input.documentId,
          OR: [{ sentRunId: { in: runIds } }, { answeredRunId: { in: runIds } }],
        },
        orderBy: { number: "asc" },
        select: { number: true, sentRunId: true, answeredRunId: true, sentById: true },
      })
    : [];
  const byRun = new Map<string, { numbers: number[]; senders: string[] }>();
  for (const t of threads) {
    for (const run of new Set([t.sentRunId, t.answeredRunId])) {
      if (!run || !runIds.includes(run)) continue;
      const entry = byRun.get(run) ?? { numbers: [], senders: [] };
      entry.numbers.push(t.number);
      if (t.sentById && t.sentRunId === run) entry.senders.push(t.sentById);
      byRun.set(run, entry);
    }
  }
  const names = await principalNames(db, [
    ...page.flatMap((v) => (v.createdById ? [v.createdById] : [])),
    ...[...byRun.values()].flatMap((e) => e.senders),
  ]);
  const versions = page.map((v): VersionListItem => {
    const run = v.runId ? byRun.get(v.runId) : undefined;
    let author: VersionListItem["author"];
    if (v.via === "agent") {
      const sender = run?.senders[0] ?? v.createdById;
      author = { kind: "agent", name: "Agent", ...(sender ? { viaName: names.get(sender) ?? FORMER_MEMBER } : {}) };
    } else {
      author = { kind: "member", name: (v.createdById && names.get(v.createdById)) || FORMER_MEMBER };
    }
    return {
      number: v.number,
      via: v.via,
      createdAt: v.createdAt,
      author,
      ...(v.via === "editor" && v.createdById ? { authorKey: authorKeyOf(input.documentId, v.createdById) } : {}),
      ...(v.runId ? { runId: v.runId } : {}),
      ...(v.summary ? { summary: v.summary } : {}),
      answeredThreads: [...new Set(run?.numbers ?? [])],
    };
  });
  return {
    versions,
    ...(rows.length > limit && page.length > 0 ? { nextBefore: page[page.length - 1].number } : {}),
  };
}

/** One version's Markdown. */
export async function getVersion(
  db: PrismaClient,
  input: { documentId: string; viewer: Viewer; number: number },
): Promise<{ number: number; markdown: string; createdAt: Date }> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "read");
  const v = await db.documentVersion.findUnique({
    where: { documentId_number: { documentId: input.documentId, number: input.number } },
    select: { number: true, markdown: true, createdAt: true },
  });
  if (!v) throw new Error("document_version_not_found");
  return v;
}

/**
 * Publishes version `number`'s Markdown as the next version (needs write; a
 * member). `baseNumber` (the latest version the caller saw) is required:
 * document_version_conflict unless it is still the latest. Restoring the
 * version that is already the latest is refused (document_version_is_latest).
 */
export async function restoreVersion(
  db: PrismaClient,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; number: number; baseNumber: number; via: PublishVia },
): Promise<{ number: number; reanchored: { kept: number; outdated: number } }> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "write");
  if (input.viewer.kind !== "principal") throw new Error("document_access_denied");
  const v = await db.documentVersion.findUnique({
    where: { documentId_number: { documentId: input.documentId, number: input.number } },
    select: { markdown: true },
  });
  if (!v) throw new Error("document_version_not_found");
  const latest = await db.documentVersion.aggregate({
    where: { documentId: input.documentId },
    _max: { number: true },
  });
  if ((latest._max.number ?? 0) !== input.baseNumber) throw new Error("document_version_conflict");
  if (input.number === input.baseNumber) throw new Error("document_version_is_latest");
  const out = await publishVersion(db, cipher, {
    documentId: input.documentId,
    markdown: v.markdown,
    via: input.via,
    createdById: input.viewer.principalId,
    summary: restoredSummary(input.number),
    expectedNumber: input.baseNumber,
    allowRestoredSummary: true,
  });
  return { number: out.number, reanchored: out.reanchored };
}
