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
  "coding_stream_failed",
  "coding_output_missing",
  "coding_output_invalid",
  "coding_output_run_mismatch",
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
