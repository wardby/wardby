/**
 * Send-to-agent for repository-linked documents and designs (coding agents).
 *
 * A person with write access sends open comment threads to the document's
 * coding agent: one run per send, trigger `comment`. The document in Wardby is
 * the source of truth, not the repository: the run's task is fixed
 * instructions (trusted) plus, wrapped as untrusted context, the current
 * version (a document's whole Markdown; a design's files that differ from the
 * repository) and the threads' text (people wrote both). The agent writes that
 * content first, then applies the requested changes. What differs per kind is
 * the adapter in agent-formats.ts; everything below is shared.
 *
 * When the run ends, its threads are claimed once (answeredRunId), so the
 * completion hook and the reconciler's sweep never answer a run twice. Wardby
 * reads the linked file or design at the run's pushed commit and publishes it as the
 * next version only while the document is still at the version that was sent
 * (a newer edit is never overwritten); then it posts the agent's replies
 * (redacted with the agent's secret values) and resolves only the threads the
 * agent flagged.
 *
 * When the document moved on while the agent worked, three layers in order:
 * the edit merged with the newer version (merge.ts: file by file, then line by
 * line inside a file both changed) and the merge published; else one reconcile run as the original sender on the latest
 * version, every send check made again (at most one per send:
 * CommentThread.reconcileOfRunId); else the fixed conflict reply.
 *
 * An approved or archived document takes no edit: each thread gets the locked reply (lockedEditReply)
 * and no merge or reconcile is tried.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "#prisma";
import { byteLength, MAX_CODING_TASK_BYTES, publicCodingRunResult, truncateText } from "../../coding/protocol.js";
import { PostgresRateLimiter, RateLimitError, type RateLimiter } from "../../mcp/auth/self-hosted/rate-limit.js";
import type { Executor } from "../../providers/executor/types.js";
import { RepositoryChoiceRefusedError } from "../coding-repository.js";
import { dispatchRun, type DispatchRunOptions } from "../dispatch.js";
import { atLeast, effectiveAccess } from "../grants.js";
import { TERMINAL_RUN_STATUSES } from "../host-status.js";
import { logger } from "../logger.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { composeTaskOverride, MAX_UNTRUSTED_BODY_CHARS } from "../untrusted-content.js";
import { requireDocumentAccess, type Viewer } from "./access.js";
import {
  agentEditFormat,
  REPLIES_FENCE,
  THREADS_HEADING,
  type AgentEditFormat,
  type EarlierEditForm,
} from "./agent-formats.js";
import { assertAgentRepository, assertDocumentAgentOverride, validDocumentBaseRef } from "./agent-link.js";
import { authorLabel, listThreads, postAgentReply } from "./comments.js";
import { contentHash, type VersionContent } from "./content.js";
import { notifyDocumentChange } from "./events.js";
import { loadContent } from "./files.js";
import { mergeContent } from "./merge.js";
import { documentReviewState } from "./review.js";
import { isLocked, type LockedState } from "./review-state.js";
import { getDocument, publishVersion } from "./service.js";
import { withHtmlEscapedForms } from "./formats/boards.js";
import { formatFor, type DocumentFormat } from "./formats/index.js";

export { currentDocumentHeading, MAX_SEND_MARKDOWN_CHARS, REPLIES_FENCE } from "./agent-formats.js";

const log = logger.child({ module: "documents-agent-loop" });

type Cipher = Parameters<typeof loadAgentSecretValues>[1];

/** Sends per document per hour (the design's limit). */
export const MAX_SENDS_PER_DOCUMENT_HOUR = 30;
export const SEND_RATE_BUCKET = "document-send";
const SEND_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Threads one send may carry. */
export const MAX_THREADS_PER_SEND = 50;

export const AGENT_RUN_FAILED_REPLY = "The agent run failed; the document was not changed.";
export const AGENT_NO_REPLY = "The agent did not reply to this thread.";
/** The reply when the agent's edit was published but its summary had no reply for the thread (it stays open). */
export const AGENT_EDITED_NO_REPLY = "The agent edited the document but did not reply to this thread.";
/** Appended to the agent's reply when its edit could not be read or published (threads stay open). */
export const EDIT_NOT_APPLIED_NOTE = "(The edit could not be applied.)";
/** The reply when the document got a newer version after the send and neither a merge nor a reconcile run applied the edit. */
export function versionConflictReply(branch: string): string {
  return `The document changed after this was sent, so the agent's edit was not applied. It is on branch ${branch}.`;
}
/** The reply when the document was approved or archived while the agent worked: no merge or reconcile is tried. */
export function lockedEditReply(state: LockedState, branch: string): string {
  return `The document was ${state} while the agent worked, so its edit was not applied. It is on branch ${branch}.`;
}
/** The reply when the edit conflicted and is too large, even as a diff, to send back to the agent to re-apply. */
export function reconcileTooLargeReply(branch: string): string {
  return `The document changed after this was sent, and the agent's edit is too large to re-apply automatically, so it was not applied. It is on branch ${branch}.`;
}
/** The reply when a reconcile run ends without succeeding: the conflicted run's edit is still on its branch. */
export function reconcileFailedReply(branch: string): string {
  return `The agent run that re-applied the edit on the newer version failed, so the document was not changed. The earlier edit is on branch ${branch}.`;
}
/**
 * Room kept in the coding task for what dispatch adds around this request
 * (the standing-instructions heading) and for the threads' cut marker. A
 * services note that does not fit makes dispatch refuse the task, which is
 * answered as document_too_large_for_agent too.
 */
