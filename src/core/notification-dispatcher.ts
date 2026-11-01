/**
 * Delivers pending NotificationDelivery rows to chat (Slack), one thread per
 * work item (or PR, or run) per channel.
 *
 * Rules:
 * - Lease-gated: only the holder of the "notification-dispatch" SchedulerLease
 *   delivers. The lease is renewed before every delivery and the pass ends
 *   when renewal fails; a pass also stops after PASS_BUDGET_MS so a delivery
 *   always starts well inside the lease TTL. Replicas therefore don't
 *   double-post while the lease is held. Delivery is still at-least-once: a
 *   failed "delivered" write after a successful post retries (and reposts).
 * - Threads: the first delivery for a (provider, channel, threadKey) posts a
 *   parent message and stores its ts in NotificationThread; every event is a
 *   reply under it. The thread status is derived from its delivered events;
 *   NotificationThread.status is the status last rendered on the parent, which
 *   is re-rendered with chat.update whenever the two differ. A deleted parent
 *   (message_not_found on update) drops the thread row; the next event posts
 *   a fresh parent.
 * - Ordering: within a thread, deliveries go strictly oldest-first. A thread is
 *   only worked when its oldest pending delivery is due, and it stops at its
 *   first failure in a pass, so a reply never overtakes an older one.
 * - Pacing: at most one Slack call per second per channel (posts and updates).
 * - Errors: rate_limited defers by Retry-After without counting an attempt and
 *   holds the whole channel (every thread on it) until Retry-After passes;
 *   transient (and any non-ChatError) backs
 *   off exponentially and fails at MAX_ATTEMPTS; channel_unreachable fails
 *   every pending delivery for the channel and stamps lastError on its links;
 *   auth_failed pauses the whole dispatcher for 5 minutes (no attempt counted),
 *   then re-checks each provider with auth.test.
 * - Sender: with WARDBY_SLACK_CUSTOMIZE on, a message's display name is the
 *   agent the event names (picked up, review, failure), else "wardby".
 * - The pause and channel holds live on `deps.state` (created on first use), not in module
 *   state: one dispatcher (or one test) per deps object.
 */
import { Prisma, type PrismaClient } from "#prisma";
import {
  ChatError,
  type ChatProvider,
  type ChatProviderName,
  type ChatProviderRegistry,
} from "../providers/chat/types.js";
import { pullRequestWebUrl } from "../coding/code-host.js";
import { tryAcquireLease } from "./lease.js";
import { logger } from "./logger.js";
import {
  broadcasts,
  nextStatus,
  renderEvent,
  renderParent,
  senderName,
  type ThreadStatus,
} from "./notification-templates.js";
import { spendLine } from "./issue-status.js";
import { shortReason, type ThreadSubject, type WorkflowPayload } from "./workflow-events.js";

const log = logger.child({ module: "notification-dispatcher" });

export const DISPATCH_LEASE_SCOPE = "notification-dispatch";
export const MAX_ATTEMPTS = 10;
const LEASE_TTL_MS = 30_000;
/** A pass stops starting deliveries after this long; the rest wait for the next tick. */
const PASS_BUDGET_MS = 20_000;
const BATCH = 100;
const AUTH_PAUSE_MS = 5 * 60_000;
const AUTH_RECHECK_RETRY_MS = 30_000;
const CHANNEL_GAP_MS = 1000;
const PRUNE_EVERY_MS = 3_600_000;

/** Per-dispatcher mutable state; `dispatchOnce` creates it on `deps` when absent. */
export interface DispatcherState {
  /** While set and in the future, passes deliver nothing. */
  pausedUntil?: Date;
  /** provider\0channel → no Slack call to that channel before this time (rate limit Retry-After). */
  channelBlockedUntil?: Map<string, Date>;
}

export interface DispatcherDeps {
  db: PrismaClient; // full client: lease uses $queryRaw, threads need several models
  chat: ChatProviderRegistry;
  holder: string; // lease holder id (process-unique)
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>; // pacing; tests pass a no-op
  state?: DispatcherState;
  /** Test-only: deliver only rows whose channelId starts with this (keeps parallel DB suites apart). */
  channelIdPrefix?: string;
}

/** Exponential back-off: 5s · 2^(attempts-1), capped at 1h. */
export function backoffMs(attempts: number): number {
  return Math.min(5000 * 2 ** (Math.max(1, attempts) - 1), 3_600_000);
}

