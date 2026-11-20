import type { PrismaClient } from "#prisma";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import { isPackageAuditMode, parsePackageAuditVerdict } from "../../../coding/registry/audit-mode.js";
import type { DeclaredDependency, FileDependency } from "../../../coding/registry/types.js";
import { extraAllowanceName, extraOfAllowanceName } from "./store.js";
import type {
  ApprovedDownload,
  ApprovedVersion,
  PlanRefusedVersion,
  PlanStart,
  RegistryAuditInsert,
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
        run: {
          select: {
            packageAllowlist: true,
            packagePolicy: true,
            repository: true,
            workerImage: true,
            toolImage: true,
            dependencyCache: true,
            packageAuditMode: true,
          },
        },
      },
    });
    if (!session || session.status !== "active" || session.deadlineAt <= now) return null;
    return {
      runId: session.runId,
      deadlineAt: session.deadlineAt,
      allowlist: (session.run.packageAllowlist ?? {}) as PackageAllowlist,
      policy: session.run.packagePolicy,
      repository: session.run.repository,
      cacheImage: session.run.toolImage ?? session.run.workerImage,
      dependencyCache: session.run.dependencyCache,
      packageAudit: isPackageAuditMode(session.run.packageAuditMode) ? session.run.packageAuditMode : null,
    };
  }

  async isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean> {
    // An extra's row (`name[extra]`) is never a package allowance.
    if (name.includes("[")) return false;
    const row = await this.db.registryAllowance.findUnique({
      where: { runId_ecosystem_name: { runId, ecosystem, name } },
      select: { runId: true },
    });
    return row !== null;
  }

  async findAllowance(runId: string, ecosystem: string, name: string): Promise<{ auditedVia: string | null } | null> {
    // An extra's row (`name[extra]`) is never a package allowance.
    if (name.includes("[")) return null;
    return this.db.registryAllowance.findUnique({
      where: { runId_ecosystem_name: { runId, ecosystem, name } },
      select: { auditedVia: true },
    });
  }

  async addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    await this.db.registryAllowance.createMany({
      data: [...new Set(names)].map((name) => ({ runId, ecosystem, name })),
      skipDuplicates: true,
    });
  }

  async addAuditedAllowances(
    runId: string,
    ecosystem: string,
    names: readonly string[],
    auditedVia: string,
  ): Promise<void> {
    if (names.length === 0) return;
    // Insert-only (the proxy has no UPDATE): an existing row keeps its first writer.
    await this.db.registryAllowance.createMany({
      data: [...new Set(names)].map((name) => ({ runId, ecosystem, name, auditedVia })),
      skipDuplicates: true,
    });
  }

  async recordAudit(record: RegistryAuditInsert): Promise<void> {
    await this.db.registryAuditRecord.createMany({
      data: [
        {
          runId: record.runId,
          ecosystem: record.ecosystem,
          name: record.name,
          version: record.version,
          relation: record.relation,
          via: record.via ?? null,
          sizeBytes: record.sizeBytes ?? null,
          advisories: record.advisories.map(({ id, severity, summary }) => ({ id, severity, summary })),
        },
      ],
      skipDuplicates: true,
    });
  }

  async allowedExtras(runId: string, ecosystem: string, name: string): Promise<string[]> {
    const rows = await this.db.registryAllowance.findMany({
      where: { runId, ecosystem, name: { startsWith: `${name}[` } },
      select: { name: true },
    });
    return rows
      .map((row) => extraOfAllowanceName(row.name, name))
      .filter((extra): extra is string => extra !== null)
      .sort();
  }

  async addExtraAllowances(runId: string, ecosystem: string, dependencies: readonly FileDependency[]): Promise<void> {
    await this.addAllowances(
      runId,
      ecosystem,
      dependencies.flatMap((dependency) =>
        dependency.extras.map((extra) => extraAllowanceName(dependency.name, extra)),
      ),
    );
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
    return rows.map(fetchRecordOf);
  }

  async listRecentRefusals(
    runId: string,
    since: Date,
    limit: number,
  ): Promise<(RegistryFetchRecord & { createdAt: Date })[]> {
    const rows = await this.db.registryFetch.findMany({
      where: { runId, outcome: "refused", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(fetchRecordOf);
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
        dependencies: fact.dependencies.map(({ key, name, range, extras, when }) => ({
          key,
          name,
          range,
          ...(extras ? { extras: [...extras] } : {}),
          ...(when ? { when: [...when] } : {}),
        })),
      })),
      skipDuplicates: true,
    });
  }

  async approveVersions(runId: string, ecosystem: string, versions: readonly ApprovedVersion[]): Promise<void> {
    if (versions.length === 0) return;
    await this.db.registryApprovedVersion.createMany({
      data: versions.map(({ name, version, integrity, acceptedAdvisories, audit }) => ({
        runId,
        ecosystem,
        name,
        version,
        integrity,
        acceptedAdvisories: [...(acceptedAdvisories ?? [])],
        ...(audit
          ? {
              audit: {
                relation: audit.relation,
                ...(audit.via ? { via: audit.via } : {}),
                ...(audit.advisories?.length
                  ? { advisories: audit.advisories.map(({ id, severity, summary }) => ({ id, severity, summary })) }
                  : {}),
              },
            }
          : {}),
      })),
      skipDuplicates: true,
    });
  }

  async findApprovedVersion(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<ApprovedDownload | null> {
    const approval = await this.db.registryApprovedVersion.findUnique({
      where: { runId_ecosystem_name_version: { runId, ecosystem, name, version } },
      select: { integrity: true, acceptedAdvisories: true, audit: true },
    });
    if (!approval) return null;
    const fact = await this.db.registryVersionFact.findUnique({
      where: { ecosystem_name_version: { ecosystem, name, version } },
      select: { downloadUrl: true },
    });
    const audit = parsePackageAuditVerdict(approval.audit);
    return fact
      ? {
          integrity: approval.integrity,
          downloadUrl: fact.downloadUrl,
          acceptedAdvisories: approval.acceptedAdvisories,
          ...(audit ? { audit } : {}),
        }
      : null;
  }

  async refusePlanVersions(runId: string, ecosystem: string, versions: readonly PlanRefusedVersion[]): Promise<void> {
    if (versions.length === 0) return;
    await this.db.registryPlanRefusal.createMany({
      data: versions.map(({ name, version, code, reason, publishedAt }) => ({
        runId,
        ecosystem,
        name,
        version,
        code,
        reason,
        publishedAt: publishedAt ?? null,
      })),
      skipDuplicates: true,
    });
  }

  async findPlanRefusal(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ code: string; reason: string; publishedAt: Date | null } | null> {
    return this.db.registryPlanRefusal.findUnique({
      where: { runId_ecosystem_name_version: { runId, ecosystem, name, version } },
      select: { code: true, reason: true, publishedAt: true },
    });
  }

  async recordDependencyCacheLockHash(runId: string, lockHash: string, max: number): Promise<void> {
    // One statement, so a concurrent seal or plan can never slip past a check.
    await this.db.$executeRaw`
      UPDATE "CodingProxySession"
      SET "dependencyCacheLockHashes" = array_append("dependencyCacheLockHashes", ${lockHash})
      WHERE "runId" = ${runId}
        AND "dependencyCacheSealedAt" IS NULL
        AND NOT (${lockHash} = ANY("dependencyCacheLockHashes"))
        AND cardinality("dependencyCacheLockHashes") < ${max}`;
  }

  async planFallback(runId: string): Promise<string[]> {
    const session = await this.db.codingProxySession.findUnique({
      where: { runId },
      select: { registryPlanFallback: true },
    });
    return session?.registryPlanFallback ?? [];
  }

  async addPlanFallback(runId: string, ecosystem: string): Promise<void> {
    await this.db.$executeRaw`
      UPDATE "CodingProxySession"
      SET "registryPlanFallback" = array_append(COALESCE("registryPlanFallback", ARRAY[]::TEXT[]), ${ecosystem})
      WHERE "runId" = ${runId}
        AND NOT (${ecosystem} = ANY(COALESCE("registryPlanFallback", ARRAY[]::TEXT[])))`;
  }

  async startPlan(runId: string, input: { max: number; leaseUntil: Date; now: Date }): Promise<PlanStart> {
    // One UPDATE with its conditions in the WHERE, so two replicas can never both start a plan the run's
    // lease or limit forbids.
    const { count: started } = await this.db.codingProxySession.updateMany({
      where: {
        runId,
        registryPlans: { lt: input.max },
        OR: [{ registryPlanLeaseUntil: null }, { registryPlanLeaseUntil: { lte: input.now } }],
      },
      data: { registryPlans: { increment: 1 }, registryPlanLeaseUntil: input.leaseUntil },
    });
    if (started > 0) return "started";
    const session = await this.db.codingProxySession.findUnique({
      where: { runId },
      select: { registryPlanLeaseUntil: true },
    });
    return session?.registryPlanLeaseUntil && session.registryPlanLeaseUntil > input.now ? "busy" : "limit";
  }

  async endPlan(runId: string): Promise<void> {
    await this.db.codingProxySession.updateMany({ where: { runId }, data: { registryPlanLeaseUntil: null } });
  }

  async reserveDownload(
    runId: string,
    input: { sizeBytes: number | null; maxFiles: number; leaseUntil: Date; now: Date },
  ): Promise<string | null> {
    return this.db.$transaction(async (tx) => {
      // The session row is the run's lock: reservations of one run are admitted one at a time, across replicas.
      await tx.$queryRaw`SELECT 1 FROM "CodingProxySession" WHERE "runId" = ${runId} FOR UPDATE`;
      await tx.registryReservation.deleteMany({ where: { runId, expiresAt: { lte: input.now } } });
      const served = await tx.registryFetch.count({ where: { runId, outcome: "served" } });
      const held = await tx.registryReservation.count({ where: { runId } });
      if (served + held >= input.maxFiles) return null;
      const row = await tx.registryReservation.create({
        data: { runId, bytes: input.sizeBytes ?? 0, expiresAt: input.leaseUntil },
        select: { id: true },
      });
      return row.id;
    });
  }

  async syncDownload(
    runId: string,
    reservationId: string,
    input: { streamedBytes: number | null; leaseUntil: Date; now: Date },
  ): Promise<number> {
    await this.db.registryReservation.updateMany({
      where: { id: reservationId },
      data: { expiresAt: input.leaseUntil, ...(input.streamedBytes !== null ? { bytes: input.streamedBytes } : {}) },
    });
    const served = await this.usage(runId);
    const held = await this.db.registryReservation.aggregate({
      where: { runId, expiresAt: { gt: input.now } },
      _sum: { bytes: true },
    });
    return served.bytes + (held._sum.bytes ?? 0);
  }

  async releaseDownload(reservationId: string): Promise<void> {
    await this.db.registryReservation.deleteMany({ where: { id: reservationId } });
  }
}

function fetchRecordOf(row: {
  runId: string;
  ecosystem: string;
  name: string;
  version: string | null;
  filename: string | null;
  integrity: string | null;
  sizeBytes: number | null;
  outcome: RegistryFetchRecord["outcome"];
  reason: string | null;
  createdAt: Date;
}): RegistryFetchRecord & { createdAt: Date } {
  return {
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
  };
}
