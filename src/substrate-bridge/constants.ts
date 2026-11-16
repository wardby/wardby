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
/**
 * The protocol of the routes, bodies and headers this bridge uses with the coding proxy (an integer,
 * bumped whenever one of them changes). The proxy serves names.ts BRIDGE_PROTOCOL_RANGE.
 */
export const BRIDGE_PROTOCOL = 1;
/** The header every bridge request to the proxy carries (names.ts BRIDGE_PROTOCOL_HEADER). */
export const BRIDGE_PROTOCOL_HEADER = "x-wardby-bridge-protocol";
/** What a bridge's image check reports missing (names.ts SUBSTRATE_IMAGE_ITEMS; constants.test.ts keeps them equal). */
export const IMAGE_ITEMS = ["user", "runner", "tar", "workspace", "run_dir"] as const;
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
/**
 * The result bundle a git-history run's worker leaves in the workspace's root `.git`
 * (providers/jobs/workspace-swap.ts RESULT_BUNDLE_FILE): the only `.git` file the tool bridge uploads.
 */
export const RESULT_BUNDLE_FILE = "wardby-result.bundle";

/**
 * MCP tools (remote MCP servers): the proxy's flag on a round's `input` answer (routes.ts), and the
 * workers' header-mode environment (coding-worker/mcp-config.ts); constants.test.ts asserts they stay
 * equal. The MCP placeholder is not a secret, but it is redacted from every tail and passed-on line
 * like the capability's, so a tail never carries an `rmt_` shape the proxy would refuse.
 */
export const MCP_TOOLS_INPUT_HEADER = "x-wardby-mcp-tools";
export const MCP_TOKEN_ENV = "WARDBY_MCP_TOKEN";
export const MCP_TOKEN_HEADER_ENV = "WARDBY_MCP_TOKEN_HEADER";
export const MCP_TOKEN_HEADER = "x-wardby-mcp-token";
export const INJECTED_MCP_TOKEN_PLACEHOLDER = "rmt_placeholder_injected_by_gateway";
/** Every placeholder a bridge hands its worker: redacted from every tail and passed-on line. */
export const WORKER_PLACEHOLDERS: readonly string[] = [PLACEHOLDER_CAPABILITY, INJECTED_MCP_TOKEN_PLACEHOLDER];

/**
 * The Codex worker's entry point in its image (src/coding-worker/Dockerfile ENTRYPOINT), and the
 * environment it reads in header mode (coding-worker/credentials.ts); constants.test.ts asserts they
 * stay equal.
 */
export const CODEX_WORKER_ENTRY = "/opt/wardby/coding-worker/main.js";
export const CAPABILITY_HEADER_ENV = "WARDBY_CAPABILITY_HEADER";
export const REGISTRY_TOKEN_ENV = "WARDBY_REGISTRY_TOKEN";
/** A run's registry-only token (coding-worker/credentials.ts REGISTRY_TOKEN_SHAPE). */
export const REGISTRY_TOKEN_SHAPE = /^rrg_[A-Za-z0-9_-]{43}$/;

/** Where the workers write their plan folder's output (coding/protocol.ts PLAN_FILES_ARTIFACT under /run/wardby/output). */
export const PLAN_FILES_OUTPUT_PATH = "/run/wardby/output/plan-files.json";
/** The plan folder (coding/protocol.ts PLAN_FOLDER_PATH): removed between warm rounds by the tool bridge. */
export const PLAN_FOLDER = "/tmp/wardby-plan";

/** Where extra repositories live (providers/jobs/storage-init.ts REPOSITORY_MOUNT_ROOT). */
export const REPOSITORY_MOUNT_ROOT = "/repos";
/** coding/protocol.ts MAX_RUN_REPOSITORIES_IN_INPUT and CODING_REPOSITORY_NAME (constants.test.ts keeps them equal). */
export const MAX_SETUP_REPOSITORIES = 16;
export const REPOSITORY_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
