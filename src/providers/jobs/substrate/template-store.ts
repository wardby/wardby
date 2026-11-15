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
   * Records a golden-snapshot failure seen at `at`, atomically. With no failure yet, or the window's
   * first failure more than `windowMs` before `at`: a new window (goldenFailures 1, lastFailureAt = at,
   * readyAt cleared). Otherwise goldenFailures + 1 (lastFailureAt unchanged). Returns goldenFailures;
   * 0 when the row does not exist.
   */
  recordGoldenFailure(name: string, at: Date, windowMs: number): Promise<number>;
  /** Sets readyAt = at on each named row whose readyAt is null. */
  markReady(names: readonly string[], at: Date): Promise<void>;
  /** Rows with lastUsedAt < cutoff, least recently used first, at most `limit`. */
  listUnusedBefore(cutoff: Date, limit: number): Promise<SubstrateTemplateRecord[]>;
  /** Deletes the row only while its lastUsedAt < cutoff; whether it did. */
  deleteIfUnusedBefore(name: string, cutoff: Date): Promise<boolean>;
  /** Inserts the row as given unless one with its name exists (undo a sweep's row delete). */
  restore(record: SubstrateTemplateRecord): Promise<void>;
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
    try {
      await this.db.substrateTemplate.upsert({
        where: { name },
        create: { name, atespace, role, image, createdAt: at, lastUsedAt: at },
        update: { lastUsedAt: at },
      });
    } catch (error) {
      // Two launches created the row at once: the other's insert won, so this one is an update.
      if (!isUniqueViolation(error)) throw error;
      await this.db.substrateTemplate.update({ where: { name }, data: { lastUsedAt: at } });
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

  async recordGoldenFailure(name: string, at: Date, windowMs: number): Promise<number> {
    const cutoff = new Date(at.getTime() - windowMs);
    // One statement: Postgres evaluates every SET against the old row, so concurrent failures each count once.
    const rows = await this.db.$queryRaw<{ goldenFailures: number }[]>`
      UPDATE "SubstrateTemplate" SET
        "goldenFailures" = CASE WHEN "lastFailureAt" IS NULL OR "lastFailureAt" < ${cutoff} THEN 1 ELSE "goldenFailures" + 1 END,
        "lastFailureAt"  = CASE WHEN "lastFailureAt" IS NULL OR "lastFailureAt" < ${cutoff} THEN ${at} ELSE "lastFailureAt" END,
        "readyAt"        = CASE WHEN "lastFailureAt" IS NULL OR "lastFailureAt" < ${cutoff} THEN NULL ELSE "readyAt" END
      WHERE "name" = ${name}
      RETURNING "goldenFailures"`;
    return rows[0]?.goldenFailures ?? 0;
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

  async recordGoldenFailure(name: string, at: Date, windowMs: number): Promise<number> {
    const row = this.rows.get(name);
    if (!row) return 0;
    const cutoff = at.getTime() - windowMs;
    if (row.lastFailureAt === undefined || row.lastFailureAt.getTime() < cutoff) {
      row.goldenFailures = 1;
      row.lastFailureAt = new Date(at);
      delete row.readyAt;
    } else {
      row.goldenFailures += 1;
    }
    return row.goldenFailures;
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