const TASK_RESERVE_BYTES = 512;
/** Fewer bytes than this left for the threads: the document is too large to send with them. */
const MIN_THREADS_BYTES = 512;
/** Runs the reconciler's sweep answers per pass. */
export const DOCUMENT_SWEEP_BATCH = 20;
/** How long after a run ends before the sweep answers it (the completion hook goes first). */
export const DOCUMENT_SWEEP_GRACE_MS = 60_000;

const TERMINAL = new Set<string>(TERMINAL_RUN_STATUSES);

/** What the reconciler's sweep needs to answer runs (sweepUnansweredDocumentRuns). */
export interface DocumentSweepDeps {
  db: PrismaClient;
  cipher: Cipher;
  /** A whole executor: answering a conflicted run can start its reconcile run. */
  executor: Executor;
  rateLimiter?: RateLimiter;
  /** Files a reconcile run's start failure as a self-defect, as a send does. Required, so every entry point wires it. */
  selfDefects: DispatchRunOptions["selfDefects"];
}

export interface DocumentAgentDeps {
  executor: Executor;
  cipher: Cipher;
  /** Counts sends per document; default: the Postgres limiter over one-hour windows. */
  rateLimiter?: RateLimiter;
  selfDefects?: DispatchRunOptions["selfDefects"];
}

/** Rate-limit keys: a domain-separated hash of bucket, document id and window (no secret involved). */
const sendRateKeyHasher = {
  hash: (value: string): string => createHash("sha256").update(`wardby/documents/send-rate/v1:${value}`).digest("hex"),
};

function defaultLimiter(db: PrismaClient): RateLimiter {
  return new PostgresRateLimiter(db, sendRateKeyHasher, SEND_RATE_WINDOW_MS);
}

/** The hashed per-document limiter over one-hour windows; exports count on it in their own bucket. */
export { defaultLimiter as documentHourlyLimiter };

const THREADS_CUT_MARKER = "\n\n[comment threads cut to fit the task]";

/** The sent threads as plain text, for the untrusted context. */
function threadsText(threads: Awaited<ReturnType<typeof listThreads>>, fmt: DocumentFormat): string {
  return threads
    .map((t) => {
      const lines = t.comments.map((c) => `- ${authorLabel(c.author)}: ${c.body}`);
      return [`Thread #${t.number} on ${fmt.anchorLabel(t.anchor)}:`, ...lines].join("\n");
    })
    .join("\n\n");
}

/**
 * The run's task: the adapter's instructions, then the untrusted context
 * holding the document part (whole: the current version, and for a reconcile
 * run the agent's earlier edit) and the threads (cut to the room left in the
 * coding task). A document that leaves too little room is refused.
 *
 * The task is stored in the run record (Run and CodingRun request), so every
 * part of it is redacted by exact value against the agent's current secret
 * values (`redact`) before it is measured and composed: a value that became an
 * agent secret after the version was published, or that a commenter wrote,
 * never reaches the record or the agent.
 */
function buildTask(
  instructions: string,
  documentText: string,
  kind: string,
  threads: Awaited<ReturnType<typeof listThreads>>,
  agentInstructions: string,
  redact: (text: string) => string,
): string {
  const task = redact(instructions);
  const documentPart = redact(`${documentText}\n\n${THREADS_HEADING}\n`);
  const used = byteLength(composeTaskOverride(task, documentPart)) + byteLength(agentInstructions.trim());
  const room = MAX_CODING_TASK_BYTES - TASK_RESERVE_BYTES - used;
  if (room < MIN_THREADS_BYTES) throw new Error("document_too_large_for_agent");
  const text = redact(threadsText(threads, formatFor(kind)));
  const byChars = text.length > MAX_UNTRUSTED_BODY_CHARS ? text.slice(0, MAX_UNTRUSTED_BODY_CHARS) : text;
  const fitted = truncateText(byChars, room, byteLength, THREADS_CUT_MARKER);
  const threadsPart =
    fitted === text ? text : fitted.endsWith(THREADS_CUT_MARKER) ? fitted : `${fitted}${THREADS_CUT_MARKER}`;
  return composeTaskOverride(task, `${documentPart}${threadsPart}`);
}

/** composeCodingTask's refusal (dispatch): the agent's own instructions plus this task do not fit. */
const CODING_TASK_LIMIT = /coding task limit/;

