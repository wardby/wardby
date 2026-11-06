/**
 * WARDBY_MCP_SERVERS: who may register remote MCP servers for native agents (docs/security-deployment.md,
 * "Remote MCP servers"). Default `owners`. Read on every call, like `loadToolMaxTimeoutMs`.
 */
export type McpServersMode = "off" | "admins" | "owners";

/** What every MCP-server path says when the mode is off (the Wardby MCP tools' 403 and a run's tool call). */
export const MCP_SERVERS_OFF_MESSAGE = "Remote MCP servers are turned off on this server (WARDBY_MCP_SERVERS=off).";

const MODES: readonly McpServersMode[] = ["off", "admins", "owners"];

export function loadMcpServersMode(env: NodeJS.ProcessEnv = process.env): McpServersMode {
  const raw = (env.WARDBY_MCP_SERVERS ?? "").trim();
  if (raw === "") return "owners";
  const mode = raw.toLowerCase();
  if ((MODES as readonly string[]).includes(mode)) return mode as McpServersMode;
  throw new Error(`WARDBY_MCP_SERVERS must be off, admins or owners (got "${raw}").`);
}
