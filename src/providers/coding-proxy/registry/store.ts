import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import type { DeclaredDependency } from "../../../coding/registry/types.js";

export interface RegistryRunContext {
  runId: string;
  deadlineAt: Date;
  allowlist: PackageAllowlist;
  policy: unknown; // resolved with resolvePolicy()
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
}

/** Run-scoped store over the registry-only token session lookup and the
 *  RegistryAllowance/RegistryFetch tables (Task 5). Backs the registry proxy:
 *  it never sees the model capability, only the derived registry token. */
export interface RegistryStore {
  findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null>;
  isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean>;
  addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void>;
  recordFetch(record: RegistryFetchRecord): Promise<void>;
  usage(runId: string): Promise<{ files: number; bytes: number }>;
  /** Number of refused RegistryFetch rows recorded for the run. */
  refusalCount(runId: string): Promise<number>;
  listFetches(runId: string): Promise<(RegistryFetchRecord & { createdAt: Date })[]>;
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
   *  the version's fact), or null. */
  findApprovedVersion(
    runId: string,
    ecosystem: string,
    name: string,
    version: string,
  ): Promise<{ integrity: string; downloadUrl: string } | null>;
}

/** In-memory adapter for tests. `contexts` is settable directly so tests can
 *  seed a run without going through a full proxy session. */
export class MemoryRegistryStore implements RegistryStore {
  readonly contexts = new Map<string, RegistryRunContext>();
  readonly allowances = new Set<string>();
  readonly fetches: (RegistryFetchRecord & { createdAt: Date })[] = [];
  /** `ecosystem\0name\0version` -> fact. */
  readonly facts = new Map<string, StoredVersionFact>();
  /** `runId\0ecosystem\0name\0version` -> approval. */
  readonly approvals = new Map<string, ApprovedVersion>();

  async findRunByRegistryTokenHash(hash: string, now: Date): Promise<RegistryRunContext | null> {
    const context = this.contexts.get(hash);
    return context && context.deadlineAt > now ? context : null;
  }

  async isAllowedDependency(runId: string, ecosystem: string, name: string): Promise<boolean> {
    return this.allowances.has(`${runId}\0${ecosystem}\0${name}`);
  }

  async addAllowances(runId: string, ecosystem: string, names: readonly string[]): Promise<void> {
    for (const name of names) this.allowances.add(`${runId}\0${ecosystem}\0${name}`);
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
  ): Promise<{ integrity: string; downloadUrl: string } | null> {
    const approval = this.approvals.get(`${runId}\0${ecosystem}\0${name}\0${version}`);
    const fact = this.facts.get(`${ecosystem}\0${name}\0${version}`);
    return approval && fact ? { integrity: approval.integrity, downloadUrl: fact.downloadUrl } : null;
  }
}
