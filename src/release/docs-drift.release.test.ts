/**
 * Release invariant 7: docs and help drift (CLAUDE.md "Every feature gets a docs + help check").
 *
 * - Every error code an operator or an agent is shown has a help/errors/ article that names it.
 *   The codes are read from the code itself: the review and issue-tracker tool errors, the codes
 *   a run's error may lead with (CHILD_RUN_FAILURE_CODES, which includes GATEWAY_CAUSE_CODES), and
 *   the package registry's refusal codes.
 * - Every MCP tool is named in docs/ or help/.
 * - Every environment variable the code reads is named in docs/, help/, README.md or a deploy/
 *   guide, unless it is internal plumbing (INTERNAL_ENV, each with its reason).
 * - Help frontmatter `tags:` stays on one line of at most 120 characters.
 *
 * Gaps found when this suite was written are listed in KNOWN_*: the main tests check everything
 * else and that each listed gap is still a gap (so a fixed one is taken off the list); the
 * `it.fails` tests below them hold the gaps themselves, as findings, until they are fixed. This file reads only source
 * and docs, never a secret value, so it is the one release file without a secret sweep.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHILD_RUN_FAILURE_CODES } from "../core/error-code.js";
import { registerAllTools } from "../mcp/index.js";
import type { WardbyMcpServer } from "../mcp/server.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const read = (path: string) => readFileSync(path, "utf8");
const sourceFiles = walk(join(ROOT, "src")).filter(
  (f) => /\.(ts|mjs)$/.test(f) && !/\.test\.|test-support|[/\\]generated[/\\]/.test(f),
);
const helpErrors = walk(join(ROOT, "help/errors")).filter((f) => f.endsWith(".md"));
const helpArticles = walk(join(ROOT, "help")).filter((f) => f.endsWith(".md"));
const operatorDocs = [
  ...walk(join(ROOT, "docs")).filter((f) => f.endsWith(".md") && !relative(ROOT, f).startsWith("docs/private")),
  ...helpArticles,
  join(ROOT, "README.md"),
  ...walk(join(ROOT, "deploy")).filter((f) => f.endsWith(".md")),
];
const helpErrorsText = helpErrors.map(read).join("\n");
const operatorText = operatorDocs.map(read).join("\n");
const named = (text: string, word: string) => new RegExp(`(^|[^A-Za-z0-9_])${word}([^A-Za-z0-9_]|$)`).test(text);

/** Every error code an operator or agent is shown, with where it comes from. */
function errorCodes(): Map<string, string> {
  const codes = new Map<string, string>();
  const add = (code: string, from: string) => {
    if (!codes.has(code)) codes.set(code, from);
  };
  for (const file of ["src/core/review-host-tools.ts", "src/core/issue-tracker-tools.ts"]) {
    for (const match of read(join(ROOT, file)).matchAll(/\berror\(\s*"([a-z][a-z0-9_]*_[a-z0-9_]*)"/g)) {
      add(match[1], file);
    }
  }
  // The delegate tools' errors (delegate_to_*), as the runner answers them.
  for (const match of read(join(ROOT, "src/core/runner.ts")).matchAll(/\berror:\s*"([a-z][a-z0-9_]*_[a-z0-9_]*)"/g)) {
    add(match[1], "src/core/runner.ts");
  }
  // repo_pr_read's `patch_cursor_${reason}` (PatchCursorError's reasons).
  for (const reason of ["malformed", "stale"]) add(`patch_cursor_${reason}`, "src/core/review-host-tools.ts");
  for (const code of CHILD_RUN_FAILURE_CODES) add(code, "CHILD_RUN_FAILURE_CODES");
  for (const file of sourceFiles.filter((f) => /[/\\]registry[/\\]/.test(f))) {
    for (const match of read(file).matchAll(/code:\s*"(wardby_[a-z0-9_]+)"/g)) add(match[1], relative(ROOT, file));
  }
  return codes;
}

/** Error codes with no help/errors article when this suite was written: finding D1. */
const KNOWN_UNDOCUMENTED_CODES = new Set<string>([
  // Review tool errors (repo_*).
  ...["invalid_arguments_json", "invalid_arguments", "repository_not_linked", "write_access_required"],
  ...["host_not_configured", "issues_unavailable", "is_pull_request", "issue_not_found", "ci_failing"],
  ...["ci_pending", "unknown_tool", "host_api_error"],
  // Issue-tracker tool errors (jira_*).
  ...["project_not_linked", "transition_not_allowed", "field_not_allowed", "link_type_not_allowed"],
  ...["tracker_not_configured", "invalid_link_type", "not_available", "issue_type_not_allowed"],
  ...["issue_cap_reached", "invalid_jql", "tracker_not_found", "not_own_comment", "field_not_editable"],
  ...["tracker_api_error"],
  // Delegate tool errors (delegate_to_*).
  ...["validation_failed", "already_dispatched", "subagent_not_authorized", "cross_owner_not_allowed"],
  ...["continuation_requires_coding_agent", "subagent_wait_timed_out", "parent_cancelled", "no_such_subagent"],
  ...["continuation_refused", "dispatch_failed", "delegation_unavailable"],
  // A run's error codes (CHILD_RUN_FAILURE_CODES).
  ...["coding_profile_missing", "message_too_large", "message_not_json", "message_invalid"],
  ...["unsupported_protocol_version", "invalid_merge_order", "coding_worker_image_invalid", "run_tree_exhausted"],
  ...["coding_failure_turn_limit", "coding_failure_service_unready", "coding_failure_preflight"],
  ...["coding_failure_job", "coding_failure_repo_access_unavailable", "coding_failure_repo_access"],
  ...["coding_failure_github", "coding_failure_protected_path", "coding_failure_continuation_closed"],
  ...["coding_failure_target_merge", "coding_failure_budget", "coding_failure_artifact"],
  ...["coding_failure_cancelled", "coding_failure_executor", "coding_provider_quota"],
  ...["coding_provider_rate_limited", "coding_provider_unavailable", "coding_provider_rejected"],
  ...["coding_ambiguous_provisioning", "coding_artifact_duplicate_key", "coding_artifact_invalid_json"],
  ...["coding_artifact_nesting_limit", "coding_artifact_path_invalid", "coding_artifact_root_invalid"],
  ...["coding_artifact_size_limit", "coding_capability_exists", "coding_capability_unavailable"],
  ...["coding_credential_ref_invalid", "coding_credential_reference_invalid", "coding_credential_unavailable"],
  ...["coding_dispatch_unavailable", "coding_head_ref_invalid", "coding_input_invalid_file"],
  ...["coding_job_handle_conflict", "coding_job_handle_mismatch", "coding_job_status_unavailable"],
  ...["coding_output_invalid", "coding_output_missing", "coding_output_run_mismatch", "coding_output_size_limit"],
  ...["coding_provider_unsupported", "coding_queue_timeout", "coding_recovery_incomplete"],
  ...["coding_recovery_unavailable", "coding_resource_limits_invalid", "coding_result_missing"],
  ...["coding_result_run_mismatch", "coding_run_budget_invalid", "coding_run_no_longer_active"],
  ...["coding_run_not_active", "coding_run_not_found", "coding_run_ownership_invalid"],
  ...["coding_run_pricing_mismatch", "coding_run_status_invalid", "coding_run_terminal_conflict"],
  ...["coding_service_catalog_invalid", "coding_services_unsupported", "coding_services_unsupported_launcher"],
  ...["coding_stream_agent_exited", "coding_stream_failed", "coding_stream_proxy_denied"],
  ...["coding_stream_proxy_unreachable", "coding_stream_rate_limited", "coding_stream_timeout"],
  ...["coding_stream_upstream_error", "coding_toolchain_unsupported", "coding_turn_failed"],
  ...["coding_workspace_lost", "model_not_allowed", "executor_run_not_found", "run_not_drivable"],
  ...["ownership_lost", "step_replay_mismatch", "worker_error", "worker_tool_runner_unreachable"],
  ...["sandbox_dispatch_unavailable", "native_sandbox_invalid_run_id", "native_sandbox_invalid_warm_token"],
  ...["native_sandbox_platform_unsupported", "native_sandbox_recovery_unavailable"],
  // Package registry refusals.
  ...["wardby_lockfile_integrity_mismatch", "wardby_package_not_found", "wardby_registry_integrity_missing"],
  ...["wardby_upstream_host_not_allowed", "wardby_metadata_too_large", "wardby_file_not_allowed"],
]);

/** Every MCP tool name. */
function mcpTools(): string[] {
  const names: string[] = [];
  const fake = {
    registerTool: (spec: { name: string }) => names.push(spec.name),
    registerRequestHandler: () => undefined,
  } as unknown as WardbyMcpServer;
  registerAllTools(fake, {
    secretElicitationUrl: async () => "https://example/elicit",
    secretElicitationProtocol: false,
  });
  return names;
}

/** MCP tools named nowhere in docs/ or help/ when this suite was written: finding D2. */
const KNOWN_UNDOCUMENTED_TOOLS = new Set<string>([
  ...["update_budget_group", "list_budget_groups", "delete_budget_group", "detach_tool"],
  ...["create_datastore", "list_datastores", "delete_datastore", "attach_datastore"],
  ...["detach_datastore", "datastore_get", "datastore_list", "datastore_delete", "detach_subagent"],
  ...["list_subagents", "unlink_repository", "get_agent_memory", "list_agent_memory", "delete_agent_memory"],
  ...["detach_secret", "delete_secret", "create_webhook", "list_webhooks", "delete_webhook"],
]);

/** Every environment variable the code reads, with the first file that reads it. */
function envVars(): Map<string, string> {
  const vars = new Map<string, string>();
  for (const file of sourceFiles) {
    const text = read(file);
    const patterns = [
      /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)\b/g,
      /\b(?:process\.env|env)\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g,
      /"(WARDBY_[A-Z0-9_]+)"/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) if (!vars.has(match[1])) vars.set(match[1], relative(ROOT, file));
    }
  }
  return vars;
}

