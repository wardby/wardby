/**
 * Cron window computation for the scheduler — pure wrapper around `croner`
 * so the due-window / DST logic is unit-testable without a live clock or DB.
 */

import { Cron } from "croner";

export interface DueCheckInput {
  schedule: string;
  timezone: string;
  /** Start of the most recent window this agent already fired for, or null if never. */
  lastScheduledAt: Date | null;
  now: Date;
}

/**
 * The start of the most recent due window at/before `now` that hasn't
 * already been fired for, or `null` if not due.
 *
 * Only ever returns the single latest window — this is what implements
 * "skip, don't backfill": if several windows elapsed since
 * `lastScheduledAt` (e.g. the scheduler was down), the caller advances
 * `lastScheduledAt` straight to this value, abandoning the earlier ones.
 *
 * Boundary note: croner's `previousRuns` treats its reference instant as
 * excluded (strictly-before), so a `now` that lands on the exact
 * millisecond of a scheduled tick reports that tick as not-yet-due until a
 * subsequent check. Irrelevant in practice at a multi-second tick
 * interval, but worth knowing if this is ever called with a synthetic
 * `now` that lands exactly on a boundary.
 */
export function dueWindow(input: DueCheckInput): Date | null {
  const { schedule, timezone, lastScheduledAt, now } = input;
  const job = new Cron(schedule, { timezone });
  const [mostRecent] = job.previousRuns(1, now);
  if (!mostRecent) {
    return null;
  }
  if (lastScheduledAt && mostRecent.getTime() <= lastScheduledAt.getTime()) {
    return null;
  }
  return mostRecent;
}

export function isDue(input: DueCheckInput): boolean {
  return dueWindow(input) !== null;
}

/** Throws a descriptive error for an invalid cron expression or timezone. */
export function validateCronExpression(schedule: string, timezone: string): void {
  // The Cron constructor validates the pattern synchronously, but an
  // invalid timezone only throws once a run is actually computed.
  const job = new Cron(schedule, { timezone });
  job.nextRun();
}
