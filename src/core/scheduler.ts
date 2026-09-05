/**
 * The scheduler: a lease loop (only one process ticks at a time) and a tick
 * loop (the holder claims due agents and hands them to the `Executor`).
 * At-most-once firing is enforced by `claimDueRun`'s row lock + the
 * `lastScheduledAt` advance happening in the same transaction as the `Run`
 * create — never by the lease alone (the lease only prevents concurrent
 * *ticking*, not a race within a single tick against a future one).
 */

import { randomUUID } from "node:crypto";
import type { Agent, PrismaClient } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { dueWindow } from "./cron.js";
import { tryAcquireLease } from "./lease.js";
import { prisma as defaultDb } from "./db.js";
import { LEASE_RENEW_INTERVAL_MS, LEASE_TTL_MS, TICK_INTERVAL_MS } from "./timing.js";

export type SchedulerDb = Pick<PrismaClient, "agent" | "run" | "$transaction" | "$queryRaw">;

/**
 * Per spec: "Executor throws synchronously on start → the run is marked
 * failed with the error." A guarded `updateMany` (only `pending`/`running`)
 * rather than an unconditional `update`, so this can never clobber a run
 * that already reached a terminal state through some other path.
 */
export async function markRunFailedFromExecutorError(
  db: Pick<SchedulerDb, "run">,
  runId: string,
  err: unknown,
): Promise<void> {
  await db.run.updateMany({
    where: { id: runId, status: { in: ["pending", "running"] } },
    data: {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    },
  });
}

/** Cheap, lock-free pass: which enabled+scheduled agents look due right now. */
export async function findDueCandidates(db: Pick<SchedulerDb, "agent">, now: Date): Promise<Agent[]> {
  const candidates = await db.agent.findMany({
    where: { scheduleEnabled: true, schedule: { not: null } },
  });
  return candidates.filter((agent) =>
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
export async function claimDueRun(db: SchedulerDb, agentId: string, now: Date): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Agent" WHERE "id" = ${agentId} FOR UPDATE SKIP LOCKED
    `;
    if (locked.length === 0) {
      return null;
    }

    const agent = await tx.agent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.scheduleEnabled || !agent.schedule) {
      return null;
    }

    const window = dueWindow({
      schedule: agent.schedule,
      timezone: agent.timezone,
      lastScheduledAt: agent.lastScheduledAt,
      now,
    });
    if (!window) {
      return null;
    }

    await tx.agent.update({ where: { id: agentId }, data: { lastScheduledAt: window } });
    const run = await tx.run.create({ data: { agentId, trigger: "scheduled" } });
    return run.id;
  });
}

export interface SchedulerOptions {
  executor: Executor;
  db?: SchedulerDb;
  scope?: string;
  instanceId?: string;
  now?: () => Date;
  onLog?: (message: string) => void;
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
  const log = options.onLog ?? ((message: string) => console.log(message));

  let leader = false;

  async function leaseTick(): Promise<void> {
    const acquired = await tryAcquireLease(db, scope, instanceId, LEASE_TTL_MS);
    if (acquired && !leader) {
      log(`[scheduler] acquired leadership for scope "${scope}" as ${instanceId}`);
    } else if (!acquired && leader) {
      log(`[scheduler] lost leadership for scope "${scope}"`);
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
        const runId = await claimDueRun(db, agent.id, now());
        if (runId) {
          log(`[scheduler] firing agent "${agent.name}" -> run ${runId}`);
          options.executor.start(runId).catch(async (err) => {
            console.error(`[scheduler] run ${runId} for agent "${agent.name}" failed to start:`, err);
            try {
              await markRunFailedFromExecutorError(db, runId, err);
            } catch (updateErr) {
              console.error(`[scheduler] failed to mark run ${runId} as failed:`, updateErr);
            }
          });
        }
      } catch (err) {
        console.error(`[scheduler] error claiming a due run for agent "${agent.name}":`, err);
      }
    }
  }

  const leaseTimer = setInterval(() => {
    leaseTick().catch((err) => console.error("[scheduler] lease error:", err));
  }, LEASE_RENEW_INTERVAL_MS);
  const tickTimer = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, TICK_INTERVAL_MS);

  // Acquire immediately rather than waiting a full renew interval to start.
  leaseTick().catch((err) => console.error("[scheduler] lease error:", err));

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
