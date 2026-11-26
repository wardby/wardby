import { MCP_TOKEN_ENV } from "../coding-worker/mcp-config.js";
import { tunnelNoProxy } from "../coding/tunnel-env.js";
import { GEMINI_AUTH_TYPE_ENV, type GeminiBackend } from "./cli.js";

/**
 * CLI-read variables a service's testEnv or the agent environment could otherwise set: each is
 * set empty, last (Decision 14), and 0.70.0 reads an empty value as unset. The repository's .env
 * is already blocked (ignoreLocalEnv); these also cover what reaches the CLI's own process
 * environment.
 */
export const GEMINI_GUARD_VARIABLES = [
  "GEMINI_SYSTEM_MD",
  "GEMINI_WRITE_SYSTEM_MD",
  "GEMINI_CLI_CUSTOM_HEADERS",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  "GEMINI_CLI_HOME",
  "GEMINI_CLI_TRUST_WORKSPACE",
  "GEMINI_SANDBOX",
  "GEMINI_CLI_ACTIVITY_LOG_TARGET",
  "GEMINI_DEBUG_LOG_FILE",
  "GEMINI_MODEL",
  // How the key is sent (bearer would move it out of x-goog-api-key) and which API version path.
  "GEMINI_API_KEY_AUTH_MECHANISM",
  "GOOGLE_GENAI_API_VERSION",
  // Other auth routes; security.auth.enforcedType already pins the type.
  "GOOGLE_GENAI_USE_GCA",
  "GEMINI_CLI_USE_COMPUTE_ADC",
  // An experiments file that flips the CLI's feature flags, and a context trace written to disk.
  "GEMINI_EXP",
  "GEMINI_CONTEXT_TRACE_DIR",
  // IDE companion connection (ide.enabled is off; these stay off too).
  "GEMINI_CLI_IDE_SERVER_PORT",
  "GEMINI_CLI_IDE_SERVER_STDIO_COMMAND",
  "GEMINI_CLI_IDE_SERVER_STDIO_ARGS",
  // Telemetry string values the CLI reads ahead of settings (0.70.0 ALLOWED_TELEMETRY_ENV_KEYS);
  // telemetry is off below, and empty headers are ignored.
  "GEMINI_TELEMETRY_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "GEMINI_TELEMETRY_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "GEMINI_TELEMETRY_OUTFILE",
] as const;

/**
 * Guards where an empty value would not mean "off": the CLI reads these telemetry flags ahead of
 * the system settings' `telemetry.enabled: false`, so each is fixed to its off value.
 */
export const GEMINI_GUARD_VALUES: Readonly<Record<string, string>> = {
  GEMINI_TELEMETRY_ENABLED: "false",
  GEMINI_TELEMETRY_TRACES_ENABLED: "false",
  GEMINI_TELEMETRY_LOG_PROMPTS: "false",
  GEMINI_TELEMETRY_USE_COLLECTOR: "false",
  GEMINI_TELEMETRY_USE_CLI_AUTH: "false",
  OTEL_SDK_DISABLED: "true",
};

/**
 * Guards removed instead: an empty target or protocol is a fatal configuration error in 0.70.0,
 * while an absent one falls back to the system settings.
 */
export const GEMINI_GUARD_UNSET = ["GEMINI_TELEMETRY_TARGET", "GEMINI_TELEMETRY_OTLP_PROTOCOL"] as const;

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
  const noProxy = input.agentEnvironment.NO_PROXY ?? tunnelNoProxy(new URL(base).hostname);
  const guards = Object.fromEntries(GEMINI_GUARD_VARIABLES.map((name) => [name, ""]));
  const backend: Record<string, string> =
    input.backend === "vertex"
      ? {
          GOOGLE_GENAI_USE_VERTEXAI: "true",
          GOOGLE_API_KEY: input.capability,
          GOOGLE_VERTEX_BASE_URL: base,
          // Express mode (the proxy's /v1beta1/publishers/... route) ends when project and location are both set.
          GOOGLE_CLOUD_LOCATION: "",
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
