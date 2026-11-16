/**
 * Where a Substrate startup canary's verdict waits for the launcher (substrate-launcher.ts): the
 * launcher creates the row before the canary actor starts, the gateway's unauthenticated canary
 * route records the verdict once, and the launcher reads it and deletes the actor and then the row.
 * A row left by a process that died mid-canary names an actor to sweep (`stale`).
 *
 * The route takes no credential, so the row is what limits it: a report counts only for an actor
 * name that already has a row (random, `wr-<20 hex>-canary`), only once, and only within
 * CANARY_REPORT_WINDOW_MS of the row's creation. The row holds no credential and no run data.
 */

import type { PrismaClient } from "#prisma";
import { NATIVE_CANARY_RESULTS, type NativeCanaryResult } from "./protocol.js";

/** How long after its row is created a canary's report is accepted. */
export const CANARY_REPORT_WINDOW_MS = 10 * 60_000;

export interface NativeCanaryStore {
  create(actor: string, template: string): Promise<void>;
  /** Sets result and reportedAt once, for a row created in the last 10 minutes; whether a row took it. */
  report(actor: string, result: NativeCanaryResult, at: Date): Promise<boolean>;
  result(actor: string): Promise<NativeCanaryResult | undefined>;
  delete(actor: string): Promise<void>;
  /**
   * Actors whose row was created before `before`, oldest first. A row outlives its canary only when
   * the process died mid-canary (or could not delete the actor): the launcher's sweep deletes the
   * actor, its policy and then the row.
   */
  stale(before: Date): Promise<string[]>;
}

const KNOWN: ReadonlySet<string> = new Set(NATIVE_CANARY_RESULTS);

/** A stored result, or undefined for none (or a value this version does not know). */
function asResult(value: string | null | undefined): NativeCanaryResult | undefined {
  return value && KNOWN.has(value) ? (value as NativeCanaryResult) : undefined;
}

export type NativeCanaryDb = Pick<PrismaClient, "nativeSubstrateCanary">;

export class PrismaNativeCanaryStore implements NativeCanaryStore {
  constructor(private readonly db: NativeCanaryDb) {}

  async create(actor: string, template: string): Promise<void> {
    await this.db.nativeSubstrateCanary.create({ data: { actor, template } });
  }

  async report(actor: string, result: NativeCanaryResult, at: Date): Promise<boolean> {
    const { count } = await this.db.nativeSubstrateCanary.updateMany({
      where: { actor, result: null, createdAt: { gte: new Date(at.getTime() - CANARY_REPORT_WINDOW_MS) } },
      data: { result, reportedAt: at },
    });
    return count === 1;
  }

  async result(actor: string): Promise<NativeCanaryResult | undefined> {
    const row = await this.db.nativeSubstrateCanary.findUnique({ where: { actor }, select: { result: true } });
    return asResult(row?.result);
  }

  async delete(actor: string): Promise<void> {
    await this.db.nativeSubstrateCanary.deleteMany({ where: { actor } });
  }

  async stale(before: Date): Promise<string[]> {
    const rows = await this.db.nativeSubstrateCanary.findMany({
      where: { createdAt: { lt: before } },
      orderBy: { createdAt: "asc" },
      select: { actor: true },
    });
    return rows.map((row) => row.actor);
  }
}

/** The same contract in memory (tests, and a process with no database). */
export class MemoryNativeCanaryStore implements NativeCanaryStore {
  readonly rows = new Map<
    string,
    { template: string; result?: NativeCanaryResult; createdAt: Date; reportedAt?: Date }
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(actor: string, template: string): Promise<void> {
    if (this.rows.has(actor)) throw new Error("native_substrate_canary_exists");
    this.rows.set(actor, { template, createdAt: this.now() });
  }

  async report(actor: string, result: NativeCanaryResult, at: Date): Promise<boolean> {
    const row = this.rows.get(actor);
    if (!row || row.result !== undefined) return false;
    if (row.createdAt.getTime() < at.getTime() - CANARY_REPORT_WINDOW_MS) return false;
    row.result = result;
    row.reportedAt = at;
    return true;
  }

  async result(actor: string): Promise<NativeCanaryResult | undefined> {
    return this.rows.get(actor)?.result;
  }

  async delete(actor: string): Promise<void> {
    this.rows.delete(actor);
  }

  async stale(before: Date): Promise<string[]> {
    return [...this.rows.entries()]
      .filter(([, row]) => row.createdAt.getTime() < before.getTime())
      .sort(([, a], [, b]) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(([actor]) => actor);
  }
}
