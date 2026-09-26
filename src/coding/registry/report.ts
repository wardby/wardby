/**
 * The one summary of a run's RegistryFetch rows, shared by get_run and the
 * coding executor's PR-body report so both deduplicate identically: served
 * packages collapse on ecosystem + name + version (a retried download is one
 * package), refusals on ecosystem + name + reason.
 */
export interface RegistryFetchRow {
  ecosystem: string;
  name: string;
  version: string | null;
  outcome: string;
  reason: string | null;
  sizeBytes: number | null;
  /** `-/plan` for a refusal a lockfile plan recorded (see PLAN_FETCH_FILENAME). */
  filename?: string | null;
}

/** The `filename` a lockfile plan records its refusals under. */
export const PLAN_REFUSAL_FILENAME = "-/plan";

/** Distinct refusals lockfile plans recorded (ecosystem + name + version +
 *  reason), however often the lockfile was planned. */
export function countPlanRefusals(rows: readonly RegistryFetchRow[]): number {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.outcome !== "refused" || row.filename !== PLAN_REFUSAL_FILENAME) continue;
    keys.add(`${row.ecosystem}\0${row.name}\0${row.version ?? ""}\0${row.reason ?? ""}`);
  }
  return keys.size;
}

export interface RegistryPackageSummary {
  ecosystem: string;
  name: string;
  version: string;
  /** Bytes served (RegistryFetch.sizeBytes); null when not recorded. */
  size: number | null;
}

export interface RegistryRefusalSummary {
  ecosystem: string;
  name: string;
  reason: string;
}

export function summarizeRegistryFetches(rows: readonly RegistryFetchRow[]): {
  packages: RegistryPackageSummary[];
  packageRefusals: RegistryRefusalSummary[];
} {
  const packages = new Map<string, RegistryPackageSummary>();
  const refusals = new Map<string, RegistryRefusalSummary>();
  for (const row of rows) {
    if (row.outcome === "served" && row.version) {
      const key = `${row.ecosystem}\0${row.name}\0${row.version}`;
      if (!packages.has(key))
        packages.set(key, { ecosystem: row.ecosystem, name: row.name, version: row.version, size: row.sizeBytes });
    } else if (row.outcome === "refused") {
      const reason = row.reason ?? "refused";
      const key = `${row.ecosystem}\0${row.name}\0${reason}`;
      if (!refusals.has(key)) refusals.set(key, { ecosystem: row.ecosystem, name: row.name, reason });
    }
  }
  return { packages: [...packages.values()], packageRefusals: [...refusals.values()] };
}
