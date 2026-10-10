import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { normalizeGitHubRepository, normalizeGitRef } from "../../coding/protocol.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2026-03-10";
const RUN_MARKER_PREFIX = "<!-- wardby:";
const STATUS_COMMENT_MARKER_PREFIX = "<!-- wardby-status:";
const CONTINUATION_CHECK_RUN_NAME = "wardby/continuation";
/** Mirrors coding/protocol.ts's tagSchema — validated independently here since this is where it reaches GitHub. */
const SAFE_PULL_REQUEST_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;
/** Mirrors the runId shape validated elsewhere (coding/protocol.ts, git.ts) — validated independently here too. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
}

export interface PullRequestTestResult {
  command: string;
  outcome: "passed" | "failed" | "skipped";
}

/** One package the registry proxy served during the run (RegistryFetch outcome "served"). */
export interface PackageReport {
  ecosystem: string;
  name: string;
  version: string;
}

/** One package the registry proxy refused during the run (RegistryFetch outcome "refused"). */
export interface PackageRefusal {
  ecosystem: string;
  name: string;
  reason: string;
}

export interface PullRequestInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  /** Already-validated/redacted agent-authored fields (coding/protocol.ts); optional for callers with none. */
  summary?: string;
  tests?: readonly PullRequestTestResult[];
  tag?: string;
  /** Deduplicated by the caller isn't required — pullRequestBody dedupes itself (ecosystem+name+version / +reason). */
  packages?: readonly PackageReport[];
  packageRefusals?: readonly PackageRefusal[];
  /** Lock files the run changed (repository paths); with refusals, the PR body warns they may be incomplete. */
  changedLockfiles?: readonly string[];
  /**
   * A continuation re-finds the PR its root run opened, and a person may
   * have marked that PR ready for review since. The push has already updated
   * it, so it is accepted as found instead of failing the run as
   * `github_pull_request_not_draft`. A PR this client creates is always a
   * draft either way; unset (a fresh run), only a draft PR is accepted.
   */
  acceptReadyForReview?: boolean;
  /**
   * The originating issue-tracker issue (control-plane data, never model
   * output). Provider-neutral: the title gets a `[KEY] ` prefix and the body a
   * first line linking it ("Resolves <trackerName> issue …"). The key is
   * re-validated here, a non-https `url` is dropped, and so is a `trackerName`
   * that isn't a short plain name. The PR lookup keys on the hidden run
   * marker, never the title.
   */
  issue?: { key: string; url?: string; trackerName?: string };
  /**
   * The request's other pull requests (control-plane rows only), rendered as
   * the marked "Related pull requests" section. Rendering failures omit it.
   */
  related?: RelatedPullRequestsInput;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

/** See VcsProvider.notifyContinuationStarted/Finished (types.ts) — these back that GitHub-specific mechanism. */
export interface ContinuationStatusCommentInput {
  /** This continuation round's own run id — the comment's identity/marker key. */
  runId: string;
  /** The run whose PR this belongs to (used only to re-find the PR via the existing marker lookup). */
  rootRunId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  body: string;
}

export interface ContinuationCheckRunInput {
  repository: string;
  headSha: string;
  /** Stored as the check run's external_id — the re-lookup key, so no numeric id needs to be cached anywhere. */
  runId: string;
}

export interface ContinuationCheckRunCompleteInput extends ContinuationCheckRunInput {
  outcome: "succeeded" | "failed";
}

/** One file at one ref, read through the API without a clone. */
export interface RepositoryFileInput {
  repository: string;
  ref: string;
  /** Repository-relative POSIX path. */
  path: string;
  /** Refused above this many bytes. */
  maxBytes: number;
}

const SAFE_FILE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export interface GitHubRepositoryAccess {
  withRepositoryToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T>;
  createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  /**
   * The root run's marked pull request if it is still open (draft or ready),
   * else null (merged, closed, or gone). Optional: without it, continuations
   * are not checked.
   */
  findOpenPullRequest?(input: {
    runId: string;
    repository: string;
    baseRef: string;
    headRef: string;
  }): Promise<PullRequestResult | null>;
  /** Creates the status comment if none exists yet for this run, else updates it. */
  upsertContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void>;
  /** Updates the status comment if one already exists for this run; a no-op otherwise (never creates). */
  updateContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void>;
  /** Creates an in-progress check run if none exists yet for this run+commit; a no-op if one already does. */
  createContinuationCheckRun(input: ContinuationCheckRunInput): Promise<void>;
  /** Completes the check run if one exists for this run+commit; a no-op otherwise (never creates). */
  completeContinuationCheckRun(input: ContinuationCheckRunCompleteInput): Promise<void>;
  /**
   * The raw text of one file at a ref, or null when it does not exist (a
   * Contents: read token). Optional so test doubles and non-GitHub providers
   * can omit it: coding-run services then read no declaration.
   */
  readFileAtRef?(input: RepositoryFileInput): Promise<string | null>;
}