/** Read by the code but not operator settings: set by wardby itself for a process it starts, or test-only. */
const INTERNAL_ENV: Record<string, string> = {
  NPM_CONFIG_REGISTRY: "npm's own setting, set by the coding worker for the npm it runs",
  NPM_CONFIG_USERCONFIG: "npm's own setting, set by the coding worker for the npm it runs",
  NPM_CONFIG_CACHE: "npm's own setting, set by the coding worker for the npm it runs",
  WARDBY_NPM_PLAN_REGISTRY: "set by the coding worker for its dependency-cache plan",
  WARDBY_NPM_SHIM_ACTIVE: "the npm shim's marker that it is already running (nested runs)",
  WARDBY_UV_SHIM_ACTIVE: "the uv shim's marker that it is already running (nested runs)",
  NATIVE_WORKER_INPUT_FILE: "set by the native sandbox launcher for the worker it starts",
  NATIVE_WORKER_INPUT_WAIT_MS: "set by the native sandbox launcher for a warm-pool worker",
  WARDBY_CANARY_PROXY_IP: "set by the Kubernetes preflight for its own canary pod",
  WARDBY_DOCKER_SEED_DEBUG: "test-only: read only when NODE_ENV=test",
  WARDBY_MERGE_STATE_MSG: "not a variable: the name of a file in a git directory",
  WARDBY_TEST_SIMULATORS: "test-only: the release suite's simulator switch, refused alongside production configuration",
  WARDBY_SIM_BASE_URL: "test-only: the simulator's origin for WARDBY_TEST_SIMULATORS (loopback or cluster-local only)",
  WARDBY_SIM_CA_FILE: "test-only: the simulator's throwaway CA for git under WARDBY_TEST_SIMULATORS",
  WARDBY_TEST_SIMULATORS_ALLOWED: "baked into an image at build time (0 for release images), never set by an operator",
};

