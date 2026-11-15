import type { PrismaClient } from "#prisma";
import type { WarmColdReason } from "../types.js";
import { isCodingRepositoryName, MAX_RUN_REPOSITORIES_IN_INPUT } from "../../../coding/protocol.js";
import { retiredRunToken } from "./names.js";

/**
 * provisioning, running and requeued are active. The rest are terminal and never change except to
 * `removed`: stopped (stop()), and the outcomes the launcher observed itself rather than read from a
 * reported result — timed_out, lost (an actor is gone), crashed (the agent actor), tool_failed (the
 * tool actor), provisioning_failed (launch failed after the fence), collect_timeout (the worker
 * exited but the workspace never arrived), startup_timeout (an actor never reached the proxy),
 * bridge_incompatible (the proxy refused a bridge of another protocol, BRIDGE_PROTOCOL_RANGE) and
 * image_incomplete (the workspace holder's image check reported a missing prerequisite).
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
  | "bridge_incompatible"
  | "image_incomplete"
  | "parked"
  | "adopted";

/** pair = agent + tool actors (Claude Code); single = one agent actor that also holds the workspace (Codex). */
export type SubstrateActorShape = "pair" | "single";

/** One extra repository of a run, as its row records it: never its host path. */
export interface SubstrateRunRepository {
  name: string;
  access: "read" | "write";
}

/** A run's actor shape and extra repositories (the proxy's layout lookup). */
export interface SubstrateRunLayout {
  shape: SubstrateActorShape;
  repositories?: SubstrateRunRepository[];
}

/**
 * The column's value as records carry it: 1 to MAX_RUN_REPOSITORIES_IN_INPUT entries, each exactly
 * { name, access } with a valid link name and no name twice; undefined for null or anything else.
 */
export function parseRunRepositories(value: unknown): SubstrateRunRepository[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RUN_REPOSITORIES_IN_INPUT) return undefined;
  const seen = new Set<string>();
  const out: SubstrateRunRepository[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("name") || !keys.includes("access")) return undefined;
    const { name, access } = entry as { name: unknown; access: unknown };
    if (typeof name !== "string" || !isCodingRepositoryName(name) || seen.has(name)) return undefined;
    if (access !== "read" && access !== "write") return undefined;
    seen.add(name);
    out.push({ name, access });
  }
  return out;
}

export interface SubstrateRunRecord {
  runId: string;
  token: string;
  specHash: string;
  phase: SubstratePhase;
  deadlineAt: Date;
  /**
   * The round this row's actors are on: 1 on a claim (the store's default when absent), the parked
   * run's + 1 on an adopter. Always present on a record the store returns.
   */
  round?: number;
  /** The run's agent (JobSpec.agentId), when the spec carried it. */
  agentId?: string;
  /** Warm rounds, set by park(): the commit the round pushed and the agent fingerprint it ran with. */
  headSha?: string;
  fingerprint?: string;
  /** Warm rounds: when park() parked the run. */
  parkedAt?: Date;
  /** Warm rounds: why this continuation launched cold (set on claim, or on reclaim of a refused adopter). */
  coldReason?: WarmColdReason;
  /** Set on claim (absent = pair); always present on a record the store returns. An adopter is always pair. */
  actorShape?: SubstrateActorShape;
  /** Set on claim (spec order) for a run with extra repositories; absent otherwise. Names and access only. */
  repositories?: SubstrateRunRepository[];
  /**
   * Set by the store (ignored on claim) when the row holds a repositories value that does not parse
   * (never written by claim): the record then carries no repositories, so removal cannot name the
   * extras' blobs, and the launcher logs that (a fixed event, no content).
   */
  repositoriesUnreadable?: true;
  /**
   * Set by the store (ignored on claim): when the row last changed. While a run is `running` and
   * neither actor has reached the proxy, that is when it became running: the relay's own writes to
   * the row (channels, lines) only start once the agent has its input.
   */
  updatedAt?: Date;
}

/** What park() records. `expiresAt` becomes the row's deadlineAt (the park's expiry). */
export interface SubstrateParkFields {
  headSha?: string;
  fingerprint?: string;
  parkedAt: Date;
  round: number;
  expiresAt: Date;
}

