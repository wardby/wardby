import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";

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
}

/** In-memory adapter for tests. `contexts` is settable directly so tests can
 *  seed a run without going through a full proxy session. */
export class MemoryRegistryStore implements RegistryStore {
  readonly contexts = new Map<string, RegistryRunContext>();
  readonly allowances = new Set<string>();
  readonly fetches: (RegistryFetchRecord & { createdAt: Date })[] = [];

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
}
