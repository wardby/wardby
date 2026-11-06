import { Codex } from "@openai/codex-sdk";
import { MCP_TOKEN_ENV, WARDBY_MCP_SERVER, WARDBY_MCP_TIMEOUT_MS, wardbyMcpUrl } from "./mcp-config.js";
import type { WorkerClientConfig, WorkerClientFactory } from "./types.js";

type WardbyMcpServers = {
  [WARDBY_MCP_SERVER]: {
    url: string;
    bearer_token_env_var: typeof MCP_TOKEN_ENV;
    tool_timeout_sec: number;
    default_tools_approval_mode: "approve";
  };
};

/**
 * The wardby_mcp server on a run with MCP tools. Codex reads the bearer from its own process env
 * (bearer_token_env_var; it refuses an inline bearer_token for an HTTP server), so the config, and
 * with it Codex's command line, never holds the token. That does not hide it from the model: shell
 * commands run in the same container and can still read the token from Codex's environment through
 * /proc, which is why a Codex run gets only read-only MCP tools (isCodexCoding, core/mcp-tools.ts).
 */
function wardbyMcpServers(config: WorkerClientConfig): Record<string, never> | { mcp_servers: WardbyMcpServers } {
  if (!config.mcpToken) return {};
  return {
    mcp_servers: {
      [WARDBY_MCP_SERVER]: {
        url: wardbyMcpUrl(config.proxyBaseUrl),
        bearer_token_env_var: MCP_TOKEN_ENV,
        tool_timeout_sec: WARDBY_MCP_TIMEOUT_MS / 1000,
        // Today's default under approval_policy "never" runs every call too; pinned so a changed
        // default can't stall a run. The proxy and gateway allow only the run's pinned tools.
        default_tools_approval_mode: "approve",
      },
    },
  };
}

export function codexSdkOptions(config: WorkerClientConfig) {
  return {
    apiKey: config.capability,
    // The Codex process env. The shells' own env is only shell_environment_policy.set, which never holds
    // the MCP token, but a shell can still read Codex's env (and the token) through /proc.
    env: config.mcpToken ? { ...config.environment, [MCP_TOKEN_ENV]: config.mcpToken } : config.environment,
    config: {
      developer_instructions: config.developerInstructions,
      skills: { config: config.disabledSkills.map((name) => ({ name, enabled: false })) },
      shell_environment_policy: {
        inherit: "none",
        ignore_default_excludes: false,
        set: config.environment,
      },
      model_provider: "wardby_proxy",
      model_providers: {
        wardby_proxy: {
          name: "Wardby per-run proxy",
          base_url: `${config.proxyBaseUrl.replace(/\/$/, "")}/v1`,
          env_key: "CODEX_API_KEY",
          wire_api: "responses",
          // One failed request (a 5xx, a connection reset) or a dropped
          // stream would otherwise end the whole run and its spend. Every
          // retry is a new request through the proxy, so it passes the run's
          // budget reservation again; a budget refusal (429) retried is
          // refused again at no cost.
          request_max_retries: 3,
          stream_max_retries: 3,
          supports_websockets: false,
        },
      },
      ...wardbyMcpServers(config),
    },
  } as const;
}

export const createCodexSdkClient: WorkerClientFactory = (config) => new Codex(codexSdkOptions(config));