/** Threads among `rows` whose sent run is still going: they cannot be sent again until it ends. */
async function stillSent(
  db: Pick<PrismaClient, "run" | "commentThread">,
  rows: { sentRunId: string | null; answeredRunId: string | null }[],
): Promise<{ running: boolean; unanswered: string[] }> {
  const runIds = [
    ...new Set(rows.flatMap((r) => (r.sentRunId && r.answeredRunId !== r.sentRunId ? [r.sentRunId] : []))),
  ];
  if (runIds.length === 0) return { running: false, unanswered: [] };
  const runs = await db.run.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true } });
  // A run that no longer exists can never be answered: count it as answered so its threads can be sent again.
  for (const gone of runIds.filter((id) => !runs.some((r) => r.id === id))) {
    await db.commentThread.updateMany({
      where: { sentRunId: gone, answeredRunId: null },
      data: { answeredRunId: gone },
    });
  }
  const running = runs.some((r) => !TERMINAL.has(r.status));
  return { running, unanswered: runs.filter((r) => TERMINAL.has(r.status)).map((r) => r.id) };
}

/** A document whose agent link a sender may use now (sendableLink). */
type SendableLink = {
  doc: Awaited<ReturnType<typeof requireDocumentAccess>> & { repository: string; path: string; agentId: string };
  senderId: string;
  agent: { systemPrompt: string };
  ef: AgentEditFormat;
  path: string;
  baseRef: string | null;
};

/**
 * Everything a send checks before it reads the document, and a reconcile run re-checks as the
 * original sender: write access, a linked coding agent the document's owner still holds execute on
 * (and may give task text), the agent still authorised for the repository, and a safe stored link.
 */
async function sendableLink(db: PrismaClient, documentId: string, viewer: Viewer): Promise<SendableLink> {
  const doc = await requireDocumentAccess(db, documentId, viewer, "write");
  if (isLocked(doc.reviewState)) throw new Error("document_locked");
  if (viewer.kind !== "principal") throw new Error("document_access_denied");
  if (!doc.agentId || !doc.repository || !doc.path) throw new Error("document_not_agent_linked");
  const agent = await db.agent.findUnique({
    where: { id: doc.agentId },
    select: {
      id: true,
      kind: true,
      ownerId: true,
      systemPrompt: true,
      codingProfile: { select: { allowWebhookTaskOverride: true, repository: true, repositoryAuthorizedVia: true } },
      repositories: { select: { repository: true, authorizedVia: true } },
    },
  });
  if (agent?.kind !== "coding") throw new Error("document_not_agent_linked");
  // The owner linked the agent while holding execute on it and the right to give it task text (trigger_agent's
  // rule); the link is only good while they still hold both.
  if (!atLeast("agent", await effectiveAccess(db, "agent", agent, doc.ownerId), "execute")) {
    throw new Error("document_agent_unavailable");
  }
  assertDocumentAgentOverride(doc.ownerId, agent);
  // Ruling T6-1 at send time too: no repository is read, and no run started, for an agent that is no
  // longer authorized for the linked repository.
  try {
    assertAgentRepository(agent, doc.repository);
  } catch (err) {
    throw new Error("document_not_agent_linked", { cause: err });
  }
  const ef = agentEditFormat(doc.kind);
  const path = ef.validLinkPath(doc.path);
  const baseRef = doc.baseRef === null ? null : validDocumentBaseRef(doc.baseRef);
  return {
    doc: { ...doc, agentId: doc.agentId, repository: doc.repository, path: doc.path },
    senderId: viewer.principalId,
    agent,
    ef,
    path,
    baseRef,
  };
}

/**
 * The agent's current secret values with their JSON- and HTML-escaped forms (board bodies are
 * serialised HTML, the manifest JSON). A failed read refuses the send: the task is not built unchecked.
 */
async function taskSecretValues(db: PrismaClient, cipher: Cipher, agentId: string): Promise<string[]> {
  try {
    return withHtmlEscapedForms((await loadAgentSecretValues(db, cipher, agentId)).flatMap((e) => e.values));
  } catch (err) {
    throw new Error("document_send_failed", { cause: err });
  }
}

/**
 * Counts the send against the hourly limit, then starts the run (trigger `comment`, as the sender)
 * and marks the threads sent in the run's own transaction. A send marks open threads none of whose
 * runs is still going or to be answered; a reconcile (`reconcileOf`: the run whose conflicted edit it
 * re-applies) re-stamps the threads that run sent and was answered, open or outdated, only when none
 * is a reconcile already. Live pages are told.
 */
