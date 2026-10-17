import { defuseMentions } from "../core/reply-parts.js";
import { neutraliseWrapperTags } from "../core/untrusted-content.js";
import { byteLength, truncateText } from "./protocol.js";

/**
 * A coding continuation whose pull request is no longer open (merged or
 * closed) pushes nothing: git.ts checks before cloning and again before the
 * push. These are the fixed texts the delegating agent and status comments see.
 */
export const CONTINUATION_CLOSED_ERROR = "vcs_continuation_pull_request_not_open";
export const CONTINUATION_CLOSED_CATEGORY = "continuation_closed";
export const CONTINUATION_CLOSED_SENTENCE =
  "The pull request this run was asked to continue is no longer open (merged or closed), so nothing was pushed. " +
  "If the change is still needed, delegate again without continuePriorRun: it becomes a new pull request from the default branch.";
export const CONTINUATION_CLOSED_HOST_LINE =
  "A sub-run was asked to continue a pull request that is no longer open (merged or closed); nothing was pushed.";

export function isContinuationClosedError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(`coding_failure_${CONTINUATION_CLOSED_CATEGORY}:`);
}

/**
 * A run stopped at its budget pushes the changes it made so far as the usual
 * draft (the run still ends budget_exhausted). Its summary, and so the pull
 * request description, starts with this sentence.
 */
export const BUDGET_STOPPED_SUMMARY_PREFIX =
  "Stopped at its budget before finishing; the changes so far are in this draft.";

/**
 * The fixed summary both coding workers return when the proxy refused a model
 * request for budget (src/coding-worker/driver.ts,
 * src/claude-coding-worker/driver.ts; their tests pin it to this constant).
 */
export const WORKER_BUDGET_EXHAUSTED_SUMMARY = "The coding budget was exhausted before the task could complete.";

/**
 * The summary of a budget-stopped run whose changes were pushed: the prefix,
 * then the worker's own summary unless it is only the workers' fixed budget
 * sentence (the prefix already says that).
 */
export function budgetStoppedSummary(summary: string, request?: string | null): string {
  const head = request?.trim()
    ? `${BUDGET_STOPPED_SUMMARY_PREFIX}\n\n${budgetStoppedTaskSection(request)}`
    : BUDGET_STOPPED_SUMMARY_PREFIX;
  if (summary.trim() === WORKER_BUDGET_EXHAUSTED_SUMMARY) return head;
  return `${head}\n\n${summary}`;
}

/** The most of a request a budget-stopped draft quotes. */
const MAX_TASK_QUOTE_BYTES = 4 * 1024;
const TASK_TRUNCATED_MARKER = "\n\n[task truncated]";

/**
 * The "Task" section of a budget-stopped draft: the run's own request (not the
 * agent's standing instructions) as a Markdown blockquote. The request is
 * untrusted text going into a pull request body: capped, App mentions
 * defused, and prompt-fence lookalikes neutralised (a later continuation reads
 * this body back in its task).
 */
export function budgetStoppedTaskSection(request: string): string {
  const capped = truncateText(request.trim(), MAX_TASK_QUOTE_BYTES, byteLength, TASK_TRUNCATED_MARKER);
  const safe = neutraliseWrapperTags(defuseMentions(capped));
  const quoted = safe
    .split(/\r\n|\r|\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `### Task\n\n${quoted}`;
}

/**
 * How to continue a budget-stopped run's pushed changes, after "ran out of
 * budget before finishing". `ref` names the pull request (`#42`,
 * `owner/repo#42`), `draft` when this run opened it. Status comments are
 * posted by the App, and a bot-authored comment never starts a run, so the
 * mention here is safe.
 */
export function budgetStoppedChangesSentence(ref: string, draft: boolean): string {
  return `The changes so far are in ${draft ? "draft PR " : ""}${ref}; comment \`@wardby\` on it to continue.`;
}
