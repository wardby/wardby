import { MCP_TOKEN_ENV } from "../coding-worker/mcp-config.js";
import { tunnelNoProxy } from "../coding/tunnel-env.js";
import { GEMINI_AUTH_TYPE_ENV, type GeminiBackend } from "./cli.js";
import {
  GEMINI_GUARD_UNSET,
  GEMINI_GUARD_VALUES,
  GEMINI_GUARD_VARIABLES,
  GEMINI_VERTEX_BLANKED,
} from "../coding/gemini-cli-env.js";

export { GEMINI_GUARD_UNSET, GEMINI_GUARD_VALUES, GEMINI_GUARD_VARIABLES };

/**
 * An inherited NO_PROXY (the tunnel's, or one the agent environment brings) with the machine's and
 * the proxy's own hosts added when missing: model calls must never be sent into the tunnel.
 */
function withProxyHosts(inherited: string, required: string): string {
  const hosts = inherited
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  for (const host of required.split(",")) if (!hosts.includes(host)) hosts.push(host);
  return hosts.join(",");
}

/**
 * The CLI's environment, which its shell commands inherit (the CLI has no separate shell
 * environment; Decision 13). The capability goes in the key the backend's client sends as
 * x-goog-api-key; model calls go to the proxy directly (NO_PROXY: without it the CLI tunnels even
 * plain-http model calls, risk 11).
 */
export function geminiCliEnvironment(input: {
  agentEnvironment: Record<string, string>;
  proxyBaseUrl: string;
  capability: string;
  backend: GeminiBackend;
  home: string;
  mcpToken?: string;
  mcpHeaderMode?: boolean;
}): Record<string, string> {
  const base = input.proxyBaseUrl.replace(/\/$/, "");
  const proxyHost = new URL(base).hostname;
  const noProxy = withProxyHosts(
    input.agentEnvironment.NO_PROXY ?? input.agentEnvironment.no_proxy ?? "",
    tunnelNoProxy(proxyHost),
  );
  const guards = Object.fromEntries(GEMINI_GUARD_VARIABLES.map((name) => [name, ""]));
  const backend: Record<string, string> =
    input.backend === "vertex"
      ? {
          GOOGLE_GENAI_USE_VERTEXAI: "true",
          GOOGLE_API_KEY: input.capability,
          GOOGLE_VERTEX_BASE_URL: base,
          // Express mode (the proxy's /v1beta1/publishers/... route) ends when project and location are
          // both set (GEMINI_VERTEX_BLANKED, coding/gemini-cli-env.ts).
          ...Object.fromEntries(GEMINI_VERTEX_BLANKED.map((name) => [name, ""])),
          GEMINI_API_KEY: "",
          GOOGLE_GEMINI_BASE_URL: "",
        }
      : {
          GOOGLE_GENAI_USE_VERTEXAI: "false",
          GEMINI_API_KEY: input.capability,
          GOOGLE_GEMINI_BASE_URL: base,
          GOOGLE_API_KEY: "",
          GOOGLE_VERTEX_BASE_URL: "",
        };
  const env: Record<string, string> = {
    ...input.agentEnvironment,
    HOME: input.home,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // The system settings' security.auth.enforcedType reads this.
    [GEMINI_AUTH_TYPE_ENV]: input.backend === "vertex" ? "vertex-ai" : "gemini-api-key",
    ...(input.mcpToken && !input.mcpHeaderMode ? { [MCP_TOKEN_ENV]: input.mcpToken } : {}),
    ...guards,
    ...GEMINI_GUARD_VALUES,
    ...backend,
  };
  for (const name of GEMINI_GUARD_UNSET) delete env[name];
  return env;
}