type Fetch = typeof globalThis.fetch;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("github_api_invalid_response");
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("github_api_invalid_response");
  return Number(value);
}

function safeApiError(response: Response): Error {
  const requestId = response.headers.get("x-github-request-id");
  return new Error(`github_api_error:${response.status}${requestId ? `:${requestId}` : ""}`);
}

/** Accepts bounded opaque installation tokens without allowing control characters. */
export function isSafeGitHubInstallationToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

/**
 * Same shape as ISSUE_KEY (issue-tracker/types.ts); duplicated so the VCS layer
 * stays free of issue-tracker imports (a test keeps the two in step). The
 * executor validates with the shared one.
 */
export const PR_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,9}$/;

/** The issue key when it is well-formed; a malformed one is dropped everywhere it would be rendered. */
function validIssueKey(input: PullRequestInput): string | undefined {
  const key = input.issue?.key;
  return typeof key === "string" && PR_ISSUE_KEY.test(key) ? key : undefined;
}

export function pullRequestTitle(input: PullRequestInput): string {
  const base = input.tag ? `[${input.tag}] Wardby run ${input.runId}` : `Wardby run ${input.runId}`;
  const key = validIssueKey(input);
  return key ? `[${key}] ${base}` : base;
}

/** Validated issue parts; the tracker prefix is "" or "<Name> ". */
function issueParts(issue: PullRequestInput["issue"]): { key: string; url?: string; tracker: string } | undefined {
  const key = issue?.key;
  if (typeof key !== "string" || !PR_ISSUE_KEY.test(key)) return undefined;
  const url = issue?.url;
  const safeUrl = typeof url === "string" && url.startsWith("https://") && !/[\s<>()]/.test(url) ? url : undefined;
  const name = issue?.trackerName;
  const tracker = typeof name === "string" && /^[A-Za-z][A-Za-z0-9 .-]{0,39}$/.test(name) ? `${name.trim()} ` : "";
  return { key, ...(safeUrl ? { url: safeUrl } : {}), tracker };
}

function issueLine(input: PullRequestInput): string | undefined {
  const parts = issueParts(input.issue);
  if (!parts?.url) return undefined;
  return `Resolves ${parts.tracker}issue [${parts.key}](${parts.url})`;
}

/**
 * Package names/versions/reasons come from registry metadata, not from
 * anything Wardby validated, and land inside inline code spans in the PR
 * body. A backtick or newline in one of those fields could break out of the
 * span or the line structure, so any entry containing either is dropped
 * rather than escaped (npm/PyPI names can't contain backticks in practice,
 * so this should never trigger — it's a cheap belt-and-suspenders guard).
 */
function isSafeMarkdownFragment(value: string): boolean {
  return !value.includes("`") && !value.includes("\n") && !value.includes("\r");
}

export const RELATED_SECTION_START = "<!-- wardby-related:start -->";
export const RELATED_SECTION_END = "<!-- wardby-related:end -->";
/** At most this many pull requests are listed; the rest are counted. */
export const MAX_RELATED_PULL_REQUESTS = 20;
/** GitHub rejects a pull request body longer than this. */
export const MAX_PULL_REQUEST_BODY_CHARS = 65_536;

export type RelatedPullRequestState = "open" | "draft" | "merged" | "closed";

/** One pull request of the request's set, from stored control-plane rows only. */
export interface RelatedPullRequestEntry {
  repository: string;
  /** Absent only for `self` while the pull request is being created. */
  number?: number;
  /** Live state; absent when unknown (at creation). */
  state?: RelatedPullRequestState;
  /** The pull request whose description this section is in. */
  self?: boolean;
  /**
   * Step in the delegating agent's declared merge order (1-99), from
   * CodingRun.mergeOrder; absent = the delegating agent set no order
   * (listed under "Not ordered:" when any other open entry has one).
   */
  mergeOrder?: number;
}

export interface RelatedPullRequestsInput {
  /** In merge order: by mergeOrder when set, else the order the request's coding runs were dispatched. */
  entries: readonly RelatedPullRequestEntry[];
  issue?: { key: string; url?: string; trackerName?: string };
}

const RELATED_STATES = new Set<string>(["open", "draft", "merged", "closed"]);

/** The repository normalized, or undefined when it isn't a plain owner/name safe inside a link. */
function safeRepository(value: string): string | undefined {
  try {
    const repository = normalizeGitHubRepository(value);
    return isSafeMarkdownFragment(repository) && !/[[\]()<>\s]/.test(repository) ? repository : undefined;
  } catch {
    return undefined;
  }
}

