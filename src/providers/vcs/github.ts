import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { isGitHubLogin } from "../../config/github-allowed-accounts.js";
import { ACCEPTED_ADVISORY_ID } from "../../coding/registry/allowlist.js";
import {
  packageAuditRows,
  packageAuditWording,
  summarizePackageAudit,
  type PackageAuditReport,
} from "../../coding/registry/audit-mode.js";
import { refusalMeaning } from "../../coding/registry/refusal-hints.js";
import {
  DEPENDENCY_CACHE_PATH,
  normalizeGitHubRepository,
  normalizeGitRef,
  truncateText,
} from "../../coding/protocol.js";
import {
  LATEST_RUN_MARKER_PREFIX,
  RELATED_SECTION_END,
  RELATED_SECTION_START,
  assessFinalMessage,
  descriptionAppliedComment,
  descriptionFallbackComment,
  descriptionSha256,
  extractRelatedBlock,
  findDescriptionComments,
  hasClosingKeyword,
  isUneditedDescription,
  supersededDescriptionComment,
  type DescriptionCommentRecord,
} from "./pr-description.js";

export { RELATED_SECTION_END, RELATED_SECTION_START };

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
  /** Blocking advisories the run's packagePolicy.acceptedAdvisories waived
   *  to serve it; listed under "Accepted advisories". */
  acceptedAdvisories?: readonly string[];
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
  /**
   * Package audit mode (control-plane records, never model output): rendered
   * as a [!CAUTION] banner with the packages installed outside the allowlist
   * (and, in full mode, versions served past advisories). Kept when the
   * packages section is dropped for size.
   */
  packageAudit?: PackageAuditReport;
  /** Folders whose node_modules the dependency cache restored from a snapshot ("." for the root); control-plane data. */
  restoredDependencies?: readonly string[];
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
   * The issue in this pull request's own repository the run came from (a
   * mention on a GitHub issue; control-plane data, never model output): the
   * body's first visible line is `Resolves #N`, the GitHub issue's form of
   * the issue line above. Used only when `issue` renders no line.
   */
  issueNumber?: number;
  /**
   * The request's other pull requests (control-plane rows only), rendered as
   * the marked "Related pull requests" section. Rendering failures omit it.
   */
  related?: RelatedPullRequestsInput;
  /**
   * The run that last wrote this description (a fix round), rendered as the
   * hidden `<!-- wardby-latest:<runId> -->` last line. The root run marker
   * stays first. Dropped when it isn't a safe run id.
   */
  latestRunId?: string;
  /**
   * What the packages list covers: this run (the default), or every run on
   * the pull request (a later run's description update, whose `packages` are
   * cumulative). Only the section title differs.
   */
  packagesScope?: "run" | "pull_request";
}

export interface PullRequestResult {
  number: number;
  url: string;
  /**
   * Hash (descriptionSha256) of the body in GitHub's create response. Set only
   * when this call created the pull request; absent when it found one.
   */
  descriptionSha256?: string;
}

/** What wardby last wrote into a pull request description (control-plane records). */
export interface DescriptionBaseline {
  /** Null = legacy pull request (no recorded write). */
  recordedSha256: string | null;
  /**
   * Legacy pull requests only: the hash of the body wardby would have written
   * for the root run, rebuilt from stored records. A current body with this
   * hash is unedited. Absent when the records can't rebuild it (then the
   * description counts as edited).
   */
  legacySha256?: string;
  /** Stored summary of the run whose text the description carries (root run for legacy). */
  previousAgentText?: string;
  /** That run's id. */
  agentTextRunId: string;
}

/**
 * A fix round's description update. `runId` is this (latest) run; the pull
 * request is re-found by `rootRunId`'s marker. `related` is ignored: the
 * current body's Related block is kept verbatim.
 */
export interface UpdateDescriptionInput extends Omit<PullRequestInput, "runId" | "acceptReadyForReview"> {
  rootRunId: string;
  runId: string;
  baseline: DescriptionBaseline;
  /**
   * The head commit this description describes (the run's pushed commit, or
   * the unchanged head of a no-change round); stamped on the fallback
   * comment so a reviewer only trusts a proposal for the head it reviews.
   */
  headSha?: string;
}