async function startDocumentRun(
  db: PrismaClient,
  deps: DocumentAgentDeps,
  input: { link: SendableLink; ids: string[]; versionNumber: number; task: string; reconcileOf: string | null },
): Promise<{ id: string; status: string }> {
  const { link, ids, versionNumber, reconcileOf } = input;
  const { doc, senderId } = link;
  // Counted last: a send refused for any other reason uses none of the hourly allowance.
  try {
    await (deps.rateLimiter ?? defaultLimiter(db)).check(SEND_RATE_BUCKET, doc.id, MAX_SENDS_PER_DOCUMENT_HOUR);
  } catch (err) {
    if (err instanceof RateLimitError) throw new Error("comment_send_rate_limited", { cause: err });
    throw err;
  }

  let dispatched: Awaited<ReturnType<typeof dispatchRun>>;
  try {
    dispatched = await dispatchRun({
      db,
      executor: deps.executor,
      selfDefects: deps.selfDefects,
      agentId: doc.agentId,
      trigger: "comment",
      triggeredById: senderId,
      codingTask: input.task,
      codingRepository: doc.repository,
      ...(link.baseRef ? { codingBaseRef: link.baseRef } : {}),
      // In the run's own transaction: the threads are marked sent only with the run.
      afterPersist: async (tx, run) => {
        let marked: { count: number };
        if (reconcileOf === null) {
          // Only while still open, and only when no earlier run of theirs is still going or still to be answered.
          const current = await tx.commentThread.findMany({
            where: { id: { in: ids }, documentId: doc.id },
            select: { status: true, sentRunId: true, answeredRunId: true },
          });
          if (current.some((r) => r.sentRunId !== null && r.answeredRunId !== r.sentRunId)) {
            throw new Error("comment_thread_already_sent");
          }
          marked = await tx.commentThread.updateMany({
            where: { id: { in: ids }, documentId: doc.id, status: "open" },
            data: {
              sentAt: new Date(),
              sentById: senderId,
              sentRunId: run.id,
              sentVersionNumber: versionNumber,
              answeredRunId: null,
              reconcileOfRunId: null,
            },
          });
        } else {
          // Only threads the conflicted run sent and this caller answered, still not closed, and not
          // already a reconcile's (one reconcile per send).
          marked = await tx.commentThread.updateMany({
            where: {
              id: { in: ids },
              documentId: doc.id,
              sentRunId: reconcileOf,
              answeredRunId: reconcileOf,
              reconcileOfRunId: null,
              status: { in: ["open", "outdated"] },
            },
            data: {
              sentRunId: run.id,
              sentVersionNumber: versionNumber,
              answeredRunId: null,
              reconcileOfRunId: reconcileOf,
            },
          });
        }
        if (marked.count !== ids.length) throw new Error("comment_thread_closed");
      },
    });
  } catch (err) {
    if (err instanceof RepositoryChoiceRefusedError) throw new Error("document_not_agent_linked", { cause: err });
    if (err instanceof Error && CODING_TASK_LIMIT.test(err.message)) {
      throw new Error("document_too_large_for_agent", { cause: err });
    }
    throw err;
  }
  if (!dispatched) throw new Error("document_send_failed");
  // The threads are marked sent (committed with the run).
  await notifyDocumentChange(db, doc.id, "thread");
  return dispatched.run;
}

export async function sendThreadsToAgent(
  db: PrismaClient,
  deps: DocumentAgentDeps,
  input: { documentId: string; viewer: Viewer; threadIds: string[] },
): Promise<{ runId: string; status: string }> {
  const link = await sendableLink(db, input.documentId, input.viewer);
  const { doc, ef, path, baseRef } = link;

  const ids = [...new Set(input.threadIds)];
  if (ids.length === 0 || ids.length > MAX_THREADS_PER_SEND) throw new Error("comment_not_found");
  const select = { id: true, status: true, sentRunId: true, answeredRunId: true } as const;
  let rows = await db.commentThread.findMany({ where: { id: { in: ids }, documentId: doc.id }, select });
  if (rows.length !== ids.length) throw new Error("comment_not_found");
  const previous = await stillSent(db, rows);
  if (previous.running) throw new Error("comment_thread_already_sent");
  if (previous.unanswered.length > 0) {
    // An earlier run ended but its answer is still due: give it now, so this send cannot replace it.
    for (const runId of previous.unanswered) await onDocumentRunFinished(db, deps, runId);
    rows = await db.commentThread.findMany({ where: { id: { in: ids }, documentId: doc.id }, select });
    // Answering it may have started a reconcile run for these threads.
    if ((await stillSent(db, rows)).running) throw new Error("comment_thread_already_sent");
  }
  if (rows.some((r) => r.status !== "open")) throw new Error("comment_thread_closed");

  const { version, content } = await getDocument(db, doc.id);

  const idSet = new Set(ids);
  const threads = (await listThreads(db, { documentId: doc.id, viewer: input.viewer, filter: "open" })).filter((t) =>
    idSet.has(t.id),
  );
  if (threads.length !== ids.length) throw new Error("comment_thread_closed");
  const context = await ef.sendContext(
    deps,
    { repository: doc.repository, path, baseRef },
    { number: version.number, content },
  );
  const secretValues = await taskSecretValues(db, deps.cipher, doc.agentId);
  const task = buildTask(
    ef.instructions(
      { path, baseRef },
      version.number,
      threads.map((t) => t.number),
      context,
    ),
    `${context.heading}\n${context.body}`,
    doc.kind,
    threads,
    link.agent.systemPrompt,
    (text) => redactExactSecretValues(text, secretValues),
  );

  const run = await startDocumentRun(db, deps, { link, ids, versionNumber: version.number, task, reconcileOf: null });
  // Refused or failed at dispatch: the run is already over, so the threads get their reply now.
  if (TERMINAL.has(run.status)) await onDocumentRunFinished(db, deps, run.id);
  return { runId: run.id, status: run.status };
}

