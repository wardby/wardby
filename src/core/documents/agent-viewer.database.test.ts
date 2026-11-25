import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { agentGranteeKey } from "../grants.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import { createThread, listThreads, reply, setThreadStatus, editComment, deleteComment } from "./comments.js";
import { requestRenderedExport } from "./exports.js";
import { listDocumentsForAgent } from "./list.js";
import { forceApprove, getReviewView, reopenDocument, reviewDocument, setArchived, submitForReview } from "./review.js";
import { createDocument } from "./service.js";

const SECRET = "sk-fake-625-secret";

describe.skipIf(!process.env.DATABASE_URL)("document services accept the agent viewer (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const [A, N] = [`agv-a-${s}`, `agv-n-${s}`];
  let o: Principal;
  let r: Principal;
  let d: string; // linked to A (write)
  let dRead: string; // granted to A at comment
  let dOther: string; // owner's, A has nothing
  let threadId: string;
  const anchor = { type: "text", quote: "hello", prefix: "", suffix: " world" };
  const agentViewer = (agentId = A, runId = "run-1"): Viewer => ({ kind: "agent", agentId, runId });
  const setting = { access: "write", reviewers: ["x"], finalApproverId: null, maxNewPerRun: 5, plans: [] };
  const owner = (): Viewer => ({ kind: "principal", principalId: o.id });

  beforeAll(async () => {
    o = await db.principal.create({ data: { subject: `agv-o-${s}` } });
    r = await db.principal.create({ data: { subject: `agv-r-${s}` } });
    const base = { systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: o.id };
    await db.agent.create({ data: { id: A, name: A, ...base, documentTools: setting } });
    await db.agent.create({ data: { id: N, name: N, ...base } });
    await createSecret(`AGV_KEY_${s.slice(0, 8)}`, SECRET, o.id, cipher, db);
    await attachSecret(A, `AGV_KEY_${s.slice(0, 8)}`, o.id, db);
    d = (await createDocument(db, cipher, { ownerId: o.id, title: "D", markdown: "hello world", agentId: A })).id;
    dRead = (await createDocument(db, cipher, { ownerId: o.id, title: "R", markdown: "hello world" })).id;
    dOther = (await createDocument(db, cipher, { ownerId: o.id, title: "O", markdown: "hello world" })).id;
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: dRead,
        granteeKind: "agent",
        granteeAgentId: A,
        granteeKey: agentGranteeKey(A),
        level: "comment",
      },
    });
    threadId = (await createThread(db, cipher, { documentId: d, viewer: owner(), anchor, body: "first" })).threadId;
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: o.id } });
    await db.agentSecret.deleteMany({ where: { agentId: A } });
    await db.agent.deleteMany({ where: { id: { in: [A, N] } } });
    await db.secret.deleteMany({ where: { name: `AGV_KEY_${s.slice(0, 8)}` } });
    await db.principal.deleteMany({ where: { id: { in: [o.id, r.id] } } });
    await db.$disconnect();
  });

  it("a reply stores the run, no author, the secret redacted, and shows as an agent", async () => {
    const res = await reply(db, cipher, {
      threadId,
      viewer: agentViewer(),
      body: `see ${SECRET}`,
    });
    const row = await db.comment.findUniqueOrThrow({ where: { id: res.commentId } });
    expect(row.runId).toBe("run-1");
    expect(row.authorId).toBeNull();
    expect(row.body).not.toContain(SECRET);
    expect(row.body).toContain("see ");
    const threads = await listThreads(db, { documentId: d, viewer: agentViewer(), filter: "all" });
    const mine = threads[0].comments.find((c) => c.id === res.commentId)!;
    expect(mine.author.kind).toBe("agent");
    expect(mine.mine).toBe(true);
    const others = await listThreads(db, { documentId: d, viewer: agentViewer(A, "run-2"), filter: "all" });
    expect(others[0].comments.find((c) => c.id === res.commentId)!.mine).toBe(false);
  });

  it("refuses to open a thread, and to edit or delete comments", async () => {
    await expect(createThread(db, cipher, { documentId: d, viewer: agentViewer(), anchor, body: "x" })).rejects.toThrow(
      "document_access_denied",
    );
    const c = await db.comment.findFirstOrThrow({ where: { threadId, runId: "run-1" } });
    await expect(editComment(db, cipher, { commentId: c.id, viewer: agentViewer(), body: "x" })).rejects.toThrow(
      "comment_edit_forbidden",
    );
    await expect(deleteComment(db, { commentId: c.id, viewer: agentViewer() })).rejects.toThrow(
      "comment_edit_forbidden",
    );
  });

  it("an agent without access sees not found, never a refusal", async () => {
    const v = agentViewer(N);
    await expect(createThread(db, cipher, { documentId: d, viewer: v, anchor, body: "x" })).rejects.toThrow(
      "document_not_found",
    );
    await expect(
      reviewDocument(db, cipher, { documentId: d, viewer: v, verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_not_found");
    await expect(forceApprove(db, cipher, { documentId: d, viewer: v, note: "n" })).rejects.toThrow(
      "document_not_found",
    );
    await expect(reopenDocument(db, cipher, { documentId: d, viewer: v })).rejects.toThrow("document_not_found");
    await expect(setArchived(db, { documentId: d, viewer: v, archived: true })).rejects.toThrow("document_not_found");
    await expect(submitForReview(db, { documentId: d, viewer: v, reviewers: [r.id] })).rejects.toThrow(
      "document_not_found",
    );
    await expect(getReviewView(db, d, v)).rejects.toThrow("document_not_found");
  });

  it("resolves a thread with write, never on a comment-only document", async () => {
    await setThreadStatus(db, { threadId, viewer: agentViewer(), status: "resolved" });
    const row = await db.commentThread.findUniqueOrThrow({ where: { id: threadId } });
    expect(row.status).toBe("resolved");
    expect(row.resolvedById).toBeNull();
    await setThreadStatus(db, { threadId, viewer: owner(), status: "open" });

    const t = await createThread(db, cipher, { documentId: dRead, viewer: owner(), anchor, body: "hi" });
    await expect(
      setThreadStatus(db, { threadId: t.threadId, viewer: agentViewer(), status: "resolved" }),
    ).rejects.toThrow("document_access_denied");
  });

  it("submits for review with write, recording the run and no principal", async () => {
    const view = await submitForReview(db, { documentId: d, viewer: agentViewer(), reviewers: [r.id] });
    expect(view.state).toBe("in_review");
    const ev = await db.documentReviewEvent.findFirstOrThrow({ where: { documentId: d, kind: "submitted" } });
    expect(ev.actorRunId).toBe("run-1");
    expect(ev.actorPrincipalId).toBeNull();
    const read = await getReviewView(db, d, agentViewer());
    expect(read.events[0].actorName).toBe("Agent");
  });

  it("submit with only comment access is denied", async () => {
    await expect(submitForReview(db, { documentId: dRead, viewer: agentViewer(), reviewers: [r.id] })).rejects.toThrow(
      "document_access_denied",
    );
  });

  it("refuses review, force approval, reopen, archive and export for an agent with access", async () => {
    const v = agentViewer();
    await expect(
      reviewDocument(db, cipher, { documentId: d, viewer: v, verdict: "approve", versionNumber: 1 }),
    ).rejects.toThrow("document_access_denied");
    await expect(forceApprove(db, cipher, { documentId: d, viewer: v, note: "n" })).rejects.toThrow(
      "document_access_denied",
    );
    await expect(reopenDocument(db, cipher, { documentId: d, viewer: v })).rejects.toThrow("document_access_denied");
    await expect(setArchived(db, { documentId: d, viewer: v, archived: true })).rejects.toThrow(
      "document_access_denied",
    );
    await expect(requestRenderedExport({ db } as never, { documentId: d, viewer: v, format: "pdf" })).rejects.toThrow(
      "document_access_denied",
    );
  });

  it("createDocument keeps the run and credits the owner", async () => {
    const made = await createDocument(db, cipher, {
      ownerId: o.id,
      agentId: A,
      runId: "run-x",
      via: "agent",
      title: "T",
      markdown: "x",
    });
    const v = await db.documentVersion.findUniqueOrThrow({ where: { id: made.versionId } });
    expect(v.runId).toBe("run-x");
    expect(v.createdById).toBe(o.id);
  });

  it("lists linked and granted documents with their access, not the owner's others", async () => {
    const { rows, truncated } = await listDocumentsForAgent(db, A, { limit: 50 });
    const byId = new Map(rows.map((x) => [x.id, x.access]));
    expect(byId.get(d)).toBe("write");
    expect(byId.get(dRead)).toBe("comment");
    expect(byId.has(dOther)).toBe(false);
    expect(truncated).toBe(false);
    expect((await listDocumentsForAgent(db, A, { limit: 1 })).truncated).toBe(true);
    expect((await listDocumentsForAgent(db, N, { limit: 50 })).rows).toEqual([]);
  });

  it("lists a plan document of a planner named in plans", async () => {
    const P = `agv-p-${s}`;
    await db.agent.create({
      data: { id: P, name: P, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: o.id, kind: "coding" },
    });
    await db.agent.update({ where: { id: A }, data: { documentTools: { ...setting, plans: [P] } } });
    const set = await db.planSet.create({
      data: { agentId: P, repository: `o/r-${s}`, number: 1, store: "wardby", createdByRunId: "run-x" },
    });
    const pd = await db.document.create({
      data: { title: "PD", ownerId: o.id, planSetId: set.id, planPath: "pd.md" },
    });
    const { rows } = await listDocumentsForAgent(db, A, { limit: 50 });
    expect(rows.find((x) => x.id === pd.id)?.access).toBe("comment");
    await db.agent.update({ where: { id: A }, data: { documentTools: setting } });
    await db.document.delete({ where: { id: pd.id } });
    await db.planSet.delete({ where: { id: set.id } });
    await db.agent.delete({ where: { id: P } });
  });
});
