import { Prisma } from "#prisma";
import type { PrismaClient } from "#prisma";
import { atLeast } from "../grants.js";
import { preferIndexScans, withSerializableRetry } from "../serializable-retry.js";
import type { loadAgentSecretValues } from "../secret-guard.js";
import { documentAccess, requireDocumentAccess } from "./access.js";
import type { Viewer } from "./access.js";
import { parseTextAnchor } from "./anchors.js";
import type { TextAnchor } from "./anchors.js";
import { MAX_COMMENT_CHARS } from "./limits.js";
import { parseMentions } from "./mentions.js";
import { displayNameFor } from "./names.js";
import { profileNames } from "./profiles.js";
import { redactForDocumentAgent } from "./redact.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
export type CommentDb = PrismaClient;

export type ThreadFilter = "open" | "resolved" | "sent" | "mine" | "all";

export interface CommentView {
  id: string;
  author: { kind: "member" | "guest" | "agent"; name: string; viaName?: string };
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  mine: boolean;
}

export interface ThreadView {
  id: string;
  number: number;
  status: string;
  anchor: TextAnchor;
  sentAt: Date | null;
  comments: CommentView[];
}

const FORMER_MEMBER = "Former member";

function checkBody(body: string): void {
  if (body.length > MAX_COMMENT_CHARS) throw new Error("comment_too_long");
}

/** Display names for principals; ids that no longer exist are absent from the map. */
export async function principalNames(db: CommentDb, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const [principals, profile, hosts] = await Promise.all([
    db.principal.findMany({ where: { id: { in: unique } }, select: { id: true, subject: true } }),
    profileNames(db, unique),
    db.hostIdentity.findMany({
      where: { principalId: { in: unique }, provider: "github" },
      select: { principalId: true, login: true },
    }),
  ]);
  const login = new Map(hosts.map((h) => [h.principalId, h.login]));
  for (const p of principals) {
    out.set(p.id, displayNameFor({ profileName: profile.get(p.id), githubLogin: login.get(p.id), subject: p.subject }));
  }
  return out;
}

/** Deduped mentioned ids that cannot see the document. The body is not changed. */
async function mentionsWithoutAccess(db: CommentDb, documentId: string, body: string): Promise<string[]> {
  const missing: string[] = [];
  for (const id of new Set(parseMentions(body))) {
    const access = await documentAccess(db, documentId, { kind: "principal", principalId: id });
    if (access === "none") missing.push(id);
  }
  return missing;
}

function authorFields(viewer: Viewer): { authorId: string | null; guestId: string | null } {
  return viewer.kind === "principal"
    ? { authorId: viewer.principalId, guestId: null }
    : { authorId: null, guestId: viewer.guestId };
}