/** The adopter's own fields, which the parked row does not give it. */
export interface SubstrateAdoptFields {
  specHash: string;
  agentId?: string;
}

export interface SubstrateRunStore {
  /** Inserts; on an existing row returns it unchanged with created=false (the launch fence). */
  claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }>;
  get(runId: string): Promise<SubstrateRunRecord | undefined>;
  /** The run whose row holds `token` (substrateRunToken(runId), or a parked run's token on its adopter). */
  getByToken(token: string): Promise<SubstrateRunRecord | undefined>;
  /**
   * Moves a requeued run back to provisioning with a fresh deadline, at round 1 (a relaunch after a
   * capacity refusal is always cold: the refused attempt was cleaned up); undefined when it is not
   * requeued. `coldReason`, when given, is recorded with it (a refused adopter: `capacity`).
   */
  reclaim(
    runId: string,
    deadlineAt: Date,
    fields?: { coldReason?: WarmColdReason },
  ): Promise<SubstrateRunRecord | undefined>;
  /**
   * Moves the run to `phase`; with `from`, only when its current phase is listed (else
   * substrate_phase_conflict). `deadlineAt`, when given, is written with it.
   */
  setPhase(
    runId: string,
    phase: SubstratePhase,
    from?: SubstratePhase[],
    deadlineAt?: Date,
  ): Promise<SubstrateRunRecord>;
  /**
   * Warm rounds: moves a running run to `parked` with what it was parked with; its deadlineAt becomes
   * `expiresAt`. substrate_phase_conflict when the run is not running.
   */
  park(runId: string, fields: SubstrateParkFields): Promise<SubstrateRunRecord>;
  /**
   * Warm rounds, in one transaction: the parked, unexpired run `fromRunId` moves to `adopted` under
   * retiredRunToken(fromRunId), and `newRunId` gets a row holding its token, in provisioning, at its
   * round + 1, with `newDeadline`. Undefined, with nothing changed, when that run is not parked, its
   * park has expired, or `newRunId` already has a row.
   */
  adopt(
    fromRunId: string,
    newRunId: string,
    newDeadline: Date,
    fields: SubstrateAdoptFields,
  ): Promise<SubstrateRunRecord | undefined>;
  /** Warm rounds: parked runs, oldest park first; `olderThan` keeps those parked before it. */
  listParked(options?: { olderThan?: Date; limit?: number }): Promise<SubstrateRunRecord[]>;
  /** Warm rounds: how many runs are parked. */
  countParked(): Promise<number>;
}

/** Rolls back an adoption whose run is no longer parked (never leaves the store). */
const NOT_ADOPTED = "substrate_not_adopted";

function phaseConflict(): Error {
  return new Error("substrate_phase_conflict");
}

interface Row {
  runId: string;
  token: string;
  specHash: string;
  phase: string;
  deadlineAt: Date;
  round: number;
  agentId: string | null;
  headSha: string | null;
  fingerprint: string | null;
  parkedAt: Date | null;
  coldReason: string | null;
  actorShape: string;
  repositories: unknown;
  updatedAt: Date;
}

function toRecord(row: Row): SubstrateRunRecord {
  const repositories = parseRunRepositories(row.repositories);
  return {
    runId: row.runId,
    token: row.token,
    specHash: row.specHash,
    phase: row.phase as SubstratePhase,
    deadlineAt: row.deadlineAt,
    round: row.round,
    ...(row.agentId !== null ? { agentId: row.agentId } : {}),
    ...(row.headSha !== null ? { headSha: row.headSha } : {}),
    ...(row.fingerprint !== null ? { fingerprint: row.fingerprint } : {}),
    ...(row.parkedAt !== null ? { parkedAt: row.parkedAt } : {}),
    ...(row.coldReason !== null ? { coldReason: row.coldReason as WarmColdReason } : {}),
    actorShape: row.actorShape === "single" ? "single" : "pair",
    ...(repositories ? { repositories } : {}),
    ...(row.repositories !== null && !repositories ? { repositoriesUnreadable: true as const } : {}),
    updatedAt: row.updatedAt,
  };
}

function validLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("substrate_list_limit_invalid");
  return limit;
}

