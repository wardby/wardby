import type { PrismaClient } from "#prisma";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import type { RegistryFetchRecord, RegistryRunContext, RegistryStore } from "./store.js";

export class PrismaRegistryStore implements RegistryStore {
  constructor(private readonly db: PrismaClient) {}

  async findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null> {
    const session = await this.db.codingProxySession.findUnique({
      where: { registryTokenHash: hash },
      select: {
        runId: true,
        status: true,
        deadlineAt: true,
        run: { select: { packageAllowlist: true, packagePolicy: true } },
      },
    });
    if (!session || session.status !== "active" || session.deadlineAt <= now) return null;
    return {
      runId: session.runId,
      deadlineAt: session.deadlineAt,
      allowlist: (session.run.packageAllowlist ?? {}) as PackageAllowlist,
      policy: session.run.packagePolicy,
    };
  }

  async isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean> {
    const row = await this.db.registryAllowance.findUnique({
      where: { runId_ecosystem_name: { runId, ecosystem, name } },
      select: { runId: true },
    });
    return row !== null;
  }

  async addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await this.db.registryAllowance.createMany({
      data: [...new Set(names)].map((name) => ({ runId, ecosystem, name })),
      skipDuplicates: true,
    });
  }

  async recordFetch(record: RegistryFetchRecord): Promise<void> {
    await this.db.registryFetch.create({ data: record });
  }

  async usage(runId: string): Promise<{ files: number; bytes: number }> {
    const totals = await this.db.registryFetch.aggregate({
      where: { runId, outcome: "served" },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    return { files: totals._count._all, bytes: totals._sum.sizeBytes ?? 0 };
  }

  async refusalCount(runId: string): Promise<number> {
    return this.db.registryFetch.count({ where: { runId, outcome: "refused" } });
  }

  async listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]> {
    const rows = await this.db.registryFetch.findMany({ where: { runId }, orderBy: { createdAt: "asc" } });
    return rows.map((row) => ({
      runId: row.runId,
      ecosystem: row.ecosystem,
      name: row.name,
      version: row.version ?? undefined,
      filename: row.filename ?? undefined,
      integrity: row.integrity ?? undefined,
      sizeBytes: row.sizeBytes ?? undefined,
      outcome: row.outcome,
      reason: row.reason ?? undefined,
      createdAt: row.createdAt,
    }));
  }
}
