import type { PrismaClient } from "#prisma";

export type SubstratePhase = "provisioning" | "running" | "requeued" | "stopped" | "removed";

export interface SubstrateRunRecord {
  runId: string;
  token: string;
  specHash: string;
  phase: SubstratePhase;
  deadlineAt: Date;
}

export interface SubstrateRunStore {
  /** Inserts; on an existing row returns it unchanged with created=false (the launch fence). */
  claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }>;
  get(runId: string): Promise<SubstrateRunRecord | undefined>;
  /** Moves the run to `phase`; with `from`, only when its current phase is listed (else substrate_phase_conflict). */
  setPhase(runId: string, phase: SubstratePhase, from?: SubstratePhase[]): Promise<SubstrateRunRecord>;
}

function phaseConflict(): Error {
  return new Error("substrate_phase_conflict");
}

function toRecord(row: {
  runId: string;
  token: string;
  specHash: string;
  phase: string;
  deadlineAt: Date;
}): SubstrateRunRecord {
  return {
    runId: row.runId,
    token: row.token,
    specHash: row.specHash,
    phase: row.phase as SubstratePhase,
    deadlineAt: row.deadlineAt,
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

  async setPhase(runId: string, phase: SubstratePhase, from?: SubstratePhase[]): Promise<SubstrateRunRecord> {
    const result = await this.db.substrateRun.updateMany({
      where: { runId, ...(from ? { phase: { in: from } } : {}) },
      data: { phase },
    });
    if (result.count === 0) throw phaseConflict();
    const row = await this.db.substrateRun.findUnique({ where: { runId } });
    if (!row) throw phaseConflict();
    return toRecord(row);
  }
}

export class MemorySubstrateRunStore implements SubstrateRunStore {
  private readonly rows = new Map<string, SubstrateRunRecord>();

  async claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }> {
    const existing = this.rows.get(record.runId);
    if (existing) return { created: false, record: { ...existing } };
    this.rows.set(record.runId, { ...record });
    return { created: true, record: { ...record } };
  }

  async get(runId: string): Promise<SubstrateRunRecord | undefined> {
    const row = this.rows.get(runId);
    return row ? { ...row } : undefined;
  }

  async setPhase(runId: string, phase: SubstratePhase, from?: SubstratePhase[]): Promise<SubstrateRunRecord> {
    const row = this.rows.get(runId);
    if (!row || (from && !from.includes(row.phase))) throw phaseConflict();
    row.phase = phase;
    return { ...row };
  }
}
