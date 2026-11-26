import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  /** Local agents the repository defines (.gemini/agents), pinned to the run model (readRepoAgents). */
  repoAgentNames: readonly string[];
  /** readRepoAgents found an agent file it could not pin: sub-agents are turned off for the run. */
  repoAgentsUnpinnable: boolean;
  /** The Gemini-safe final-answer schema (output.ts). */
  outputSchema: Record<string, unknown>;
  /** Set only on a run with MCP tools. Header mode: Substrate's gateway placeholder in its own header. */
  mcp?: { proxyBaseUrl: string; headerMode: boolean };
  /**
   * The run's extra repositories (/repos/<name>), which the CLI's file tools refuse outside its
   * workspace unless included. Absent or empty on a one-repository run.
   */
  includeDirectories?: readonly string[];
}

/** Why a run that asked for sub-agents runs without them, for the driver to record; undefined when it has them. */
export type GeminiSubAgentsDisabledReason = "repo_agents_unpinnable";

export function geminiSubAgentsDisabledReason(
  input: Pick<GeminiUserSettingsInput, "subAgents" | "repoAgentsUnpinnable">,
): GeminiSubAgentsDisabledReason | undefined {
  // An agent wardby cannot pin could run on any model the repository names: fail closed, not the run.
  return input.subAgents && input.repoAgentsUnpinnable ? "repo_agents_unpinnable" : undefined;
}

function perRunExclusions(input: GeminiUserSettingsInput): string[] {
  const subAgents = input.subAgents && geminiSubAgentsDisabledReason(input) === undefined;
  return [
    ...(subAgents ? [] : ["invoke_agent"]),
    ...(input.webTools === "search" || input.webTools === "search-and-fetch" ? [] : ["google_web_search"]),
    ...(input.webTools === "search-and-fetch" ? [] : ["web_fetch"]),
  ];
}

