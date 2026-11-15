import { Codex } from "@openai/codex-sdk";
import { INJECTED_CAPABILITY_PLACEHOLDER } from "./credentials.js";
import {
  INJECTED_MCP_TOKEN_PLACEHOLDER,
  MCP_TOKEN_ENV,
  type MCP_TOKEN_HEADER,
  WARDBY_MCP_SERVER,
  WARDBY_MCP_TIMEOUT_MS,
  wardbyMcpUrl,
} from "./mcp-config.js";
import type { WorkerClientConfig, WorkerClientFactory } from "./types.js";

type WardbyMcpServer = {
  url: string;
  tool_timeout_sec: number;
  default_tools_approval_mode: "approve";
} & (
  | { bearer_token_env_var: typeof MCP_TOKEN_ENV }
  // Header mode (Substrate; Task 1A outcome A): with no bearer_token_env_var Codex sends these headers
  // and no Authorization.
  | { http_headers: { [MCP_TOKEN_HEADER]: string } }
);

type WardbyMcpServers = { [WARDBY_MCP_SERVER]: WardbyMcpServer };

/**
 * The wardby_mcp server on a run with MCP tools. Codex reads the bearer from its own process env
 * (bearer_token_env_var; it refuses an inline bearer_token for an HTTP server), so the config, and
 * with it Codex's command line, never holds the token. That does not hide it from the model: shell
 * commands run in the same container and can still read the token from Codex's environment through
 * /proc, which is why a Codex run gets only read-only MCP tools (isCodexCoding, core/mcp-tools.ts).
 * On Substrate (header mode) the token is the gateway's placeholder, sent in its own header from the
 * config: the shells can read only the placeholder, and the egress gateway injects the real token.
 */
function wardbyMcpServers(config: WorkerClientConfig): Record<string, never> | { mcp_servers: WardbyMcpServers } {
  if (!config.mcpToken) return {};
  return {
    mcp_servers: {
      [WARDBY_MCP_SERVER]: {
        url: wardbyMcpUrl(config.proxyBaseUrl),
        ...(config.mcpTokenHeader
          ? { http_headers: { [config.mcpTokenHeader]: config.mcpToken } }
          : { bearer_token_env_var: MCP_TOKEN_ENV }),
        tool_timeout_sec: WARDBY_MCP_TIMEOUT_MS / 1000,
        // Today's default under approval_policy "never" runs every call too; pinned so a changed
        // default can't stall a run. The proxy and gateway allow only the run's pinned tools.
        default_tools_approval_mode: "approve",
      },
    },
  };
}

/** The wardby_proxy model provider. Header mode (Substrate) sends the placeholder capability in its own
 *  header for the egress gateway to replace, and sets no env_key, so Codex sends no Authorization. */
type WardbyProxyProvider = {
  name: string;
  base_url: string;
  wire_api: "responses";
  request_max_retries: number;
  stream_max_retries: number;
  supports_websockets: false;
} & ({ env_key: "CODEX_API_KEY" } | { http_headers: Record<string, string> });

function wardbyProxyProvider(config: WorkerClientConfig): WardbyProxyProvider {
  // Header mode puts the capability in Codex's `-c` command-line config, readable by every process
  // in the container: only the gateway's placeholder may ever go there. No value in the message.
  if (config.capabilityHeader && config.capability !== INJECTED_CAPABILITY_PLACEHOLDER) {
    throw new Error("worker_capability_header_needs_placeholder");
  }
  return {
    name: "Wardby per-run proxy",
    base_url: `${config.proxyBaseUrl.replace(/\/$/, "")}/v1`,
    ...(config.capabilityHeader
      ? { http_headers: { [config.capabilityHeader]: config.capability } }
      : { env_key: "CODEX_API_KEY" as const }),
    wire_api: "responses",
    // One failed request (a 5xx, a connection reset) or a dropped
    // stream would otherwise end the whole run and its spend. Every
    // retry is a new request through the proxy, so it passes the run's
    // budget reservation again; a budget refusal (429) retried is
    // refused again at no cost.
    request_max_retries: 3,
    stream_max_retries: 3,
    supports_websockets: false,
  };
}

export function codexSdkOptions(config: WorkerClientConfig) {
  // Header mode puts the MCP token in Codex's `-c` command-line config, readable by every process in
  // the container: only the gateway's placeholder may ever go there. No value in the message.
  if (config.mcpTokenHeader && config.mcpToken !== INJECTED_MCP_TOKEN_PLACEHOLDER) {
    throw new Error("worker_mcp_header_needs_placeholder");
  }
  return {
    ...(config.capabilityHeader ? {} : { apiKey: config.capability }),
    // The Codex process env. The shells' own env is only shell_environment_policy.set, which never holds
    // the MCP token, but a shell can still read Codex's env (and the token) through /proc. Header mode
    // sends the token from the config instead, so the env holds none.
    env:
      config.mcpToken && !config.mcpTokenHeader
        ? { ...config.environment, [MCP_TOKEN_ENV]: config.mcpToken }
        : config.environment,
    config: {
      developer_instructions: config.developerInstructions,
      skills: { config: config.disabledSkills.map((name) => ({ name, enabled: false })) },
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        set: config.environment,
      },
      model_provider: "wardby_proxy",
      model_providers: { wardby_proxy: wardbyProxyProvider(config) },
      ...wardbyMcpServers(config),
    },
  } as const;
}

export const createCodexSdkClient: WorkerClientFactory = (config) => new Codex(codexSdkOptions(config));
