/**
 * The conventional-commit subject shared by the pull request title and the run's commit
 * (providers/vcs/github.ts, providers/vcs/git.ts): `type(scope): title (KEY)`.
 *
 * The model proposes a type, an optional scope and a short title; they are model-written, so
 * each is normalized rather than rejected and a run is never failed over them. A missing or
 * unusable title falls back to `Wardby run <runId>` under the `chore` type, which is still a
 * valid conventional subject. Pure: the VCS layer and the worker drivers import it (its
 * model-facing pieces live in protocol.ts, which workers ship as a single file).
 */

import {
  COMMIT_TYPES,
  MAX_COMMIT_SCOPE_LENGTH,
  MAX_COMMIT_TITLE_INPUT,
  normalizeCommitScope,
  normalizeCommitTitle,
  normalizeCommitType,
  type CommitType,
} from "./protocol.js";

export {
  COMMIT_TYPES,
  MAX_COMMIT_SCOPE_LENGTH,
  MAX_COMMIT_TITLE_INPUT,
  normalizeCommitScope,
  normalizeCommitTitle,
  normalizeCommitType,
  type CommitType,
};

/** Subject line budget (type, scope, title and issue key together), the usual commitlint limit. */
export const MAX_COMMIT_SUBJECT_LENGTH = 72;
/** Same shape as PR_ISSUE_KEY (providers/vcs/github.ts); a test keeps the two in step. */
export const COMMIT_ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,9}$/;

/** What the worker schemas tell the model about each field; shared so both providers say the same thing. */
export const COMMIT_TYPE_DESCRIPTION =
  "Conventional-commit type for THIS run's change: feat (new behavior), fix (bug fix), docs (documentation only), style (formatting only), refactor (restructuring without behavior change), perf (performance), test (tests only), build (build or dependencies), ci (CI configuration), chore (maintenance, anything else). It names the pull request on the first run and this run's commit on every run.";
export const COMMIT_SCOPE_DESCRIPTION =
  "Optional short area name for the scope, such as \"webhooks\" or \"auth\": lowercase letters, digits, '.', '_', '/', '-', at most 32 characters. Omit it or use null when no single area fits.";
export const COMMIT_TITLE_DESCRIPTION =
  'Imperative one-line summary of THIS run\'s change, e.g. "add retry to Jira webhook delivery". No type prefix, no ticket id, no trailing period; keep it under 50 characters (it is cut to fit a 72-character subject line).';

/**
 * The key shown after the title: the originating issue's key (control-plane data) when it is
 * well-formed, else the model's tag when that is itself an issue key (e.g. "GH-42").
 */
export function commitIssueKey(issueKey: string | undefined, tag: string | undefined): string | undefined {
  for (const candidate of [issueKey, tag]) {
    if (candidate !== undefined && COMMIT_ISSUE_KEY.test(candidate)) return candidate;
  }
  return undefined;
}

export interface CommitSubjectInput {
  runId: string;
  type?: string;
  scope?: string;
  title?: string;
  /** Already validated by the caller or not: it is re-checked here and dropped when malformed. */
  issueKey?: string;
}

/** A key the model wrote at the start of its title: "DEVXP-3988: add x", "[DEVXP-3988] add x". */
const LEADING_KEY = /^\[?([A-Z][A-Z0-9_]{0,254}-[1-9]\d{0,9})\]?\s*[:\-\u2013]?\s+/;

/** `type(scope): title (KEY)`, at most MAX_COMMIT_SUBJECT_LENGTH characters; the title is what gets cut. */
export function conventionalSubject(input: CommitSubjectInput): string {
  let title = normalizeCommitTitle(input.title);
  // The key is added once, after the title, so one the model wrote into it is taken out (and used
  // when the run has no key of its own).
  const lead = title === undefined ? null : LEADING_KEY.exec(title);
  if (lead !== null && title !== undefined) title = normalizeCommitTitle(title.slice(lead[0].length));
  const key = input.issueKey !== undefined && COMMIT_ISSUE_KEY.test(input.issueKey) ? input.issueKey : lead?.[1];
  if (title !== undefined && key !== undefined) {
    title = normalizeCommitTitle(title.replace(new RegExp(`\\s*\\(?\\b${key}\\b\\)?`, "g"), " "));
  }
  const type = title ? (normalizeCommitType(input.type) ?? "chore") : "chore";
  const scope = title ? normalizeCommitScope(input.scope) : undefined;
  const prefix = `${type}${scope ? `(${scope})` : ""}: `;
  const suffix = key ? ` (${key})` : "";
  const text = title ?? `Wardby run ${input.runId}`;
  const room = Math.max(MAX_COMMIT_SUBJECT_LENGTH - prefix.length - suffix.length, 0);
  // Cut at a word boundary when one is close, so the subject doesn't end mid-word.
  const cut =
    text.length <= room
      ? text
      : text
          .slice(0, room)
          .replace(/\s+\S*$/, (tail) => (tail.length <= 12 ? "" : tail))
          .replace(/[.\s]+$/, "");
  return `${prefix}${cut}${suffix}`;
}

/** The commit message: the subject, then a blank line and a `Wardby-Run` trailer naming the run. */
export function conventionalCommitMessage(input: CommitSubjectInput): string {
  return `${conventionalSubject(input)}\n\nWardby-Run: ${input.runId}`;
}