/** The note posted on each thread when a reconcile run starts on version `n`. */
export function reconcilingReply(n: number): string {
  return `The document changed while the agent worked, so it is re-applying its edit on version ${n}.`;
}

/**
 * Layer 2 of a conflicted edit: one follow-up run, as the original sender, on the latest version,
 * holding the current content and the agent's earlier edit, for the threads still open or outdated
 * (a thread closed meanwhile is left out and gets no reply). Everything a send checks is checked
 * again. The earlier edit goes as the files the agent left, or as a diff of them when those do not
 * fit. A refusal of any kind (a second reconcile for the same send, no thread left open, a failed
 * check) answers "refused", and a task that does not fit even as a diff "too_large"; either starts
 * nothing. Once the run is dispatched the answer is "started" whatever follows: a note that cannot
 * be posted is only logged. Never throws. Exported for tests.
 */
export type ReconcileStart = "started" | "refused" | "too_large";

export async function startReconcileRun(
  db: PrismaClient,
  deps: DocumentAgentDeps,
  input: {
    runId: string;
    threads: ClaimedThread[];
    sentVersion: number;
    base: VersionContent;
    ours: VersionContent;
    secretValues: readonly string[];
  },
): Promise<ReconcileStart> {
  const { runId, threads } = input;
  const documentId = threads[0].documentId;
  let run: { id: string; status: string };
  let reconciled: ClaimedThread[];
  let senderId: string;
  let versionNumber: number;
  try {
    // One reconcile per send: these threads were sent by a reconcile run already.
    if (threads.some((t) => t.reconcileOfRunId !== null)) return "refused";
    const sender = threads[0].sentById;
    if (sender === null || threads.some((t) => t.sentById !== sender)) return "refused";
    senderId = sender;
    const viewer: Viewer = { kind: "principal", principalId: senderId };
    const link = await sendableLink(db, documentId, viewer);
    const { doc, ef, path, baseRef } = link;
    const { version, content } = await getDocument(db, documentId);
    versionNumber = version.number;
    const idSet = new Set(threads.map((t) => t.id));
    const views = (await listThreads(db, { documentId, viewer, filter: "all" })).filter(
      (t) => idSet.has(t.id) && (t.status === "open" || t.status === "outdated"),
    );
    if (views.length === 0) return "refused";
    const openIds = new Set(views.map((t) => t.id));
    reconciled = threads.filter((t) => openIds.has(t.id));
    const context = await ef.sendContext(
      deps,
      { repository: doc.repository, path, baseRef },
      { number: version.number, content },
    );
    const secretValues = await taskSecretValues(db, deps.cipher, doc.agentId);
    const taskWith = (form: EarlierEditForm) => {
      const earlier = ef.earlierEdit({ path }, input.base, input.ours, input.sentVersion, form);
      return buildTask(
        ef.reconcileInstructions(
          { path, baseRef },
          version.number,
          views.map((t) => t.number),
          context,
          earlier,
        ),
        `${context.heading}\n${context.body}\n\n${earlier.heading}\n${earlier.body}`,
        doc.kind,
        views,
        link.agent.systemPrompt,
        (text) => redactExactSecretValues(text, secretValues),
      );
    };
    // The files as the agent left them are clearest; a diff of them when they do not fit.
    let task: string;
    try {
      task = taskWith("files");
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "document_too_large_for_agent") throw err;
      task = taskWith("diff");
    }
    run = await startDocumentRun(db, deps, {
      link,
      ids: reconciled.map((t) => t.id),
      versionNumber: version.number,
      task,
      reconcileOf: runId,
    });
  } catch (err) {
    const code = codeOf(err);
    log.info({ runId, documentId, code }, "no reconcile run for the conflicted document edit");
    return code === "document_too_large_for_agent" ? "too_large" : "refused";
  }
  // Dispatched: the reconcile run owns these threads now, whatever happens below.
  // Said first, so people see why the threads are still going (the conflicted run's answer).
  for (const t of reconciled) {
    try {
      await postAgentReply(db, {
        threadId: t.id,
        runId,
        viaId: senderId,
        body: reconcilingReply(versionNumber),
        secretValues: input.secretValues,
      });
    } catch (err) {
      log.warn({ runId, documentId, code: codeOf(err) }, "could not post the reconciling note");
    }
  }
  // Refused or failed at dispatch: the reconcile run is already over, so it is answered now (never throws).
  if (TERMINAL.has(run.status)) await onDocumentRunFinished(db, deps, run.id);
  return "started";
}

const replyEntry = z.object({
  thread: z.number().int().positive(),
  reply: z.string().min(1),
  resolved: z.boolean().optional(),
});

