import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import type {
  AuditAdvisory,
  AuditRelation,
  PackageAuditMode,
  PackageAuditVerdict,
} from "../../../coding/registry/audit-mode.js";
import type { DeclaredDependency, FileDependency } from "../../../coding/registry/types.js";

export interface RegistryRunContext {
  runId: string;
  deadlineAt: Date;
  allowlist: PackageAllowlist;
  policy: unknown; // resolved with resolvePolicy()
  /** The run's repository (CodingRun.repository), a cache-key input. */
  repository: string;
  /** The image whose environment the install runs in: CodingRun.toolImage ?? workerImage; null when neither is recorded. */
  cacheImage: string | null;
  /** Whether the run's agent enabled the dependency cache, fixed at dispatch (CodingRun.dependencyCache). */
  dependencyCache: boolean;
  /** Package audit mode, fixed at dispatch (CodingRun.packageAuditMode); null = normal enforcement. */
  packageAudit: PackageAuditMode | null;
}

/** A coding proxy session's dependency cache state (CodingProxySession). */
export interface DependencyCacheSessionState {
  /** Lockfile hashes this session's plans approved with no refusals, while unsealed. */
  lockHashes: string[];
  /** When the run's dependency step ended; after it the cache refuses the session. */
  sealedAt: Date | null;
  /** When the session was created: the upload window starts here. */
  createdAt: Date;
}

export interface RegistryFetchRecord {
  runId: string;
  ecosystem: string;
  name: string;
  version?: string;
  filename?: string;
  integrity?: string;
  sizeBytes?: number;
  outcome: "served" | "refused";
  reason?: string;
}

/** A registry-verified version fact as stored: always with its publish time. */
export interface StoredVersionFact {
  name: string;
  version: string;
  publishedAt: Date;
  integrity: string;
  downloadUrl: string;
  dependencies: readonly DeclaredDependency[];
}

/** One exact version a lockfile plan approved for a run. */
export interface ApprovedVersion {
  name: string;
  version: string;
  integrity: string;
  /** Blocking advisories the run's accepted set waived for this version,
   *  when the plan kept it only by that waiver; absent or empty otherwise. */
  acceptedAdvisories?: readonly string[];
  /** Audit-mode plans only: why this approval is audited (outside the
   *  allowlist, or kept past advisories in full mode). Absent = a normal approval. */
  audit?: PackageAuditVerdict;
}

/** What a download of a plan-approved version needs. */
export interface ApprovedDownload {
  integrity: string;
  downloadUrl: string;
  /** Advisories the approval waived (empty when none). */
  acceptedAdvisories: string[];
  /** The approval's audit verdict; absent for a normal approval. */
  audit?: PackageAuditVerdict;
}

/** One RegistryAuditRecord: a version a run's registry served only because of package audit mode. */
export interface RegistryAuditInsert {
  runId: string;
  ecosystem: string;
  name: string;
  version: string;
  relation: AuditRelation;
  via?: string;
  sizeBytes?: number;
  advisories: readonly AuditAdvisory[];
}

/** One exact version a lockfile plan definitively refused for a run. */
export interface PlanRefusedVersion {
  name: string;
  version: string;
  code: string;
  reason: string;
  /** Set for a too-new refusal: it lapses once the version is old enough. */
  publishedAt?: Date | null;
}

/**
 * An extra a run allows for a package (PyPI `uvicorn[standard]`) is kept as
 * an allowance row named `name[extra]`, beside the package's own row. No
 * registry route can ask for that name (routes accept only valid package
 * names, which never contain `[`), so the row never allows a fetch itself:
 * it only tells the proxy which of the package's extra-gated dependencies
 * to follow when it serves the package's files.
 */
export function extraAllowanceName(name: string, extra: string): string {
  return `${name}[${extra}]`;
}

/** The extra in an allowance row name for `name`, or null when the row is not one of its extras. */
export function extraOfAllowanceName(rowName: string, name: string): string | null {
  const prefix = `${name}[`;
  if (!rowName.startsWith(prefix) || !rowName.endsWith("]")) return null;
  const extra = rowName.slice(prefix.length, -1);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(extra) ? extra : null;
}

/** The `auditedVia` of an audited allowance whose relation a lockfile plan
 *  could not tell (`unknown`): no package name is empty. */
export const AUDITED_VIA_UNKNOWN = "";

/** Run-scoped store over the registry-only token session lookup and the
 *  RegistryAllowance/RegistryFetch tables (Task 5). Backs the registry proxy:
 *  it never sees the model capability, only the derived registry token. */
