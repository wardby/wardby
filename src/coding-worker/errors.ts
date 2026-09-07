const SAFE_WORKER_ERROR_CODES = new Set([
  "reevo_proxy_url_missing",
  "reevo_run_capability_missing",
  "coding_input_invalid_file",
  "coding_output_size_limit",
  "coding_artifact_size_limit",
  "coding_artifact_invalid_json",
  "coding_artifact_nesting_limit",
  "coding_artifact_duplicate_key",
  "coding_turn_failed",
  "coding_output_missing",
  "coding_output_run_mismatch",
]);

export function safeWorkerErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "worker_failed";
  if (error.message.startsWith("coding_artifact_duplicate_key:")) {
    return "coding_artifact_duplicate_key";
  }
  return SAFE_WORKER_ERROR_CODES.has(error.message) ? error.message : "worker_failed";
}
