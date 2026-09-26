import type { PrismaClient } from "#prisma";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import type { DeclaredDependency } from "../../../coding/registry/types.js";
import type {
  ApprovedVersion,
  PlanRefusedVersion,
  RegistryFetchRecord,
  RegistryRunContext,
  RegistryStore,
  StoredVersionFact,
} from "./store.js";

/** Versions looked up per query, so a 5000-entry lockfile is a handful of
 *  bounded queries rather than one enormous OR. */
const FACT_QUERY_CHUNK = 500;

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

  async getVersionFacts(
    ecosystem: string,
    versions: readonly { name: string; version: string }[],
  ): Promise<StoredVersionFact[]> {
    const facts: StoredVersionFact[] = [];
    for (let start = 0; start < versions.length; start += FACT_QUERY_CHUNK) {
      const chunk = versions.slice(start, start + FACT_QUERY_CHUNK);
      const rows = await this.db.registryVersionFact.findMany({
        where: { OR: chunk.map(({ name, version }) => ({ ecosystem, name, version })) },
      });
      for (const row of rows) {
        facts.push({
          name: row.name,
          version: row.version,
          publishedAt: row.publishedAt,
          integrity: row.integrity,
          downloadUrl: row.downloadUrl,
          dependencies: row.dependencies as unknown as DeclaredDependency[],
        });
      }
    }
    return facts;
  }

  async putVersionFacts(ecosystem: string, facts: readonly StoredVersionFact[]): Promise<void> {
    if (facts.length === 0) return;
    await this.db.registryVersionFact.createMany({
      data: facts.map((fact) => ({
        ecosystem,
        name: fact.name,
        version: fact.version,
        publishedAt: fact.publishedAt,
        integrity: fact.integrity,
        downloadUrl: fact.downloadUrl,
        dependencies: fact.dependencies.map(({ key, name, range }) => ({ key, name, range })),
      })),
      skipDuplicates: true,
    });
  }

  async approveVersions(runId: string, ecosystem: string, versions: readonly ApprovedVersion[]): Promise<void> {
    if (versions.length === 0) return;
    await this.db.registryApprovedVersion.createMany({
      data: versions.map(({ name, version, integrity }) => ({ runId, ecosystem, name, version, integrity })),
      skipDuplicates: true,
    });
  }

  async findApprovedVersion(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ integrity: string; downloadUrl: string } | null> {
    const approval = await this.db.registryApprovedVersion.findUnique({
      where: { runId_ecosystem_name_version: { runId, ecosystem, name, version } },
      select: { integrity: true },
    });
    if (!approval) return null;
    const fact = await this.db.registryVersionFact.findUnique({
      where: { ecosystem_name_version: { ecosystem, name, version } },
      select: { downloadUrl: true },
    });
    return fact ? { integrity: approval.integrity, downloadUrl: fact.downloadUrl } : null;
  }

  async refusePlanVersions(runId: string, ecosystem: string, versions: readonly PlanRefusedVersion[]): Promise<void> {
    if (versions.length === 0) return;
    await this.db.registryPlanRefusal.createMany({
      data: versions.map(({ name, version, code, reason }) => ({ runId, ecosystem, name, version, code, reason })),
      skipDuplicates: true,
    });
  }

  async findPlanRefusal(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ code: string; reason: string } | null> {
    return this.db.registryPlanRefusal.findUnique({
      where: { runId_ecosystem_name_version: { runId, ecosystem, name, version } },
      select: { code: true, reason: true },
    });
  }
}
