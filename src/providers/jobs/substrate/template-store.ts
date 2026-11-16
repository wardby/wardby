/**
 * The Substrate launcher's record of the actor templates it created (SubstrateTemplate): one row per
 * template name, for readiness (golden-snapshot failures in a window, a template that never became
 * ready) and cleanup (templates no run has used for SUBSTRATE_TEMPLATE_TTL_SEC). Control plane only;
 * a row never holds a secret: a name, an atespace, a role, an image digest, counters and times.
 */
import type { PrismaClient } from "#prisma";

export type SubstrateTemplateRole = "agent" | "tool" | "codex";

/** A template row. Never a secret: a name, an atespace, a role, an image digest, counters and times. */
export interface SubstrateTemplateRecord {
  name: string;
  atespace: string;
  role: SubstrateTemplateRole;
  image: string;
  createdAt: Date;
  lastUsedAt: Date;
  goldenFailures: number;
  lastFailureAt?: Date;
  readyAt?: Date;
}

/** What a launch knows of a template when it records it. */
export interface SubstrateTemplateRef {
  name: string;
  atespace: string;
  role: SubstrateTemplateRole;
  image: string;
}

export interface SubstrateTemplateStore {
  /** Creates the row (createdAt = lastUsedAt = at) or sets its lastUsedAt to `at`. A concurrent create is retried as an update. */
  touch(template: SubstrateTemplateRef, at: Date): Promise<void>;
  /** Sets lastUsedAt = at on each named row that exists (park, adopt); other names are ignored. */
  touchNames(names: readonly string[], at: Date): Promise<void>;
  get(name: string): Promise<SubstrateTemplateRecord | undefined>;
  /**
   * Records a golden-snapshot failure seen at `at`, atomically (see nextGoldenFailure): a new window,
   * the same build as the window's first failure (seen within `sameBuildMs` of it: not counted again),
   * or one more failure. Returns the window's count and whether it was the same build; failures 0 when
   * the row does not exist.
   */
  recordGoldenFailure(name: string, at: Date, windowMs: number, sameBuildMs: number): Promise<GoldenFailureCount>;
  /**
   * Takes back a failure recordGoldenFailure counted (its `failures`) for a launch that then could not
   * rebuild the template, so no build was tried: goldenFailures - 1, only while it is still `failures`
   * (no later failure was counted). The window's anchor stays, so a launch that sees the same failed
   * build within sameBuildMs still requeues. Nothing for a missing row or failures < 1.
   */
  withdrawGoldenFailure(name: string, failures: number): Promise<void>;
  /** Sets readyAt = at on each named row whose readyAt is null. */
  markReady(names: readonly string[], at: Date): Promise<void>;
  /** Rows with lastUsedAt < cutoff, least recently used first, at most `limit`. */
  listUnusedBefore(cutoff: Date, limit: number): Promise<SubstrateTemplateRecord[]>;
  /** Deletes the row only while its lastUsedAt < cutoff; whether it did. */
  deleteIfUnusedBefore(name: string, cutoff: Date): Promise<boolean>;
  /** Inserts the row as given unless one with its name exists (undo a sweep's row delete). */
  restore(record: SubstrateTemplateRecord): Promise<void>;
}

/** What recordGoldenFailure saw. */
export interface GoldenFailureCount {
  /** The golden-snapshot failures in the window, this one included (0: no row). */
  failures: number;
  /**
   * The failure was seen within sameBuildMs of the window's first failure: the build that failure
   * already counted (another launch saw it too, before the template was rebuilt), so not counted again.
   */
  sameBuild: boolean;
}

/**
 * One golden-snapshot failure at `at` against a row's window. No failure yet, or the window's first
 * failure more than `windowMs` before `at`: a new window (goldenFailures 1, lastFailureAt = at, readyAt
 * cleared). Within `sameBuildMs` of the window's first failure (or before it, on a skewed clock): the
 * same build, nothing written. Otherwise goldenFailures + 1, lastFailureAt unchanged. A rebuild takes a
 * fresh golden snapshot build, so a distinct build's failure comes later than `sameBuildMs`; one that
 * comes sooner is taken as the same build, which requeues rather than fails (fails safe).
 */