/** Operator-facing variables named nowhere in the operator docs when this suite was written: finding D3. */
const KNOWN_UNDOCUMENTED_ENV = new Set<string>([
  ...["BLOB_STORE_S3_ENDPOINT", "EMAIL_PROVIDER", "SECRET_CIPHER", "DATASTORE", "ENGINE", "VCS_PROVIDER"],
  ...["GITHUB_API_VERSION", "VCS_MAX_CHANGED_FILES", "VCS_MAX_DIFF_BYTES", "KUBERNETES_PREFLIGHT_TIMEOUT_MS"],
  ...["MCP_SECRET_ELICITATION_PROTOCOL", "LOG_LEVEL", "METRICS_ALLOW_NON_LOOPBACK", "BEDROCK_REGION"],
  ...["WARDBY_LOAD_MOCK_JITTER_MS"],
]);

/** Help articles whose tags line is longer than 120 characters when this suite was written: finding D4. */
const KNOWN_LONG_TAGS = new Set<string>([
  ...["help/agent-recipes.md", "help/code-review-agents.md", "help/dependency-cache.md"],
  ...["help/errors/package-refusals.md", "help/low-power-mode.md", "help/package-audit-mode.md"],
  ...["help/troubleshooting/coding-workers.md"],
]);

/** Help articles whose frontmatter tags are not one `tags: [ ... ]` line of at most 120 characters. */
function tagProblems(): { file: string; problem: string }[] {
  const problems: { file: string; problem: string }[] = [];
  for (const path of helpArticles) {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(read(path))?.[1];
    const line = frontmatter?.split("\n").find((l) => l.startsWith("tags:"));
    if (!line) continue;
    const file = relative(ROOT, path);
    if (!/^tags: \[.*\]$/.test(line)) problems.push({ file, problem: `${file}: tags is not one [ ... ] line` });
    if (line.length > 120) problems.push({ file, problem: `${file}: tags line is ${line.length} characters` });
  }
  return problems;
}

