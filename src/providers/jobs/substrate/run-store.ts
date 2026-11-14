import type { PrismaClient } from "#prisma";

/**
 * provisioning, running and requeued are active. The rest are terminal and never change except to
 * `removed`: stopped (stop()), and the outcomes the launcher observed itself rather than read from a
 * reported result — timed_out, lost (an actor is gone), crashed (the agent actor), tool_failed (the
 * tool actor), provisioning_failed (launch failed after the fence), collect_timeout (the worker
 * exited but the workspace never arrived) and startup_timeout (an actor never reached the proxy).
 *
 * Warm rounds (SUBSTRATE_WARM_ROUNDS) only: parked (a succeeded run whose actors are suspended for a
 * follow-up; its deadlineAt is when the park expires) and adopted (a parked run another run took
 * over: its row then holds retiredRunToken(runId), and the adopter holds the original token).
 */
export type SubstratePhase =
  | "provisioning"
  | "running"
  | "requeued"
  | "stopped"
  | "removed"
  | "timed_out"
  | "lost"
  | "crashed"
  | "tool_failed"
  | "provisioning_failed"
  | "collect_timeout"
  | "startup_timeout"
  | "parked"
  | "adopted";

export interface SubstrateRunRecord {
  runId: string;
  token: string;
  specHash: string;
  phase: SubstratePhase;
  deadlineAt: Date;
  /**
   * Set by the store (ignored on claim): when the row last changed. While a run is `running` and
   * neither actor has reached the proxy, that is when it became running: the relay's own writes to
   * the row (channels, lines) only start once the agent has its input.
   */
  updatedAt?: Date;
}

export interface SubstrateRunStore {
  /** Inserts; on an existing row returns it unchanged with created=false (the launch fence). */
  claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }>;
  get(runId: string): Promise<SubstrateRunRecord | undefined>;
  /** The run named by a handle's token (substrateRunToken(runId)). */
  getByToken(token: string): Promise<SubstrateRunRecord | undefined>;
  /** Moves a requeued run back to provisioning with a fresh deadline; undefined when it is not requeued. */
  reclaim(runId: string, deadlineAt: Date): Promise<SubstrateRunRecord | undefined>;
  /**
   * Moves the run to `phase`; with `from`, only when its current phase is listed (else
   * substrate_phase_conflict). `deadlineAt`, when given, is written with it (a park's expiry).
   */
  setPhase(
    runId: string,
    phase: SubstratePhase,
    from?: SubstratePhase[],
    deadlineAt?: Date,
  ): Promise<SubstrateRunRecord>;
  /**
   * Warm rounds: atomically moves the parked run `parkedRunId` to `adopted` under `retiredToken`
   * and inserts `record` (which carries the parked run's token). Undefined, with nothing changed,
   * when that run is no longer parked or `record.runId` already has a row.
   */
  adopt(parkedRunId: string, retiredToken: string, record: SubstrateRunRecord): Promise<SubstrateRunRecord | undefined>;
  /** Warm rounds: every run in `phase` (the sweep of expired parked runs). */
  listByPhase(phase: SubstratePhase): Promise<SubstrateRunRecord[]>;
}

/** Rolls back an adoption whose run is no longer parked (never leaves the store). */
const NOT_ADOPTED = "substrate_not_adopted";

function phaseConflict(): Error {
  return new Error("substrate_phase_conflict");
}