/**
 * ~/.gemini/settings.json for one run: everything per run (Decision 6). The system file
 * (system-settings.json) outranks it for scalars and unions or intersects its arrays, so nothing
 * here can relax the lock-down. Every reply is capped (spec "Output cap"): an override on the run
 * model (main loop and sub-agents), one per helper alias that also moves the alias to the run model
 * (Decision 5), and each agent pinned to the run model. When a repository agent cannot be pinned,
 * `invoke_agent` is excluded (geminiSubAgentsDisabledReason).
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
    // Trusted roots for the file tools and context-file loading (context-files.ts scans the same
    // roots). Policies, commands, skills, agents and workspace settings still come only from the
    // workspace's .gemini (0.70.0 reads those from the target directory alone).
    ...(input.includeDirectories?.length ? { context: { includeDirectories: [...input.includeDirectories] } } : {}),
    modelConfigs: {
      customOverrides: [
        { match: { model: input.googleModel }, modelConfig: { generateContentConfig: cap } },
        ...GEMINI_HELPER_ALIASES.map((alias) => ({
          match: { model: alias },
          modelConfig: { model: input.googleModel, generateContentConfig: cap },
        })),
        // The main loop's own replies answer in JSON. Only the main loop resolves its config with
        // isChatModel: true (0.70.0); helpers and sub-agents never do. Not overrideScope "core": that
        // also matches a call with no scope, so a helper whose default model is the run model would get it.
        {
          match: { model: input.googleModel, isChatModel: true },
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
/** The CLI's agent name rule (0.70.0). */
const AGENT_NAME_LINE = /^name: ([a-z0-9_-]{1,64})$/;
/** A column-0 line that is not a plain key: a quoted key, complex key, flow collection, anchor, alias, tag, directive or list. */
const NOT_PLAIN_KEY = /^["'?{[&*!%|>@`-]/;
/** Frontmatter lines that could set or change the top-level name some way this reader does not parse. */
const AMBIGUOUS_LINE = [
  /^\s*["']?name["']?\s*:/, // another name key, quoted or indented
  // Quoted keys (an escape can spell "name") and the other non-plain forms; a list at the top is
  // the remote-agents form.
  NOT_PLAIN_KEY,
  /<</, // merge keys
  /^(---|\.\.\.)/, // document markers
];

export interface RepoAgents {
  /** The names to pin to the run model, sorted. */
  names: string[];
  /** Some file the CLI may load as an agent was not pinned with certainty. */
  unpinnable: boolean;
}

/** A column-0 `key: value` whose quoted or flow value does not close on its own line (it would run on into later lines). */
function opensMultiLineValue(line: string): boolean {
  if (/^\s|^#/.test(line)) return false;
  const colon = line.indexOf(":");
  if (colon < 0) return false;
  const value = line.slice(colon + 1).trimStart();
  const count = (char: string) => value.split(char).length - 1;
  switch (value[0]) {
    case '"':
      // Closed: ends in a quote not escaped by an odd run of backslashes.
      return value.length < 2 || !value.endsWith('"') || /(^|[^\\])(\\\\)*\\"$/.test(value);
    case "'":
      // '' is an escaped quote, so a closed value has an even number of quotes.
      return value.length < 2 || !value.endsWith("'") || count("'") % 2 !== 0;
    case "{":
    case "[":
      return !/[}\]]$/.test(value) || count("{") !== count("}") || count("[") !== count("]");
    default:
      return false;
  }
}

/**
 * The single top-level `name` of an agent file, only when it is certain: LF-only, no BOM, the CLI's
 * `---` delimiters exactly, and one `name: <slug>` line with nothing that could override or extend it.
 *
 * The root mapping must start at column 0 (YAML also allows an indented root, where a multi-line
 * quoted scalar can hide a column-0 `name:` line while the real key sits indented). With a column-0
 * root, every real top-level key is a column-0 line these checks see. A column-0 `name:` that is
 * really inside a multi-line string means the mapping has no name of its own, so the CLI rejects the
 * file and nothing unpinned runs; and any column-0 quoted or flow value left open is refused anyway.
 */
function certainAgentName(content: string): string | undefined {
  if (!content.startsWith("---\n") || content.includes("\r")) return undefined;
  const lines = content.slice(4).split("\n");
  const close = lines.indexOf("---");
  if (close < 0) return undefined;
  const frontmatter = lines.slice(0, close);
  const first = frontmatter.find((line) => line.trim() !== "" && !line.startsWith("#"));
  if (first === undefined || /^\s/.test(first) || NOT_PLAIN_KEY.test(first)) return undefined;
  if (frontmatter.some(opensMultiLineValue)) return undefined;
  const nameLines = frontmatter.flatMap((line, index) => (line.startsWith("name:") ? [index] : []));
  if (nameLines.length !== 1) return undefined;
  const name = AGENT_NAME_LINE.exec(frontmatter[nameLines[0]])?.[1];
  // A following indented line would continue the value (YAML folds it into the name).
  if (!name || /^\s/.test(frontmatter[nameLines[0] + 1] ?? "")) return undefined;
  const others = frontmatter.filter((_, index) => index !== nameLines[0]);
  if (others.some((line) => AMBIGUOUS_LINE.some((pattern) => pattern.test(line)))) return undefined;
  return name;
}

/**
 * The repository's local agents (.gemini/agents, untrusted) the CLI may load: regular *.md files not
 * starting with "_" (0.70.0's rule). Each name comes only from certainAgentName; anything else (too
 * large, past the count cap, unreadable, a format variant, no or an ambiguous name) marks the set
 * unpinnable so the driver turns sub-agents off. Never throws.
 */
export async function readRepoAgents(workspace: string): Promise<RepoAgents> {
  const dir = join(workspace, ".gemini", "agents");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Nothing to load; any other listing failure is not certain.
    return { names: [], unpinnable: code !== "ENOENT" && code !== "ENOTDIR" };
  }
  const loadable = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
  let unpinnable = loadable.length > MAX_REPO_AGENTS;
  const names = new Set<string>();
  for (const file of loadable.slice(0, MAX_REPO_AGENTS)) {
    let content: string;
    try {
      content = await readBoundedRegularFile(join(dir, file), MAX_AGENT_FILE_BYTES, "gemini_agent_file_invalid");
    } catch {
      unpinnable = true;
      continue;
    }
    const name = certainAgentName(content);
    if (name === undefined) unpinnable = true;
    else names.add(name);
  }
  return { names: [...names].sort(), unpinnable };
}