type Delivery = Prisma.NotificationDeliveryGetPayload<{ include: { event: true } }>;
type Thread = { id: string; parentTs: string; status: string };

interface Pass {
  deps: DispatcherDeps;
  state: DispatcherState;
  now: Date;
  /** provider\0channel → stop for the rest of the pass. */
  blocked: Set<string>;
  /** provider\0channel → wall-clock ms of the last Slack call in this pass. */
  lastCall: Map<string, number>;
}

type Outcome = "ok" | "stop_thread" | "stop_pass";

const channelKey = (d: { provider: string; channelId: string }) => `${d.provider}\u0000${d.channelId}`;

/** Holds every thread on the channel until `retryAfterMs` from now (across passes). */
function holdChannel(pass: Pass, d: Delivery, retryAfterMs: number | undefined): void {
  const key = channelKey(d);
  pass.blocked.add(key);
  const holds = (pass.state.channelBlockedUntil ??= new Map());
  holds.set(key, new Date(pass.now.getTime() + (retryAfterMs ?? CHANNEL_GAP_MS)));
}

async function pace(pass: Pass, key: string): Promise<void> {
  const last = pass.lastCall.get(key);
  if (last !== undefined) {
    const wait = CHANNEL_GAP_MS - (Date.now() - last);
    if (wait > 0) await (pass.deps.sleep ?? defaultSleep)(wait);
  }
  pass.lastCall.set(key, Date.now());
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function subjectOf(db: PrismaClient, d: Delivery): Promise<ThreadSubject> {
  const ev = d.event;
  if (ev.workItemProvider && ev.workItemKey) {
    const item = await db.workItem.findUnique({
      where: { provider_key: { provider: ev.workItemProvider, key: ev.workItemKey } },
      select: { title: true, url: true },
    });
    return { label: ev.workItemKey, title: item?.title ?? null, url: item?.url ?? null };
  }
  if (ev.repository && ev.prNumber != null) {
    const url = pullRequestWebUrl(ev.codeProvider ?? "", ev.repository, ev.prNumber);
    return { label: `${ev.repository}#${ev.prNumber}`, title: null, url };
  }
  if (ev.runId) return { label: `run ${ev.runId.slice(0, 8)}`, title: null, url: null };
  return { label: d.threadKey, title: null, url: null };
}

/** Posts the thread's parent and records it; a lost create race adopts the winner's parent. */
async function openThread(pass: Pass, provider: ChatProvider, d: Delivery, payload: WorkflowPayload): Promise<Thread> {
  const { db } = pass.deps;
  const status = nextStatus(null, payload);
  const subject = await subjectOf(db, d);
  await pace(pass, channelKey(d));
  const { ts } = await provider.postMessage(d.channelId, {
    ...renderParent(subject, status),
    username: senderName(payload),
  });
  const where = { provider: d.provider, channelId: d.channelId, threadKey: d.threadKey };
  try {
    return await db.notificationThread.create({ data: { ...where, parentTs: ts, status } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    log.warn({ channelId: d.channelId, threadKey: d.threadKey, ts }, "lost a thread-parent race; extra parent posted");
    return db.notificationThread.findUniqueOrThrow({ where: { provider_channelId_threadKey: where } });
  }
}

/** The thread's status as implied by its delivered events, oldest first (terminal statuses stick). */
async function derivedStatus(db: PrismaClient, d: Delivery): Promise<ThreadStatus | null> {
  const rows = await db.notificationDelivery.findMany({
    where: { provider: d.provider, channelId: d.channelId, threadKey: d.threadKey, state: "delivered" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { event: { select: { payload: true } } },
  });
  return rows.reduce<ThreadStatus | null>((s, r) => nextStatus(s, r.event.payload as unknown as WorkflowPayload), null);
}

/**
 * Re-renders the parent when the derived status differs from the one last
 * rendered (NotificationThread.status). Re-derives once after an edit so a
 * status another replica delivered meanwhile still reaches the parent. A
 * failed edit leaves the status alone: the next event re-derives and retries.
 * Never throws: the reply is already delivered.
 */
async function refreshParent(pass: Pass, provider: ChatProvider, d: Delivery): Promise<void> {
  const { db } = pass.deps;
  const key = { provider: d.provider, channelId: d.channelId, threadKey: d.threadKey };
  let threadId: string | null = null;
  try {
    let subject: ThreadSubject | null = null;
    for (let round = 0; round < 2; round++) {
      const thread = await db.notificationThread.findUnique({ where: { provider_channelId_threadKey: key } });
      const derived = await derivedStatus(db, d);
      if (!thread || !derived || derived === thread.status) return;
      threadId = thread.id;
      subject ??= await subjectOf(db, d);
      await pace(pass, channelKey(d));
      await provider.updateMessage(d.channelId, thread.parentTs, renderParent(subject, derived));
      await db.notificationThread.updateMany({ where: { id: thread.id }, data: { status: derived } });
    }
  } catch (err) {
    if (err instanceof ChatError && err.code === "message_not_found" && threadId) {
      log.info({ ...key }, "thread parent is gone; next event starts a new one");
      await db.notificationThread.deleteMany({ where: { id: threadId } }).catch((e: unknown) => {
        log.warn({ err: e, threadId }, "could not drop the stale thread row");
      });
      return;
    }
    if (err instanceof ChatError && err.code === "rate_limited") holdChannel(pass, d, err.retryAfterMs);
    log.warn({ err, ...key }, "could not update the thread parent status");
  }
}

async function deliver(pass: Pass, provider: ChatProvider, d: Delivery): Promise<Outcome> {
  const { db } = pass.deps;
  const payload = d.event.payload as unknown as WorkflowPayload;
  try {
    const where = { provider: d.provider, channelId: d.channelId, threadKey: d.threadKey };
    const thread =
      (await db.notificationThread.findUnique({ where: { provider_channelId_threadKey: where } })) ??
      (await openThread(pass, provider, d, payload));
    const spend = d.includeCost && d.event.runId ? (await spendLine(db, d.event.runId)) || null : null;
    await pace(pass, channelKey(d));
    const msg = { ...renderEvent(payload, spend), username: senderName(payload) };
    const { ts } = await provider.postMessage(d.channelId, msg, {
      threadTs: thread.parentTs,
      broadcast: broadcasts(payload),
    });
    await db.notificationDelivery.update({
      where: { id: d.id },
      data: { state: "delivered", deliveredAt: pass.now, messageTs: ts, lastError: null, attempts: { increment: 1 } },
    });
    await refreshParent(pass, provider, d);
    return "ok";
  } catch (err) {
    return handleFailure(pass, d, err);
  }
}

async function handleFailure(pass: Pass, d: Delivery, err: unknown): Promise<Outcome> {
  const { db } = pass.deps;
  const { now } = pass;
  const chat = err instanceof ChatError ? err : null;
  const message = chat?.slackError ?? shortReason(err instanceof Error ? err.message : String(err)) ?? "unknown error";
  switch (chat?.code) {
    case "rate_limited":
      holdChannel(pass, d, chat.retryAfterMs);
      await db.notificationDelivery.update({
        where: { id: d.id },
        data: { nextAttemptAt: new Date(now.getTime() + (chat.retryAfterMs ?? CHANNEL_GAP_MS)) },
      });
      return "stop_thread";
    case "channel_unreachable":
      pass.blocked.add(channelKey(d));
      log.warn(
        { provider: d.provider, channelId: d.channelId, error: message },
        "channel unreachable; failing its deliveries",
      );
      await db.notificationDelivery.updateMany({
        where: { provider: d.provider, channelId: d.channelId, state: "pending" },
        data: { state: "failed", lastError: message },
      });
      await db.notificationChannel.updateMany({
        where: { provider: d.provider, channelId: d.channelId },
        data: { lastError: message, lastErrorAt: now },
      });
      return "stop_thread";
    case "auth_failed":
      pass.state.pausedUntil = new Date(now.getTime() + AUTH_PAUSE_MS);
      log.error(
        { provider: d.provider, error: message },
        "chat auth failed; pausing notification delivery for 5 minutes",
      );
      return "stop_pass";
    default: {
      if (chat?.code === "message_not_found") {
        // The thread's parent is gone (reply to a deleted parent): start over on the retry.
        await db.notificationThread.deleteMany({
          where: { provider: d.provider, channelId: d.channelId, threadKey: d.threadKey },
        });
      }
      const attempts = d.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      if (!chat) log.warn({ err, deliveryId: d.id }, "notification delivery failed");
      await db.notificationDelivery.update({
        where: { id: d.id },
        data: {
          attempts,
          lastError: message,
          ...(failed ? { state: "failed" } : { nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) }),
        },
      });
      return "stop_thread";
    }
  }
}

/** Expired pause: auth.test every provider; true when delivery may resume. */
async function recheckAuth(deps: DispatcherDeps, state: DispatcherState, now: Date): Promise<boolean> {
  for (const provider of Object.values(deps.chat)) {
    if (!provider) continue;
    try {
      await provider.authTest();
    } catch (err) {
      const stillRevoked = err instanceof ChatError && err.code === "auth_failed";
      state.pausedUntil = new Date(now.getTime() + (stillRevoked ? AUTH_PAUSE_MS : AUTH_RECHECK_RETRY_MS));
      if (!stillRevoked) log.warn({ err, provider: provider.name }, "auth re-check failed; retrying shortly");
      return false;
    }
  }
  state.pausedUntil = undefined;
  log.info("chat auth restored; resuming notification delivery");
  return true;
}

/** One pass: deliver what is due. Returns the number of deliveries attempted. */
export async function dispatchOnce(deps: DispatcherDeps): Promise<number> {
  const state = (deps.state ??= {});
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const { db } = deps;
  if (!(await tryAcquireLease(db, DISPATCH_LEASE_SCOPE, deps.holder, LEASE_TTL_MS))) return 0;
  if (state.pausedUntil) {
    if (state.pausedUntil > now) return 0;
    if (!(await recheckAuth(deps, state, now))) return 0;
  }

  const holds = state.channelBlockedUntil;
  for (const [key, until] of holds ?? []) if (until <= now) holds?.delete(key);
  const scope = deps.channelIdPrefix ? { channelId: { startsWith: deps.channelIdPrefix } } : {};
  const due = await db.notificationDelivery.findMany({
    where: { state: "pending", nextAttemptAt: { lte: now }, ...scope },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: BATCH,
    include: { event: true },
  });
  const threads = new Map<string, Delivery[]>();
  for (const d of due) {
    const key = `${channelKey(d)}\u0000${d.threadKey}`;
    const group = threads.get(key);
    if (group) group.push(d);
    else threads.set(key, [d]);
  }

  const pass: Pass = { deps, state, now, blocked: new Set(), lastCall: new Map() };
  let attempted = 0;
  for (const group of threads.values()) {
    const head = group[0];
    const provider = deps.chat[head.provider as ChatProviderName];
    if (!provider || pass.blocked.has(channelKey(head)) || holds?.has(channelKey(head))) continue;
    // An older pending delivery that is not yet due holds the whole thread.
    const older = await db.notificationDelivery.findFirst({
      where: {
        provider: head.provider,
        channelId: head.channelId,
        threadKey: head.threadKey,
        state: "pending",
        createdAt: { lt: head.createdAt },
      },
      select: { id: true },
    });
    if (older) continue;
    for (const d of group) {
      if (pass.blocked.has(channelKey(d))) break;
      if (attempted > 0 && clock().getTime() - now.getTime() >= PASS_BUDGET_MS) return attempted;
      if (!(await tryAcquireLease(db, DISPATCH_LEASE_SCOPE, deps.holder, LEASE_TTL_MS))) {
        log.warn({ holder: deps.holder }, "lost the dispatch lease mid-pass; stopping");
        return attempted;
      }
      attempted++;
      const outcome = await deliver(pass, provider, d);
      if (outcome === "stop_pass") return attempted;
      if (outcome === "stop_thread") break;
    }
  }
  return attempted;
}

/**
 * Deletes events (and their deliveries) older than `days` with no pending
 * delivery. `only` narrows the candidates further (tests scope it to their own rows).
 */
export async function pruneWorkflowEvents(
  db: PrismaClient,
  now: Date,
  days = 30,
  only: Prisma.WorkflowEventWhereInput = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const { count } = await db.workflowEvent.deleteMany({
    where: { ...only, createdAt: { lt: cutoff }, deliveries: { none: { state: "pending" } } },
  });
  return count;
}

export interface DispatcherHandle {
  stop(): void;
}

export function startNotificationDispatcher(deps: DispatcherDeps & { intervalMs?: number }): DispatcherHandle {
  deps.state ??= {};
  let running = false;
  let lastPrune = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchOnce(deps);
      const nowMs = Date.now();
      if (nowMs - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = nowMs;
        const pruned = await pruneWorkflowEvents(deps.db, new Date(nowMs));
        if (pruned > 0) log.info({ pruned }, "pruned old workflow events");
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    tick().catch((err: unknown) => log.error({ err }, "notification dispatch tick failed"));
  }, deps.intervalMs ?? 2000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
