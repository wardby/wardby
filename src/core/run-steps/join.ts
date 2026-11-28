/**
 * Join (Claude Code coding runs and native agent runs): people with execute on an agent join one of
 * its running runs and send it messages. Every join event is a RunStep, so it shows in the run's steps where it
 * happened:
 *
 * - "join" / "leave": a person joined or left (fromPrincipalId). While anyone is joined the run
 *   stays open, until the last person leaves or the run's timeout.
 * - "message" / "interrupt": text for the agent, a message at the agent's next step, an interrupt
 *   at once. deliveredAt is set the first time it is sent. A Claude Code worker receives it over
 *   the run-steps listener (RUN_JOIN_POLL_PATH, through the coding proxy); a native run's engine
 *   reads it here (control plane) or through the native gateway's join methods (sandbox).
 *
 * Writing is RunStepWriter.recordJoin's (the one writer of RunStep rows): a message is masked by
 * exact value against the agent's secrets there before it is stored, and only that stored text is
 * returned or delivered. This module only reads. Nothing here logs text.
 */
import type { PrismaClient } from "#prisma";

export const JOIN_STEP_KINDS = ["join", "leave", "message", "interrupt"] as const;
export type JoinStepKind = (typeof JOIN_STEP_KINDS)[number];
/** The longest message a person may send. */
export const MAX_JOIN_MESSAGE_CHARS = 8_000;
/** How long one poll waits for news before answering empty (well under proxy and load-balancer idle timeouts). */
export const JOIN_POLL_WINDOW_MS = 20_000;
const JOIN_POLL_INTERVAL_MS = 1_000;

/** Why a run cannot be joined (each has a help/errors article). */
export type JoinRefusal = "run_not_running" | "join_not_supported";

/**
 * Whether people can join this run now: a running native agent run, or a running Claude Code coding
 * run, workflow runs included (#657: messages reach the run's lead session). Other coding agents
 * (Codex, Gemini CLI) come in a later phase.
 */
export async function joinRefusal(
  db: Pick<PrismaClient, "run" | "codingRun">,
  runId: string,
): Promise<JoinRefusal | null> {
  const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run || run.status !== "running") return "run_not_running";
  const coding = await db.codingRun.findUnique({ where: { runId }, select: { provider: true } });
  // No CodingRun: a native agent run.
  if (coding && coding.provider !== "claude-code") return "join_not_supported";
  return null;
}

/** The principals joined now: each one's latest join or leave step decides. */
export async function joinedPrincipals(db: Pick<PrismaClient, "runStep">, runId: string): Promise<Set<string>> {
  const rows = await db.runStep.findMany({
    where: { runId, kind: { in: ["join", "leave"] } },
    orderBy: { seq: "asc" },
    select: { kind: true, fromPrincipalId: true },
  });
  const joined = new Set<string>();
  for (const row of rows) {
    if (!row.fromPrincipalId) continue;
    if (row.kind === "join") joined.add(row.fromPrincipalId);
    else joined.delete(row.fromPrincipalId);
  }
  return joined;
}

export interface JoinPollRequest {
  /** The last join message seq the worker has. */
  after: number;
  /** Whether the worker last saw anyone joined. */
  joined: boolean;
}

export interface JoinPollAnswer {
  joined: boolean;
  messages: { seq: number; text: string; interrupt: boolean }[];
}

/** Whether an interrupt after `after` has not been delivered yet. Only reads. */
export async function interruptPending(
  db: Pick<PrismaClient, "runStep">,
  runId: string,
  after: number,
): Promise<boolean> {
  const row = await db.runStep.findFirst({
    where: { runId, kind: "interrupt", seq: { gt: after }, deliveredAt: null },
    select: { id: true },
  });
  return row !== null;
}

async function pollOnce(
  db: Pick<PrismaClient, "runStep">,
  runId: string,
  after: number,
  now: Date,
): Promise<JoinPollAnswer> {
  const [joined, rows] = await Promise.all([
    joinedPrincipals(db, runId),
    db.runStep.findMany({
      where: { runId, kind: { in: ["message", "interrupt"] }, seq: { gt: after } },
      orderBy: { seq: "asc" },
      take: 50,
      select: { id: true, seq: true, kind: true, detail: true, deliveredAt: true },
    }),
  ]);
  const undelivered = rows.filter((row) => row.deliveredAt === null).map((row) => row.id);
  if (undelivered.length > 0) {
    await db.runStep.updateMany({ where: { id: { in: undelivered }, deliveredAt: null }, data: { deliveredAt: now } });
  }
  return {
    joined: joined.size > 0,
    messages: rows.map((row) => ({ seq: row.seq, text: row.detail ?? "", interrupt: row.kind === "interrupt" })),
  };
}

/**
 * The worker's poll: answers at once when there are messages after `after`, the joined state
 * differs from the worker's, or nobody is joined; while someone is joined it checks again every
 * second until the window ends, then answers with the state as it is.
 */
export async function pollJoin(
  db: Pick<PrismaClient, "runStep">,
  runId: string,
  request: JoinPollRequest,
  opts: { windowMs?: number; intervalMs?: number; now?: () => Date; signal?: AbortSignal } = {},
): Promise<JoinPollAnswer> {
  const now = opts.now ?? (() => new Date());
  const end = now().getTime() + (opts.windowMs ?? JOIN_POLL_WINDOW_MS);
  const interval = opts.intervalMs ?? JOIN_POLL_INTERVAL_MS;
  for (;;) {
    const answer = await pollOnce(db, runId, request.after, now());
    if (answer.messages.length > 0 || answer.joined !== request.joined) return answer;
    // Held only while someone is joined: a run nobody joined answers at once and the worker asks
    // again a few seconds later, so the listener's connections go to joined runs only.
    if (!answer.joined) return answer;
    if (opts.signal?.aborted || now().getTime() + interval >= end) return answer;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