export async function createThread(
  db: CommentDb,
  cipher: Cipher,
  input: { documentId: string; viewer: Viewer; anchor: unknown; body: string },
): Promise<{ threadId: string; number: number; mentionsWithoutAccess: string[] }> {
  const doc = await requireDocumentAccess(db, input.documentId, input.viewer, "comment");
  const anchor = parseTextAnchor(input.anchor);
  checkBody(input.body);
  if (!doc.currentVersionId) throw new Error("document_not_found");
  const body = await redactForDocumentAgent(db, cipher, doc.agentId, input.body);
  const created = await withSerializableRetry(() =>
    db.$transaction(
      async (tx) => {
        await preferIndexScans(tx);
        const last = await tx.commentThread.aggregate({ where: { documentId: doc.id }, _max: { number: true } });
        const number = (last._max.number ?? 0) + 1;
        const thread = await tx.commentThread.create({
          data: { documentId: doc.id, number, versionId: doc.currentVersionId!, anchor },
        });
        await tx.comment.create({ data: { threadId: thread.id, body, ...authorFields(input.viewer) } });
        return { threadId: thread.id, number };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  return { ...created, mentionsWithoutAccess: await mentionsWithoutAccess(db, doc.id, input.body) };
}

export async function reply(
  db: CommentDb,
  cipher: Cipher,
  input: { threadId: string; viewer: Viewer; body: string },
): Promise<{ commentId: string; mentionsWithoutAccess: string[] }> {
  const thread = await db.commentThread.findUnique({ where: { id: input.threadId } });
  if (!thread) throw new Error("comment_not_found");
  const doc = await requireDocumentAccess(db, thread.documentId, input.viewer, "comment");
  checkBody(input.body);
  if (thread.status !== "open") throw new Error("comment_thread_closed");
  const body = await redactForDocumentAgent(db, cipher, doc.agentId, input.body);
  const c = await db.comment.create({ data: { threadId: thread.id, body, ...authorFields(input.viewer) } });
  return { commentId: c.id, mentionsWithoutAccess: await mentionsWithoutAccess(db, doc.id, input.body) };
}

export async function setThreadStatus(
  db: CommentDb,
  input: { threadId: string; viewer: Viewer; status: "open" | "resolved" },
): Promise<void> {
  const thread = await db.commentThread.findUnique({
    where: { id: input.threadId },
    include: { comments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1 } },
  });
  if (!thread) throw new Error("comment_not_found");
  await requireDocumentAccess(db, thread.documentId, input.viewer, "read");
  const first = thread.comments[0];
  const isAuthor =
    !!first &&
    (input.viewer.kind === "principal"
      ? first.authorId === input.viewer.principalId && first.runId === null
      : first.guestId === input.viewer.guestId);
  if (!isAuthor) {
    const access = await documentAccess(db, thread.documentId, input.viewer);
    if (!atLeast("document", access, "write")) throw new Error("document_access_denied");
  }
  await db.commentThread.update({
    where: { id: thread.id },
    data: {
      status: input.status,
      resolvedById: input.status === "resolved" && input.viewer.kind === "principal" ? input.viewer.principalId : null,
    },
  });
}

async function ownComment(db: CommentDb, commentId: string, viewer: Viewer) {
  const c = await db.comment.findUnique({ where: { id: commentId }, include: { thread: true } });
  if (!c || c.deletedAt) throw new Error("comment_not_found");
  const doc = await requireDocumentAccess(db, c.thread.documentId, viewer, "comment");
  const own =
    c.runId === null &&
    (viewer.kind === "principal" ? c.authorId === viewer.principalId : c.guestId === viewer.guestId);
  if (!own) throw new Error("comment_edit_forbidden");
  return { c, doc };
}

export async function editComment(
  db: CommentDb,
  cipher: Cipher,
  input: { commentId: string; viewer: Viewer; body: string },
): Promise<void> {
  checkBody(input.body);
  const { c, doc } = await ownComment(db, input.commentId, input.viewer);
  const body = await redactForDocumentAgent(db, cipher, doc.agentId, input.body);
  await db.comment.update({ where: { id: c.id }, data: { body, editedAt: new Date() } });
}

export async function deleteComment(db: CommentDb, input: { commentId: string; viewer: Viewer }): Promise<void> {
  const { c } = await ownComment(db, input.commentId, input.viewer);
  await db.comment.update({ where: { id: c.id }, data: { deletedAt: new Date() } });
}

export async function listThreads(
  db: CommentDb,
  input: { documentId: string; viewer: Viewer; filter: ThreadFilter },
): Promise<ThreadView[]> {
  await requireDocumentAccess(db, input.documentId, input.viewer, "read");
  const threads = await db.commentThread.findMany({
    where: {
      documentId: input.documentId,
      ...(input.filter === "open" || input.filter === "resolved" ? { status: input.filter } : {}),
      ...(input.filter === "sent" ? { sentAt: { not: null } } : {}),
    },
    orderBy: { number: "asc" },
    include: { comments: { where: { deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
  });
  const guestIds = new Set<string>();
  const principalIds: string[] = [];
  for (const t of threads) {
    for (const c of t.comments) {
      if (c.guestId) guestIds.add(c.guestId);
      if (c.runId) {
        if (c.viaId) principalIds.push(c.viaId);
      } else if (c.authorId) principalIds.push(c.authorId);
    }
  }
  const [names, guests] = await Promise.all([
    principalNames(db, principalIds),
    guestIds.size
      ? db.documentGuest.findMany({ where: { id: { in: [...guestIds] } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const guestName = new Map(guests.map((g) => [g.id, g.name]));
  const isMine = (c: { authorId: string | null; guestId: string | null; runId: string | null }) =>
    c.runId === null &&
    (input.viewer.kind === "principal" ? c.authorId === input.viewer.principalId : c.guestId === input.viewer.guestId);

  const views: ThreadView[] = threads.map((t) => ({
    id: t.id,
    number: t.number,
    status: t.status,
    anchor: parseTextAnchor(t.anchor),
    sentAt: t.sentAt,
    comments: t.comments.map((c): CommentView => {
      let author: CommentView["author"];
      if (c.runId) {
        author = { kind: "agent", name: "Agent" };
        if (c.viaId) author.viaName = names.get(c.viaId) ?? FORMER_MEMBER;
      } else if (c.guestId) {
        author = { kind: "guest", name: `${guestName.get(c.guestId) ?? "Guest"} (guest)` };
      } else {
        author = { kind: "member", name: (c.authorId && names.get(c.authorId)) || FORMER_MEMBER };
      }
      return { id: c.id, author, body: c.body, createdAt: c.createdAt, editedAt: c.editedAt, mine: isMine(c) };
    }),
  }));
  return input.filter === "mine" ? views.filter((t) => t.comments.some((c) => c.mine)) : views;
}

export async function mentionCandidates(
  db: CommentDb,
  documentId: string,
): Promise<{ principalId: string; name: string }[]> {
  const doc = await db.document.findUnique({ where: { id: documentId }, select: { ownerId: true } });
  if (!doc) throw new Error("document_not_found");
  const grants = await db.resourceGrant.findMany({
    where: { resourceType: "document", resourceId: documentId },
    select: { granteeKind: true, granteePrincipalId: true },
  });
  const ids = new Set<string>([doc.ownerId]);
  for (const g of grants) if (g.granteeKind === "principal" && g.granteePrincipalId) ids.add(g.granteePrincipalId);
  if (grants.some((g) => g.granteeKind === "everyone")) {
    for (const p of await db.principalProfile.findMany({ select: { principalId: true } })) ids.add(p.principalId);
  }
  const names = await principalNames(db, [...ids]);
  return [...ids].filter((id) => names.has(id)).map((principalId) => ({ principalId, name: names.get(principalId)! }));
}