function nextGoldenFailure(
  row: { goldenFailures: number; lastFailureAt?: Date },
  at: Date,
  windowMs: number,
  sameBuildMs: number,
): { result: GoldenFailureCount; data?: { goldenFailures: number; lastFailureAt?: Date; readyAt?: null } } {
  const first = row.lastFailureAt?.getTime();
  if (first === undefined || first < at.getTime() - windowMs) {
    return {
      result: { failures: 1, sameBuild: false },
      data: { goldenFailures: 1, lastFailureAt: new Date(at), readyAt: null },
    };
  }
  if (at.getTime() - first < sameBuildMs) return { result: { failures: row.goldenFailures, sameBuild: true } };
  return {
    result: { failures: row.goldenFailures + 1, sameBuild: false },
    data: { goldenFailures: row.goldenFailures + 1 },
  };
}

interface Row {
  name: string;
  atespace: string;
  role: string;
  image: string;
  createdAt: Date;
  lastUsedAt: Date;
  goldenFailures: number;
  lastFailureAt: Date | null;
  readyAt: Date | null;
}

/** Rows are only written by touch and restore, so `role` is always one of the three. */
function toRecord(row: Row): SubstrateTemplateRecord {
  return {
    name: row.name,
    atespace: row.atespace,
    role: row.role as SubstrateTemplateRole,
    image: row.image,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    goldenFailures: row.goldenFailures,
    ...(row.lastFailureAt !== null ? { lastFailureAt: row.lastFailureAt } : {}),
    ...(row.readyAt !== null ? { readyAt: row.readyAt } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === "P2002";
}

export class PrismaSubstrateTemplateStore implements SubstrateTemplateStore {
  constructor(private readonly db: PrismaClient) {}

  async touch(template: SubstrateTemplateRef, at: Date): Promise<void> {
    const { name, atespace, role, image } = template;
    const upsert = () =>
      this.db.substrateTemplate.upsert({
        where: { name },
        create: { name, atespace, role, image, createdAt: at, lastUsedAt: at },
        update: { lastUsedAt: at },
      });
    try {
      await upsert();
    } catch (error) {
      // Two launches created the row at once: the other's insert won, so this one is an update.
      if (!isUniqueViolation(error)) throw error;
      const { count } = await this.db.substrateTemplate.updateMany({ where: { name }, data: { lastUsedAt: at } });
      if (count === 1) return;
      // The cleanup sweep deleted that row in between: create it again. Another concurrent create
      // winning that too touched it just now, which is as good.
      try {
        await upsert();
      } catch (again) {
        if (!isUniqueViolation(again)) throw again;
      }
    }
  }

  async touchNames(names: readonly string[], at: Date): Promise<void> {
    if (names.length === 0) return;
    await this.db.substrateTemplate.updateMany({ where: { name: { in: [...names] } }, data: { lastUsedAt: at } });
  }

  async get(name: string): Promise<SubstrateTemplateRecord | undefined> {
    const row = await this.db.substrateTemplate.findUnique({ where: { name } });
    return row ? toRecord(row) : undefined;
  }

  async recordGoldenFailure(
    name: string,
    at: Date,
    windowMs: number,
    sameBuildMs: number,
  ): Promise<GoldenFailureCount> {
    // Under the row's lock: concurrent observers of one failure are serialized, so the first opens the
    // window and the others see it (the same build), however many replicas record at once.
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ goldenFailures: number; lastFailureAt: Date | null }[]>`
        SELECT "goldenFailures", "lastFailureAt" FROM "SubstrateTemplate" WHERE "name" = ${name} FOR UPDATE`;
      const row = locked[0];
      if (!row) return { failures: 0, sameBuild: false };
      const next = nextGoldenFailure(
        { goldenFailures: row.goldenFailures, ...(row.lastFailureAt ? { lastFailureAt: row.lastFailureAt } : {}) },
        at,
        windowMs,
        sameBuildMs,
      );
      if (next.data) await tx.substrateTemplate.update({ where: { name }, data: next.data });
      return next.result;
    });
  }

  async withdrawGoldenFailure(name: string, failures: number): Promise<void> {
    if (failures < 1) return;
    await this.db.substrateTemplate.updateMany({
      where: { name, goldenFailures: failures },
      data: { goldenFailures: failures - 1 },
    });
  }

  async markReady(names: readonly string[], at: Date): Promise<void> {
    if (names.length === 0) return;
    await this.db.substrateTemplate.updateMany({
      where: { name: { in: [...names] }, readyAt: null },
      data: { readyAt: at },
    });
  }

  async listUnusedBefore(cutoff: Date, limit: number): Promise<SubstrateTemplateRecord[]> {
    const rows = await this.db.substrateTemplate.findMany({
      where: { lastUsedAt: { lt: cutoff } },
      orderBy: [{ lastUsedAt: "asc" }, { name: "asc" }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async deleteIfUnusedBefore(name: string, cutoff: Date): Promise<boolean> {
    const { count } = await this.db.substrateTemplate.deleteMany({ where: { name, lastUsedAt: { lt: cutoff } } });
    return count === 1;
  }

  async restore(record: SubstrateTemplateRecord): Promise<void> {
    try {
      await this.db.substrateTemplate.create({
        data: {
          name: record.name,
          atespace: record.atespace,
          role: record.role,
          image: record.image,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          goldenFailures: record.goldenFailures,
          lastFailureAt: record.lastFailureAt ?? null,
          readyAt: record.readyAt ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

/** In-memory SubstrateTemplateStore, for tests and the launcher's harness. */
export class MemorySubstrateTemplateStore implements SubstrateTemplateStore {
  private readonly rows = new Map<string, SubstrateTemplateRecord>();

  async touch(template: SubstrateTemplateRef, at: Date): Promise<void> {
    const row = this.rows.get(template.name);
    if (row) {
      row.lastUsedAt = new Date(at);
      return;
    }
    this.rows.set(template.name, {
      name: template.name,
      atespace: template.atespace,
      role: template.role,
      image: template.image,
      createdAt: new Date(at),
      lastUsedAt: new Date(at),
      goldenFailures: 0,
    });
  }

  async touchNames(names: readonly string[], at: Date): Promise<void> {
    for (const name of names) {
      const row = this.rows.get(name);
      if (row) row.lastUsedAt = new Date(at);
    }
  }

  async get(name: string): Promise<SubstrateTemplateRecord | undefined> {
    const row = this.rows.get(name);
    return row ? structuredClone(row) : undefined;
  }

  async recordGoldenFailure(
    name: string,
    at: Date,
    windowMs: number,
    sameBuildMs: number,
  ): Promise<GoldenFailureCount> {
    const row = this.rows.get(name);
    if (!row) return { failures: 0, sameBuild: false };
    const next = nextGoldenFailure(row, at, windowMs, sameBuildMs);
    if (next.data) {
      row.goldenFailures = next.data.goldenFailures;
      if (next.data.lastFailureAt) row.lastFailureAt = next.data.lastFailureAt;
      if (next.data.readyAt === null) delete row.readyAt;
    }
    return next.result;
  }

  async withdrawGoldenFailure(name: string, failures: number): Promise<void> {
    const row = this.rows.get(name);
    if (row && failures >= 1 && row.goldenFailures === failures) row.goldenFailures = failures - 1;
  }

  async markReady(names: readonly string[], at: Date): Promise<void> {
    for (const name of names) {
      const row = this.rows.get(name);
      if (row && row.readyAt === undefined) row.readyAt = new Date(at);
    }
  }

  async listUnusedBefore(cutoff: Date, limit: number): Promise<SubstrateTemplateRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.lastUsedAt.getTime() < cutoff.getTime())
      .sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime() || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }

  async deleteIfUnusedBefore(name: string, cutoff: Date): Promise<boolean> {
    const row = this.rows.get(name);
    if (!row || row.lastUsedAt.getTime() >= cutoff.getTime()) return false;
    this.rows.delete(name);
    return true;
  }

  async restore(record: SubstrateTemplateRecord): Promise<void> {
    if (!this.rows.has(record.name)) this.rows.set(record.name, structuredClone(record));
  }
}