/** `agentTextRunId` is the run whose summary the description now carries. */
export type DescriptionUpdateResult =
  | { kind: "replaced" | "unchanged"; sha256: string; agentTextRunId: string }
  | {
      kind: "refreshed";
      reason: "empty" | "too_short" | "missing_closing_keyword";
      sha256: string;
      agentTextRunId: string;
    }
  | { kind: "edited_by_hand"; commentPosted: boolean }
  | { kind: "skipped"; reason: "not_open" | "too_long" | "error" };

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

export interface ContinuationCheckRunCompleteInput {
  repository: string;
  runId: string;
  outcome: "succeeded" | "failed";
  /** The commit the check run was created on. */
  headSha?: string;
  /**
   * Used when headSha is unknown (the run's workspace is gone): the check run is
   * looked up on the pull request's head branch, which a run that pushed nothing
   * left at that commit.
   */
  headRef?: string;
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
  /**
   * Whether the root run's marked open pull request is still a draft: true or
   * false, or null when it is not open (merged, closed, or gone). Optional:
   * without it a caller treats the draft state as unknown.
   */
  openPullRequestDraft?(input: {
    runId: string;
    repository: string;
    baseRef: string;
    headRef: string;
  }): Promise<boolean | null>;
  /**
   * Rewrites the root run's open pull request description for a fix round,
   * or, when a person edited it since wardby last wrote it, upserts a comment
   * carrying the proposed description instead. Never throws. Optional:
   * without it, descriptions are not updated after the first run.
   */
  updatePullRequestDescription?(input: UpdateDescriptionInput): Promise<DescriptionUpdateResult>;
  /**
   * Before a fix round's push: when wardby can't write the description
   * directly, writes (or updates) the fallback comment stamped with the head
   * about to be pushed, so it already exists when the push starts a review.
   * True when it wrote one. Never throws. Optional.
   */
  proposeDescriptionComment?(input: UpdateDescriptionInput): Promise<boolean>;
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

/** The body's issue line: a tracker issue's link, else the same-repository issue the run came from. */
function issueLine(input: PullRequestInput): string | undefined {
  const parts = issueParts(input.issue);
  if (parts?.url) return `Resolves ${parts.tracker}issue [${parts.key}](${parts.url})`;
  const number = input.issueNumber;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? `Resolves #${number}` : undefined;
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

/** Whether a comment was written by this GitHub App (its bot user, through this App's id). */
function isThisAppsComment(comment: Record<string, unknown>, appId: number): boolean {
  const user = comment.user;
  const app = comment.performed_via_github_app;
  return (
    !!user &&
    typeof user === "object" &&
    (user as Record<string, unknown>).type === "Bot" &&
    !!app &&
    typeof app === "object" &&
    (app as Record<string, unknown>).id === appId
  );
}

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
   * (an open entry is listed under "Not ordered:" when any other entry,
   * open or done, has one).
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
 * When any valid entry (open, merged or closed) carries a `mergeOrder` (set
 * by the delegating agent), steps are counted over all of them, so a
 * label never changes as pull requests merge: the open entries that have
 * one are numbered under "Merge order" and labelled with their step (equal
 * `mergeOrder` values share a step label), any open entry without one is
 * listed after under "Not ordered:", and a merged or closed entry that has
 * one carries its step label in the context list too. Otherwise every open
 * entry is numbered in the unordered "Suggested merge order" list.
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
  // Over every valid entry, done ones included, so "step 2 of 3" stays the
  // same label after step 1 merges.
  const steps = [...new Set(valid.map((entry) => entry.mergeOrder).filter(isNumber))].sort((a, b) => a - b);
  const stepLabel = (entry: RelatedPullRequestEntry) =>
    isNumber(entry.mergeOrder) ? ` — step ${steps.indexOf(entry.mergeOrder) + 1} of ${steps.length}` : "";
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
          ...(ordered.length > 0
            ? [
                "",
                "Merge order (set by the delegating agent; equal steps can merge in either order):",
                "",
                ...ordered.map((entry, index) => `${relatedLine(entry, `${index + 1}.`)!}${stepLabel(entry)}`),
              ]
            : []),
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
      ? [
          "",
          "Already merged or closed (context only):",
          "",
          ...done.map((entry) => `${relatedLine(entry, "-")!}${stepLabel(entry)}`),
        ]
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

/** The accepted-advisories list's ceiling: smaller, so adding it keeps the
 *  whole section's worst case well inside the body limit. */
const MAX_PR_WAIVER_LIST_CHARS = 8 * 1024;

/** Renders at most MAX_PR_PACKAGE_LINES lines (and at most `maxChars`
 *  characters) of `lines`, then a count of the rest. */
function cappedList(lines: readonly string[], maxChars = MAX_PR_PACKAGE_LIST_CHARS): string[] {
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, MAX_PR_PACKAGE_LINES)) {
    if (chars + line.length + 1 > maxChars) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, `- …and ${more} more — see get_run for the full list`] : shown;
}

