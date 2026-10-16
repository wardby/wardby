/**
 * Package audit mode (docs/coding-packages.md#package-audit-mode): a timed,
 * owner-set mode in which a coding run's registry serves packages outside the
 * agent's allowlist (`audit`) and, in `full`, versions withheld only by
 * non-malware blocking advisories, recording each one for approval
 * afterwards. Pure (no provider imports): the MCP tools, dispatch, the proxy,
 * the PR body, the status comment and Slack all read this one model.
 */
import { ACCEPTED_ADVISORY_ID } from "./allowlist.js";
import { codeSpan } from "./refusal-wording.js";

export const PACKAGE_AUDIT_MODES = ["audit", "full"] as const;
export type PackageAuditMode = (typeof PACKAGE_AUDIT_MODES)[number];
/** The window `packageAuditMode` opens when `packageAuditMinutes` is omitted: 24 hours. */
export const DEFAULT_PACKAGE_AUDIT_MINUTES = 24 * 60;
/** The longest window one update may open: 7 days. */
export const MAX_PACKAGE_AUDIT_MINUTES = 7 * 24 * 60;

/**
 * How an audited package reached the run: named by the project or a lockfile
 * project (`top-level`), declared by an audited package (`transitive`),
 * fetched with no metadata or plan to prove a parent (`unknown`), or on the
 * allowlist graph and recorded only for advisories served past (`allowed`).
 */
export type AuditRelation = "top-level" | "transitive" | "unknown" | "allowed";
const RELATIONS: readonly AuditRelation[] = ["top-level", "unknown", "transitive", "allowed"];

export interface AuditAdvisory {
  id: string;
  severity: string;
  summary: string;
}

/** Why one request or plan approval was audited; `advisories` only for full-mode waivers. */
export interface PackageAuditVerdict {
  relation: AuditRelation;
  /** The top-level audited package that pulled it in (transitive only). */
  via?: string;
  advisories?: AuditAdvisory[];
}

/** A RegistryAuditRecord row as read back (advisories is untrusted JSON). */
export interface PackageAuditRow {
  ecosystem: string;
  name: string;
  version: string;
  relation: string;
  via: string | null;
  sizeBytes: number | null;
  advisories: unknown;
}

/** One audited package version as get_run, the PR body and the status comment show it. */
export interface PackageAuditEntry {
  ecosystem: string;
  name: string;
  version: string;
  size: number | null;
  relation: AuditRelation;
  via?: string;
  advisories?: AuditAdvisory[];
}

export class PackageAuditPatchError extends Error {}

export function isPackageAuditMode(value: unknown): value is PackageAuditMode {
  return typeof value === "string" && (PACKAGE_AUDIT_MODES as readonly string[]).includes(value);
}

/** Whether a stored mode is in force: set, and its window has not ended. */
export function isPackageAuditActive(
  mode: string | null | undefined,
  until: Date | null | undefined,
  now: Date,
): mode is PackageAuditMode {
  return isPackageAuditMode(mode) && !!until && until.getTime() > now.getTime();
}

/** The get_agent / update_agent warning while a mode is in force. */
export function packageAuditActiveWarning(mode: PackageAuditMode, until: Date): string {
  return `Package audit mode (\`${mode}\`) is on until ${until.toISOString()}: this agent's coding runs install packages outside the allowlist.`;
}

/**
 * update_agent's packageAuditMode / packageAuditMinutes semantics: a mode
 * opens a window of the given minutes (24 hours by default), minutes alone
 * re-arm the stored mode, and null clears both. Returns undefined when the
 * patch names neither field; throws PackageAuditPatchError for a 400.
 */
