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
  /** The coding run that recorded it; needed when rows of several runs are summarized together. */
  runId?: string;
}

/** The `filename` a lockfile plan records its refusals under. */
export const PLAN_REFUSAL_FILENAME = "-/plan";

/**
 * The `filename` of a refusal recorded only from an index listing: the
 * registry answered a metadata request whose kept versions have no file the
 * client may download (a PyPI project published only as an sdist, or whose
 * every wheel is too new). The installer may only have looked at the name
 * (a resolver exploring candidates, a dependency under a marker that does not
 * apply), so such a refusal is weaker evidence than a refused download.
 *
 * The rule, the same for every ecosystem: a listing-only refusal is cleared
 * like any refusal of a whole name, by any version of that name served after
 * it in the same run (summarizeRegistryFetches). One left standing (nothing
 * of that name was served) is marked `listingOnly`. It is reported to the
 * agent (`wardby-packages`, GET /registry/-/refusals) and in get_run, and:
 * - a coding sub-run failed: it counts toward ⛔ "Blocked by the package
 *   registry" and Slack `run_blocked` like any refusal (blockingRefusals in
 *   core/host-status.ts);
 * - the run made no changes (and none failed): it is a ⚠️ line on the status,
 *   never ⛔ or `run_blocked` (a package whose only release has nothing but
 *   too-new wheels can be why);
 * - a pull request resulted: it adds nothing, neither to the description's
 *   install warning and package section nor to the status (warningRefusals).
 */
export const LISTING_REFUSAL_FILENAME = "-/listing";

/** The refusals a pull request description or a not-blocked status warns
 *  about: all but listing-only ones (see LISTING_REFUSAL_FILENAME). */
export function warningRefusals<T extends { listingOnly?: boolean }>(refusals: readonly T[]): T[] {
  return refusals.filter((refusal) => refusal.listingOnly !== true);
}

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
  /** Every row behind it was an index listing's (LISTING_REFUSAL_FILENAME); absent otherwise. */
  listingOnly?: true;
};

/**
 * Rows must be in the order they were recorded (createdAt ascending): a
 * refusal followed by a served row for the same package in the same run
 * (`runId`; rows without one count as one run) no longer counts, since that
 * run's install went on to get it (npm retrying a temporary
 * `wardby_upstream_error`, an audit that was briefly unavailable). A package
 * served to a sibling sub-run never clears another run's refusal. A refusal
 * of one version is cleared only by that version being served; a refusal of
 * the whole name (no version) by any version of it. A refusal recorded after
 * the package was served still counts. Cleared refusals are left out of every
 * surface (get_run, the PR warning, the status comments, Slack), because each
 * of them tells the user the install did not finish, which is then untrue.
 *
 * Known limits: order is by record time, and a served row is recorded when
 * its download finishes (no start time is stored), so a download that started
 * before a concurrent refusal of the same version in the same run, and
 * finished after it, clears it; rows in the same millisecond have no
 * tiebreaker. Matching is per version, not per file, so serving any file of
 * a PyPI release clears a refused file of that release (another platform's
 * too-new wheel).
 */
export function summarizeRegistryFetches(rows: readonly RegistryFetchRow[]): {
  packages: RegistryPackageSummary[];
  packageRefusals: RegistryRefusalSummary[];
} {
  const packages = new Map<string, RegistryPackageSummary>();
  // Each refusal with the run + version pairs it still stands for (version "" = the whole name).
  const refusals = new Map<string, { summary: RegistryRefusalSummary; versions: Set<string>; listing: boolean }>();
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
        refusal.versions.delete(`${row.runId ?? ""}\0`);
        refusal.versions.delete(`${row.runId ?? ""}\0${row.version}`);
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
          listing: true,
        };
        refusals.set(key, refusal);
      }
      refusal.versions.add(`${row.runId ?? ""}\0${row.version ?? ""}`);
      refusal.listing &&= row.filename === LISTING_REFUSAL_FILENAME;
    }
  }
  return {
    packages: [...packages.values()],
    packageRefusals: [...refusals.values()].map(({ summary, listing }) =>
      listing ? { ...summary, listingOnly: true as const } : summary,
    ),
  };
}
