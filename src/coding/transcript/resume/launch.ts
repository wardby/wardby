/**
 * Starts Claude Code on the imported session:
 *
 *   claude --resume <session file> --mcp-config <stand-in config>
 *          [--system-prompt-snapshot off] --append-system-prompt <move note>
 *
 * in the checkout. The MCP config starts the stand-in `wardby_tools` server
 * (stand-in.ts) from this same wardby install, so the run's tool calls
 * render and a call to run_command explains the move.
 *
 * System prompt flags on resume (Claude Code CLI reference, "System prompt
 * flags in resumed conversations"): from v2.1.265 Claude Code records the
 * system prompt on a conversation's first request and reuses it after
 * --resume, so new flag text would apply only after compaction.
 * `--system-prompt-snapshot off` (v2.1.257 and later) rebuilds the prompt on
 * every request, so the note applies. Older versions did not record it
 * while a system prompt flag was passed, so the note applies without it.
 * When the version cannot be read, the flag is included (every current
 * release has it) and the output says to remove it for a version before
 * 2.1.257.
 */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { STAND_IN_SERVER_NAME } from "./stand-in.js";

const execFileAsync = promisify(execFile);

/** Where the run's commands ran in the worker (run_command's workspace, claude-tool-runner/main.mjs). */
export const WORKER_WORKSPACE = "/workspace";
/** First Claude Code version with --system-prompt-snapshot. */
const SNAPSHOT_FLAG_SINCE: [number, number, number] = [2, 1, 257];

/** This install's wardby entry point, for the MCP config to start the stand-in with. */
export function wardbyBinPath(): string {
  // src/coding/transcript/resume/ and dist/coding/transcript/resume/ are both four levels below the package root.
  return fileURLToPath(new URL("../../../../bin/wardby.js", import.meta.url));
}

/**
 * `runChanges`: true when the checkout is at the run's branch, false when it fell back to the base
 * commit, undefined for --here (the importer did not choose what is checked out).
 */
export function moveNote(opts: {
  runId: string;
  ref: string;
  from: string;
  checkout: string;
  runChanges?: boolean;
}): string {
  const changes =
    opts.runChanges === true
      ? "This checkout already contains the run's changes: do not redo them. "
      : opts.runChanges === false
        ? "This checkout is at the run's base commit: the run's changes are not in it. "
        : "";
  return (
    `This conversation was moved from wardby run ${opts.runId} to the user's machine. ` +
    `The worker path ${opts.from} is now ${opts.checkout} (checked out at ${opts.ref}). ` +
    changes +
    `The run_command tool only worked inside the worker and is gone: use your local tools (Bash, Read, Edit) in ${opts.checkout}.`
  );
}

export function mcpConfig(opts: { checkout: string; from: string; node?: string; bin?: string }): unknown {
  return {
    mcpServers: {
      [STAND_IN_SERVER_NAME]: {
        type: "stdio",
        command: opts.node ?? process.execPath,
        args: [opts.bin ?? wardbyBinPath(), "resume-tools", "--checkout", opts.checkout, "--from", opts.from],
      },
    },
  };
}

/** Writes the MCP config next to the session file (mode 0600, atomically). */
export async function writeMcpConfig(dir: string, config: unknown): Promise<string> {
  const path = join(dir, "mcp-config.json");
  const temp = join(dir, `.mcp-config.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  return path;
}

export function parseClaudeVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atLeast(version: [number, number, number], min: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

/** `claude --version`, or undefined when claude is not on PATH. */
export async function claudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], { timeout: 15_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export const UNKNOWN_VERSION_NOTE =
  "Could not read the Claude Code version: the command includes --system-prompt-snapshot off (Claude Code 2.1.257 or later); remove that flag for an older version.";

export function claudeArgs(opts: {
  sessionFile: string;
  mcpConfigPath: string;
  note: string;
  version: [number, number, number] | undefined;
}): string[] {
  // Unknown version (claude missing or unparseable): include it, as every current release supports it.
  const snapshot =
    !opts.version || atLeast(opts.version, SNAPSHOT_FLAG_SINCE) ? ["--system-prompt-snapshot", "off"] : [];
  return [
    "--resume",
    opts.sessionFile,
    "--mcp-config",
    opts.mcpConfigPath,
    ...snapshot,
    "--append-system-prompt",
    opts.note,
  ];
}

/** POSIX shell quoting, for printing a command the user can paste. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function printableCommand(cwd: string, args: string[]): string {
  return `cd ${shellQuote(cwd)} && claude ${args.map(shellQuote).join(" ")}`;
}

/** Runs claude in the checkout with this terminal; resolves with its exit code. */
export function launchClaude(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