function toRecord(row: {
  runId: string;
  token: string;
  specHash: string;
  phase: string;
  deadlineAt: Date;
  updatedAt: Date;
}): SubstrateRunRecord {
  return {
    runId: row.runId,
    token: row.token,
    specHash: row.specHash,
    phase: row.phase as SubstratePhase,
    deadlineAt: row.deadlineAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaSubstrateRunStore implements SubstrateRunStore {
  constructor(private readonly db: PrismaClient) {}

  async claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }> {
    try {
      const row = await this.db.substrateRun.create({
        data: {
          runId: record.runId,
          token: record.token,
          specHash: record.specHash,
          phase: record.phase,
          deadlineAt: record.deadlineAt,
        },
      });
      return { created: true, record: toRecord(row) };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const existing = await this.db.substrateRun.findUnique({ where: { runId: record.runId } });
      if (!existing) throw error;
      return { created: false, record: toRecord(existing) };
    }
  }

  async get(runId: string): Promise<SubstrateRunRecord | undefined> {
    const row = await this.db.substrateRun.findUnique({ where: { runId } });
    return row ? toRecord(row) : undefined;
  }

  async getByToken(token: string): Promise<SubstrateRunRecord | undefined> {
    const row = await this.db.substrateRun.findUnique({ where: { token } });
    return row ? toRecord(row) : undefined;
  }

  async reclaim(runId: string, deadlineAt: Date): Promise<SubstrateRunRecord | undefined> {
    const result = await this.db.substrateRun.updateMany({
      where: { runId, phase: "requeued" },
      data: { phase: "provisioning", deadlineAt },
    });
    if (result.count === 0) return undefined;
    return this.get(runId);
  }

  async setPhase(
    runId: string,
    phase: SubstratePhase,
    from?: SubstratePhase[],
    deadlineAt?: Date,
  ): Promise<SubstrateRunRecord> {
    const result = await this.db.substrateRun.updateMany({
      where: { runId, ...(from ? { phase: { in: from } } : {}) },
      data: { phase, ...(deadlineAt ? { deadlineAt } : {}) },
    });
    if (result.count === 0) throw phaseConflict();
    const row = await this.db.substrateRun.findUnique({ where: { runId } });
    if (!row) throw phaseConflict();
    return toRecord(row);
  }

  async adopt(
    parkedRunId: string,
    retiredToken: string,
    record: SubstrateRunRecord,
  ): Promise<SubstrateRunRecord | undefined> {
    try {
      return await this.db.$transaction(async (tx) => {
        const moved = await tx.substrateRun.updateMany({
          where: { runId: parkedRunId, phase: "parked", token: record.token },
          data: { phase: "adopted", token: retiredToken },
        });
        // Throwing rolls the transaction back; the sentinel is mapped to undefined below.
        if (moved.count === 0) throw new Error(NOT_ADOPTED);
        const row = await tx.substrateRun.create({
          data: {
            runId: record.runId,
            token: record.token,
            specHash: record.specHash,
            phase: record.phase,
            deadlineAt: record.deadlineAt,
          },
        });
        return toRecord(row);
      });
    } catch (error) {
      if (error instanceof Error && error.message === NOT_ADOPTED) return undefined;
      if ((error as { code?: string }).code === "P2002") return undefined;
      throw error;
    }
  }

  async listByPhase(phase: SubstratePhase): Promise<SubstrateRunRecord[]> {
    const rows = await this.db.substrateRun.findMany({ where: { phase }, orderBy: { runId: "asc" } });
    return rows.map(toRecord);
  }
}

export class MemorySubstrateRunStore implements SubstrateRunStore {
  private readonly rows = new Map<string, SubstrateRunRecord>();

  /** `now` stamps updatedAt on every write (tests pass their clock). */
  constructor(private readonly now: () => number = Date.now) {}

  async claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }> {
    const existing = this.rows.get(record.runId);
    if (existing) return { created: false, record: { ...existing } };
    const row = { ...record, updatedAt: new Date(this.now()) };
    this.rows.set(record.runId, row);
    return { created: true, record: { ...row } };
  }

  async get(runId: string): Promise<SubstrateRunRecord | undefined> {
    const row = this.rows.get(runId);
    return row ? { ...row } : undefined;
  }

  async getByToken(token: string): Promise<SubstrateRunRecord | undefined> {
    const row = [...this.rows.values()].find((candidate) => candidate.token === token);
    return row ? { ...row } : undefined;
  }

  async reclaim(runId: string, deadlineAt: Date): Promise<SubstrateRunRecord | undefined> {
    const row = this.rows.get(runId);
    if (!row || row.phase !== "requeued") return undefined;
    row.phase = "provisioning";
    row.deadlineAt = deadlineAt;
    row.updatedAt = new Date(this.now());
    return { ...row };
  }

  async setPhase(
    runId: string,
    phase: SubstratePhase,
    from?: SubstratePhase[],
    deadlineAt?: Date,
  ): Promise<SubstrateRunRecord> {
    const row = this.rows.get(runId);
    if (!row || (from && !from.includes(row.phase))) throw phaseConflict();
    row.phase = phase;
    if (deadlineAt) row.deadlineAt = deadlineAt;
    row.updatedAt = new Date(this.now());
    return { ...row };
  }

  async adopt(
    parkedRunId: string,
    retiredToken: string,
    record: SubstrateRunRecord,
  ): Promise<SubstrateRunRecord | undefined> {
    const parked = this.rows.get(parkedRunId);
    if (!parked || parked.phase !== "parked" || parked.token !== record.token || this.rows.has(record.runId)) {
      return undefined;
    }
    parked.phase = "adopted";
    parked.token = retiredToken;
    parked.updatedAt = new Date(this.now());
    const row = { ...record, updatedAt: new Date(this.now()) };
    this.rows.set(record.runId, row);
    return { ...row };
  }

  async listByPhase(phase: SubstratePhase): Promise<SubstrateRunRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.phase === phase)
      .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
      .map((row) => ({ ...row }));
  }
}
