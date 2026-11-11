/**
 * `wardby claude-plugin install | uninstall | status`: sets up the wardby-runs
 * Claude Code plugin (plugins/claude-code) on this machine. Install adds the
 * plugin from a marketplace (wardby/wardby by default, or an operator's own),
 * can register the wardby MCP server, and offers the allow rules auto mode
 * needs for the pane's read-only tools. Uninstall removes the plugin and only
 * the settings install added. Status reports all three.
 *
 * Runs without a database or any server configuration. It prints the commands
 * it runs and their outcome, never a token: the MCP server's sign-in is Claude
 * Code's own, at first use.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { atLeast, parseClaudeVersion } from "../coding/transcript/resume/launch.js";

export const PLUGIN = "wardby-runs";
export const DEFAULT_MARKETPLACE = "wardby/wardby";
export const MCP_SERVER = "wardby";

/**
 * The pane's read-only tools on a server: what auto mode needs allowed. stop_run is never added: it
 * changes a run. get_run_steps backs Recent steps and Steps; get_run_text reads the rest of a long request,
 * final answer or error for Show full text and Copy. Against an older server without them the rules are harmless.
 */
export function paneTools(server: string): string[] {
  return ["list_runs", "list_agents", "get_run", "get_run_transcript", "get_run_steps", "get_run_text"].map(
    (tool) => `mcp__${server}__${tool}`,
  );
}
export const PANE_TOOLS = paneTools(MCP_SERVER);

/**
 * The first Claude Code release that draws the pane: an older one refuses its tree (Text size, weight, mono
 * and tabular; spacing tokens; Text children in a Button) and shows nothing, and before about 2.1.290 the
 * plugin does not load at all. Keep in step with MIN_CLAUDE_CODE in plugins/claude-code/hooks/register.tsx.
 */
export const PANE_MIN_CLAUDE_CODE = "2.1.299";

/** How long one `claude` call may take: `claude mcp get` can check its server, which shouldn't stall doctor. */
const CLAUDE_TIMEOUT_MS = 20_000;

export const CLAUDE_PLUGIN_USAGE = `usage: wardby claude-plugin install [--marketplace <owner/repo|path>] [--server-url <url>]
                                   [--allow-tools | --no-allow-tools] [--fullscreen] [--yes]
       wardby claude-plugin uninstall
       wardby claude-plugin status

Set up the wardby-runs Claude Code plugin: a pane listing your wardby runs.

  --server-name <name> The MCP server the pane uses, as /mcp lists it (default ${MCP_SERVER}); its
                       allow rules follow the name
  --marketplace <src>  Where to install it from (default ${DEFAULT_MARKETPLACE}; an operator's own
                       marketplace repository or a local folder works too)
  --server-url <url>   Register the wardby MCP server at this URL first (for example
                       https://wardby.example.com/mcp) when Claude Code has none named ${MCP_SERVER}
  --allow-tools        Allow the pane's read-only wardby tools for auto mode without asking
  --no-allow-tools     Leave permission rules alone
  --fullscreen         Also switch Claude Code's terminal to its fullscreen view, where the pane
                       is a side bar that takes clicks (applies to every session)
  --yes, -y            Answer yes to every question`;

/** The record of what install changed, so uninstall removes exactly that. */
export type InstallRecord = { settingsPath: string; rules: string[]; tui: boolean };

export type ClaudePluginDeps = {
  /** Runs a command; resolves its exit code and output. */
  run: (command: string, args: string[]) => { status: number; stdout: string; stderr: string };
  /** Asks a yes/no question; false when there's nobody to ask. */
  confirm: (question: string) => Promise<boolean>;
  /** Where Claude Code keeps its settings: CLAUDE_CONFIG_DIR, else ~/.claude. */
  claudeConfigDir: string;
  /** Where wardby keeps the install record: ~/.wardby. */
  wardbyDir: string;
  out: (line: string) => void;
};