/** One list line; `prefix` is "1." … for the merge order, "-" for the context list. */
function relatedLine(entry: RelatedPullRequestEntry, prefix: string): string | undefined {
  const repository = safeRepository(entry.repository);
  if (!repository) return undefined;
  const state = entry.state && RELATED_STATES.has(entry.state) ? ` — ${entry.state}` : "";
  if (entry.self) return `${prefix} **This pull request**${state}`;
  if (!Number.isSafeInteger(entry.number) || (entry.number ?? 0) <= 0) return undefined;
  return `${prefix} [${repository}#${entry.number}](https://github.com/${repository}/pull/${entry.number})${state}`;
}

const isDone = (entry: RelatedPullRequestEntry) => entry.state === "merged" || entry.state === "closed";

/**
 * The "Related pull requests" block, markers included, built only from
 * stored rows (never agent text). Open (and draft, and not-yet-known) pull
 * requests form the merge order; merged and closed ones follow as context.
 * Undefined when no other valid pull request is left after validation: a
 * set of one is not a set.
 *
 * When any open entry carries a `mergeOrder` (set by the delegating agent),
 * the open entries that have one are numbered and labelled with their step
 * (equal `mergeOrder` values share a step label), and any open entry
 * without one is listed after under "Not ordered:". Otherwise every open
 * entry is numbered in today's unordered "Suggested merge order" list.
 */
export function renderRelatedSection(input: RelatedPullRequestsInput): string | undefined {
  const valid = input.entries.filter((entry) => relatedLine(entry, "-") !== undefined);
  if (!valid.some((entry) => !entry.self)) return undefined;
  const issue = issueParts(input.issue);
  const issueText = issue ? ` for ${issue.tracker}issue ${issue.url ? `[${issue.key}](${issue.url})` : issue.key}` : "";
  const open = valid.filter((entry) => !isDone(entry)).slice(0, MAX_RELATED_PULL_REQUESTS);
  const done = valid.filter(isDone).slice(0, MAX_RELATED_PULL_REQUESTS - open.length);
  const more = valid.length - open.length - done.length;
  const isNumber = (value: number | undefined): value is number => Number.isSafeInteger(value);
  const steps = [...new Set(open.map((entry) => entry.mergeOrder).filter(isNumber))].sort((a, b) => a - b);
  // Stable-sorted by mergeOrder so numbering and step labels are correct
  // regardless of the caller's input order; unordered entries keep input order.
  const ordered =
    steps.length > 0
      ? open.filter((entry) => isNumber(entry.mergeOrder)).sort((a, b) => a.mergeOrder! - b.mergeOrder!)
      : [];
  const unordered = steps.length > 0 ? open.filter((entry) => !isNumber(entry.mergeOrder)) : [];
  return [
    RELATED_SECTION_START,
    "**Related pull requests**",
    "",
    `Wardby opened these pull requests for the same request${issueText}.`,
    ...(steps.length > 0
      ? [
          "",
          "Merge order (set by the delegating agent; equal steps can merge in either order):",
          "",
          ...ordered.map(
            (entry, index) =>
              `${relatedLine(entry, `${index + 1}.`)!} — step ${steps.indexOf(entry.mergeOrder!) + 1} of ${steps.length}`,
          ),
          ...(unordered.length > 0
            ? ["", "Not ordered:", "", ...unordered.map((entry) => relatedLine(entry, "-")!)]
            : []),
        ]
      : open.length > 0
        ? [
            "",
            "Suggested merge order (the order Wardby's agent opened them in; not a guarantee, so check dependencies before merging):",
            "",
            ...open.map((entry, index) => relatedLine(entry, `${index + 1}.`)!),
          ]
        : []),
    ...(done.length > 0
      ? ["", "Already merged or closed (context only):", "", ...done.map((entry) => relatedLine(entry, "-")!)]
      : []),
    ...(more > 0 ? ["", `…and ${more} more`] : []),
    "",
    "<sub>Written by Wardby from its run records; this section is replaced when the request's runs finish.</sub>",
    RELATED_SECTION_END,
  ].join("\n");
}

/** The run marker, then optionally blank lines and the "Resolves …" line: the section goes right after. */
const BODY_HEAD =
  /^[^\S\n]*<!-- (?:wardby|reevo-run):\S+ -->[^\S\n]*(?:\n|$)(?:[^\S\n]*\n)*(?:Resolves [^\n]*(?:\n|$))?/;

/**
 * The body with `block` in place of the existing marked section, or inserted
 * after the run marker (and the issue line) when there is none. Null — do not
 * write — when the body has no leading run marker, its section markers are
 * malformed (one missing, reversed, or repeated), or `block` isn't a marked block.
 */
