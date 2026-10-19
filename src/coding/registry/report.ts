/**
 * The one summary of a run's RegistryFetch rows, shared by get_run and the
 * coding executor's PR-body report so both deduplicate identically: served
 * packages collapse on ecosystem + name + version (a retried download is one
 * package), refusals on ecosystem + name + reason.
 */
import { ACCEPTED_ADVISORY_ID } from "./allowlist.js";
import { refusalHint } from "./refusal-hints.js";
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

/** A served row's `reason` when serving it waived blocking advisories the
 *  run's packagePolicy.acceptedAdvisories lists: this prefix, then the
 *  waived advisory ids joined by ", ". */
export const ACCEPTED_ADVISORIES_PREFIX = "accepted advisories: ";

/** The served-row reason recording these waived advisory ids, or undefined
 *  when none were waived (the row then has no reason, as before). */
export function acceptedAdvisoriesReason(ids: readonly string[]): string | undefined {
  return ids.length > 0 ? `${ACCEPTED_ADVISORIES_PREFIX}${ids.join(", ")}` : undefined;
}

/** The waived advisory ids a served row's reason records (empty for any
 *  other reason, or none). */
export function parseAcceptedAdvisories(reason: string | null | undefined): string[] {
  if (!reason?.startsWith(ACCEPTED_ADVISORIES_PREFIX)) return [];
  return reason
    .slice(ACCEPTED_ADVISORIES_PREFIX.length)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => ACCEPTED_ADVISORY_ID.test(id));
}

export interface RegistryPackageSummary {
  ecosystem: string;
  name: string;
  version: string;
  /** Bytes served (RegistryFetch.sizeBytes); null when not recorded. */
  size: number | null;
  /** Blocking advisories waived to serve it (the run's accepted set);
   *  absent when none were. */
  acceptedAdvisories?: string[];
}

export type RegistryRefusalSummary = {
  ecosystem: string;
  name: string;
  reason: string;
  /** Static guidance for the code (shared with the proxy message and the PR banner); absent for unknown codes. */
  hint?: string;
};

/**
 * Rows must be in the order they were recorded (createdAt ascending): a
 * refusal followed by a served row for the same package no longer counts,
 * since the install went on to get it (npm retrying a temporary
 * `wardby_upstream_error`, an audit that was briefly unavailable). A refusal
 * of one version is cleared only by that version being served; a refusal of
 * the whole name (no version) by any version of it. A refusal recorded after
 * the package was served still counts. Cleared refusals are left out of every
 * surface (get_run, the PR warning, the status comments, Slack), because each
 * of them tells the user the install did not finish, which is then untrue.
 */
export function summarizeRegistryFetches(rows: readonly RegistryFetchRow[]): {
  packages: RegistryPackageSummary[];
  packageRefusals: RegistryRefusalSummary[];
} {
  const packages = new Map<string, RegistryPackageSummary>();
  // Each refusal with the versions it still stands for ("" = the whole name).
  const refusals = new Map<string, { summary: RegistryRefusalSummary; versions: Set<string> }>();
  for (const row of rows) {
    if (row.outcome === "served" && row.version) {
      const key = `${row.ecosystem}\0${row.name}\0${row.version}`;
      let summary = packages.get(key);
      if (!summary) {
        summary = { ecosystem: row.ecosystem, name: row.name, version: row.version, size: row.sizeBytes };
        packages.set(key, summary);
      }
      // Every file of the version (a retry, a wheel and its metadata) may
      // record the waiver; the package lists each advisory once.
      const accepted = parseAcceptedAdvisories(row.reason);
      if (accepted.length > 0)
        summary.acceptedAdvisories = [...new Set([...(summary.acceptedAdvisories ?? []), ...accepted])];
      for (const [refusalKey, refusal] of refusals) {
        if (refusal.summary.ecosystem !== row.ecosystem || refusal.summary.name !== row.name) continue;
        refusal.versions.delete("");
        refusal.versions.delete(row.version);
        if (refusal.versions.size === 0) refusals.delete(refusalKey);
      }
    } else if (row.outcome === "refused") {
      const reason = row.reason ?? "refused";
      const key = `${row.ecosystem}\0${row.name}\0${reason}`;
      let refusal = refusals.get(key);
      if (!refusal) {
        const hint = refusalHint(reason);
        refusal = {
          summary: { ecosystem: row.ecosystem, name: row.name, reason, ...(hint ? { hint } : {}) },
          versions: new Set(),
        };
        refusals.set(key, refusal);
      }
      refusal.versions.add(row.version ?? "");
    }
  }
  return {
    packages: [...packages.values()],
    packageRefusals: [...refusals.values()].map((refusal) => refusal.summary),
  };
}
