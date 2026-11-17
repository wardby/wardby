/**
 * Where a Substrate startup canary's verdict waits for the launcher (substrate-launcher.ts): the
 * launcher creates the row before the canary actor starts, the gateway's canary route records the
 * verdict once, and the launcher reads it and deletes the actor, its Secret and then the row. A row
 * left by a process that died mid-canary names an actor (and Secret) to sweep (`stale`).
 *
 * Each canary has its own short-lived capability, which only its Secret holds (the egress gateway
 * puts it on the canary's report on the wire); the row keeps only its hash. A report counts only
 * with that capability for that actor (random, `wr-<20 hex>-canary`), only once, and only within
 * CANARY_REPORT_WINDOW_MS of the row's creation. The row holds no credential and no run data.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { NATIVE_CANARY_RESULTS, type NativeCanaryResult } from "./protocol.js";

/** The upper bound of SUBSTRATE_NATIVE_GOLDEN_WAIT_SEC (config/providers.ts). */
export const SUBSTRATE_NATIVE_GOLDEN_WAIT_MAX_SEC = 600;
/** How long the launcher waits for a canary's verdict after its actor resumes. */
export const NATIVE_CANARY_TIMEOUT_MS = 120_000;
/**
 * How long after its row is created a canary's report is accepted: at least the longest a canary
 * can run (the longest golden wait for its resume, then the verdict timeout), plus a minute for
 * the calls in between. A report later than that has no launcher waiting for it.
 */
export const CANARY_REPORT_WINDOW_MS = SUBSTRATE_NATIVE_GOLDEN_WAIT_MAX_SEC * 1_000 + NATIVE_CANARY_TIMEOUT_MS + 60_000;

/** What a canary row keeps of its capability: the SHA-256 hex digest, never the capability itself. */
export function canaryCapabilityHash(capability: string): string {
  return createHash("sha256").update(capability).digest("hex");
}

export interface NativeCanaryStore {
  create(actor: string, template: string, capabilityHash: string): Promise<void>;
  /**
   * Sets result and reportedAt once, for the row of `actor` whose capability hashes to
   * `capabilityHash` and which was created within CANARY_REPORT_WINDOW_MS; whether a row took it.
   */
  report(actor: string, capabilityHash: string, result: NativeCanaryResult, at: Date): Promise<boolean>;
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

  async create(actor: string, template: string, capabilityHash: string): Promise<void> {
    await this.db.nativeSubstrateCanary.create({ data: { actor, template, capabilityHash } });
  }

  async report(actor: string, capabilityHash: string, result: NativeCanaryResult, at: Date): Promise<boolean> {
    const { count } = await this.db.nativeSubstrateCanary.updateMany({
      where: {
        actor,
        capabilityHash,
        result: null,
        createdAt: { gte: new Date(at.getTime() - CANARY_REPORT_WINDOW_MS) },
      },
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
    { template: string; capabilityHash?: string; result?: NativeCanaryResult; createdAt: Date; reportedAt?: Date }
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(actor: string, template: string, capabilityHash: string): Promise<void> {
    if (this.rows.has(actor)) throw new Error("native_substrate_canary_exists");
    this.rows.set(actor, { template, capabilityHash, createdAt: this.now() });
  }

  async report(actor: string, capabilityHash: string, result: NativeCanaryResult, at: Date): Promise<boolean> {
    const row = this.rows.get(actor);
    if (!row || row.result !== undefined) return false;
    if (row.capabilityHash === undefined || row.capabilityHash !== capabilityHash) return false;
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
