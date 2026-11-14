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