export function upsertRelatedSection(body: string, block: string): string | null {
  if (!block.startsWith(RELATED_SECTION_START) || !block.endsWith(RELATED_SECTION_END)) return null;
  const text = body.replace(/\r\n/g, "\n");
  const start = text.indexOf(RELATED_SECTION_START);
  const end = text.indexOf(RELATED_SECTION_END);
  if (start !== -1 || end !== -1) {
    if (
      start === -1 ||
      end === -1 ||
      end < start ||
      text.indexOf(RELATED_SECTION_START, start + 1) !== -1 ||
      text.indexOf(RELATED_SECTION_END, end + 1) !== -1
    ) {
      return null;
    }
    return text.slice(0, start) + block + text.slice(end + RELATED_SECTION_END.length);
  }
  const head = BODY_HEAD.exec(text);
  if (!head) return null;
  const before = text.slice(0, head[0].length).trimEnd();
  const rest = text.slice(head[0].length).trimStart();
  return rest ? `${before}\n\n${block}\n\n${rest}` : `${before}\n\n${block}`;
}

/** At most this many packages, and separately this many refusals, are listed
 *  in a PR body; the rest are counted in a "…and N more" line pointing at
 *  get_run, which returns the full list. */
export const MAX_PR_PACKAGE_LINES = 100;
/** A hard ceiling on each list's rendered size, whatever the entries
 *  contain, so the section can never push the body past GitHub's limit. */
const MAX_PR_PACKAGE_LIST_CHARS = 16 * 1024;

/** Renders at most MAX_PR_PACKAGE_LINES lines (and at most
 *  MAX_PR_PACKAGE_LIST_CHARS characters) of `lines`, then a count of the rest. */
function cappedList(lines: readonly string[]): string[] {
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, MAX_PR_PACKAGE_LINES)) {
    if (chars + line.length + 1 > MAX_PR_PACKAGE_LIST_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, `- …and ${more} more — see get_run for the full list`] : shown;
}

function packagesSection(input: PullRequestInput): string | undefined {
  const packages = [
    ...new Map(
      (input.packages ?? [])
        .filter(
          (pkg) =>
            isSafeMarkdownFragment(pkg.ecosystem) &&
            isSafeMarkdownFragment(pkg.name) &&
            isSafeMarkdownFragment(pkg.version),
        )
        .map((pkg) => [`${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`, pkg] as const),
    ).values(),
  ];
  const refusals = [
    ...new Map(
      (input.packageRefusals ?? [])
        .filter(
          (refusal) =>
            isSafeMarkdownFragment(refusal.ecosystem) &&
            isSafeMarkdownFragment(refusal.name) &&
            isSafeMarkdownFragment(refusal.reason),
        )
        .map((refusal) => [`${refusal.ecosystem}\0${refusal.name}\0${refusal.reason}`, refusal] as const),
    ).values(),
  ];
  if (packages.length === 0 && refusals.length === 0) return undefined;
  return [
    "<details>",
    `<summary>Packages installed during this run (${packages.length})</summary>`,
    "",
    ...cappedList(packages.map((pkg) => `- ${pkg.ecosystem} \`${pkg.name}@${pkg.version}\``)),
    ...(refusals.length > 0
      ? [
          "",
          "**Refused:**",
          ...cappedList(refusals.map((refusal) => `- ${refusal.ecosystem} \`${refusal.name}\`: ${refusal.reason}`)),
        ]
      : []),
    "</details>",
  ].join("\n");
}

/** Lock file names whose change, alongside a refusal, means CI's clean install may fail. */
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
]);

export function isLockfilePath(path: string): boolean {
  return LOCKFILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1));
}

/** What each refusal code means to someone reading the PR, without the registry's internals. */
const REFUSAL_MEANING: Record<string, string> = {
  wardby_package_not_allowed: "not on the allowlist, or only reachable through a refused package",
  wardby_version_filtered: "withheld: newer than the release-age limit, or a high-severity advisory",
  wardby_graph_incomplete: "its dependencies could not be confirmed (usually transient)",
  wardby_lockfile_integrity_mismatch: "the lock file's integrity does not match the registry's",
  wardby_upstream_error: "the upstream registry failed (transient)",
  wardby_audit_unavailable: "the advisory check was unavailable (transient)",
};

/** At most this many refused packages are named in the warning; the full list stays in the details. */
const MAX_WARNING_NAMES = 8;

/**
 * A visible warning when the registry refused packages: the run's own
 * installs were then incomplete, so failed checks in Tests may be the
 * sandbox, not the change, and a changed lock file may not install in CI.
 * Built only from registry records and the run's own diff, never from the
 * agent's summary, so it cannot be softened or left out by the model.
 */
/** Rendered verbatim in refusalWarning's first line, and used to locate it in tests. */
export const DEPENDENCY_INSTALL_INCOMPLETE = "Dependency install incomplete.";