const FENCE = new RegExp("```" + REPLIES_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*```", "g");

/** The agent's replies by thread number, from the last replies block in its final text. Malformed parts are ignored. */
export function parseThreadReplies(text: string | null | undefined): Map<number, { reply: string; resolved: boolean }> {
  const out = new Map<number, { reply: string; resolved: boolean }>();
  if (!text) return out;
  const blocks = [...text.matchAll(FENCE)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    const entry = replyEntry.safeParse(item);
    if (entry.success && !out.has(entry.data.thread)) {
      out.set(entry.data.thread, { reply: entry.data.reply, resolved: entry.data.resolved === true });
    }
  }
  return out;
}

/** An error's code for the log: its message when it is a code, else its class name. Never free text. */
function codeOf(err: unknown): string {
  if (err instanceof Error) return /^[a-z][a-z0-9_]*$/.test(err.message) ? err.message : err.name;
  return typeof err;
}

/**
 * Called when a run ends (any terminal status): by the completion hook, by the
 * reconciler's sweep, and at send time for a run that ended unanswered. The
 * run's threads are claimed first (answeredRunId), each by one caller only,
 * so a run is answered exactly once however many callers see it end.
 *
 * Succeeded: the file at the run's pushed commit is published as the next
 * version while the document is still at the version that was sent; then the
 * agent's replies are posted and the threads it flagged resolved. A newer
 * version in between: the edit is merged with it (merge.ts, file then line) and
 * the merge published when no file conflicts; else one reconcile run starts
 * on the latest version (startReconcileRun: at most one per send); else each
 * thread gets the fixed conflict reply. An edit that could not be read or
 * published: the agent's replies get a note and no thread is resolved. Any
 * other ending posts the failure reply on each thread. Never throws.
 */
export async function onDocumentRunFinished(db: PrismaClient, deps: DocumentAgentDeps, runId: string): Promise<void> {
  try {
    const run = await db.run.findUnique({
      where: { id: runId },
      select: { status: true, finalText: true, agentId: true, codingRun: { select: { result: true } } },
    });
    if (!run || !TERMINAL.has(run.status)) return;
    const threads = await claimThreads(db, runId);
    if (threads.length === 0) return;
    const secretValues = (await loadAgentSecretValues(db, deps.cipher, run.agentId)).flatMap((e) => e.values);
    const reply = (t: ClaimedThread, body: string) =>
      postAgentReply(db, { threadId: t.id, runId, viaId: t.sentById, body, secretValues });

    if (run.status !== "succeeded") {
      // A reconcile run's threads: the conflicted run's edit is still on its branch, so say where.
      const branches = await conflictedBranches(db, threads);
      for (const t of threads) {
        const branch = t.reconcileOfRunId === null ? undefined : branches.get(t.reconcileOfRunId);
        await reply(t, branch === undefined ? AGENT_RUN_FAILED_REPLY : reconcileFailedReply(branch));
      }
      return;
    }

    const edit = await publishRunEdit(db, deps, runId, threads, run.codingRun?.result, secretValues);
    if (edit.kind === "locked") {
      for (const t of threads) await reply(t, lockedEditReply(edit.state, edit.branch));
      return;
    }
    if (edit.kind === "conflict") {
      const start =
        edit.reconcile === null
          ? "refused"
          : await startReconcileRun(db, deps, { runId, threads, ...edit.reconcile, secretValues });
      if (start !== "started") {
        // A reconcile refused because the document was locked meanwhile gets the locked reply.
        const lockedNow = await documentReviewState(db, threads[0].documentId);
        const text =
          lockedNow && isLocked(lockedNow)
            ? lockedEditReply(lockedNow, edit.branch)
            : start === "too_large"
              ? reconcileTooLargeReply(edit.branch)
              : versionConflictReply(edit.branch);
        for (const t of threads) await reply(t, text);
      }
      return;
    }
    const replies = parseThreadReplies(run.finalText);
    for (const t of threads) {
      const entry = replies.get(t.number);
      const body = entry?.reply ?? (edit.kind === "published" ? AGENT_EDITED_NO_REPLY : AGENT_NO_REPLY);
      await reply(t, edit.kind === "failed" ? `${body}\n\n${EDIT_NOT_APPLIED_NOTE}` : body);
      if (entry?.resolved && edit.kind !== "failed") {
        const resolved = await db.commentThread.updateMany({
          where: { id: t.id, status: { in: ["open", "outdated"] } },
          data: { status: "resolved", resolvedById: null },
        });
        if (resolved.count > 0) await notifyDocumentChange(db, t.documentId, "thread");
      }
    }
  } catch (err) {
    log.warn({ runId, code: codeOf(err) }, "could not finish the document send for this run");
  }
}

type ClaimedThread = {
  id: string;
  number: number;
  documentId: string;
  sentById: string | null;
  sentVersionNumber: number | null;
  reconcileOfRunId: string | null;
};

/** The run's sent threads this caller claimed (answeredRunId set by it); none when another caller got there first. */
async function claimThreads(db: PrismaClient, runId: string): Promise<ClaimedThread[]> {
  return db.$transaction(async (tx) => {
    const candidates = await tx.commentThread.findMany({
      where: { sentRunId: runId, answeredRunId: null },
      orderBy: { number: "asc" },
      select: {
        id: true,
        number: true,
        documentId: true,
        sentById: true,
        sentVersionNumber: true,
        reconcileOfRunId: true,
      },
    });
    const claimed: ClaimedThread[] = [];
    for (const t of candidates) {
      const won = await tx.commentThread.updateMany({
        where: { id: t.id, sentRunId: runId, answeredRunId: null },
        data: { answeredRunId: runId },
      });
      if (won.count === 1) claimed.push(t);
    }
    return claimed;
  });
}

/** The branch each conflicted run (a reconcile run's reconcileOfRunId) left its edit on. */
async function conflictedBranches(db: PrismaClient, threads: ClaimedThread[]): Promise<Map<string, string>> {
  const runIds = [...new Set(threads.flatMap((t) => (t.reconcileOfRunId === null ? [] : [t.reconcileOfRunId])))];
  const out = new Map<string, string>();
  if (runIds.length === 0) return out;
  const rows = await db.codingRun.findMany({ where: { runId: { in: runIds } }, select: { runId: true, result: true } });
  for (const row of rows) {
    const result = publicCodingRunResult(row.result);
    const branch = result?.headRef ?? result?.commitSha;
    if (branch) out.set(row.runId, branch);
  }
  return out;
}

/**
 * A conflicted edit: the branch it is on, and what a reconcile run needs (the sent version's content
 * as `base`, the agent's prepared edit as `ours`), null when there is no edit to re-apply.
 */
type RunEdit =
  | { kind: "published" | "unchanged" | "failed" }
  | { kind: "locked"; state: LockedState; branch: string }
  | {
      kind: "conflict";
      branch: string;
      reconcile: { sentVersion: number; base: VersionContent; ours: VersionContent } | null;
    };

/** A document version's stored content by number. */
async function versionContent(db: PrismaClient, documentId: string, number: number): Promise<VersionContent> {
  const version = await db.documentVersion.findUnique({ where: { documentId_number: { documentId, number } } });
  if (!version) throw new Error("document_version_not_found");
  return loadContent(db, version);
}

/**
 * Publishes the linked file or design at the run's pushed commit as the next version while the
 * document is still at the version the threads were sent with. When it moved on, the edit is merged
 * (file by file, then line by line) with the current version (base: the sent version) and published while the
 * document is still at that current version; a conflicting file, or a newer version again, is a
 * conflict. Both publishes go through publishVersion (normalising and redaction).
 * Never throws: an error is reported as `failed`.
 */
async function publishRunEdit(
  db: PrismaClient,
  deps: Pick<DocumentAgentDeps, "cipher"> & { executor: Pick<Executor, "readCodingRepositoryFile"> },
  runId: string,
  threads: ClaimedThread[],
  codingResult: unknown,
  secretValues: readonly string[],
): Promise<RunEdit> {
  const documentId = threads[0].documentId;
  try {
    if (await db.documentVersion.findFirst({ where: { documentId, runId }, select: { id: true } })) {
      return { kind: "published" };
    }
    const result = publicCodingRunResult(codingResult);
    // Nothing pushed: the agent changed nothing (the file already held the document).
    if (result?.outcome === "no_changes") return { kind: "unchanged" };
    const doc = await db.document.findUnique({ where: { id: documentId }, include: { currentVersion: true } });
    const ref = result?.commitSha ?? result?.headRef;
    if (!doc?.repository || !doc.path || !doc.currentVersion || !ref || !deps.executor.readCodingRepositoryFile) {
      return { kind: "failed" };
    }
    const sentVersion = threads[0].sentVersionNumber;
    if (sentVersion === null || threads.some((t) => t.sentVersionNumber !== sentVersion)) return { kind: "failed" };
    const ef = agentEditFormat(doc.kind);
    const path = ef.validLinkPath(doc.path);
    // Agent output, redacted by the adapter (token shapes and the agent's secret values).
    const edited = await ef.readEdit(deps, { repository: doc.repository, path }, ref, secretValues);
    if (edited === null) return { kind: "failed" };
    // As it would be stored (ruling PF-H3): limits, format check, normalising and exact-value
    // redaction again. A refusal (board_format_invalid, an external reference, too large) is `failed`.
    const fmt = formatFor(doc.kind);
    const prepared = fmt.prepare(edited, secretValues).content;
    const branch = result?.headRef ?? ref;
    const numbers = threads.map((t) => `#${t.number}`).join(", ");
    const publish = async (
      content: VersionContent,
      expectedNumber: number,
      summary: string,
    ): Promise<"published" | "conflict" | "locked"> => {
      try {
        await publishVersion(db, deps.cipher, {
          documentId,
          ...(content.format === "markdown" ? { markdown: content.markdown } : { files: content.files }),
          via: "agent",
          runId,
          summary,
          expectedNumber,
        });
        return "published";
      } catch (err) {
        if (err instanceof Error && err.message === "document_version_conflict") return "conflict";
        if (err instanceof Error && err.message === "document_locked") return "locked";
        throw err;
      }
    };
    // Locked between the read above and a publish: the state at that moment names the reply.
    // Anything but archived reads as approved, a document deleted meanwhile (null) included: the
    // reply must still say the edit was not applied, and approved is the only other locked state.
    const locked = async (): Promise<RunEdit> => ({
      kind: "locked",
      state: (await documentReviewState(db, documentId)) === "archived" ? "archived" : "approved",
      branch,
    });

    // Approved or archived while the agent worked: nothing is published, merged or reconciled.
    if (isLocked(doc.reviewState) && contentHash(prepared) !== doc.currentVersion.contentHash) {
      return { kind: "locked", state: doc.reviewState, branch };
    }
    let current = doc.currentVersion;
    if (current.number === sentVersion) {
      if (contentHash(prepared) === current.contentHash) return { kind: "unchanged" };
      const out = await publish(prepared, sentVersion, `Agent edit for comment threads ${numbers}`);
      if (out === "published") return { kind: "published" };
      if (out === "locked") return locked();
      // Someone published first: merge with what they published.
      const latest = await getDocument(db, documentId);
      current = latest.version;
    }
    // Layer 1: the per-file three-way merge with the version the threads were sent with. Base and
    // theirs are prepared with the same secret values as ours, so a value that became a secret since
    // (redacted in ours only) does not make an untouched file differ.
    // A stored version the checks now refuse (e.g. a near-limit board that the longer redaction marker
    // pushes over) is compared as stored: at worst a false conflict, which the reconcile run handles.
    const prep = (c: VersionContent): VersionContent => {
      try {
        return fmt.prepare(c, secretValues).content;
      } catch {
        return c;
      }
    };
    const base = prep(await versionContent(db, documentId, sentVersion));
    const reconcile = { sentVersion, base, ours: prepared };
    const theirs = prep(await loadContent(db, current));
    const merged = mergeContent(ef, base, theirs, prepared);
    if (merged.kind === "conflict") return { kind: "conflict", branch, reconcile };
    // A line-merged file is new text: it must pass the format's checks (sanitiser, board rules,
    // redaction) as any edit does. A refusal is a conflict, so the reconcile run can redo it.
    let mergedContent: VersionContent;
    try {
      mergedContent = fmt.prepare(merged.content, secretValues).content;
    } catch (err) {
      log.info({ runId, documentId, code: codeOf(err) }, "the merged agent edit does not pass the format checks");
      return { kind: "conflict", branch, reconcile };
    }
    // The current version already holds the agent's edit.
    if (contentHash(mergedContent) === contentHash(theirs)) return { kind: "unchanged" };
    try {
      const summary = `Agent edit for comment threads ${numbers} (merged with v${current.number})`;
      const out = await publish(mergedContent, current.number, summary);
      if (out === "published") return { kind: "published" };
      if (out === "locked") return locked();
    } catch (err) {
      // A merge the store refuses (a manifest and boards that no longer agree) is a conflict too.
      log.info({ runId, documentId, code: codeOf(err) }, "the merged agent edit could not be stored");
    }
    return { kind: "conflict", branch, reconcile };
  } catch (err) {
    log.warn({ runId, documentId, code: codeOf(err) }, "could not publish the agent's edit");
    return { kind: "failed" };
  }
}

