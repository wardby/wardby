/**
 * Request leases, shared by every system that reserves budget before it can settle it (the coding
 * proxy now, the native gateway next). A reservation carries an `ownerId` and a `leaseUntil`; the
 * process holding it renews the lease on a heartbeat, and every process sweeps reservations whose
 * lease ran out because their owner died. This module owns the timers, the fencing and the sweep
 * loop; each system supplies a `LeaseLedger` over its own tables.
 *
 * Fencing: a process whose reservation was swept or taken over is still alive and would keep relaying
 * and billing upstream. The heartbeat compares what the ledger renewed with what the process holds
 * and reports every id it no longer owns, so the caller can abort that work.
 */
import { startInterval } from "./interval.js";
import { logger } from "./logger.js";

const leaseLog = logger.child({ module: "lease" });

export interface LeaseConfig {
  /** How long a lease lasts from its last renewal. */
  leaseMs: number;
  /** How often a process renews the leases it holds. */
  heartbeatMs: number;
  /** How often a process settles reservations whose lease ran out. */
  sweepMs: number;
}

/**
 * A lease that outlasts only one heartbeat expires on a single late or failed renewal, and a live
 * request would be settled as if its process had died. `names` are the settings the error blames.
 */
export function assertLeaseConfig(
  config: Pick<LeaseConfig, "leaseMs" | "heartbeatMs">,
  names: { lease: string; heartbeat: string },
): void {
  if (config.leaseMs <= 2 * config.heartbeatMs) {
    throw new Error(`${names.lease} must be greater than twice ${names.heartbeat}.`);
  }
}

export interface LeaseRenewal {
  /** The ids whose lease moved: the ones this owner still holds. */
  renewed: string[];
  /** Renewed ids whose session was cancelled, so their owner should stop them. */
  cancelled?: string[];
}

/** What settling one expired reservation did. `lostRace` means the owner or another sweeper got there first. */
export type LeaseSettlement = "settled" | "settledWithoutEstimate" | "lostRace";

/** Why a process no longer owns a reservation: its lease was swept or taken over, or its session was cancelled. */
export type LeaseLossReason = "lost" | "cancelled";

/**
 * A system's reservation store. `E` is whatever `expired` lists and `settleExpired` needs back (the
 * row, its run); the shared sweep never looks inside it.
 */
export interface LeaseLedger<E> {
  /** Extends the lease of the ids this owner holds; ids it does not hold (settled, taken over) are left out. */
  renew(ownerId: string, ids: string[]): Promise<LeaseRenewal>;
  /** Up to `limit` reservations whose lease ran out, oldest first. */
  expired(limit: number): Promise<E[]>;
  /** Settles one expired reservation; it applies only while the row is still reserved and expired. */
  settleExpired(expired: E): Promise<LeaseSettlement>;
}

/**
 * One heartbeat: renews `held()` and calls `onLost` for each id the ledger did not renew, and for
 * each one it reports cancelled. An id that left `held()` while the renewal ran (the request
 * finished) is not lost, so it is not reported.
 */
export async function renewHeldLeases(options: {
  ledger: Pick<LeaseLedger<unknown>, "renew">;
  ownerId: string;
  held: () => string[];
  onLost: (id: string, reason: LeaseLossReason) => void;
}): Promise<void> {
  const ids = options.held();
  if (ids.length === 0) return;
  const { renewed, cancelled = [] } = await options.ledger.renew(options.ownerId, ids);
  const kept = new Set(renewed);
  const stillHeld = new Set(options.held());
  for (const id of ids) if (!kept.has(id) && stillHeld.has(id)) options.onLost(id, "lost");
  for (const id of cancelled) if (stillHeld.has(id)) options.onLost(id, "cancelled");
}

/** What one sweep did. `failures` are errors thrown while settling a row; the caller logs them. */
export interface SweepResult {
  settled: number;
  withoutEstimate: number;
  failures: unknown[];
}

const SWEEP_BATCH = 50;
const SWEEP_MAX_PASSES = 10;

