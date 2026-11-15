/**
 * The few launcher values the bridges need. The images carry only dist/substrate-bridge/, so this
 * file re-declares them instead of importing src/providers/jobs/substrate/names.ts;
 * constants.test.ts asserts they stay equal.
 */
export const PLACEHOLDER_CAPABILITY = "rrp_placeholder_injected_by_gateway";
/**
 * The header the tool actor sends on every proxy call (names.ts TOOL_ACTOR_JWT_HEADER, lower-cased);
 * the egress gateway replaces its placeholder value with the actor JWT.
 */
export const ACTOR_JWT_HEADER = "x-wardby-actor-jwt";
/** The tool actor's ACTOR_JWT_HEADER value; the egress gateway replaces it with the actor JWT. */
export const GATEWAY_ACTOR_JWT_PLACEHOLDER = "placeholder";
export const AGENT_SUFFIX = "-agent";
export const TOOL_SUFFIX = "-tool";
/** substrateRunToken: "wr-" + 20 hex chars. */
export const RUN_TOKEN_PATTERN = /^wr-[0-9a-f]{20}$/;

export const DEFAULT_METADATA_DIR = "/run/ate/actor";
export const DEFAULT_TOOL_SOCKET = "/run/wardby/tool/runner.sock";
export const DEFAULT_READY_PORT = 8080;

/**
 * The worker diagnostic patterns and bound (providers/jobs/worker-diagnostic.ts and
 * coding/protocol.ts); constants.test.ts asserts they stay equal and that the bridge's parser agrees
 * with the shared one line for line.
 */
export const SAFE_WORKER_DIAGNOSTIC = /^(?:worker_[a-z_]+|coding_[a-z_]+|wardby_[a-z_]+)$/;
export const SAFE_CODING_OUTPUT_ISSUE =
  /^(?:\$|[a-z][A-Za-z]{0,31}(?:\.(?:[a-z][A-Za-z]{0,31}|\d{1,3})){0,7}):[a-z_]{1,32}$/;
export const MAX_CODING_OUTPUT_ISSUES = 8;

/** The worker's stdout+stderr lines the agent bridge keeps in memory (never sent) to find its diagnostic. */
export const WORKER_OUTPUT_TAIL = { lines: 200, bytes: 64 * 1024 } as const;
/**
 * The operator-diagnostics tail a bridge posts on a failure (redacted first): the last lines of its
 * child processes' stderr. `bytes` is the proxy's MAX_DIAGNOSTICS_BYTES (routes.ts).
 */
export const DIAGNOSTICS_TAIL = { lines: 40, bytes: 8 * 1024 } as const;
/** What an exact secret value is replaced with in a diagnostics tail. */
export const REDACTED = "[redacted]";

/**
 * Warm rounds (SUBSTRATE_WARM_ROUNDS on the control plane): the templates set this env to "1"
 * (specs.ts WARM_ROUNDS_ENV), and the bridges then stay for a follow-up round instead of idling.
 */
export const WARM_ROUNDS_ENV = "WARDBY_SUBSTRATE_WARM_ROUNDS";
/** The worker's native-mode context directory (claude-coding-worker/context.ts CONTEXT_ROOT): made afresh each round. */
export const WORKER_CONTEXT_ROOT = "/tmp/wardby-context";
/** The highest round (names.ts MAX_ROUND). */
export const MAX_ROUND = 1000;
/** How long a bridge waits between asks for the next round's file. */
export const NEXT_ROUND_POLL_MS = 1_000;
