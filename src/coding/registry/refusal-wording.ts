/** Fixed operator guidance from structured registry codes, never registry free text. */
import { GRAPH_INCOMPLETE, GRAPH_LIMIT, PACKAGE_NOT_ALLOWED, PACKAGE_NOT_ALLOWED_PENDING } from "./refusal-hints.js";
import type { RegistryRefusalSummary } from "./report.js";

const HELP_URL = "https://github.com/wardby/wardby/blob/main/help/coding-packages.md";
const HELP_LABEL = "Help: package allowlist";
const ALLOWLIST = new Set([PACKAGE_NOT_ALLOWED, PACKAGE_NOT_ALLOWED_PENDING, GRAPH_LIMIT]);
/** Upstream or check failures that usually pass: a later run may succeed unchanged. */
const TRANSIENT = new Set([
  GRAPH_INCOMPLETE,
  "wardby_upstream_error",
  "wardby_upstream_unavailable",
  "wardby_audit_unavailable",
  "wardby_download_idle",
]);

/** Untrusted names stay bounded code spans with mentions and markup defused. */
export function codeSpan(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping untrusted control characters.
  const withoutControls = value.replace(/[`\u0000-\u001f\u007f<>]/g, " ");
  const safe = withoutControls.replace(/\s+/g, " ").replace(/@/g, "@​").slice(0, 120);
  return `\`${safe}\``;
}

/**
 * The ⛔ blocked status (or, with `blocked: false`, the ⚠️ warning) for a run's refusals, as GitHub/Jira
 * Markdown or, with `slack`, as Slack mrkdwn (already escaped).
 */
export function packageRefusalWording(
  refusals: readonly RegistryRefusalSummary[],
  opts: { blocked?: boolean; slack?: boolean } = {},
): string {
  const blocked = opts.blocked ?? true;
  const bold = (text: string) => (opts.slack ? `*${text}*` : `**${text}**`);
  const distinct = [...new Map(refusals.map((r) => [JSON.stringify([r.ecosystem, r.name, r.reason]), r])).values()];
  const lines = distinct.slice(0, 10).map((r) => {
    const code = /^wardby_[a-z_]+$/.exec(r.reason)?.[0] === r.reason ? ` (\`${r.reason}\`)` : "";
    const guidance = ALLOWLIST.has(r.reason)
      ? "not on this agent's allowlist; add it to `codingProfile.packageAllowlist`"
      : r.reason === "wardby_version_filtered"
        ? "no version passed the release-age, advisory or malware checks; wait or adjust `packagePolicy.minReleaseAgeDays`, accept an advisory in `packagePolicy.acceptedAdvisories`, or upgrade. Never bypass malware checks"
        : r.reason === "wardby_lockfile_entry_unsupported"
          ? "the lock file installs it from git or a URL, which the registry cannot verify; depend on a registry version instead"
          : TRANSIENT.has(r.reason)
            ? "the registry could not finish checking it (a slow or failing upstream); mention `@wardby` again to retry"
            : "refused by the package registry; review the package policy and registry error before retrying";
    return `- ${codeSpan(r.ecosystem)} ${codeSpan(r.name)}: ${guidance}${code}`;
  });
  if (distinct.length > 10) lines.push(`- ${distinct.length - 10} more refused packages.`);
  const text = [
    blocked
      ? `⛔ ${bold("Blocked by the package registry: no changes were made.")} Coding sub-runs couldn't install:`
      : `⚠️ ${bold("Dependency install incomplete.")} Coding sub-runs couldn't install:`,
    ...lines,
    "",
    "To unblock: use `update_agent` to update `codingProfile.packageAllowlist` or `codingProfile.packagePolicy` as appropriate (needs `packages:approve` or `agents:admin`), then mention `@wardby` again. ",
  ].join("\n");
  // Slack's three control characters; the names cannot hold < or > (codeSpan), but may hold &.
  return opts.slack
    ? `${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}<${HELP_URL}|${HELP_LABEL}>`
    : `${text}[${HELP_LABEL}](${HELP_URL})`;
}
