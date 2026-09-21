import type { PrismaClient } from "@prisma/client";

/**
 * `reevo mcp` serves the MCP surface and launches the executor, but the
 * scheduler and reconciler live in `reevo scheduler` (or in `reevo serve`,
 * which runs everything). A deployment running only `mcp` accepts schedules
 * through set_schedule and then never fires them: no error, no crash,
 * `lastScheduledAt` simply stays null. Nothing else surfaces that.
 *
 * Kept free of logging and process state so it can be unit-tested and reused
 * by any composition root.
 */

/** Same predicate the scheduler uses to find candidates (core/scheduler.ts). */
export async function countUnattendedSchedules(db: Pick<PrismaClient, "agent">): Promise<number> {
  return db.agent.count({ where: { scheduleEnabled: true, schedule: { not: null } } });
}

/** The warning to log for `count` unattended schedules, or null when there is nothing to warn about. */
export function unattendedSchedulesWarning(count: number): string | null {
  if (count === 0) return null;
  return (
    `${count} agent(s) have an enabled schedule, but this process does not run the scheduler. ` +
    `Run "reevo scheduler" alongside it, or run "reevo serve" instead, or those schedules will never fire.`
  );
}