export class PrismaSubstrateRunStore implements SubstrateRunStore {
  /** `now` decides whether a park has expired (tests pass their clock). */
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => number = Date.now,
  ) {}

  async claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }> {
    try {
      const row = await this.db.substrateRun.create({
        data: {
          runId: record.runId,
          token: record.token,
          specHash: record.specHash,
          phase: record.phase,
          deadlineAt: record.deadlineAt,
          round: record.round ?? 1,
          agentId: record.agentId ?? null,
          coldReason: record.coldReason ?? null,
          actorShape: record.actorShape ?? "pair",
          ...(record.repositories
            ? { repositories: record.repositories.map(({ name, access }) => ({ name, access })) }
            : {}),
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

  async reclaim(
    runId: string,
    deadlineAt: Date,
    fields: { coldReason?: WarmColdReason } = {},
  ): Promise<SubstrateRunRecord | undefined> {
    const result = await this.db.substrateRun.updateMany({
      where: { runId, phase: "requeued" },
      data: {
        phase: "provisioning",
        deadlineAt,
        round: 1,
        ...(fields.coldReason !== undefined ? { coldReason: fields.coldReason } : {}),
      },
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

  async park(runId: string, fields: SubstrateParkFields): Promise<SubstrateRunRecord> {
    const result = await this.db.substrateRun.updateMany({
      where: { runId, phase: "running" },
      data: {
        phase: "parked",
        deadlineAt: fields.expiresAt,
        parkedAt: fields.parkedAt,
        round: fields.round,
        headSha: fields.headSha ?? null,
        fingerprint: fields.fingerprint ?? null,
      },
    });
    if (result.count === 0) throw phaseConflict();
    const row = await this.db.substrateRun.findUnique({ where: { runId } });
    if (!row) throw phaseConflict();
    return toRecord(row);
  }

  async adopt(
    fromRunId: string,
    newRunId: string,
    newDeadline: Date,
    fields: SubstrateAdoptFields,
  ): Promise<SubstrateRunRecord | undefined> {
    const now = new Date(this.now());
    try {
      return await this.db.$transaction(async (tx) => {
        const parked = await tx.substrateRun.findUnique({ where: { runId: fromRunId } });
        if (!parked || parked.phase !== "parked" || parked.deadlineAt <= now) throw new Error(NOT_ADOPTED);
        // Guarded on what was read, so a concurrent adopter or sweep wins cleanly.
        const moved = await tx.substrateRun.updateMany({
          where: { runId: fromRunId, phase: "parked", token: parked.token, deadlineAt: { gt: now } },
          data: { phase: "adopted", token: retiredRunToken(fromRunId) },
        });
        // Throwing rolls the transaction back; the sentinel is mapped to undefined below.
        if (moved.count === 0) throw new Error(NOT_ADOPTED);
        const row = await tx.substrateRun.create({
          data: {
            runId: newRunId,
            token: parked.token,
            specHash: fields.specHash,
            phase: "provisioning",
            deadlineAt: newDeadline,
            round: parked.round + 1,
            agentId: fields.agentId ?? null,
            actorShape: "pair",
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

  async listParked(options: { olderThan?: Date; limit?: number } = {}): Promise<SubstrateRunRecord[]> {
    const limit = validLimit(options.limit);
    const rows = await this.db.substrateRun.findMany({
      where: { phase: "parked", ...(options.olderThan ? { parkedAt: { lt: options.olderThan } } : {}) },
      orderBy: [{ parkedAt: { sort: "asc", nulls: "last" } }, { runId: "asc" }],
      ...(limit !== undefined ? { take: limit } : {}),
    });
    return rows.map(toRecord);
  }

  async countParked(): Promise<number> {
    return this.db.substrateRun.count({ where: { phase: "parked" } });
  }
}

export class MemorySubstrateRunStore implements SubstrateRunStore {
  private readonly rows = new Map<string, SubstrateRunRecord>();

  /** `now` stamps updatedAt on every write and decides whether a park has expired (tests pass their clock). */
  constructor(private readonly now: () => number = Date.now) {}

  async claim(record: SubstrateRunRecord): Promise<{ created: boolean; record: SubstrateRunRecord }> {
    const existing = this.rows.get(record.runId);
    if (existing) return { created: false, record: copy(existing) };
    const row: SubstrateRunRecord = {
      runId: record.runId,
      token: record.token,
      specHash: record.specHash,
      phase: record.phase,
      deadlineAt: record.deadlineAt,
      round: record.round ?? 1,
      ...(record.agentId !== undefined ? { agentId: record.agentId } : {}),
      ...(record.coldReason !== undefined ? { coldReason: record.coldReason } : {}),
      actorShape: record.actorShape ?? "pair",
      ...(record.repositories
        ? { repositories: record.repositories.map(({ name, access }) => ({ name, access })) }
        : {}),
      updatedAt: new Date(this.now()),
    };
    this.rows.set(record.runId, row);
    return { created: true, record: copy(row) };
  }

  async get(runId: string): Promise<SubstrateRunRecord | undefined> {
    const row = this.rows.get(runId);
    return row ? copy(row) : undefined;
  }

  async getByToken(token: string): Promise<SubstrateRunRecord | undefined> {
    const row = [...this.rows.values()].find((candidate) => candidate.token === token);
    return row ? copy(row) : undefined;
  }

  async reclaim(
    runId: string,
    deadlineAt: Date,
    fields: { coldReason?: WarmColdReason } = {},
  ): Promise<SubstrateRunRecord | undefined> {
    const row = this.rows.get(runId);
    if (!row || row.phase !== "requeued") return undefined;
    row.phase = "provisioning";
    row.deadlineAt = deadlineAt;
    row.round = 1;
    if (fields.coldReason !== undefined) row.coldReason = fields.coldReason;
    row.updatedAt = new Date(this.now());
    return copy(row);
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
    return copy(row);
  }

  async park(runId: string, fields: SubstrateParkFields): Promise<SubstrateRunRecord> {
    const row = this.rows.get(runId);
    if (!row || row.phase !== "running") throw phaseConflict();
    row.phase = "parked";
    row.deadlineAt = fields.expiresAt;
    row.parkedAt = fields.parkedAt;
    row.round = fields.round;
    if (fields.headSha !== undefined) row.headSha = fields.headSha;
    else delete row.headSha;
    if (fields.fingerprint !== undefined) row.fingerprint = fields.fingerprint;
    else delete row.fingerprint;
    row.updatedAt = new Date(this.now());
    return copy(row);
  }

  async adopt(
    fromRunId: string,
    newRunId: string,
    newDeadline: Date,
    fields: SubstrateAdoptFields,
  ): Promise<SubstrateRunRecord | undefined> {
    const parked = this.rows.get(fromRunId);
    if (!parked || parked.phase !== "parked" || parked.deadlineAt.getTime() <= this.now() || this.rows.has(newRunId)) {
      return undefined;
    }
    const token = parked.token;
    parked.phase = "adopted";
    parked.token = retiredRunToken(fromRunId);
    parked.updatedAt = new Date(this.now());
    const row: SubstrateRunRecord = {
      runId: newRunId,
      token,
      specHash: fields.specHash,
      phase: "provisioning",
      deadlineAt: newDeadline,
      round: (parked.round ?? 1) + 1,
      ...(fields.agentId !== undefined ? { agentId: fields.agentId } : {}),
      actorShape: "pair",
      updatedAt: new Date(this.now()),
    };
    this.rows.set(newRunId, row);
    return copy(row);
  }

  async listParked(options: { olderThan?: Date; limit?: number } = {}): Promise<SubstrateRunRecord[]> {
    const limit = validLimit(options.limit);
    const olderThan = options.olderThan?.getTime();
    const parked = [...this.rows.values()]
      .filter((row) => row.phase === "parked")
      .filter((row) => olderThan === undefined || (row.parkedAt !== undefined && row.parkedAt.getTime() < olderThan))
      .sort((a, b) => {
        // As Postgres orders them: by parkedAt (a row without one last), then by run id.
        const at = (row: SubstrateRunRecord) => row.parkedAt?.getTime() ?? Number.POSITIVE_INFINITY;
        if (at(a) !== at(b)) return at(a) - at(b);
        return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
      });
    return (limit !== undefined ? parked.slice(0, limit) : parked).map(copy);
  }

  async countParked(): Promise<number> {
    return [...this.rows.values()].filter((row) => row.phase === "parked").length;
  }
}

function copy(row: SubstrateRunRecord): SubstrateRunRecord {
  return structuredClone(row);
}