export interface RegistryStore {
  findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null>;
  isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean>;
  /** The run's allowance of `name` (null = none): `auditedVia` is the audited package that declared it,
   *  AUDITED_VIA_UNKNOWN when no one is known to, or null. */
  findAllowance(runId: string, ecosystem: string, name: string): Promise<{ auditedVia: string | null } | null>;
  addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void>;
  /** Like addAllowances, each name tagged with the audited package that declared it; existing rows are kept. */
  addAuditedAllowances(runId: string, ecosystem: string, names: readonly string[], auditedVia: string): Promise<void>;
  /** Insert-only; a row for the same run/ecosystem/name/version already present is kept. */
  recordAudit(record: RegistryAuditInsert): Promise<void>;
  /** The extras the run allows for `name` (normalized, sorted). */
  allowedExtras(runId: string, ecosystem: string, name: string): Promise<string[]>;
  /** Records extras the run allows for each package (an existing one is kept). */
  addExtraAllowances(runId: string, ecosystem: string, dependencies: readonly FileDependency[]): Promise<void>;
  recordFetch(record: RegistryFetchRecord): Promise<void>;
  usage(runId: string): Promise<{ files: number; bytes: number }>;
  /** Number of refused RegistryFetch rows recorded for the run. */
  refusalCount(runId: string): Promise<number>;
  listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]>;
  /** The run's refused rows recorded at or after `since`, newest first, at most `limit`. */
  listRecentRefusals(runId: string, since: Date, limit: number): Promise<(RegistryFetchRecord & { createdAt: Date })[]>;
  /** Stored facts for these versions (any not stored are absent). */
  getVersionFacts(
    ecosystem: string,
    versions: readonly { name: string; version: string }[],
  ): Promise<StoredVersionFact[]>;
  /** Stores facts; one already stored is kept as it is (facts are immutable). */
  putVersionFacts(ecosystem: string, facts: readonly StoredVersionFact[]): Promise<void>;
  /** Approves exact versions for the run (an existing approval is kept). */
  approveVersions(runId: string, ecosystem: string, versions: readonly ApprovedVersion[]): Promise<void>;
  /** The run's approval of this exact version, with its download URL (from
   *  the version's fact) and any advisories it was approved by waiving, or
   *  null. */
  findApprovedVersion(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<ApprovedDownload | null>;
  /** Stores the run's plan refusals (an existing one is kept). */
  refusePlanVersions(runId: string, ecosystem: string, versions: readonly PlanRefusedVersion[]): Promise<void>;
  /** The run's plan refusal of this exact version, or null. */
  findPlanRefusal(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ code: string; reason: string; publishedAt: Date | null } | null>;
  /** Adds a lockfile hash to the run's session, atomically and only while
   *  the session is unsealed, does not already hold it, and holds fewer
   *  than `max`; otherwise does nothing. */
  recordDependencyCacheLockHash(runId: string, lockHash: string, max: number): Promise<void>;
}

/** In-memory adapter for tests. `contexts` is settable directly so tests can
 *  seed a run without going through a full proxy session. */
export class MemoryRegistryStore implements RegistryStore {
  readonly contexts = new Map<string, RegistryRunContext>();
  readonly allowances = new Set<string>();
  /** `runId\0ecosystem\0name` -> the audited package that declared the allowance (first writer). */
  readonly auditedVia = new Map<string, string>();
  readonly audits: (RegistryAuditInsert & { createdAt: Date })[] = [];
  readonly fetches: (RegistryFetchRecord & { createdAt: Date })[] = [];
  /** `ecosystem\0name\0version` -> fact. */
  readonly facts = new Map<string, StoredVersionFact>();
  /** `runId\0ecosystem\0name\0version` -> approval. */
  readonly approvals = new Map<string, ApprovedVersion>();
  /** `runId\0ecosystem\0name\0version` -> plan refusal. */
  readonly planRefusals = new Map<string, PlanRefusedVersion>();
  /** runId -> dependency cache session state (shareable with the cache's memory store). */
  readonly cacheSessions = new Map<string, DependencyCacheSessionState>();

  async findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null> {
    const context = this.contexts.get(hash);
    return context && context.deadlineAt > now ? context : null;
  }

  async isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean> {
    // An extra's row (`name[extra]`) is never a package allowance.
    if (name.includes("[")) return false;
    return this.allowances.has(`${runId}\0${ecosystem}\0${name}`);
  }

  async findAllowance(runId: string, ecosystem: string, name: string): Promise<{ auditedVia: string | null } | null> {
    if (!(await this.isAllowedDependency(runId, ecosystem, name))) return null;
    return { auditedVia: this.auditedVia.get(`${runId}\0${ecosystem}\0${name}`) ?? null };
  }

  async addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void> {
    for (const name of names) this.allowances.add(`${runId}\0${ecosystem}\0${name}`);
  }

