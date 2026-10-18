/**
 * The code a wardby error message leads with (`some_code` or `some_code: detail`), or undefined.
 * Worker-safe: the native sandbox worker image ships this module.
 */
export function errorCodeOf(message: string | null | undefined): string | undefined {
  return message ? /^([a-z][a-z0-9_]*)(:|$)/.exec(message)?.[1] : undefined;
}

/** The longest cause code carried; a longer leading word is not a code. */
const MAX_CAUSE_CODE_LENGTH = 64;

/** The code an unexpected error's message leads with, if it is code-shaped (has an underscore) and short enough. */
export function causeCodeOf(err: unknown): string | undefined {
  const code = errorCodeOf(err instanceof Error ? err.message : typeof err === "string" ? err : undefined);
  // Only the code form leaves a boundary: snake_case with an underscore, so a bare word
  // (which could be a token) never crosses.
  return code && code.includes("_") && code.length <= MAX_CAUSE_CODE_LENGTH ? code : undefined;
}

/**
 * The only codes that may be shown from an arbitrary error's text (to a worker, or to the model in a
 * tool result): wardby's own codes that an unexpected error on those paths can lead with. Anything
 * else, however code-shaped, could be a value from an error's text, so it never crosses.
 * - coding_execution_not_configured, coding_profile_missing: a coding delegation reaching a process
 *   that cannot start coding runs (core/deferred-coding.ts, providers/executor/routing.ts).
 * - message_too_large, message_not_json, message_invalid, unsupported_protocol_version: the native
 *   worker protocol's own ProtocolError codes (native-worker/protocol.ts).
 * - invalid_merge_order: dispatchRun's refusal of a bad mergeOrder (core/dispatch.ts).
 * - coding_worker_image_invalid: a coding worker image that is not pinned by digest
 *   (providers/executor/container.ts).
 * - native_sandbox_unavailable: createRun/the router refusing a sandbox-mode agent with no sandbox executor
 *   (core/runner.ts).
 * - run_tree_exhausted: dispatchRun refusing a run whose tree budget is spent (core/dispatch.ts).
 */
export const GATEWAY_CAUSE_CODES: ReadonlySet<string> = new Set([
  "coding_execution_not_configured",
  "coding_profile_missing",
  "message_too_large",
  "message_not_json",
  "message_invalid",
  "unsupported_protocol_version",
  "invalid_merge_order",
  "coding_worker_image_invalid",
  "native_sandbox_unavailable",
  "run_tree_exhausted",
]);

/**
 * The codes wardby itself writes as a failed coding or native child run's Run.error (read from the
 * literals in core/dispatch.ts, core/coding-queue.ts, providers/executor/*, core/run-pricing.ts,
 * providers/llm/catalog-types.ts and the native sandbox). A parent may be told which of these a
 * child failed with; any other leading word is not shown. Includes GATEWAY_CAUSE_CODES, and the
 * container executor's terminal codes: `coding_failure_<category>` for every category
 * failureCategory files a failure under (providers/executor/container.ts), and
 * `coding_provider_<class>` for every provider failure class (core/provider-wording.ts).
 */
export const CHILD_RUN_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...GATEWAY_CAUSE_CODES,
  "coding_failure_turn_limit",
  "coding_failure_service_unready",
  "coding_failure_preflight",
  "coding_failure_job",
  "coding_failure_repo_access_unavailable",
  "coding_failure_repo_access",
  "coding_failure_github",
  "coding_failure_protected_path",
  "coding_failure_continuation_closed",
  "coding_failure_workspace",
  "coding_failure_budget",
  "coding_failure_artifact",
  "coding_failure_cancelled",
  "coding_failure_executor",
  "coding_provider_quota",
  "coding_provider_rate_limited",
  "coding_provider_unavailable",
  "coding_provider_rejected",
  "coding_ambiguous_provisioning",
  "coding_artifact_duplicate_key",
  "coding_artifact_invalid_json",
  "coding_artifact_nesting_limit",
  "coding_artifact_path_invalid",
  "coding_artifact_root_invalid",
  "coding_artifact_size_limit",
  "coding_budget_exhausted",
  "coding_capability_exists",
  "coding_capability_unavailable",
  "coding_credential_ref_invalid",
  "coding_credential_reference_invalid",
  "coding_credential_unavailable",
  "coding_dispatch_unavailable",
  "coding_head_ref_invalid",
  "coding_input_invalid_file",
  "coding_job_handle_conflict",
  "coding_job_handle_mismatch",
  "coding_job_status_unavailable",
  "coding_output_invalid",
  "coding_output_missing",
  "coding_output_run_mismatch",
  "coding_output_size_limit",
  "coding_provider_not_configured",
  "coding_provider_unsupported",
  "coding_queue_timeout",
  "coding_recovery_incomplete",
  "coding_recovery_unavailable",
  "coding_resource_limits_invalid",
  "coding_result_missing",
  "coding_result_run_mismatch",
  "coding_run_budget_invalid",
  "coding_run_no_longer_active",
  "coding_run_not_active",
  "coding_run_not_found",
  "coding_run_ownership_invalid",
  "coding_run_pricing_mismatch",
  "coding_run_status_invalid",
  "coding_run_terminal_conflict",
  "coding_service_catalog_invalid",
  "coding_service_unready",
  "coding_services_unsupported",
  "coding_services_unsupported_launcher",
  "coding_stream_agent_exited",
  "coding_stream_failed",
  "coding_stream_proxy_denied",
  "coding_stream_proxy_unreachable",
  "coding_stream_quota_exceeded",
  "coding_stream_rate_limited",
  "coding_stream_timeout",
  "coding_stream_upstream_error",
  "coding_toolchain_unsupported",
  "coding_turn_failed",
  "coding_turn_limit",
  "coding_workspace_disk_exceeds_limit",
  "coding_workspace_lost",
  "model_unavailable",
  "model_not_allowed",
  "executor_run_not_found",
  "run_not_drivable",
  "ownership_lost",
  "step_replay_mismatch",
  "worker_error",
  "worker_tool_runner_unreachable",
  "sandbox_dispatch_unavailable",
  "native_sandbox_capacity",
  "native_sandbox_deadline_exceeded",
  "native_sandbox_docker_failed",
  "native_sandbox_gateway_error",
  "native_sandbox_gateway_unavailable",
  "native_sandbox_image_not_pinned",
  "native_sandbox_invalid_run_id",
  "native_sandbox_invalid_warm_token",
  "native_sandbox_isolation_mismatch",
  "native_sandbox_launch_abandoned",
  "native_sandbox_network_unenforced",
  "native_sandbox_platform_unsupported",
  "native_sandbox_recovery_unavailable",
  "native_sandbox_requires_catalog",
  "native_sandbox_warm_delivery_failed",
  "native_sandbox_worker_exited",
  "native_sandbox_worker_lost",
  "native_sandbox_worker_unready",
]);

/** The leading code of an arbitrary error or message, only when it is declared in `allowed`. */
export function declaredCodeOf(err: unknown, allowed: ReadonlySet<string> = GATEWAY_CAUSE_CODES): string | undefined {
  const code = causeCodeOf(err);
  return code && allowed.has(code) ? code : undefined;
}