export function resolvePackageAuditPatch(
  stored: { mode: PackageAuditMode | null },
  patch: { packageAuditMode?: PackageAuditMode | null; packageAuditMinutes?: number },
  now: Date,
): { mode: PackageAuditMode | null; until: Date | null } | undefined {
  const { packageAuditMode: mode, packageAuditMinutes: minutes } = patch;
  if (mode === undefined && minutes === undefined) return undefined;
  if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_PACKAGE_AUDIT_MINUTES)) {
    throw new PackageAuditPatchError(
      `packageAuditMinutes must be a whole number from 1 to ${MAX_PACKAGE_AUDIT_MINUTES} (7 days).`,
    );
  }
  if (mode === null) {
    if (minutes !== undefined) {
      throw new PackageAuditPatchError("packageAuditMinutes cannot be set while turning packageAuditMode off (null).");
    }
    return { mode: null, until: null };
  }
  const effective = mode ?? stored.mode;
  if (!effective) {
    throw new PackageAuditPatchError(
      'packageAuditMinutes needs a package audit mode: set packageAuditMode to "audit" or "full" as well.',
    );
  }
  return { mode: effective, until: new Date(now.getTime() + (minutes ?? DEFAULT_PACKAGE_AUDIT_MINUTES) * 60_000) };
}

const SEVERITIES = new Set(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]);
const MAX_AUDIT_ADVISORIES = 16;
export const MAX_AUDIT_SUMMARY_CHARS = 200;