function refusalWarning(input: PullRequestInput): string | undefined {
  const refusals = (input.packageRefusals ?? []).filter(
    (r) => isSafeMarkdownFragment(r.ecosystem) && isSafeMarkdownFragment(r.name) && isSafeMarkdownFragment(r.reason),
  );
  if (refusals.length === 0) return undefined;
  const byReason = new Map<string, Set<string>>();
  for (const r of refusals) {
    const names = byReason.get(r.reason) ?? new Set<string>();
    names.add(`${r.ecosystem} \`${r.name}\``);
    byReason.set(r.reason, names);
  }
  const lines = [
    "> [!WARNING]",
    `> **${DEPENDENCY_INSTALL_INCOMPLETE}** Wardby's package registry refused packages during this run, so its installs did not finish and failed checks under **Tests** may come from the sandbox rather than this change.`,
  ];
  for (const [reason, names] of byReason) {
    const listed = [...names];
    const shown = listed.slice(0, MAX_WARNING_NAMES).join(", ");
    const more = listed.length > MAX_WARNING_NAMES ? ` and ${listed.length - MAX_WARNING_NAMES} more` : "";
    const meaning = REFUSAL_MEANING[reason];
    lines.push(`> - ${shown}${more}: \`${reason}\`${meaning ? ` (${meaning})` : ""}`);
  }
  const lockfiles = (input.changedLockfiles ?? []).filter(isSafeMarkdownFragment);
  if (lockfiles.length > 0) {
    lines.push(
      `> ${lockfiles.map((f) => `\`${f}\``).join(", ")} changed in this run and may be incomplete: a clean install (\`npm ci\` or similar) in CI may fail until it is regenerated.`,
    );
  }
  return lines.join("\n");
}

/** The hidden run marker stays first and unconditional: createOrFindDraftPullRequest's idempotent lookup depends on it. */
export function pullRequestBody(input: PullRequestInput): string {
  const sections = [`${RUN_MARKER_PREFIX}${input.runId} -->`];
  // Hidden marker stays first; the issue link is the first visible line.
  const issue = issueLine(input);
  if (issue) sections.push(issue);
  try {
    const related = input.related ? renderRelatedSection(input.related) : undefined;
    if (related) sections.push(related);
  } catch {
    // omitted, like the packages section
  }
  try {
    const warning = refusalWarning(input);
    if (warning) sections.push(warning);
  } catch {
    // omitted, like the packages section
  }
  if (input.summary) sections.push(input.summary);
  if (input.tests?.length) {
    sections.push(["**Tests:**", ...input.tests.map((test) => `- \`${test.command}\`: ${test.outcome}`)].join("\n"));
  }
  // The packages section is informational: a failure rendering it (e.g. a
  // malformed report) omits the section and never fails finalization.
  try {
    const packages = packagesSection(input);
    if (packages) sections.push(packages);
  } catch {
    // omitted
  }
  return sections.join("\n\n");
}

/** The hidden marker stays first and unconditional: findStatusComment's lookup depends on it. */
function statusCommentBody(runId: string, body: string): string {
  return `${STATUS_COMMENT_MARKER_PREFIX}${runId} -->\n\n${body}`;
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("github_api_base_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") && !value.includes("\n") ? value.replaceAll("\\n", "\n") : value;
}

