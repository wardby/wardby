/**
 * Send-to-agent for a native writer against real PostgreSQL (#625, spec §3): the same send (checks,
 * limiter, sentRunId claim) starts a native run with trigger `comment` and a fixed task naming the
 * threads; when it ends Wardby publishes nothing and resolves nothing, and only answers the threads
 * the agent left unanswered. The executor is a fake. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "#prisma";
import type { Executor } from "../../providers/executor/types.js";
import type { RateLimiter } from "../../mcp/auth/self-hosted/rate-limit.js";
import { createPrismaClient } from "../db.js";
import { finishNativeRun, type NativeRunProviders } from "../runner.js";
import { attachSecret, createSecret } from "../secrets.js";
import type { Viewer } from "./access.js";
import {
  AGENT_NO_REPLY,
  AGENT_RUN_FAILED_REPLY,
  DOCUMENT_SWEEP_GRACE_MS,
  nativeSendTask,
  onDocumentRunFinished,
  sendThreadsToAgent,
  sweepUnansweredDocumentRuns,
} from "./agent-loop.js";
import { createThread } from "./comments.js";
import { createDocument } from "./service.js";

const SECRET = "s3cret-native-send-4242";
const anchor = (quote: string) => ({ type: "text", quote, prefix: "", suffix: "" });

describe.skipIf(!process.env.DATABASE_URL)("send threads to a native writer (database)", { timeout: 30_000 }, () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  const executor: Executor = { start: vi.fn(async () => {}), async stop() {} };
  const allow: RateLimiter = { check: async () => {} };
  const deps = { executor, cipher, rateLimiter: allow };
  let agentOwner: Principal;
  let docOwner: Principal;
  let writer: Principal;
  let agentId: string;
  const asWriter = (): Viewer => ({ kind: "principal", principalId: writer.id });
  const writeSetting = () => ({ access: "write", reviewers: [agentOwner.id] });

  beforeAll(async () => {
    agentOwner = await db.principal.create({ data: { subject: `nl-aowner-${s}` } });
    docOwner = await db.principal.create({ data: { subject: `nl-downer-${s}` } });
    writer = await db.principal.create({ data: { subject: `nl-writer-${s}` } });
    agentId = (
      await db.agent.create({
        data: {
          name: `nl-native-${s}`,
          systemPrompt: "Edit documents.",
          model: "claude-haiku-4-5",
          budgetUsd: 1,
          ownerId: agentOwner.id,
          documentTools: writeSetting(),
        },
      })
    ).id;
    await grantExecute();
    await createSecret(`NL_KEY_${s.slice(0, 8)}`, SECRET, agentOwner.id, cipher, db);
    await attachSecret(agentId, `NL_KEY_${s.slice(0, 8)}`, agentOwner.id, db);
  });

  /** The document's owner may execute the agent (the writer link's rule). */
  const grantExecute = () =>
    db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agentId,
        granteeKind: "principal",
        granteePrincipalId: docOwner.id,
        granteeKey: `principal:${docOwner.id}`,
        level: "execute",
      },
    });

  beforeEach(async () => {
    await db.agent.update({ where: { id: agentId }, data: { documentTools: writeSetting() } });
  });

  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: docOwner.id } });
    await db.runModelUsage.deleteMany({ where: { run: { agentId } } });
    await db.run.deleteMany({ where: { agentId } });
    await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: agentId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { ownerId: agentOwner.id } });
    await db.agent.delete({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: { in: [agentOwner.id, docOwner.id, writer.id] } } });
    await db.$disconnect();
  });

  async function writerDoc() {
    const doc = await createDocument(db, cipher, {
      ownerId: docOwner.id,
      title: "Notes",
      markdown: "hello world\n\nsecond para",
      agentId,
    });
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: doc.id,
        granteeKind: "principal",
        granteePrincipalId: writer.id,
        granteeKey: `principal:${writer.id}`,
        level: "write",
      },
    });
    return doc.id;
  }

  const thread = (documentId: string, quote: string, body: string) =>
    createThread(db, cipher, { documentId, viewer: asWriter(), anchor: anchor(quote), body });

  async function sendTwo() {
    const docId = await writerDoc();
    const t1 = await thread(docId, "hello", `Warmer please, key ${SECRET}`);
    const t2 = await thread(docId, "second", "Shorter please");
    const ids = [t1.threadId, t2.threadId];
    const { runId } = await sendThreadsToAgent(db, deps, { documentId: docId, viewer: asWriter(), threadIds: ids });
    return { docId, ids, runId };
  }

  /** Each thread's comments after the first (the person's), oldest first. */
  async function repliesOf(threadId: string) {
    const rows = await db.comment.findMany({ where: { threadId }, orderBy: { createdAt: "asc" } });
    return rows.slice(1).map((c) => ({ body: c.body, runId: c.runId }));
  }

  async function finish(runId: string, status: "succeeded" | "failed", finishedAt = new Date()) {
    await db.run.update({
      where: { id: runId },
      data: { status, finalText: status === "succeeded" ? "Done." : null, finishedAt },
    });
  }

  it("starts a native run with trigger comment and the fixed task; no comment text; threads marked sent", async () => {
    const { docId, ids, runId } = await sendTwo();
    const run = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
    expect(run.agentId).toBe(agentId);
    expect(run.trigger).toBe("comment");
    expect(run.triggeredById).toBe(writer.id);
    expect(run.codingRun).toBeNull();
    expect(run.taskOverride).toBe(nativeSendTask(docId, 1, ids));
    expect(run.taskOverride).not.toContain("Warmer");
    expect(run.taskOverride).not.toContain(SECRET);
    expect(nativeSendTask(docId, 1, ids)).toBe(
      [
        `Address the comment threads ${ids.join(", ")} on document ${docId} (version 1).`,
        "Read each thread with doc_get_thread and the document with doc_get.",
        "Publish one revision with doc_publish_version (baseNumber = the version you read), then reply to each thread with doc_reply_to_thread.",
        "If doc_publish_version reports document_version_conflict, read the document again and retry once; if it still fails, say so in your replies.",
      ].join("\n"),
    );
    for (const r of await db.commentThread.findMany({ where: { id: { in: ids } } })) {
      expect(r.sentRunId).toBe(runId);
      expect(r.sentById).toBe(writer.id);
      expect(r.sentVersionNumber).toBe(1);
      expect(r.answeredRunId).toBeNull();
    }
  });

  it("a succeeded run: only an unanswered thread gets the no-reply note; nothing resolved or published; the sweep adds nothing", async () => {
    const { docId, ids, runId } = await sendTwo();
    // The agent replied to thread 1 with doc_reply_to_thread (a comment of this run).
    await db.comment.create({ data: { threadId: ids[0], runId, viaId: writer.id, body: "Made it warmer." } });
    await finish(runId, "succeeded", new Date(Date.now() - DOCUMENT_SWEEP_GRACE_MS - 1_000));
    await onDocumentRunFinished(db, deps, runId);
    expect(await repliesOf(ids[0])).toEqual([{ body: "Made it warmer.", runId }]);
    expect(await repliesOf(ids[1])).toEqual([{ body: AGENT_NO_REPLY, runId }]);
    const rows = await db.commentThread.findMany({ where: { id: { in: ids } } });
    for (const r of rows) {
      expect(r.status).toBe("open");
      expect(r.answeredRunId).toBe(runId);
    }
    const doc = await db.document.findUniqueOrThrow({ where: { id: docId }, include: { currentVersion: true } });
    expect(doc.currentVersion?.number).toBe(1);

    await sweepUnansweredDocumentRuns({ db, cipher, executor, rateLimiter: allow, selfDefects: undefined });
    expect(await repliesOf(ids[0])).toHaveLength(1);
    expect(await repliesOf(ids[1])).toHaveLength(1);
  });

  it("a failed run: each thread gets the failure reply", async () => {
    const { ids, runId } = await sendTwo();
    await finish(runId, "failed");
    await onDocumentRunFinished(db, deps, runId);
    for (const id of ids) expect(await repliesOf(id)).toEqual([{ body: AGENT_RUN_FAILED_REPLY, runId }]);
  });

  it("answers when the native run finishes on the runner's path (finishNativeRun)", async () => {
    const { ids, runId } = await sendTwo();
    await db.run.update({ where: { id: runId }, data: { status: "running", startedAt: new Date() } });
    const providers = { executor, secrets: cipher } as unknown as NativeRunProviders;
    await finishNativeRun(
      {
        runId,
        db,
        providers,
        reviewHosts: undefined,
        repoAccess: undefined,
        issueTrackers: undefined,
      },
      "claude-haiku-4-5",
      { status: "succeeded", finalText: "Done.", turns: 1, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } },
    );
    for (const id of ids) expect(await repliesOf(id)).toEqual([{ body: AGENT_NO_REPLY, runId }]);
  });

  it("refuses a locked document before any run: document_locked", async () => {
    const docId = await writerDoc();
    const t = await thread(docId, "hello", "x");
    await db.document.update({ where: { id: docId }, data: { reviewState: "approved" } });
    const before = await db.run.count({ where: { agentId } });
    await expect(
      sendThreadsToAgent(db, deps, { documentId: docId, viewer: asWriter(), threadIds: [t.threadId] }),
    ).rejects.toThrow("document_locked");
    expect(await db.run.count({ where: { agentId } })).toBe(before);
  });

  it("refuses when the agent's setting is no longer write: document_agent_unavailable", async () => {
    const docId = await writerDoc();
    const t = await thread(docId, "hello", "x");
    await db.agent.update({
      where: { id: agentId },
      data: { documentTools: { access: "read", reviewers: [agentOwner.id] } },
    });
    await expect(
      sendThreadsToAgent(db, deps, { documentId: docId, viewer: asWriter(), threadIds: [t.threadId] }),
    ).rejects.toThrow("document_agent_unavailable");
  });

  it("refuses when the document's owner lost execute on the agent: document_agent_unavailable", async () => {
    const docId = await writerDoc();
    const t = await thread(docId, "hello", "x");
    await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: agentId } });
    try {
      await expect(
        sendThreadsToAgent(db, deps, { documentId: docId, viewer: asWriter(), threadIds: [t.threadId] }),
      ).rejects.toThrow("document_agent_unavailable");
    } finally {
      await grantExecute();
    }
  });

  it("refuses a second send while the first run is going: comment_thread_already_sent", async () => {
    const { docId, ids } = await sendTwo();
    await expect(
      sendThreadsToAgent(db, deps, { documentId: docId, viewer: asWriter(), threadIds: ids }),
    ).rejects.toThrow("comment_thread_already_sent");
  });
});
