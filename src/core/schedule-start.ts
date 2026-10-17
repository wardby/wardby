import type { PrismaClient } from "#prisma";
import { startsSchedule, type ScheduleState } from "./cron.js";

/**
 * The `lastScheduledAt` to write with a schedule change: the database's
 * clock when the change starts the schedule (see startsSchedule), nothing
 * otherwise. The database's clock, not this process's, because the CLI and
 * import can run on an operator's machine: a clock running ahead there would
 * record a start after a window the scheduler has yet to fire, and skip it.
 */
export async function scheduleStartFields(
  db: Pick<PrismaClient, "$queryRaw">,
  before: ScheduleState | null,
  after: ScheduleState,
): Promise<{ lastScheduledAt: Date } | Record<string, never>> {
  if (!startsSchedule(before, after)) return {};
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return { lastScheduledAt: now };
}