/**
 * The reconciler's sweep: runs that ended at least DOCUMENT_SWEEP_GRACE_MS ago
 * with threads still unanswered (lost runs, start failures, a missed
 * completion hook) are answered now, at most DOCUMENT_SWEEP_BATCH per pass.
 * Claiming makes it safe alongside the hook and other instances. Never throws.
 */
export async function sweepUnansweredDocumentRuns(deps: DocumentSweepDeps, now: Date = new Date()): Promise<number> {
  const { db } = deps;
  try {
    const before = new Date(now.getTime() - DOCUMENT_SWEEP_GRACE_MS);
    const rows = await db.$queryRaw<{ runId: string }[]>`
      SELECT DISTINCT t."sentRunId" AS "runId"
      FROM "CommentThread" t
      JOIN "Run" r ON r."id" = t."sentRunId"
      WHERE t."answeredRunId" IS NULL
        AND r."status"::text IN (${Prisma.join([...TERMINAL_RUN_STATUSES])})
        AND (r."finishedAt" IS NULL OR r."finishedAt" <= ${before})
      LIMIT ${DOCUMENT_SWEEP_BATCH}
    `;
    for (const { runId } of rows) await onDocumentRunFinished(db, deps, runId);
    return rows.length;
  } catch (err) {
    log.warn({ code: codeOf(err) }, "could not sweep unanswered document runs");
    return 0;
  }
}