describe("docs and help drift", () => {
  it("every error code has a help/errors article that names it (apart from the known gaps, each still a gap)", () => {
    const codes = errorCodes();
    expect(codes.size).toBeGreaterThan(100);
    const missing = [...codes.keys()].filter(
      (code) => !named(helpErrorsText, code) && !KNOWN_UNDOCUMENTED_CODES.has(code),
    );
    expect(missing.map((code) => `${code} (${codes.get(code)})`).join("\n")).toBe("");
    const fixed = [...KNOWN_UNDOCUMENTED_CODES].filter((code) => !codes.has(code) || named(helpErrorsText, code));
    expect(fixed, "documented or gone now: take these off KNOWN_UNDOCUMENTED_CODES").toEqual([]);
  });

  it("every MCP tool is named in docs/ or help/ (apart from the known gaps, each still a gap)", () => {
    const tools = mcpTools();
    expect(tools.length).toBeGreaterThan(50);
    const missing = tools.filter((tool) => !named(operatorText, tool) && !KNOWN_UNDOCUMENTED_TOOLS.has(tool));
    expect(missing.join("\n")).toBe("");
    const fixed = [...KNOWN_UNDOCUMENTED_TOOLS].filter((tool) => !tools.includes(tool) || named(operatorText, tool));
    expect(fixed, "documented or gone now: take these off KNOWN_UNDOCUMENTED_TOOLS").toEqual([]);
  });

  it("every environment variable the code reads is named in the operator docs, or listed as internal with its reason", () => {
    const vars = envVars();
    expect(vars.size).toBeGreaterThan(100);
    const missing = [...vars.keys()].filter(
      (name) => !(name in INTERNAL_ENV) && !KNOWN_UNDOCUMENTED_ENV.has(name) && !named(operatorText, name),
    );
    expect(missing.map((name) => `${name} (${vars.get(name)})`).join("\n")).toBe("");
    const stale = [...KNOWN_UNDOCUMENTED_ENV, ...Object.keys(INTERNAL_ENV)].filter((name) => !vars.has(name));
    expect(stale, "no longer read: take these off the lists").toEqual([]);
    const fixed = [...KNOWN_UNDOCUMENTED_ENV].filter((name) => named(operatorText, name));
    expect(fixed, "documented now: take these off KNOWN_UNDOCUMENTED_ENV").toEqual([]);
  });

  it("every help article's tags stay on one line of at most 120 characters (apart from the known gaps, each still a gap)", () => {
    const problems = tagProblems();
    expect(
      problems
        .filter(({ file }) => !KNOWN_LONG_TAGS.has(file))
        .map(({ problem }) => problem)
        .join("\n"),
    ).toBe("");
    const fixed = [...KNOWN_LONG_TAGS].filter((file) => !problems.some((p) => p.file === file));
    expect(fixed, "fixed now: take these off KNOWN_LONG_TAGS").toEqual([]);
  });

  // FINDING: D1-D4, unconfirmed; see regression-phase1-report.md. The gaps themselves.
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails("D1: the known undocumented error codes have help/errors articles", () => {
    expect([...KNOWN_UNDOCUMENTED_CODES].filter((code) => !named(helpErrorsText, code))).toEqual([]);
  });
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails("D2: the known undocumented MCP tools are named in docs/ or help/", () => {
    expect([...KNOWN_UNDOCUMENTED_TOOLS].filter((tool) => !named(operatorText, tool))).toEqual([]);
  });
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails("D3: the known undocumented environment variables are named in the operator docs", () => {
    expect([...KNOWN_UNDOCUMENTED_ENV].filter((name) => !named(operatorText, name))).toEqual([]);
  });
  // Known finding, expected to fail until fixed in the order of docs/private/2026-10-26-regression-findings-fix-order.md;
  // the fixing PR turns this into a normal `it`.
  it.fails("D4: the known long tags lines are at most 120 characters", () => {
    expect(tagProblems().filter(({ file }) => KNOWN_LONG_TAGS.has(file))).toEqual([]);
  });
});
