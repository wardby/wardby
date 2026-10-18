import { ZodError } from "zod";
import { MAX_CODING_OUTPUT_ISSUES, SAFE_CODING_OUTPUT_ISSUE } from "../coding/protocol.js";

const SAFE_WORKER_ERROR_CODES = new Set([
  "wardby_proxy_url_missing",
  "wardby_run_capability_missing",
  "coding_input_invalid_file",
  "coding_output_size_limit",
  "coding_artifact_size_limit",
  "coding_artifact_invalid_json",
  "coding_artifact_nesting_limit",
  "coding_artifact_duplicate_key",
  "coding_turn_failed",
  // Claude Code reached the run's turn limit (CodingAgentProfile.maxTurns) before finishing.
  "coding_turn_limit",
  "coding_stream_failed",
  "coding_stream_proxy_denied",
  "coding_stream_rate_limited",
  // The provider account is out of credit or over its spend limit: retrying never helps.
  "coding_stream_quota_exceeded",
  "coding_stream_upstream_error",
  "coding_stream_timeout",
  "coding_stream_proxy_unreachable",
  "coding_stream_agent_exited",
  "coding_output_missing",
  "coding_output_invalid",
  "coding_output_run_mismatch",
  // Claude Code: its command tool (the relay to the tool runner's socket) never connected.
  "worker_tool_runner_unreachable",
]);

/**
 * For `coding_output_invalid`, where the model's final answer failed the output
 * schema: the failing schema paths and issue codes, so the operator log can say
 * which field was wrong without ever carrying the value. Undefined when the
 * cause is not a schema failure.
 */
export function safeOutputIssues(error: unknown): string[] | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (!(cause instanceof ZodError)) return undefined;
  const issues = cause.issues
    .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}:${issue.code}`)
    .filter((issue) => SAFE_CODING_OUTPUT_ISSUE.test(issue))
    .slice(0, MAX_CODING_OUTPUT_ISSUES);
  return issues.length > 0 ? issues : undefined;
}

export function safeWorkerErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "worker_failed";
  if (error.message.startsWith("coding_artifact_duplicate_key:")) {
    return "coding_artifact_duplicate_key";
  }
  return SAFE_WORKER_ERROR_CODES.has(error.message) ? error.message : "worker_failed";
}

/**
 * What a coding agent's stream failure was, as a fixed code, from the error it threw (Codex and
 * Claude Code alike): the error text itself can carry prompts, repository content or provider
 * detail, so only the matched category ever leaves the worker. Checked in order: the proxy's own
 * budget refusal (a 429 carrying wardby_budget_exhausted), then a provider quota or spend limit
 * (OpenAI answers those with a 429 too), win over the generic 429.
 */
const STREAM_FAILURE_CODES: ReadonlyArray<readonly [RegExp, string]> = [
  [/wardby_budget_exhausted/, "budget_exhausted"],
  [
    /insufficient_quota|spend.?limit|exceeded your current quota|credit balance is too low|billing_error/,
    "coding_stream_quota_exceeded",
  ],
  [/\b40[13]\b|unauthori[sz]ed|forbidden/, "coding_stream_proxy_denied"],
  [/\b429\b|too many requests|rate.?limit/, "coding_stream_rate_limited"],
  [/\b5\d\d\b|bad gateway|service unavailable|internal server error/, "coding_stream_upstream_error"],
  [/timed? ?out/, "coding_stream_timeout"],
  [
    /connection (?:refused|reset|closed)|econn(?:refused|reset)|enotfound|eai_again|error sending request|broken pipe|dns/,
    "coding_stream_proxy_unreachable",
  ],
  [/exited with (?:code|signal)|exit code/, "coding_stream_agent_exited"],
];

export function streamFailureCode(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  for (const [pattern, code] of STREAM_FAILURE_CODES) if (pattern.test(message)) return code;
  return "coding_stream_failed";
}