  async addAuditedAllowances(
    runId: string,
    ecosystem: string,
    names: readonly string[],
    auditedVia: string,
  ): Promise<void> {
    for (const name of names) {
      const key = `${runId}\0${ecosystem}\0${name}`;
      if (this.allowances.has(key)) continue;
      this.allowances.add(key);
      this.auditedVia.set(key, auditedVia);
    }
  }

  async recordAudit(record: RegistryAuditInsert): Promise<void> {
    const same = (row: RegistryAuditInsert) =>
      row.runId === record.runId &&
      row.ecosystem === record.ecosystem &&
      row.name === record.name &&
      row.version === record.version;
    if (!this.audits.some(same)) this.audits.push({ ...record, createdAt: new Date() });
  }

  async allowedExtras(runId: string, ecosystem: string, name: string): Promise<string[]> {
    const prefix = `${runId}\0${ecosystem}\0`;
    return [...this.allowances]
      .filter((key) => key.startsWith(prefix))
      .map((key) => extraOfAllowanceName(key.slice(prefix.length), name))
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
    this.fetches.push({ ...record, createdAt: new Date() });
  }

  async usage(runId: string): Promise<{ files: number; bytes: number }> {
    const served = this.fetches.filter((fetch) => fetch.runId === runId && fetch.outcome === "served");
    return { files: served.length, bytes: served.reduce((sum, fetch) => sum + (fetch.sizeBytes ?? 0), 0) };
  }

  async refusalCount(runId: string): Promise<number> {
    return this.fetches.filter((fetch) => fetch.runId === runId && fetch.outcome === "refused").length;
  }

  async listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]> {
    return this.fetches.filter((fetch) => fetch.runId === runId);
  }

  async listRecentRefusals(
    runId: string,
    since: Date,
    limit: number,
  ): Promise<(RegistryFetchRecord & { createdAt: Date })[]> {
    return this.fetches
      .filter((fetch) => fetch.runId === runId && fetch.outcome === "refused" && fetch.createdAt >= since)
      .reverse()
      .slice(0, limit);
  }

  async getVersionFacts(
    ecosystem: string,
    versions: readonly { name: string; version: string }[],
  ): Promise<StoredVersionFact[]> {
    return versions.flatMap(({ name, version }) => this.facts.get(`${ecosystem}\0${name}\0${version}`) ?? []);
  }

  async putVersionFacts(ecosystem: string, facts: readonly StoredVersionFact[]): Promise<void> {
    for (const fact of facts) {
      const key = `${ecosystem}\0${fact.name}\0${fact.version}`;
      if (!this.facts.has(key)) this.facts.set(key, fact);
    }
  }

  async approveVersions(runId: string, ecosystem: string, versions: readonly ApprovedVersion[]): Promise<void> {
    for (const approval of versions) {
      const key = `${runId}\0${ecosystem}\0${approval.name}\0${approval.version}`;
      if (!this.approvals.has(key)) this.approvals.set(key, approval);
    }
  }

  async findApprovedVersion(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<ApprovedDownload | null> {
    const approval = this.approvals.get(`${runId}\0${ecosystem}\0${name}\0${version}`);
    const fact = this.facts.get(`${ecosystem}\0${name}\0${version}`);
    return approval && fact
      ? {
          integrity: approval.integrity,
          downloadUrl: fact.downloadUrl,
          acceptedAdvisories: [...(approval.acceptedAdvisories ?? [])],
          ...(approval.audit ? { audit: approval.audit } : {}),
        }
      : null;
  }

  async refusePlanVersions(runId: string, ecosystem: string, versions: readonly PlanRefusedVersion[]): Promise<void> {
    for (const refusal of versions) {
      const key = `${runId}\0${ecosystem}\0${refusal.name}\0${refusal.version}`;
      if (!this.planRefusals.has(key)) this.planRefusals.set(key, refusal);
    }
  }

  async findPlanRefusal(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ code: string; reason: string; publishedAt: Date | null } | null> {
    const refusal = this.planRefusals.get(`${runId}\0${ecosystem}\0${name}\0${version}`);
    return refusal ? { code: refusal.code, reason: refusal.reason, publishedAt: refusal.publishedAt ?? null } : null;
  }

  async recordDependencyCacheLockHash(runId: string, lockHash: string, max: number): Promise<void> {
    let session = this.cacheSessions.get(runId);
    if (!session) {
      session = { lockHashes: [], sealedAt: null, createdAt: new Date() };
      this.cacheSessions.set(runId, session);
    }
    if (session.sealedAt || session.lockHashes.includes(lockHash) || session.lockHashes.length >= max) return;
    session.lockHashes.push(lockHash);
  }
}