/** An advisory summary (OSV free text) as plain, single-line, bounded text. */
export function sanitizeAuditSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping untrusted control characters.
      .replace(/[`\u0000-\u001f\u007f<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_AUDIT_SUMMARY_CHARS)
  );
}

/** Untrusted advisory JSON reduced to well-formed, non-malware entries (at most 16, distinct ids). */
export function sanitizeAuditAdvisories(value: unknown): AuditAdvisory[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, AuditAdvisory>();
  for (const item of value) {
    if (out.size >= MAX_AUDIT_ADVISORIES) break;
    if (!item || typeof item !== "object") continue;
    const { id, severity, summary } = item as Record<string, unknown>;
    // Malware is never served in any mode, so a MAL- id here is malformed data.
    if (typeof id !== "string" || id.startsWith("MAL-") || !ACCEPTED_ADVISORY_ID.test(id) || out.has(id)) continue;
    const level = typeof severity === "string" ? severity.toUpperCase() : "";
    out.set(id, { id, severity: SEVERITIES.has(level) ? level : "UNKNOWN", summary: sanitizeAuditSummary(summary) });
  }
  return [...out.values()];
}

/** A stored verdict (RegistryApprovedVersion.audit, untrusted JSON) read back; null when absent or malformed. */
export function parsePackageAuditVerdict(value: unknown): PackageAuditVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { relation, via, advisories } = value as Record<string, unknown>;
  if (typeof relation !== "string" || !(RELATIONS as readonly string[]).includes(relation)) return null;
  const list = sanitizeAuditAdvisories(advisories);
  return {
    relation: relation as AuditRelation,
    ...(relation === "transitive" && typeof via === "string" && via !== "" ? { via } : {}),
    ...(list.length > 0 ? { advisories: list } : {}),
  };
}

export interface PackageAuditSummary {
  entries: PackageAuditEntry[];
  /** Names to add to the allowlist: top-level, per ecosystem, first-seen order. */
  toApprove: { ecosystem: string; name: string; dependencies: number }[];
  /** Names recorded only with relation `unknown` (a direct download, or after a plan fallback): they
   *  may be dependencies of allowlisted packages, so they are listed apart and approved only by name. */
  unknown: { ecosystem: string; name: string; dependencies: number }[];
  advisoryRows: { ecosystem: string; name: string; version: string; advisory: AuditAdvisory }[];
}

/**
 * A run's (or a PR's runs') audit rows deduplicated on ecosystem + name +
 * version (advisories unioned) and ordered top-level, unknown, transitive,
 * allowed. An unrecognised relation reads as `unknown`, so it is listed to
 * approve rather than hidden.
 */
export function summarizePackageAudit(rows: readonly PackageAuditRow[]): PackageAuditSummary {
  const byKey = new Map<string, PackageAuditEntry>();
  for (const row of rows) {
    const key = `${row.ecosystem}\0${row.name}\0${row.version}`;
    const advisories = sanitizeAuditAdvisories(row.advisories);
    const existing = byKey.get(key);
    if (existing) {
      if (advisories.length > 0) {
        const merged = new Map((existing.advisories ?? []).map((a) => [a.id, a]));
        for (const advisory of advisories) if (!merged.has(advisory.id)) merged.set(advisory.id, advisory);
        existing.advisories = [...merged.values()].slice(0, MAX_AUDIT_ADVISORIES);
      }
      continue;
    }
    const relation = (RELATIONS as readonly string[]).includes(row.relation)
      ? (row.relation as AuditRelation)
      : "unknown";
    byKey.set(key, {
      ecosystem: row.ecosystem,
      name: row.name,
      version: row.version,
      size: row.sizeBytes,
      relation,
      ...(relation === "transitive" && row.via ? { via: row.via } : {}),
      ...(advisories.length > 0 ? { advisories } : {}),
    });
  }
  const entries = [...byKey.values()].sort((a, b) => RELATIONS.indexOf(a.relation) - RELATIONS.indexOf(b.relation));

  const toApprove = new Map<string, { ecosystem: string; name: string; dependencies: number }>();
  const unknown = new Map<string, { ecosystem: string; name: string; dependencies: number }>();
  // Entries are ordered top-level first, so a name recorded both ways is listed to approve.
  for (const entry of entries) {
    if (entry.relation !== "top-level" && entry.relation !== "unknown") continue;
    const key = `${entry.ecosystem}\0${entry.name}`;
    if (toApprove.has(key) || unknown.has(key)) continue;
    (entry.relation === "top-level" ? toApprove : unknown).set(key, {
      ecosystem: entry.ecosystem,
      name: entry.name,
      dependencies: 0,
    });
  }
  const counted = new Set<string>();
  for (const entry of entries) {
    if (entry.relation !== "transitive" || !entry.via) continue;
    const parentKey = `${entry.ecosystem}\0${entry.via}`;
    const parent = toApprove.get(parentKey) ?? unknown.get(parentKey);
    const key = `${entry.ecosystem}\0${entry.via}\0${entry.name}`;
    if (!parent || counted.has(key)) continue;
    counted.add(key);
    parent.dependencies += 1;
  }

  const advisoryRows = entries.flatMap((entry) =>
    (entry.advisories ?? []).map((advisory) => ({
      ecosystem: entry.ecosystem,
      name: entry.name,
      version: entry.version,
      advisory,
    })),
  );
  return { entries, toApprove: [...toApprove.values()], unknown: [...unknown.values()], advisoryRows };
}

/** How a name recorded with relation `unknown` is labelled wherever it is listed. */
export const UNKNOWN_RELATION_LABEL = "Relation unknown — may be a dependency; approve only if needed directly";

/** At most this many names in a status comment or Slack message, and table rows in a PR body. */
const MAX_STATUS_NAMES = 10;
const MAX_PR_AUDIT_LINES = 50;

function dependencies(count: number): string {
  return count === 0 ? "" : ` (and ${count} ${count === 1 ? "dependency" : "dependencies"})`;
}

/**
 * The package audit block for a PR body (`format: "pr"`, a `[!CAUTION]`
 * banner plus the names to approve and, in full mode, the advisories served
 * past), a status comment (`format: "status"`, short), or Slack mrkdwn
 * (`slack`, already escaped). Control-plane text only: names, versions and
 * ids pass through codeSpan.
 */
export function packageAuditWording(
  mode: PackageAuditMode,
  summary: PackageAuditSummary,
  opts: { slack?: boolean; format?: "pr" | "status" } = {},
): string {
  return opts.format === "pr" && !opts.slack ? prWording(mode, summary) : statusWording(mode, summary, !!opts.slack);
}

function prWording(mode: PackageAuditMode, summary: PackageAuditSummary): string {
  const nothing = summary.entries.length === 0;
  const banner = [
    "> [!CAUTION]",
    nothing
      ? `> **Package audit mode (\`${mode}\`) was on for this run:** nothing outside the allowlist was installed${mode === "full" ? " and no advisory was served past" : ""}.`
      : `> **Package audit mode (\`${mode}\`) was on for this run.** Wardby's registry installed packages outside this agent's allowlist${mode === "full" ? " and, in `full` mode, versions with high or critical advisories" : ""}. Review them before merging. Malware and the release-age limit were still enforced.`,
  ];
  const sections = [banner.join("\n")];
  if (summary.toApprove.length > 0) {
    const lines = summary.toApprove.map(
      (pkg) => `- ${codeSpan(pkg.ecosystem).slice(1, -1)} ${codeSpan(pkg.name)}${dependencies(pkg.dependencies)}`,
    );
    sections.push(
      [
        "**Packages outside the allowlist** (add to `codingProfile.packageAllowlist` to keep using them):",
        ...capped(lines),
      ].join("\n"),
    );
  }
  if (summary.unknown.length > 0) {
    const lines = summary.unknown.map(
      (pkg) => `- ${codeSpan(pkg.ecosystem).slice(1, -1)} ${codeSpan(pkg.name)}${dependencies(pkg.dependencies)}`,
    );
    sections.push(
      [`**Relation unknown** — may be a dependency; approve only if needed directly:`, ...capped(lines)].join("\n"),
    );
  }
  if (
    !nothing &&
    summary.toApprove.length === 0 &&
    summary.unknown.length === 0 &&
    summary.entries.some((e) => e.relation === "transitive")
  ) {
    // Every audited package came in as a dependency whose parent was not itself recorded.
    sections.push(
      `**Packages outside the allowlist:** ${summary.entries.filter((e) => e.relation === "transitive").length} dependencies of audited packages.`,
    );
  }
  if (mode === "full" && summary.advisoryRows.length > 0) {
    const rows = summary.advisoryRows.map(
      (row) =>
        `| ${codeSpan(row.ecosystem).slice(1, -1)} ${codeSpan(row.name)} | ${codeSpan(row.version)} | ${codeSpan(row.advisory.id)} | ${row.advisory.severity} |`,
    );
    sections.push(
      ["**Served despite advisories:**", "| Package | Version | Advisory | Severity |", "| --- | --- | --- | --- |"]
        .concat(rows.slice(0, MAX_PR_AUDIT_LINES))
        .concat(
          rows.length > MAX_PR_AUDIT_LINES
            ? [`\n…and ${rows.length - MAX_PR_AUDIT_LINES} more — see get_run for the full list`]
            : [],
        )
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function capped(lines: readonly string[]): string[] {
  return lines.length > MAX_PR_AUDIT_LINES
    ? [
        ...lines.slice(0, MAX_PR_AUDIT_LINES),
        `- …and ${lines.length - MAX_PR_AUDIT_LINES} more — see get_run for the full list`,
      ]
    : [...lines];
}

function statusWording(mode: PackageAuditMode, summary: PackageAuditSummary, slack: boolean): string {
  return packageAuditStatusText(mode, packageAuditDigest(mode, summary), slack);
}

/** What a short audit notice needs (a status comment, a Slack message): a bounded, count-only digest.
 *  A type alias, not an interface, so it stays assignable to a stored JSON payload. */
export type PackageAuditDigest = {
  /** Names to approve, at most 10. */
  toApprove: { ecosystem: string; name: string }[];
  /** Names to approve beyond those listed. */
  moreToApprove: number;
  /** Names with relation `unknown`, at most 10, listed apart (see PackageAuditSummary.unknown). */
  unknown: { ecosystem: string; name: string }[];
  moreUnknown: number;
  /** Dependencies of audited packages, recorded transitive. */
  transitive: number;
  /** Advisories full mode served past (0 in audit mode). */
  advisories: number;
};

export function packageAuditDigest(mode: PackageAuditMode, summary: PackageAuditSummary): PackageAuditDigest {
  const listed = summary.toApprove.slice(0, MAX_STATUS_NAMES);
  return {
    toApprove: listed.map(({ ecosystem, name }) => ({ ecosystem, name })),
    moreToApprove: summary.toApprove.length - listed.length,
    unknown: summary.unknown.slice(0, MAX_STATUS_NAMES).map(({ ecosystem, name }) => ({ ecosystem, name })),
    moreUnknown: Math.max(0, summary.unknown.length - MAX_STATUS_NAMES),
    transitive: summary.entries.filter((e) => e.relation === "transitive").length,
    advisories: mode === "full" ? summary.advisoryRows.length : 0,
  };
}

/** The short audit notice as GitHub/Jira Markdown or, with `slack`, Slack mrkdwn (already escaped). */
export function packageAuditStatusText(mode: PackageAuditMode, digest: PackageAuditDigest, slack: boolean): string {
  const bold = (text: string) => (slack ? `*${text}*` : `**${text}**`);
  const head = `🔎 ${bold(`Package audit mode (\`${mode}\`) was on:`)}`;
  const advisoryText = digest.advisories > 0 ? ` ${digest.advisories} served despite advisories.` : "";
  let text: string;
  // Older stored payloads (before unknown names were listed apart) have no `unknown`.
  const unknown = digest.unknown ?? [];
  const nameList = (list: readonly { ecosystem: string; name: string }[], more: number) =>
    list
      .slice(0, MAX_STATUS_NAMES)
      .map((pkg) => `${codeSpan(pkg.name)} (${codeSpan(pkg.ecosystem).slice(1, -1)})`)
      .join(", ") + (more > 0 ? ` and ${more} more` : "");
  if (digest.toApprove.length === 0 && unknown.length === 0 && digest.transitive === 0) {
    text = `${head} nothing outside the allowlist was installed.${advisoryText}`;
  } else {
    const listed =
      digest.toApprove.length > 0 ? nameList(digest.toApprove, digest.moreToApprove) : "no top-level names";
    const transitive = digest.transitive;
    const unknownText =
      unknown.length > 0 ? ` ${UNKNOWN_RELATION_LABEL}: ${nameList(unknown, digest.moreUnknown ?? 0)}.` : "";
    text =
      `${head} installed outside the allowlist: ${listed}` +
      `${transitive > 0 ? ` (plus ${transitive} ${transitive === 1 ? "dependency" : "dependencies"})` : ""}.` +
      `${unknownText}${advisoryText} Add them with \`update_agent\` (codingProfile.packageAllowlist) to keep them.`;
  }
  // Slack's three control characters; codeSpan already removed < and > from names.
  return slack ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : text;
}

/** A run's (or a pull request's runs') package audit: the mode and what it recorded. */
export interface PackageAuditReport {
  mode: PackageAuditMode;
  entries: readonly PackageAuditEntry[];
}

/** Entries back as rows, so several runs' entries summarize (dedup, order) like one run's. */
export function packageAuditRows(entries: readonly PackageAuditEntry[]): PackageAuditRow[] {
  return entries.map((entry) => ({
    ecosystem: entry.ecosystem,
    name: entry.name,
    version: entry.version,
    relation: entry.relation,
    via: entry.via ?? null,
    sizeBytes: entry.size,
    advisories: entry.advisories ?? [],
  }));
}

/**
 * Several runs' audit reports as one (a pull request's runs): entries merged
 * on ecosystem + name + version with advisories unioned, and the strongest
 * mode seen (`full` over `audit`). Undefined when no run had the mode.
 */
export function mergePackageAuditReports(
  reports: readonly (PackageAuditReport | undefined)[],
): PackageAuditReport | undefined {
  const present = reports.filter((report): report is PackageAuditReport => !!report && isPackageAuditMode(report.mode));
  if (present.length === 0) return undefined;
  const mode: PackageAuditMode = present.some((report) => report.mode === "full") ? "full" : "audit";
  return {
    mode,
    entries: summarizePackageAudit(present.flatMap((report) => packageAuditRows(report.entries))).entries,
  };
}
