/**
 * Facts about the pinned Gemini CLI the driver was built and tested against (risk spike,
 * 2026-11-26). Names only: nothing here is the CLI's code. A version bump re-checks every list here
 * with the driver compatibility test (compatibility.docker.test.ts) before the pin moves.
 * Imports nothing: it ships in the worker image.
 */
export const GEMINI_CLI_PACKAGE = "@google/gemini-cli";
export const GEMINI_CLI_VERSION = "0.70.0";
export const GEMINI_CLI_INTEGRITY =
  "sha512-5gilVH8BI2bjSCf+X6zgGpT75bLWzK9UoZS1akjaaBwgWhm1durzKkNC1M3FamcW40YoqV0PDi4hRCIsY3f9Sg==";
/** Where the image installs it (src/gemini-coding-worker/Dockerfile); run with `node`. */
export const GEMINI_CLI_ENTRY = "/opt/wardby/node_modules/@google/gemini-cli/bundle/gemini.js";

/** The CLI's system settings folder; the image bakes settings.json and policies/wardby.toml there, root-owned. */
export const GEMINI_SYSTEM_DIR = "/etc/gemini-cli";
/** SHA-256 of src/gemini-coding-worker/system-settings.json (system-check.test.ts keeps it current). */
export const GEMINI_SYSTEM_SETTINGS_SHA256 = "1c469de4cffea71de50f979cc0ccc7ae84e339b1366aa507cbf0e8b939dc6c65";
/** SHA-256 of src/gemini-coding-worker/policies/wardby.toml. */
export const GEMINI_SYSTEM_POLICY_SHA256 = "1c8a5aa1777e054ed51463bb6549afb9f8e7f1859e88395e50c2071a502b69a8";
/** The variable the system file's `security.auth.enforcedType` reference reads (environment.ts sets it). */
export const GEMINI_AUTH_TYPE_ENV = "WARDBY_GEMINI_AUTH_TYPE";

/** The repository instruction files the CLI loads, in this order (decision 5). */
export const GEMINI_CONTEXT_FILE_NAMES = ["GEMINI.md", "AGENTS.md", "CLAUDE.md"] as const;

/** Never offered: plan mode routes to other models; background processes outlive their command. */
export const GEMINI_ALWAYS_EXCLUDED_TOOLS = [
  "enter_plan_mode",
  "list_background_processes",
  "read_background_output",
] as const;

/** The model aliases the CLI's helper calls use (0.70.0's default model configs). Each is pointed at the run model. */
export const GEMINI_HELPER_ALIASES = [
  "web-search",
  "web-fetch",
  "web-fetch-fallback",
  "classifier",
  "prompt-completion",
  "fast-ack-helper",
  "edit-corrector",
  "summarizer-default",
  "summarizer-shell",
  "loop-detection",
  "loop-detection-double-check",
  "llm-edit-fixer",
  "next-speaker-checker",
  "context-snapshotter",
  "chat-compression-3-pro",
  "chat-compression-3-flash",
  "chat-compression-3.1-flash-lite",
  "chat-compression-2.5-pro",
  "chat-compression-2.5-flash",
  "chat-compression-2.5-flash-lite",
  "chat-compression-default",
  "agent-history-provider-summarizer",
] as const;

/** The CLI's built-in sub-agents; each is pinned to the run model. */
export const GEMINI_BUILTIN_AGENTS = ["codebase_investigator", "cli_help", "generalist"] as const;

/** The CLI's built-in skills, never offered (as the Codex worker turns off Codex's). */
export const GEMINI_BUILTIN_SKILLS = ["skill-creator", "antigravity-support"] as const;

export type GeminiBackend = "ai-studio" | "vertex";

/** wardby's AI Studio model ids (providers/llm/google-ai-studio.ts GOOGLE_AI_STUDIO_PREFIX; a test keeps them equal). */
export const AI_STUDIO_MODEL_PREFIX = "google-ai-studio.";

/**
 * The backend and the Google model id `-m` takes for a wardby model id: AI Studio ids carry
 * `google-ai-studio.`; Vertex ids are global or `us.` / `eu.` (the proxy picks the location from the
 * session, the CLI's express path has none). Agrees with the proxy's googleModelId (test).
 */
export function geminiCliModel(modelId: string): { backend: GeminiBackend; googleModel: string } {
  if (modelId.startsWith(AI_STUDIO_MODEL_PREFIX)) {
    return { backend: "ai-studio", googleModel: modelId.slice(AI_STUDIO_MODEL_PREFIX.length) };
  }
  for (const location of ["us", "eu"]) {
    if (modelId.startsWith(`${location}.`)) {
      return { backend: "vertex", googleModel: modelId.slice(location.length + 1) };
    }
  }
  return { backend: "vertex", googleModel: modelId };
}