const MAX_DEPENDENCY_CACHE_FOLDERS = 4;

function dependencyCacheLine(folders: readonly string[] | undefined): string | undefined {
  const shown = [...new Set(folders ?? [])]
    .filter((folder) => DEPENDENCY_CACHE_PATH.test(folder))
    .slice(0, MAX_DEPENDENCY_CACHE_FOLDERS)
    .map((folder) => (folder === "." ? "the repo root" : `\`${folder}\``));
  return shown.length > 0 ? `Dependency cache: restored \`node_modules\` for ${shown.join(", ")}.` : undefined;
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
  const restored = dependencyCacheLine(input.restoredDependencies);
  if (packages.length === 0 && refusals.length === 0) return restored;
  // Only ids safe in a Markdown line; a package whose ids are all unsafe is
  // not listed here (it is still listed as installed).
  const waivers = packages.flatMap((pkg) => {
    // Ids come from OSV (a waiver can match via alias), so keep only the
    // policy id shape and render each in a code span.
    const ids = (pkg.acceptedAdvisories ?? []).filter((id) => ACCEPTED_ADVISORY_ID.test(id));
    return ids.length > 0 ? [`- \`${pkg.name}@${pkg.version}\`: ${ids.map((id) => `\`${id}\``).join(", ")}`] : [];
  });
  return [
    ...(restored ? [restored, ""] : []),
    "<details>",
    input.packagesScope === "pull_request"
      ? `<summary>Packages installed by wardby's runs on this pull request (${packages.length})</summary>`
      : `<summary>Packages installed during this run (${packages.length})</summary>`,
    "",
    ...cappedList(packages.map((pkg) => `- ${pkg.ecosystem} \`${pkg.name}@${pkg.version}\``)),
    ...(refusals.length > 0
      ? [
          "",
          "**Refused:**",
          ...cappedList(refusals.map((refusal) => `- ${refusal.ecosystem} \`${refusal.name}\`: ${refusal.reason}`)),
        ]
      : []),
    ...(waivers.length > 0
      ? [
          "",
          "**Accepted advisories** (waived by this agent's package policy):",
          ...cappedList(waivers, MAX_PR_WAIVER_LIST_CHARS),
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
    const meaning = refusalMeaning(reason);
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

/** The banner when the audit report can't be rendered: fixed text, no record data. */
const PACKAGE_AUDIT_FALLBACK_BANNER =
  "> [!CAUTION]\n> **Package audit mode was on for this run.** Wardby's registry may have installed packages outside this agent's allowlist; see `get_run` (`packageAudit`) before merging.";

/**
 * The package audit block: built only from registry records (names and
 * versions through codeSpan, advisory ids by their policy shape), so neither
 * the model nor a package's metadata can remove or soften it.
 */
function packageAuditSection(input: PullRequestInput): string | undefined {
  if (!input.packageAudit) return undefined;
  const summary = summarizePackageAudit(packageAuditRows(input.packageAudit.entries));
  return packageAuditWording(input.packageAudit.mode, summary, { format: "pr" });
}

/**
 * The pull request body, within GitHub's MAX_PULL_REQUEST_BODY_CHARS. When it
 * would be longer, the informational Packages section goes first; if that is
 * not enough, the agent's summary is truncated to fit (fitSummary keeps its
 * closing-keyword line). The other sections are bounded and stay whole.
 */
export function pullRequestBody(input: PullRequestInput, options: { omitPackages?: boolean } = {}): string {
  const body = buildPullRequestBody(input, options);
  if (body.length <= MAX_PULL_REQUEST_BODY_CHARS) return body;
  const withoutPackages = options.omitPackages ? body : buildPullRequestBody(input, { omitPackages: true });
  if (withoutPackages.length <= MAX_PULL_REQUEST_BODY_CHARS || !input.summary) return withoutPackages;
  const room = input.summary.length - (withoutPackages.length - MAX_PULL_REQUEST_BODY_CHARS);
  return buildPullRequestBody({ ...input, summary: fitSummary(input.summary, room) }, { omitPackages: true });
}

/**
 * `summary` cut to `max` characters. A last line with a closing keyword
 * (`Resolves #12`) is kept after the cut, so merging still closes the issue.
 */
function fitSummary(summary: string, max: number): string {
  const measure = (value: string) => value.length;
  const lines = summary.trimEnd().split("\n");
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last.length <= 200 && hasClosingKeyword(last)) {
    const kept = truncateText(lines.slice(0, -1).join("\n"), max - last.length - 2, measure);
    return `${kept}\n\n${last}`;
  }
  return truncateText(summary, max, measure);
}

/** The hidden run marker stays first and unconditional: createOrFindDraftPullRequest's idempotent lookup depends on it. */
function buildPullRequestBody(input: PullRequestInput, options: { omitPackages?: boolean }): string {
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
  try {
    const audit = packageAuditSection(input);
    if (audit) sections.push(audit);
  } catch {
    // Unlike the packages section, the audit banner fails closed: a report
    // that can't be rendered still says the mode was on.
    if (input.packageAudit) sections.push(PACKAGE_AUDIT_FALLBACK_BANNER);
  }
  if (input.summary) sections.push(input.summary);
  if (input.tests?.length) {
    sections.push(["**Tests:**", ...input.tests.map((test) => `- \`${test.command}\`: ${test.outcome}`)].join("\n"));
  }
  // The packages section is informational: a failure rendering it (e.g. a
  // malformed report) omits the section and never fails finalization.
  try {
    const packages = options.omitPackages ? undefined : packagesSection(input);
    if (packages) sections.push(packages);
  } catch {
    // omitted
  }
  if (input.latestRunId && SAFE_RUN_ID.test(input.latestRunId)) {
    sections.push(`${LATEST_RUN_MARKER_PREFIX}${input.latestRunId} -->`);
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

  private identity?: Promise<{ id: number; slug: string; ownerLogin: string }>;

  /**
   * The App's id, slug (its @-mention handle), and owner account, read once
   * with the App JWT and memoized. `fresh` re-reads GET /app and replaces the
   * memo (used before a destructive action, since the owner can change).
   * A rejection is never cached.
   */
  appIdentity(opts?: { fresh?: boolean }): Promise<{ id: number; slug: string; ownerLogin: string }> {
    if (opts?.fresh) this.identity = undefined;
    this.identity ??= (async () => {
      const response = await this.requestJson("/app", await this.appJwt());
      const payload = record(await response.json());
      if (typeof payload.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(payload.slug)) {
        throw new Error("github_api_invalid_response");
      }
      const ownerLogin = record(payload.owner).login;
      if (!isGitHubLogin(ownerLogin)) throw new Error("github_api_invalid_response");
      return { id: positiveInteger(payload.id), slug: payload.slug, ownerLogin };
    })();
    const pending = this.identity;
    void pending.catch(() => {
      // Only clear our own attempt: a newer (fresh) read may have replaced it.
      if (this.identity === pending) this.identity = undefined;
    });
    return pending;
  }

  /** Removes this App from an installation (an account outside the trusted set). */
  async deleteInstallation(installationId: number): Promise<void> {
    const id = positiveInteger(installationId);
    await this.requestJson(`/app/installations/${id}`, await this.appJwt(), { method: "DELETE" }, [204]);
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
    if (!SAFE_RUN_ID.test(input.runId) || (input.headSha !== undefined && !SAFE_COMMIT_SHA.test(input.headSha))) {
      throw new Error("github_check_run_input_invalid");
    }
    const ref = input.headSha ?? (input.headRef === undefined ? undefined : normalizeGitRef(input.headRef));
    if (!ref) throw new Error("github_check_run_input_invalid");
    await this.withChecksToken(repository, async (token) => {
      const existing = await this.findCheckRun(token, repository, ref, input.runId);
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
      if (response.status === 201) {
        const payload = record(await response.json());
        const created = this.parsePullRequest(payload, repository);
        // Hash what GitHub stored, not what was sent.
        return typeof payload.body === "string"
          ? { ...created, descriptionSha256: descriptionSha256(payload.body) }
          : created;
      }

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

  /** See GitHubRepositoryAccess.openPullRequestDraft: GitHub's own `draft` flag on the marked open PR. */
  async openPullRequestDraft(input: {
    runId: string;
    repository: string;
    baseRef: string;
    headRef: string;
  }): Promise<boolean | null> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId)) throw new Error("github_pull_request_input_invalid");
    return this.withRepositoryToken(repository, async (token) => {
      const found = await this.findMarkedPullRequest(token, {
        runId: input.runId,
        repository,
        baseRef,
        headRef,
        acceptReadyForReview: true,
      });
      return found ? found.draft : null;
    });
  }

  /**
   * A fix round's description update (see GitHubRepositoryAccess). One
   * repository token; every failure becomes `skipped:error`.
   */
  async updatePullRequestDescription(input: UpdateDescriptionInput): Promise<DescriptionUpdateResult> {
    try {
      const target = this.descriptionTarget(input);
      return await this.withRepositoryToken(target.repository, async (token) => {
        const state = await this.descriptionState(token, input, target);
        if (!state) return { kind: "skipped", reason: "not_open" } as const;
        const { pr, verdict, full, proposed } = state;
        const { repository } = target;
        if (!state.writable) {
          // The comment truncates a body too long for it, so the full one goes in.
          const commentPosted = await this.upsertDescriptionComment(token, repository, pr.number, input, full, state)
            .then(() => true)
            .catch(() => false);
          return { kind: "edited_by_hand", commentPosted } as const;
        }
        if (proposed === undefined) return { kind: "skipped", reason: "too_long" } as const;

        const agentTextRunId = verdict.ok ? input.runId : input.baseline.agentTextRunId;
        const outcome = verdict.ok
          ? ({ kind: "replaced" } as const)
          : ({ kind: "refreshed", reason: verdict.reason } as const);
        const proposedSha256 = descriptionSha256(proposed);
        if (proposedSha256 === input.baseline.recordedSha256) {
          return { kind: "unchanged", sha256: proposedSha256, agentTextRunId: input.baseline.agentTextRunId } as const;
        }
        const [owner, name] = repository.split("/");
        // Known, accepted race: a person editing between our read and this PATCH is overwritten (GitHub has no If-Match); the store's compare-and-set only covers wardby runs racing each other.
        const response = await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pr.number}`,
          token,
          { method: "PATCH", body: JSON.stringify({ body: proposed }) },
          [200],
        );
        const written = record(await response.json()).body;
        if (typeof written !== "string") throw new Error("github_api_invalid_response");
        // A proposal left from an earlier round is stale now; a failure here never undoes the write.
        await this.markDescriptionCommentApplied(token, repository, pr.number, input.runId, state).catch(
          () => undefined,
        );
        return { ...outcome, sha256: descriptionSha256(written), agentTextRunId };
      });
    } catch {
      return { kind: "skipped", reason: "error" };
    }
  }

  /** See GitHubRepositoryAccess.proposeDescriptionComment. */
  async proposeDescriptionComment(input: UpdateDescriptionInput): Promise<boolean> {
    try {
      if (!input.headSha || !/^[0-9a-f]{40}$/.test(input.headSha)) return false;
      const target = this.descriptionTarget(input);
      return await this.withRepositoryToken(target.repository, async (token) => {
        const state = await this.descriptionState(token, input, target);
        if (!state || state.writable) return false;
        await this.upsertDescriptionComment(token, target.repository, state.pr.number, input, state.full, state);
        return true;
      });
    } catch {
      return false;
    }
  }

  /** The validated repository and refs; throws unless this is wardby's own pull request branch. */
  private descriptionTarget(input: UpdateDescriptionInput): { repository: string; baseRef: string; headRef: string } {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (
      !SAFE_RUN_ID.test(input.runId) ||
      !SAFE_RUN_ID.test(input.rootRunId) ||
      !SAFE_RUN_ID.test(input.baseline.agentTextRunId) ||
      (input.headSha !== undefined && !/^[0-9a-f]{40}$/.test(input.headSha)) ||
      // Only wardby's own pull request: its branch is the root run's.
      headRef !== `wardby/run-${input.rootRunId}`
    ) {
      throw new Error("github_pull_request_description_input_invalid");
    }
    return { repository, baseRef, headRef };
  }

  /**
   * The open pull request, the description this run proposes, and whether
   * wardby may write it directly: it is unedited (recorded or rebuilt hash),
   * or a person copied wardby's latest proposal in (taken back). Null when
   * the pull request isn't open. `comments` is set when it was read.
   */
  private async descriptionState(
    token: string,
    input: UpdateDescriptionInput,
    target: { repository: string; baseRef: string; headRef: string },
  ): Promise<{
    pr: PullRequestResult;
    currentBody: string;
    verdict: ReturnType<typeof assessFinalMessage>;
    full: string;
    proposed: string | undefined;
    writable: boolean;
    comments?: { newest: DescriptionCommentRecord | null; older: DescriptionCommentRecord[] };
  } | null> {
    const { repository, baseRef, headRef } = target;
    const found = await this.findMarkedPullRequest(token, {
      runId: input.rootRunId,
      repository,
      baseRef,
      headRef,
      acceptReadyForReview: true,
    });
    if (!found) return null;
    const { pr, body: currentBody } = found;
    const verdict = assessFinalMessage(input.summary, input.baseline.previousAgentText);
    const summary = verdict.ok ? input.summary : input.baseline.previousAgentText;
    const { full, proposed } = this.proposedDescription(input, repository, baseRef, headRef, summary, currentBody);
    const unedited = isUneditedDescription({
      currentBody,
      rootRunId: input.rootRunId,
      recordedSha256: input.baseline.recordedSha256,
      ...(input.baseline.legacySha256 ? { legacySha256: input.baseline.legacySha256 } : {}),
      previousAgentText: input.baseline.previousAgentText,
    });
    if (unedited) return { pr, currentBody, verdict, full, proposed, writable: true };
    const comments = await this.findDescriptionComments(token, repository, pr.number);
    const latest = comments.newest?.parsed.proposed;
    // The author copied wardby's latest proposal in: the description is wardby's again.
    const takenBack =
      latest !== undefined &&
      isUneditedDescription({
        currentBody,
        rootRunId: input.rootRunId,
        recordedSha256: descriptionSha256(latest),
      });
    return { pr, currentBody, verdict, full, proposed, writable: takenBack, comments };
  }

  /**
   * The rebuilt description: the generated sections from this run with
   * `summary` as the agent text, the latest-run marker last, and the current
   * body's Related block re-inserted verbatim. `proposed` drops the Packages
   * section when `full` exceeds GitHub's limit, and is undefined when it still
   * would.
   */
  private proposedDescription(
    input: UpdateDescriptionInput,
    repository: string,
    baseRef: string,
    headRef: string,
    summary: string | undefined,
    currentBody: string,
  ): { full: string; proposed: string | undefined } {
    const related = extractRelatedBlock(currentBody.replace(/\r\n/g, "\n"));
    const build = (omitPackages: boolean) => {
      const body = pullRequestBody(
        {
          repository,
          baseRef,
          headRef,
          runId: input.rootRunId,
          latestRunId: input.runId,
          summary,
          tests: input.tests,
          tag: input.tag,
          packages: input.packages,
          packagesScope: "pull_request",
          packageRefusals: input.packageRefusals,
          packageAudit: input.packageAudit,
          restoredDependencies: input.restoredDependencies,
          changedLockfiles: input.changedLockfiles,
          issue: input.issue,
          issueNumber: input.issueNumber,
        },
        { omitPackages },
      );
      return related ? (upsertRelatedSection(body, related) ?? body) : body;
    };
    const full = build(false);
    if (full.length <= MAX_PULL_REQUEST_BODY_CHARS) return { full, proposed: full };
    const trimmed = build(true);
    return { full, proposed: trimmed.length <= MAX_PULL_REQUEST_BODY_CHARS ? trimmed : undefined };
  }

  /**
   * Creates the pull request's one description comment, or edits the newest
   * one this App wrote (unchanged text is not re-sent); older duplicates are
   * rewritten to point at it. A comment anyone else wrote is never edited.
   */
  private async upsertDescriptionComment(
    token: string,
    repository: string,
    pullRequestNumber: number,
    input: UpdateDescriptionInput,
    proposedBody: string,
    state: { comments?: { newest: DescriptionCommentRecord | null; older: DescriptionCommentRecord[] } },
  ): Promise<void> {
    const body = descriptionFallbackComment(input.runId, proposedBody, input.headSha);
    const { newest, older } =
      state.comments ?? (await this.findDescriptionComments(token, repository, pullRequestNumber));
    const [owner, name] = repository.split("/");
    const commentPath = (id: number) =>
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${id}`;
    let url = newest?.url;
    if (newest) {
      if (newest.body.replace(/\r\n/g, "\n") !== body) {
        await this.requestJson(
          commentPath(newest.id),
          token,
          { method: "PATCH", body: JSON.stringify({ body }) },
          [200],
        );
      }
    } else {
      const response = await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequestNumber}/comments`,
        token,
        { method: "POST", body: JSON.stringify({ body }) },
        [201],
      );
      const created = record(await response.json()).html_url;
      url = typeof created === "string" ? created : undefined;
    }
    await this.supersedeDescriptionComments(token, commentPath, older, url);
  }

  /** Once a run applied its description, a pending proposal in the description comment is marked applied. */
  private async markDescriptionCommentApplied(
    token: string,
    repository: string,
    pullRequestNumber: number,
    runId: string,
    state: { comments?: { newest: DescriptionCommentRecord | null; older: DescriptionCommentRecord[] } },
  ): Promise<void> {
    const { newest, older } =
      state.comments ?? (await this.findDescriptionComments(token, repository, pullRequestNumber));
    if (!newest) return;
    const [owner, name] = repository.split("/");
    const commentPath = (id: number) =>
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${id}`;
    if (!newest.parsed.applied) {
      await this.requestJson(
        commentPath(newest.id),
        token,
        { method: "PATCH", body: JSON.stringify({ body: descriptionAppliedComment(runId) }) },
        [200],
      );
    }
    await this.supersedeDescriptionComments(token, commentPath, older, newest.url);
  }

  /** Rewrites duplicate description comments to a pointer at the one in use. */
  private async supersedeDescriptionComments(
    token: string,
    commentPath: (id: number) => string,
    older: readonly DescriptionCommentRecord[],
    url: string | undefined,
  ): Promise<void> {
    for (const duplicate of older) {
      await this.requestJson(
        commentPath(duplicate.id),
        token,
        { method: "PATCH", body: JSON.stringify({ body: supersededDescriptionComment(url) }) },
        [200],
      );
    }
  }

  /** The description comments this App wrote (see findDescriptionComments; the reviewer reads them the same way). */
  private async findDescriptionComments(
    token: string,
    repository: string,
    pullRequestNumber: number,
  ): Promise<{ newest: DescriptionCommentRecord | null; older: DescriptionCommentRecord[] }> {
    const { id: appId } = await this.appIdentity();
    const [owner, name] = repository.split("/");
    return findDescriptionComments(
      async (page) => {
        const response = await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequestNumber}/comments?per_page=100&page=${page}`,
          token,
        );
        const payload: unknown = await response.json();
        if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
        return payload as unknown[];
      },
      // Only this App's own comments: never a person's, nor another App's or bot's.
      (comment) => isThisAppsComment(comment, appId),
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
    return (await this.findMarkedPullRequest(token, input))?.pr ?? null;
  }

  /** findPullRequest, plus the matched pull request's raw body. */
  private async findMarkedPullRequest(
    token: string,
    input: PullRequestInput,
  ): Promise<{ pr: PullRequestResult; body: string; draft: boolean } | null> {
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
        return {
          pr: this.parsePullRequest(candidate, input.repository, input.acceptReadyForReview === true),
          body: candidate.body,
          draft: candidate.draft === true,
        };
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
    const marker = `${STATUS_COMMENT_MARKER_PREFIX}${runId} -->`;
    return this.findMarkedComment(token, repository, pullRequestNumber, (body) => body.includes(marker));
  }

  /** The first comment on the pull request (first page) whose body `matches`. */
  private async findMarkedComment(
    token: string,
    repository: string,
    pullRequestNumber: number,
    matches: (body: string) => boolean,
  ): Promise<{ id: number; body: string } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequestNumber}/comments?per_page=100`,
      token,
    );
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
    for (const item of payload) {
      const candidate = record(item);
      if (typeof candidate.body !== "string" || !matches(candidate.body)) continue;
      return { id: positiveInteger(candidate.id), body: candidate.body };
    }
    return null;
  }

  private async findCheckRun(
    token: string,
    repository: string,
    ref: string,
    runId: string,
  ): Promise<{ id: number } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
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