/**
 * Settles reservations whose lease ran out. Safe to run on every replica at once: the ledger settles
 * a row for one caller only, and only while its lease is still out.
 */
export async function sweepExpiredLeases<E>(
  ledger: Pick<LeaseLedger<E>, "expired" | "settleExpired">,
  batch = SWEEP_BATCH,
): Promise<SweepResult> {
  const result: SweepResult = { settled: 0, withoutEstimate: 0, failures: [] };
  for (let pass = 0; pass < SWEEP_MAX_PASSES; pass++) {
    const expired = await ledger.expired(batch);
    let settledThisPass = 0;
    for (const item of expired) {
      try {
        const settlement = await ledger.settleExpired(item);
        if (settlement === "lostRace") continue;
        settledThisPass += 1;
        if (settlement === "settledWithoutEstimate") result.withoutEstimate += 1;
      } catch (error) {
        result.failures.push(error);
      }
    }
    result.settled += settledThisPass;
    if (expired.length < batch || settledThisPass === 0) break;
  }
  return result;
}

export interface LeaseTimersOptions {
  /** Names the timers, e.g. "coding-proxy". */
  name: string;
  /** Prefix of the log events, e.g. "proxy" for `proxy.lease_renew_failed`. */
  eventPrefix: string;
  heartbeatMs: number;
  sweepMs: number;
  /** One heartbeat: usually `renewHeldLeases`. */
  renew: () => Promise<void>;
  /** One sweep: usually `sweepExpiredLeases`. */
  sweep: () => Promise<SweepResult>;
  /** A renew or sweep still running after this long is abandoned so the next one can run. Default: twice its interval. */
  tickTimeoutMs?: number;
  /** Called once per failed or timed-out tick, with the stage that failed (metrics). */
  onError?: (stage: "renew" | "sweep") => void;
}

/**
 * The two periodic jobs that keep leases honest. Every process runs both. Neither throws: a failed
 * tick is reported and the next one tries again.
 */
export function startLeaseTimers(options: LeaseTimersOptions): { stop(): Promise<void> } {
  const heartbeat = startInterval({
    name: `${options.name}-lease-heartbeat`,
    everyMs: options.heartbeatMs,
    timeoutMs: options.tickTimeoutMs ?? options.heartbeatMs * 2,
    // A hung renewal is reported by the helper; a failed one is reported by the tick itself.
    onError: (kind) => {
      if (kind === "timeout") options.onError?.("renew");
    },
    tick: async () => {
      try {
        await options.renew();
      } catch (error) {
        options.onError?.("renew");
        leaseLog.warn(
          { event: `${options.eventPrefix}.lease_renew_failed`, err: error },
          `${options.name}: could not renew request leases`,
        );
      }
    },
  });
  const sweeper = startInterval({
    name: `${options.name}-lease-sweep`,
    everyMs: options.sweepMs,
    timeoutMs: options.tickTimeoutMs ?? options.sweepMs * 2,
    onError: (kind) => {
      if (kind === "timeout") options.onError?.("sweep");
    },
    tick: async () => {
      let result: SweepResult;
      try {
        result = await options.sweep();
      } catch (error) {
        options.onError?.("sweep");
        leaseLog.warn(
          { event: `${options.eventPrefix}.lease_sweep_failed`, err: error },
          `${options.name}: could not sweep expired leases`,
        );
        return;
      }
      for (const error of result.failures) {
        options.onError?.("sweep");
        leaseLog.warn(
          { event: `${options.eventPrefix}.lease_sweep_failed`, err: error },
          `${options.name}: could not settle an expired lease`,
        );
      }
      if (result.settled > 0) {
        leaseLog.warn(
          {
            event: `${options.eventPrefix}.lease_swept`,
            settled: result.settled,
            withoutEstimate: result.withoutEstimate,
          },
          `${options.name}: settled requests whose owner stopped renewing their lease`,
        );
      }
    },
  });
  return {
    stop: async () => {
      await Promise.all([heartbeat.stop(), sweeper.stop()]);
    },
  };
}
