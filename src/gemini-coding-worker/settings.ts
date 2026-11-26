import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isWebTools, type WebTools } from "../coding/google-web-tools.js";
import { readBoundedRegularFile } from "../coding-worker/artifact.js";
import {
  INJECTED_MCP_TOKEN_PLACEHOLDER,
  MCP_TOKEN_ENV,
  MCP_TOKEN_HEADER,
  WARDBY_MCP_SERVER,
  WARDBY_MCP_TIMEOUT_MS,
  wardbyMcpUrl,
} from "../coding-worker/mcp-config.js";
import { frontmatterName } from "../coding-worker/skills.js";
import { GEMINI_BUILTIN_AGENTS, GEMINI_BUILTIN_SKILLS, GEMINI_HELPER_ALIASES, type GeminiBackend } from "./cli.js";

/** coding/command-timeouts.ts's values (it imports the profile module, too heavy for the image; a test keeps them equal). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 7_200_000;

/** Per-run settings CodingTaskInput does not carry; the launcher sets them (phase 4), absent = default. */
export interface GeminiRunSettings {
  subAgents: boolean;
  webTools: WebTools;
  commandTimeoutMs: number;
}

const invalid = (): never => {
  throw new Error("worker_run_settings_invalid");
};

export function readGeminiRunSettings(env: NodeJS.ProcessEnv): GeminiRunSettings {
  const sub = env.WARDBY_SUB_AGENTS;
  const subAgents = sub === undefined || sub === "true" ? true : sub === "false" ? false : invalid();
  const webTools = env.WARDBY_WEB_TOOLS ?? "off";
  if (!isWebTools(webTools)) invalid();
  const raw = env.WARDBY_COMMAND_TIMEOUT_MS;
  const commandTimeoutMs = raw === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : /^\d+$/.test(raw) ? Number(raw) : invalid();
  if (commandTimeoutMs < MIN_COMMAND_TIMEOUT_MS || commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS) invalid();
  return { subAgents, webTools: webTools as WebTools, commandTimeoutMs };
}

export interface GeminiUserSettingsInput {
  backend: GeminiBackend;
  /** The Google model id the run uses (cli.ts geminiCliModel). */
  googleModel: string;
  maxOutputTokens: number;
  maxSessionTurns: number;
  commandTimeoutMs: number;
  subAgents: boolean;
  webTools: WebTools;
  repoSkills: boolean;
  /** Local agents the repository defines (.gemini/agents), pinned to the run model. */
  repoAgentNames: readonly string[];
  /** The Gemini-safe final-answer schema (output.ts). */
  outputSchema: Record<string, unknown>;
  /** Set only on a run with MCP tools. Header mode: Substrate's gateway placeholder in its own header. */
  mcp?: { proxyBaseUrl: string; headerMode: boolean };
}

function perRunExclusions(input: GeminiUserSettingsInput): string[] {
  return [
    ...(input.subAgents ? [] : ["invoke_agent"]),
    ...(input.webTools === "search" || input.webTools === "search-and-fetch" ? [] : ["google_web_search"]),
    ...(input.webTools === "search-and-fetch" ? [] : ["web_fetch"]),
  ];
}

/**
 * ~/.gemini/settings.json for one run: everything per run (Decision 6). The system file
 * (system-settings.json) outranks it for scalars and unions or intersects its arrays, so nothing
 * here can relax the lock-down. Every reply is capped (spec "Output cap"): an override on the run
 * model (main loop and sub-agents), one per helper alias that also moves the alias to the run model
 * (Decision 5), and each agent pinned to the run model.
 */
export function geminiUserSettings(input: GeminiUserSettingsInput): Record<string, unknown> {
  const cap = { maxOutputTokens: input.maxOutputTokens };
  return {
    security: { auth: { selectedType: input.backend === "vertex" ? "vertex-ai" : "gemini-api-key" } },
    model: { maxSessionTurns: input.maxSessionTurns },
    tools: {
      exclude: perRunExclusions(input),
      // The CLI's one per-command limit: seconds without output (Decision 7).
      shell: { inactivityTimeout: Math.ceil(input.commandTimeoutMs / 1000) },
    },
    skills: input.repoSkills ? { enabled: true, disabled: [...GEMINI_BUILTIN_SKILLS] } : { enabled: false },
    modelConfigs: {
      customOverrides: [
        { match: { model: input.googleModel }, modelConfig: { generateContentConfig: cap } },
        ...GEMINI_HELPER_ALIASES.map((alias) => ({
          match: { model: alias },
          modelConfig: { model: input.googleModel, generateContentConfig: cap },
        })),
        // Last and most specific: the main loop's own replies (not helpers, not sub-agents) answer in JSON.
        {
          match: { model: input.googleModel, overrideScope: "core" },
          modelConfig: {
            generateContentConfig: { responseMimeType: "application/json", responseJsonSchema: input.outputSchema },
          },
        },
      ],
    },
    agents: {
      overrides: Object.fromEntries(
        [...GEMINI_BUILTIN_AGENTS, ...input.repoAgentNames].map((name) => [
          name,
          { modelConfig: { model: input.googleModel } },
        ]),
      ),
    },
    ...(input.mcp
      ? {
          mcpServers: {
            [WARDBY_MCP_SERVER]: {
              httpUrl: wardbyMcpUrl(input.mcp.proxyBaseUrl),
              // Not the token: a reference the CLI resolves from its environment when it loads settings.
              headers: input.mcp.headerMode
                ? { [MCP_TOKEN_HEADER]: INJECTED_MCP_TOKEN_PLACEHOLDER }
                : { Authorization: `Bearer $${MCP_TOKEN_ENV}` },
              timeout: WARDBY_MCP_TIMEOUT_MS,
              trust: true,
            },
          },
        }
      : {}),
  };
}

/**
 * Writes ~/.gemini/settings.json whole (never merged with what is there), so the driver can call it
 * again before the repair turn and undo anything the run's agent changed: a ~/.gemini that is not a
 * real directory is removed, its mode reset to 0700, and the old file (or a link in its place) is
 * removed before an exclusive create, so the write never follows a link and always gets 0600.
 */
export async function writeGeminiUserSettings(home: string, settings: Record<string, unknown>): Promise<string> {
  const dir = join(home, ".gemini");
  const existing = await lstat(dir).catch(() => undefined);
  if (existing && !existing.isDirectory()) await rm(dir, { force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, "settings.json");
  await rm(path, { recursive: true, force: true });
  // The CLI rewrites this file at start (a settings migration): never read back as a record.
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

const MAX_REPO_AGENTS = 64;
const MAX_AGENT_FILE_BYTES = 64 * 1024;
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The names of the repository's local agents (.gemini/agents/*.md, untrusted): the frontmatter
 * `name`, else the file name. Bounded (64 files, 64 KiB each), regular files only (a link is never
 * opened), names wardby can put in settings. Never throws.
 */
export async function repoAgentNames(workspace: string): Promise<string[]> {
  const dir = join(workspace, ".gemini", "agents");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const entry of entries.filter((e) => e.isFile() && e.name.endsWith(".md")).slice(0, MAX_REPO_AGENTS)) {
    let content: string;
    try {
      content = await readBoundedRegularFile(join(dir, entry.name), MAX_AGENT_FILE_BYTES, "gemini_agent_file_invalid");
    } catch {
      continue;
    }
    const name = frontmatterName(content) || basename(entry.name, ".md");
    if (AGENT_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}