/** The real machine: spawns `claude`, asks on the terminal, uses CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudePluginDeps(): ClaudePluginDeps {
  return {
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS });
      return {
        status: result.error ? 127 : (result.status ?? 1),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    },
    confirm: async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
    wardbyDir: join(homedir(), ".wardby"),
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

const recordPath = (deps: ClaudePluginDeps) => join(deps.wardbyDir, "claude-plugin.json");

/** A settings file as an object: {} when absent; refuses a file that isn't a JSON object rather than overwrite it. */
function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't valid JSON; fix it, then run this again. Nothing was changed.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} isn't a JSON object; nothing was changed.`);
  }
  return parsed as Record<string, unknown>;
}

/** Writes a settings file whole, through a temporary file, so a failure never leaves half a file. */
function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.wardby-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function allowList(settings: Record<string, unknown>): string[] {
  const permissions = settings.permissions;
  if (typeof permissions !== "object" || permissions === null) return [];
  const allow = (permissions as { allow?: unknown }).allow;
  return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string") : [];
}

function withAllowList(settings: Record<string, unknown>, allow: string[]): Record<string, unknown> {
  const permissions =
    typeof settings.permissions === "object" && settings.permissions !== null
      ? (settings.permissions as Record<string, unknown>)
      : {};
  return { ...settings, permissions: { ...permissions, allow } };
}

function readRecord(deps: ClaudePluginDeps): InstallRecord | null {
  try {
    const record = JSON.parse(readFileSync(recordPath(deps), "utf8")) as InstallRecord;
    return typeof record.settingsPath === "string" && Array.isArray(record.rules) ? record : null;
  } catch {
    return null;
  }
}

function claudeAvailable(deps: ClaudePluginDeps): boolean {
  return deps.run("claude", ["--version"]).status === 0;
}

/** The warning for a Claude Code older than the pane needs, or null when it is new enough or unreadable. */
function claudeTooOldLine(deps: ClaudePluginDeps): string | null {
  const output = deps.run("claude", ["--version"]).stdout;
  const version = parseClaudeVersion(output);
  const min = parseClaudeVersion(PANE_MIN_CLAUDE_CODE) as [number, number, number];
  if (!version || atLeast(version, min)) return null;
  return `! The wardby runs pane needs Claude Code ${PANE_MIN_CLAUDE_CODE} or later; this is ${version.join(".")}. Run \`claude update\`, then restart Claude Code.`;
}

function hasMcpServer(deps: ClaudePluginDeps, server = MCP_SERVER): boolean {
  return deps.run("claude", ["mcp", "get", server]).status === 0;
}

function pluginInstalled(deps: ClaudePluginDeps): boolean {
  return pluginEntries(deps).length > 0;
}

/**
 * The installed copies of the plugin, as `claude plugin list` prints them: each id (`wardby-runs@<marketplace>`)
 * and whether it is turned on. A copy whose list entry has no Status line counts as on (older Claude Code).
 */
export function pluginEntries(deps: ClaudePluginDeps): { id: string; enabled: boolean }[] {
  const list = deps.run("claude", ["plugin", "list"]);
  if (list.status !== 0) return [];
  const entries: { id: string; enabled: boolean }[] = [];
  // Each plugin's block starts with its id (`name@marketplace`); a Status line belongs to the block it is in.
  let current: { id: string; enabled: boolean } | null = null;
  for (const line of list.stdout.split("\n")) {
    const header = /(?:^|\s)([\w.-]+@[\w.-]+)\s*$/.exec(line)?.[1];
    if (header) {
      current = header.startsWith(`${PLUGIN}@`) ? { id: header, enabled: true } : null;
      if (current) entries.push(current);
      continue;
    }
    const status = /^\s*Status:\s*(.*)$/i.exec(line)?.[1];
    if (status !== undefined && current) current.enabled = !/disabled/i.test(status);
  }
  return entries;
}