export class GitHubAppClient implements GitHubRepositoryAccess {
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9]\d*$/.test(config.appId)) throw new Error("github_app_id_invalid");
    if (!config.privateKey.trim()) throw new Error("github_app_private_key_invalid");
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) throw new Error("github_api_version_invalid");
  }

  async withRepositoryToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T> {
    const normalized = normalizeGitHubRepository(repository);
    const token = await this.mintRepositoryToken(normalized);
    try {
      return await action(token);
    } finally {
      await this.revokeToken(token).catch(() => undefined);
    }
  }

  /**
   * Isolated from withRepositoryToken on purpose: "Checks: write" is a
   * genuinely distinct GitHub App permission from contents/pull_requests
   * (confirmed empirically). Minting it separately means an ungranted-permission
   * failure here can only ever disable the check-run mechanism, never the
   * real git push, PR, or status comment. (Status comments, below, do NOT
   * need this treatment: PR-comment writes work fine on the existing
   * contents/pull_requests token -- confirmed empirically after "Issues:
   * write" alone, on its own isolated token, kept returning 403 "Resource
   * not accessible by integration" even once granted; commenting on a PR
   * apparently isn't gated the same way a genuine issue comment might be.)
   */
  private async withChecksToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T> {
    return this.withScopedToken(repository, { checks: "write" }, action);
  }

  /**
   * Mints an installation token for exactly `permissions` on one repository,
   * runs `action`, and always revokes. The building block for the
   * code-review host (providers/review-host/github.ts), whose calls each
   * request only what they need.
   */
  async withScopedToken<T>(
    repository: string,
    permissions: Record<string, "read" | "write">,
    action: (token: string) => Promise<T>,
  ): Promise<T> {
    const normalized = normalizeGitHubRepository(repository);
    const token = await this.mintScopedToken(
      normalized,
      permissions,
      (name, level) => (name === "metadata" && level === "read") || permissions[name] === level,
    );
    try {
      return await action(token);
    } finally {
      await this.revokeToken(token).catch(() => undefined);
    }
  }

  /**
   * One file's raw text at a ref, without a clone (a Contents: read token).
   * Requests the raw media type; GitHub honors it for an ordinary file but
   * falls back to a JSON metadata response for anything else the raw type
   * doesn't apply to -- a directory listing (a JSON array) or a symlink /
   * submodule (a JSON object whose `type` isn't "file"). Either of those, or
   * a 404, means there's no file text to return.
   */
  async readFileAtRef(input: RepositoryFileInput): Promise<string | null> {
    if (!SAFE_FILE_PATH.test(input.path) || input.path.split("/").some((part) => part === "." || part === "..")) {
      throw new Error("github_file_path_invalid");
    }
    const repository = normalizeGitHubRepository(input.repository);
    const ref = normalizeGitRef(input.ref);
    const [owner, name] = repository.split("/");
    const path = input.path.split("/").map(encodeURIComponent).join("/");
    return this.withScopedToken(repository, { contents: "read" }, async (token) => {
      const response = await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        token,
        { headers: { accept: "application/vnd.github.raw+json" } },
        [200, 404],
      );
      if (response.status === 404) return null;
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > input.maxBytes) throw new Error("github_file_too_large");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > input.maxBytes) throw new Error("github_file_too_large");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("github_file_not_utf8");
      }
      // Not raw content check: try to read the body as GitHub's own
      // metadata shape rather than trusting the content-type header, since
      // the raw media type itself is "application/vnd.github.raw+json" --
      // a substring check for "json" would misfire on every real file.
      let metadata: unknown;
      try {
        metadata = JSON.parse(text);
      } catch {
        return text;
      }
      if (Array.isArray(metadata)) throw new Error("github_file_not_a_file");
      if (metadata && typeof metadata === "object" && "type" in metadata && metadata.type !== "file") {
        throw new Error("github_file_not_a_file");
      }
      return text;
    });
  }

  private identity?: Promise<{ id: number; slug: string }>;

  /** The App's id and slug (its @-mention handle), read once with the App JWT. */
  appIdentity(): Promise<{ id: number; slug: string }> {
    this.identity ??= (async () => {
      const response = await this.requestJson("/app", await this.appJwt());
      const payload = record(await response.json());
      if (typeof payload.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(payload.slug)) {
        throw new Error("github_api_invalid_response");
      }
      return { id: positiveInteger(payload.id), slug: payload.slug };
    })().catch((err: unknown) => {
      this.identity = undefined;
      throw err;
    });
    return this.identity;
  }

  async upsertContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_RUN_ID.test(input.rootRunId)) {
      throw new Error("github_status_comment_input_invalid");
    }
    await this.withRepositoryToken(repository, async (token) => {
      const pr = await this.findPullRequest(token, {
        runId: input.rootRunId,
        repository,
        baseRef,
        headRef,
        acceptReadyForReview: true,
      });
      if (!pr) return;
      const existing = await this.findStatusComment(token, repository, pr.number, input.runId);
      const [owner, name] = repository.split("/");
      const body = statusCommentBody(input.runId, input.body);
      if (existing) {
        await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${existing.id}`,
          token,
          { method: "PATCH", body: JSON.stringify({ body }) },
          [200],
        );
      } else {
        await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pr.number}/comments`,
          token,
          { method: "POST", body: JSON.stringify({ body }) },
          [201],
        );
      }
    });
  }

  async updateContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_RUN_ID.test(input.rootRunId)) {
      throw new Error("github_status_comment_input_invalid");
    }
    await this.withRepositoryToken(repository, async (token) => {
      const pr = await this.findPullRequest(token, {
        runId: input.rootRunId,
        repository,
        baseRef,
        headRef,
        acceptReadyForReview: true,
      });
      if (!pr) return;
      const existing = await this.findStatusComment(token, repository, pr.number, input.runId);
      if (!existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${existing.id}`,
        token,
        { method: "PATCH", body: JSON.stringify({ body: statusCommentBody(input.runId, input.body) }) },
        [200],
      );
    });
  }

  async createContinuationCheckRun(input: ContinuationCheckRunInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_COMMIT_SHA.test(input.headSha)) {
      throw new Error("github_check_run_input_invalid");
    }
    await this.withChecksToken(repository, async (token) => {
      const existing = await this.findCheckRun(token, repository, input.headSha, input.runId);
      if (existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            name: CONTINUATION_CHECK_RUN_NAME,
            head_sha: input.headSha,
            status: "in_progress",
            external_id: input.runId,
          }),
        },
        [201],
      );
    });
  }

  async completeContinuationCheckRun(input: ContinuationCheckRunCompleteInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_COMMIT_SHA.test(input.headSha)) {
      throw new Error("github_check_run_input_invalid");
    }
    await this.withChecksToken(repository, async (token) => {
      const existing = await this.findCheckRun(token, repository, input.headSha, input.runId);
      if (!existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${existing.id}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            conclusion: input.outcome === "succeeded" ? "success" : "failure",
          }),
        },
        [200],
      );
    });
  }

  async createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId) || headRef !== `wardby/run-${input.runId}`) {
      throw new Error("github_pull_request_input_invalid");
    }
    if (input.tag !== undefined && !SAFE_PULL_REQUEST_TAG.test(input.tag)) {
      throw new Error("github_pull_request_tag_invalid");
    }

    return this.withRepositoryToken(repository, async (token) => {
      const existing = await this.findPullRequest(token, { ...input, repository, baseRef, headRef });
      if (existing) return existing;

      const [owner, name] = repository.split("/");
      const response = await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            title: pullRequestTitle(input),
            head: headRef,
            base: baseRef,
            body: pullRequestBody(input),
            draft: true,
          }),
        },
        [201, 422],
      );
      if (response.status === 201) return this.parsePullRequest(await response.json(), repository);

      const raced = await this.findPullRequest(token, { ...input, repository, baseRef, headRef });
      if (raced) return raced;
      throw safeApiError(response);
    });
  }

  /**
   * The root run's marked pull request if GitHub's `state=open` list still
   * contains it (draft or ready for review), else null -- merged, closed, or
   * gone. Used by git.ts's revision-in-place continuation to refuse a push to
   * a pull request that is no longer open.
   */
  async findOpenPullRequest(input: {
    runId: string;
    repository: string;
    baseRef: string;
    headRef: string;
  }): Promise<PullRequestResult | null> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId)) throw new Error("github_pull_request_input_invalid");
    return this.withRepositoryToken(repository, (token) =>
      this.findPullRequest(token, { runId: input.runId, repository, baseRef, headRef, acceptReadyForReview: true }),
    );
  }

  private async appJwt(): Promise<string> {
    let keyObject;
    try {
      keyObject = createPrivateKey(normalizePrivateKey(this.config.privateKey));
    } catch {
      throw new Error("github_app_private_key_invalid");
    }
    const pkcs8 = keyObject.export({ type: "pkcs8", format: "pem" }).toString();
    const key = await importPKCS8(pkcs8, "RS256");
    const now = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.config.appId)
      .sign(key);
  }

  private async mintRepositoryToken(repository: string): Promise<string> {
    return this.mintScopedToken(
      repository,
      { contents: "write", pull_requests: "write" },
      (name, level) =>
        (name === "contents" && level === "write") ||
        (name === "pull_requests" && level === "write") ||
        (name === "metadata" && level === "read"),
    );
  }

  /**
   * Shared installation-token mint: requests exactly `permissions`, then
   * verifies the response granted exactly that (no more, no less, modulo
   * the always-implicit `metadata: read`) before trusting the token. Each
   * caller requests the narrowest permission set it needs — see
   * withScopedToken/withChecksToken for why these are minted separately
   * from withRepositoryToken rather than requesting a union of everything.
   */
  private async mintScopedToken(
    repository: string,
    permissions: Record<string, string>,
    isAllowedPermission: (name: string, level: string) => boolean,
  ): Promise<string> {
    const [owner, name] = repository.split("/");
    const appJwt = await this.appJwt();
    const installationResponse = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      appJwt,
      {},
      [200, 404],
    );
    if (installationResponse.status === 404) throw new Error("github_app_not_installed");
    const installation = record(await installationResponse.json());
    const installationId = positiveInteger(installation.id);
    const tokenResponse = await this.requestJson(
      `/app/installations/${installationId}/access_tokens`,
      appJwt,
      { method: "POST", body: JSON.stringify({ repositories: [name], permissions }) },
      [201, 422],
    );
    // 422: the installation has not granted a requested permission (e.g. a
    // new permission the owner has not accepted yet).
    if (tokenResponse.status === 422) throw new Error("github_installation_token_scope_invalid");
    const payload = record(await tokenResponse.json());
    const grantedPermissions = record(payload.permissions);
    const repositories = Array.isArray(payload.repositories) ? payload.repositories.map(record) : [];
    const scopedRepository = repositories.some(
      (candidate) => typeof candidate.full_name === "string" && candidate.full_name.toLowerCase() === repository,
    );
    const expiresAt = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
    const unexpectedPermission = Object.entries(grantedPermissions).some(
      ([permissionName, level]) => !isAllowedPermission(permissionName, level as string),
    );
    const requestedGranted = Object.entries(permissions).every(
      ([permissionName, level]) => grantedPermissions[permissionName] === level,
    );
    if (
      !isSafeGitHubInstallationToken(payload.token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now().getTime() + 60_000 ||
      !requestedGranted ||
      unexpectedPermission ||
      !scopedRepository
    ) {
      throw new Error("github_installation_token_scope_invalid");
    }
    return payload.token;
  }

  private async revokeToken(token: string): Promise<void> {
    await this.requestJson("/installation/token", token, { method: "DELETE" }, [204]);
  }

  private async findPullRequest(token: string, input: PullRequestInput): Promise<PullRequestResult | null> {
    const [owner, name] = input.repository.split("/");
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${input.headRef}`,
      base: input.baseRef,
      per_page: "100",
    });
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?${query.toString()}`,
      token,
    );
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
    const marker = `${RUN_MARKER_PREFIX}${input.runId} -->`;
    for (const item of payload) {
      const candidate = record(item);
      if (typeof candidate.body === "string" && candidate.body.includes(marker)) {
        return this.parsePullRequest(candidate, input.repository, input.acceptReadyForReview === true);
      }
    }
    return null;
  }

  private parsePullRequest(value: unknown, repository: string, acceptReadyForReview = false): PullRequestResult {
    const payload = record(value);
    const number = positiveInteger(payload.number);
    if (payload.draft !== true && !acceptReadyForReview) throw new Error("github_pull_request_not_draft");
    const expectedUrl = `https://github.com/${repository}/pull/${number}`;
    if (typeof payload.html_url !== "string") throw new Error("github_pull_request_response_invalid");
    let receivedUrl: URL;
    try {
      receivedUrl = new URL(payload.html_url);
    } catch {
      throw new Error("github_pull_request_response_invalid");
    }
    if (
      receivedUrl.protocol !== "https:" ||
      receivedUrl.hostname.toLowerCase() !== "github.com" ||
      receivedUrl.port ||
      receivedUrl.username ||
      receivedUrl.password ||
      receivedUrl.search ||
      receivedUrl.hash ||
      receivedUrl.pathname.toLowerCase() !== new URL(expectedUrl).pathname.toLowerCase()
    ) {
      throw new Error("github_pull_request_response_invalid");
    }
    return { number, url: expectedUrl };
  }

  private async findStatusComment(
    token: string,
    repository: string,
    pullRequestNumber: number,
    runId: string,
  ): Promise<{ id: number } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequestNumber}/comments?per_page=100`,
      token,
    );
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
    const marker = `${STATUS_COMMENT_MARKER_PREFIX}${runId} -->`;
    for (const item of payload) {
      const candidate = record(item);
      if (typeof candidate.body === "string" && candidate.body.includes(marker)) {
        return { id: positiveInteger(candidate.id) };
      }
    }
    return null;
  }

  private async findCheckRun(
    token: string,
    repository: string,
    headSha: string,
    runId: string,
  ): Promise<{ id: number } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${headSha}/check-runs?per_page=100`,
      token,
    );
    const payload = record(await response.json());
    const checkRuns = Array.isArray(payload.check_runs) ? payload.check_runs.map(record) : [];
    for (const candidate of checkRuns) {
      if (candidate.external_id === runId) return { id: positiveInteger(candidate.id) };
    }
    return null;
  }

  /** Public for the code-review host, which issues its own REST calls with tokens minted here. */
  async requestJson(
    path: string,
    bearer: string,
    init: RequestInit = {},
    expectedStatuses: number[] = [200],
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "user-agent": "wardby",
          "x-github-api-version": this.apiVersion,
          ...init.headers,
        },
      });
    } catch (error) {
      // Keep the cause: the operator log needs the transport reason (DNS,
      // TLS, connect timeout); the message itself stays fixed and safe.
      throw new Error("github_api_unavailable", { cause: error });
    }
    if (!expectedStatuses.includes(response.status)) throw safeApiError(response);
    return response;
  }

  /**
   * Public for the code-review host: one GraphQL request, for what REST lacks
   * (review threads). A response carrying `errors` fails like a REST error.
   */
  async graphql(bearer: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.requestJson("/graphql", bearer, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    const payload = record(await response.json());
    if (Array.isArray(payload.errors) && payload.errors.length > 0) throw new Error("github_graphql_error");
    return record(payload.data);
  }
}
