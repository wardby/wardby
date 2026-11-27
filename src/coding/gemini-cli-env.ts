import { GEMINI_AUTH_TYPE_ENV, geminiCliModel } from "../gemini-coding-worker/cli.js";

/*
 * The variables a Gemini CLI run's driver owns (gemini-coding-worker/environment.ts reads these lists),
 * and the dispatch check built from the same lists: one copy, so what the driver sets or blanks and
 * what a service's testEnv may not set cannot drift. Ships in the Gemini worker image too.
 */

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
  // Each read only as "true" or non-empty in 0.70.0 (gemini-AYDYW6NZ.js, chunk-UF44X63P.js,
  // chunk-LMNAB62M.js, chunk-3VGGGCOZ.js): the experimental ADK agent runner, an auth type that
  // overrides the settings, restricted mode, an extension registry, and "standalone binary" mode
  // (which changes how the CLI reads its own arguments).
  "GEMINI_CLI_EXP_AGENT",
  "GEMINI_CLI_AUTH_OVERRIDE",
  "GEMINI_RESTRICTED_MODE",
  "GEMINI_CLI_EXTENSION_REGISTRY_URI",
  "IS_BINARY",
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
 * the system settings' `telemetry.enabled: false`, so each is fixed to its off value; and the
 * relaunch switch, fixed on.
 */
export const GEMINI_GUARD_VALUES: Readonly<Record<string, string>> = {
  GEMINI_TELEMETRY_ENABLED: "false",
  GEMINI_TELEMETRY_TRACES_ENABLED: "false",
  GEMINI_TELEMETRY_LOG_PROMPTS: "false",
  GEMINI_TELEMETRY_USE_COLLECTOR: "false",
  GEMINI_TELEMETRY_USE_CLI_AUTH: "false",
  OTEL_SDK_DISABLED: "true",
  // gemini.js otherwise relaunches itself in a child that inherits stdio (the runner also kills the
  // whole process group). Without it the CLI runs in-process, without the relaunch's heap-size flag.
  GEMINI_CLI_NO_RELAUNCH: "true",
};

/**
 * Guards removed instead: an empty target or protocol is a fatal configuration error in 0.70.0,
 * while an absent one falls back to the system settings.
 */
export const GEMINI_GUARD_UNSET = ["GEMINI_TELEMETRY_TARGET", "GEMINI_TELEMETRY_OTLP_PROTOCOL"] as const;

/**
 * Variables the driver sets itself on every run, whichever the backend (environment.ts
 * geminiCliEnvironment): the backend's key and base URL, the other backend's blanked, and the auth
 * type the system settings read.
 */
export const GEMINI_DRIVER_VARIABLES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GENAI_USE_VERTEXAI",
  GEMINI_AUTH_TYPE_ENV,
] as const;

/**
 * OPEN USER DECISION (carried from phase 3): Vertex runs blank these, because the CLI's express mode
 * (the proxy's /v1beta1/publishers/... route) ends when project and location are both set. AI Studio
 * runs leave them alone, so a service may set them there. Dispatch refuses a Vertex run whose service
 * sets one (geminiReservedServiceVariable).
 */
export const GEMINI_VERTEX_BLANKED = ["GOOGLE_CLOUD_LOCATION"] as const;

const RESERVED = new Set<string>([
  ...GEMINI_GUARD_VARIABLES,
  ...Object.keys(GEMINI_GUARD_VALUES),
  ...GEMINI_GUARD_UNSET,
  ...GEMINI_DRIVER_VARIABLES,
]);
const VERTEX_RESERVED = new Set<string>(GEMINI_VERTEX_BLANKED);
/** The CLI reads more of these than the lists name (and a version bump may add some): all reserved. */
const RESERVED_PREFIXES = ["GEMINI_TELEMETRY_", "GEMINI_CLI_"];

/**
 * The first variable (in name order) a service's testEnv sets that a Gemini CLI run on `modelId`
 * reserves: the driver sets or blanks it after merging testEnv, so the shells would never see the
 * service's value. Dispatch refuses the run instead of dropping it (no silent drops). Undefined when
 * none is reserved. The backend comes from the model id, as the driver's own (geminiCliModel).
 */
export function geminiReservedServiceVariable(names: Iterable<string>, modelId: string): string | undefined {
  const vertex = geminiCliModel(modelId).backend === "vertex";
  return [...names]
    .sort()
    .find(
      (name) =>
        RESERVED.has(name) ||
        (vertex && VERTEX_RESERVED.has(name)) ||
        RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
}