/** The first line of a failed command's output, for the message. */
const firstLine = (result: { stdout: string; stderr: string }) =>
  (result.stderr || result.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";

export async function installPlugin(
  options: {
    marketplace: string;
    serverName?: string;
    serverUrl?: string;
    allowTools?: boolean;
    fullscreen: boolean;
    yes: boolean;
  },
  deps: ClaudePluginDeps,
): Promise<number> {
  if (!claudeAvailable(deps)) {
    deps.out("Claude Code (claude) wasn't found on PATH. Install it, then run this again.");
    return 1;
  }
  // Installing still helps (the pane works once Claude Code is updated); say so first.
  const tooOld = claudeTooOldLine(deps);
  if (tooOld) deps.out(tooOld);
  const server = options.serverName ?? MCP_SERVER;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(server)) {
    deps.out(`--server-name "${server}" isn't a server name (letters, digits, - and _).`);
    return 1;
  }
  const tools = paneTools(server);
  // Read the settings file before changing anything, so a broken one stops the install cleanly.
  const settingsPath = join(deps.claudeConfigDir, "settings.json");
  let settings: Record<string, unknown>;
  try {
    settings = readSettings(settingsPath);
  } catch (error) {
    deps.out(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // 1. The MCP server the pane talks to.
  if (hasMcpServer(deps, server)) {
    deps.out(`✓ Claude Code has an MCP server named ${server}.`);
  } else if (options.serverUrl) {
    let url: URL;
    try {
      url = new URL(options.serverUrl);
    } catch {
      deps.out(`--server-url "${options.serverUrl}" isn't a URL.`);
      return 1;
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      deps.out("--server-url must be https (or http on localhost).");
      return 1;
    }
    const added = deps.run("claude", ["mcp", "add", "--transport", "http", "--scope", "user", server, url.href]);
    if (added.status !== 0) {
      deps.out(`Adding the ${server} MCP server failed: ${firstLine(added)}`);
      return 1;
    }
    deps.out(`✓ Added the ${server} MCP server (${url.href}). Sign in with /mcp in Claude Code.`);
  } else {
    deps.out(
      `! Claude Code has no MCP server named ${server}. The pane needs one: run this again with ` +
        "--server-url <your wardby URL>/mcp, or run `wardby quickstart`.",
    );
  }

  // 2. The plugin itself.
  const installed = deps.run("claude", ["plugin", "install", PLUGIN, "--marketplace", options.marketplace]);
  if (installed.status !== 0) {
    deps.out(`Installing the ${PLUGIN} plugin from ${options.marketplace} failed: ${firstLine(installed)}`);
    return 1;
  }
  deps.out(`✓ Installed the ${PLUGIN} plugin from ${options.marketplace}.`);
  // Claude Code may leave a newly installed plugin turned off, and then it never loads: turn it on.
  for (const entry of pluginEntries(deps).filter((e) => !e.enabled)) {
    const enabled = deps.run("claude", ["plugin", "enable", entry.id]);
    deps.out(
      enabled.status === 0
        ? `✓ Turned on ${entry.id}.`
        : `! ${entry.id} is installed but turned off, and turning it on failed: ${firstLine(enabled)}. Run /plugin in Claude Code and enable it.`,
    );
  }

  // 3. Allow rules for auto mode, and the fullscreen view: each only when asked for or agreed to.
  const record: InstallRecord = readRecord(deps) ?? { settingsPath, rules: [], tui: false };
  let changed = false;

  const allowTools =
    options.allowTools ??
    (options.yes ||
      (await deps.confirm(
        `Allow the pane's read-only wardby tools (${tools.map((t) => t.replace(`mcp__${server}__`, "")).join(", ")}) ` +
          `in ${settingsPath}? Auto mode refuses the pane's calls without them.`,
      )));
  if (allowTools) {
    const current = allowList(settings);
    const missing = tools.filter((rule) => !current.includes(rule));
    if (missing.length > 0) {
      settings = withAllowList(settings, [...current, ...missing]);
      record.rules = [...new Set([...record.rules, ...missing])];
      changed = true;
      deps.out(`✓ Allowed ${missing.join(", ")}.`);
    } else {
      deps.out("✓ The pane's tools are already allowed.");
    }
  } else {
    deps.out(`Left permission rules alone. Under auto mode, allow ${tools.join(", ")} in /permissions.`);
  }

  if (options.fullscreen && settings.tui !== "fullscreen") {
    settings = { ...settings, tui: "fullscreen" };
    record.tui = true;
    changed = true;
    deps.out("✓ Switched Claude Code to its fullscreen view (restart Claude Code to see it).");
  }

  if (changed) {
    writeSettings(settingsPath, settings);
    mkdirSync(deps.wardbyDir, { recursive: true });
    writeFileSync(recordPath(deps), `${JSON.stringify({ ...record, settingsPath }, null, 2)}\n`, { mode: 0o600 });
  }

  deps.out("Open the pane in Claude Code with /wardby-runs (in a new session, or after /reload-plugins).");
  return 0;
}

export async function uninstallPlugin(deps: ClaudePluginDeps): Promise<number> {
  if (!claudeAvailable(deps)) {
    deps.out("Claude Code (claude) wasn't found on PATH.");
    return 1;
  }
  const removed = deps.run("claude", ["plugin", "uninstall", PLUGIN]);
  if (removed.status === 0) deps.out(`✓ Uninstalled the ${PLUGIN} plugin.`);
  else deps.out(`The ${PLUGIN} plugin wasn't uninstalled: ${firstLine(removed)}`);

  // Only what install added: rules it added, and the fullscreen view if it switched it on. The file is
  // written only when one of those is still there; a broken file is reported, not rewritten.
  const record = readRecord(deps);
  if (record && existsSync(record.settingsPath)) {
    let settings: Record<string, unknown>;
    try {
      settings = readSettings(record.settingsPath);
    } catch (error) {
      deps.out(`${error instanceof Error ? error.message : String(error)} Remove ${record.rules.join(", ")} yourself.`);
      return 1;
    }
    const current = allowList(settings);
    const kept = current.filter((rule) => !record.rules.includes(rule));
    let changed = false;
    if (kept.length !== current.length) {
      settings = withAllowList(settings, kept);
      changed = true;
      deps.out(`✓ Removed the rules install added: ${current.filter((rule) => !kept.includes(rule)).join(", ")}.`);
    }
    if (record.tui && settings.tui === "fullscreen") {
      const { tui: _tui, ...rest } = settings;
      settings = rest;
      changed = true;
      deps.out("✓ Switched the fullscreen view back off.");
    }
    if (changed) writeSettings(record.settingsPath, settings);
  }
  if (record) writeFileSync(recordPath(deps), "{}\n", { mode: 0o600 });
  deps.out(`The ${MCP_SERVER} MCP server was left in place (remove it with: claude mcp remove ${MCP_SERVER} -s user).`);
  return removed.status === 0 ? 0 : 1;
}

export function pluginStatus(deps: ClaudePluginDeps, serverName = MCP_SERVER): number {
  if (!claudeAvailable(deps)) {
    deps.out("✗ Claude Code (claude) wasn't found on PATH.");
    return 1;
  }
  const entries = pluginEntries(deps);
  const plugin = entries.length > 0;
  const off = entries.filter((e) => !e.enabled);
  const server = hasMcpServer(deps, serverName);
  const settingsPath = join(deps.claudeConfigDir, "settings.json");
  let allowed: string[] = [];
  try {
    allowed = allowList(readSettings(settingsPath));
  } catch (error) {
    deps.out(`! ${error instanceof Error ? error.message : String(error)}`);
  }
  const missing = paneTools(serverName).filter((rule) => !allowed.includes(rule));
  if (!plugin) deps.out(`✗ ${PLUGIN} plugin not installed`);
  else if (off.length === 0) deps.out(`✓ ${PLUGIN} plugin installed and on`);
  // An installed copy that is turned off never loads: the pane is missing as surely as if not installed.
  for (const e of off) deps.out(`✗ ${e.id} is installed but turned off: run \`claude plugin enable ${e.id}\``);
  deps.out(`${server ? "✓" : "✗"} ${serverName} MCP server ${server ? "configured" : "not configured"}`);
  deps.out(
    missing.length === 0
      ? `✓ the pane's tools are allowed in ${settingsPath}`
      : `! not allowed in ${settingsPath} (auto mode refuses them): ${missing.join(", ")}. Re-run \`wardby claude-plugin install --allow-tools\` to add them.`,
  );
  return plugin && off.length === 0 && server ? 0 : 1;
}

/**
 * Quickstart's offer of the pane, once it connected Claude Code: asks unless a flag answered it,
 * never in a non-interactive run, and installs on a yes. A failed install is a warning, not a stop.
 */
export async function quickstartPaneStep(
  options: { client: string; mcpConfigured: boolean; flag?: boolean; nonInteractive: boolean; yes: boolean },
  steps: {
    ask: (question: string) => Promise<boolean>;
    install: (options: Parameters<typeof installPlugin>[0]) => Promise<number>;
    warn: (line: string) => void;
  },
): Promise<"skipped" | "installed" | "failed"> {
  if (!options.mcpConfigured || (options.client !== "claude" && options.client !== "both")) return "skipped";
  const wanted =
    options.flag ??
    (!options.nonInteractive && (await steps.ask("Add the wardby runs pane to Claude Code (the wardby-runs plugin)?")));
  if (!wanted) return "skipped";
  const status = await steps.install({ marketplace: DEFAULT_MARKETPLACE, fullscreen: false, yes: options.yes });
  if (status === 0) return "installed";
  steps.warn("! The runs pane wasn't installed; try again with: npx @wardby/cli@latest claude-plugin install");
  return "failed";
}

/**
 * `wardby doctor`'s lines for the pane: none without Claude Code. The pane is optional, so nothing
 * here is a failure (✗): a missing plugin is "○", a missing server or rule a warning ("!").
 */
export function claudePluginDoctorLines(deps: ClaudePluginDeps, serverName = MCP_SERVER): string[] {
  if (!claudeAvailable(deps)) return [];
  if (!pluginInstalled(deps)) {
    return [`○ Claude Code runs pane not installed (optional: npx @wardby/cli@latest claude-plugin install)`];
  }
  const off = pluginEntries(deps).filter((e) => !e.enabled);
  const lines =
    off.length === 0
      ? [`✓ ${PLUGIN} Claude Code plugin installed`]
      : off.map(
          (e) =>
            `! ${e.id} is installed but turned off, so the pane never loads (claude plugin enable ${e.id}, or re-run claude-plugin install)`,
        );
  const tooOld = claudeTooOldLine(deps);
  if (tooOld) lines.push(tooOld);
  lines.push(
    hasMcpServer(deps, serverName)
      ? `✓ ${serverName} MCP server configured in Claude Code`
      : `! Claude Code has no MCP server named ${serverName}: the pane has nothing to show (claude-plugin install --server-url <url>)`,
  );
  const settingsPath = join(deps.claudeConfigDir, "settings.json");
  let missing: string[] = paneTools(serverName);
  try {
    const allowed = allowList(readSettings(settingsPath));
    missing = paneTools(serverName).filter((rule) => !allowed.includes(rule));
  } catch {
    // An unreadable settings file reads as no rules: the warning below says what to allow.
  }
  lines.push(
    missing.length === 0
      ? "✓ the pane's tools are allowed for auto mode"
      : `! not allowed for auto mode in ${settingsPath}: ${missing.join(", ")} (needed only in auto mode; re-run \`claude-plugin install --allow-tools\` to add them)`,
  );
  return lines;
}

export async function claudePluginCommand(
  args: string[],
  deps: ClaudePluginDeps = claudePluginDeps(),
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    deps.out(CLAUDE_PLUGIN_USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub === "install") {
    const { values } = parseArgs({
      args: rest,
      allowNegative: true,
      options: {
        marketplace: { type: "string" },
        "server-name": { type: "string" },
        "server-url": { type: "string" },
        "allow-tools": { type: "boolean" },
        fullscreen: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
      },
    });
    return installPlugin(
      {
        marketplace: values.marketplace ?? DEFAULT_MARKETPLACE,
        serverName: values["server-name"],
        serverUrl: values["server-url"],
        allowTools: values["allow-tools"],
        fullscreen: values.fullscreen ?? false,
        yes: values.yes ?? false,
      },
      deps,
    );
  }
  if (sub === "uninstall") return uninstallPlugin(deps);
  if (sub === "status") {
    const { values } = parseArgs({ args: rest, options: { "server-name": { type: "string" } } });
    return pluginStatus(deps, values["server-name"] ?? MCP_SERVER);
  }
  deps.out(`Unknown claude-plugin command "${sub}".\n${CLAUDE_PLUGIN_USAGE}`);
  return 1;
}
