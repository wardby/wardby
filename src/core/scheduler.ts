/**
 * The scheduler: a lease loop (only one process ticks at a time) and a tick
 * loop (the holder claims due agents and hands them to the `Executor`).
 * At-most-once firing is enforced by `claimDueRun`'s row lock + the
 * `lastScheduledAt` advance happening in the same transaction as the `Run`
 * create — never by the lease alone (the lease only prevents concurrent
 * *ticking*, not a race within a single tick against a future one).
 */

import { randomUUID } from "node:crypto";
import type { Agent } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import { dueWindow } from "./cron.js";
import { dispatchRun, type DispatchDb } from "./dispatch.js";
import { tryAcquireLease } from "./lease.js";
import { prisma as defaultDb } from "./db.js";
import { LEASE_RENEW_INTERVAL_MS, LEASE_TTL_MS, TICK_INTERVAL_MS } from "./timing.js";
import { logger } from "./logger.js";

const schedulerLog = logger.child({ module: "scheduler" });

export type SchedulerDb = DispatchDb;

/**
 * Per spec: "Executor throws synchronously on start → the run is marked
 * failed with the error." A guarded `updateMany` (only `pending`/`running`)
 * rather than an unconditional `update`, so this can never clobber a run
 * that already reached a terminal state through some other path.
 */
export { markRunFailedFromExecutorError } from "./dispatch.js";

/** Cheap, lock-free pass: which enabled+scheduled agents look due right now. */
export async function findDueCandidates(db: Pick<SchedulerDb, "agent">, now: Date): Promise<Agent[]> {
  const candidates = await db.agent.findMany({
    where: { scheduleEnabled: true, schedule: { not: null } },
  });
  return candidates.filter(
    (agent) =>
      dueWindow({
        schedule: agent.schedule as string,
        timezone: agent.timezone,
        lastScheduledAt: agent.lastScheduledAt,
        now,
      }) !== null,
  );
}

/**
 * Re-checks due-ness under `FOR UPDATE SKIP LOCKED` and, if still due,
 * advances `lastScheduledAt` and creates the `Run` in the same transaction.
 * Returns the new run's id, or null if the agent wasn't (or is no longer)
 * due, or another tick already holds its row lock.
 */
export async function claimDueRun(
  db: SchedulerDb,
  executor: Executor,
  agentId: string,
  now: Date,
): Promise<string | null> {
  const dispatched = await dispatchRun({
    db,
    executor,
    agentId,
    trigger: "scheduled",
    now,
    lockAgent: true,
    beforePersist: async (tx, agent) => {
      if (!agent.scheduleEnabled || !agent.schedule) return false;
      const window = dueWindow({
        schedule: agent.schedule,
        timezone: agent.timezone,
        lastScheduledAt: agent.lastScheduledAt,
        now,
      });
      if (!window) return false;
      await tx.agent.update({ where: { id: agentId }, data: { lastScheduledAt: window } });
      return true;
    },
  });
  return dispatched?.run.id ?? null;
}

export interface SchedulerOptions {
  executor: Executor;
  db?: SchedulerDb;
  scope?: string;
  instanceId?: string;
  now?: () => Date;
  onLog?: (message: string) => void;
  /**
   * Awaited at the end of every tick on the lease holder only; used to drain
   * the coding concurrency queue. Errors are logged, never thrown, so a
   * failing hook cannot stop scheduled agents from firing.
   */
  onLeaderTick?: () => Promise<void>;
}

export interface SchedulerHandle {
  stop(): void;
  isLeader(): boolean;
}

export function startScheduler(options: SchedulerOptions): SchedulerHandle {
  const db = options.db ?? defaultDb;
  const scope = options.scope ?? "default";
  const instanceId = options.instanceId ?? randomUUID();
  const now = options.now ?? (() => new Date());
  const log = options.onLog ?? ((message: string) => schedulerLog.info(message));

  let leader = false;

  async function leaseTick(): Promise<void> {
    const acquired = await tryAcquireLease(db, scope, instanceId, LEASE_TTL_MS);
    if (acquired && !leader) {
      log(`acquired leadership for scope "${scope}" as ${instanceId}`);
    } else if (!acquired && leader) {
      log(`lost leadership for scope "${scope}"`);
    }
    leader = acquired;
  }

  async function tick(): Promise<void> {
    if (!leader) {
      return;
    }
    const due = await findDueCandidates(db, now());
    for (const agent of due) {
      try {
        const runId = await claimDueRun(db, options.executor, agent.id, now());
        if (runId) {
          log(`firing agent "${agent.name}" -> run ${runId}`);
        }
      } catch (err) {
        schedulerLog.error({ err, agentName: agent.name }, "error claiming a due run");
      }
    }
    if (options.onLeaderTick) {
      await options.onLeaderTick().catch((err) => schedulerLog.error({ err }, "leader tick hook failed"));
    }
  }

  const leaseTimer = setInterval(() => {
    leaseTick().catch((err) => schedulerLog.error({ err }, "lease error"));
  }, LEASE_RENEW_INTERVAL_MS);
  const tickTimer = setInterval(() => {
    tick().catch((err) => schedulerLog.error({ err }, "tick error"));
  }, TICK_INTERVAL_MS);

  // Acquire immediately rather than waiting a full renew interval to start.
  leaseTick().catch((err) => schedulerLog.error({ err }, "lease error"));

  return {
    stop() {
      clearInterval(leaseTimer);
      clearInterval(tickTimer);
    },
    isLeader() {
      return leader;
    },
  };
}
