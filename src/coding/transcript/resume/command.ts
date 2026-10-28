/**
 * `wardby resume '<link>'`: continue a wardby coding run's Claude Code
 * session on this machine. The link comes from the get_run_transcript MCP
 * tool. Downloads and verifies the transcript, writes it under
 * ~/.wardby/sessions/<runId>/, checks out the run's branch, and starts
 * `claude --resume` there with the stand-in tool server.
 *
 * Runs without a database or any server configuration. Output never
 * includes the link (it is a credential until it expires).
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { downloadTranscript, isLoopbackLink, parseResumeLink, ResumeError } from "./download.js";
import { writeSessionFile } from "./session-file.js";
import { prepareCheckout, type Git } from "./checkout.js";
import {
  WORKER_WORKSPACE,
  claudeArgs,
  claudeVersion,
  launchClaude,
  mcpConfig,
  moveNote,
  parseClaudeVersion,
  printableCommand,
  UNKNOWN_VERSION_NOTE,
  writeMcpConfig,
} from "./launch.js";

export const RESUME_USAGE = `usage: wardby resume - [--dir <path> | --here] [--force] [--print]
       wardby resume '<link>' [options]

Continue a wardby coding run's Claude Code session on this machine. Get the
link (valid for 10 minutes) from the get_run_transcript MCP tool. With "-",
paste the link when asked (or pipe it in): this keeps it out of your shell
history and the process list, where a link given as an argument stays while
Claude Code runs.

  --dir <path>  Check the run out here (default: a sibling <repo>-run-<id>)
  --here        Use the current directory as it is; no checkout
  --force       Replace a different session file already imported for this run
  --print       Print the claude command instead of starting it`;

/** Largest link read from standard input. */
const MAX_LINK_BYTES = 8192;

/** Reads the link from standard input: one pasted line on a terminal, else the piped text. */
async function readLinkFromStdin(out: (line: string) => void): Promise<string> {
  if (process.stdin.isTTY) {
    out("Paste the get_run_transcript link and press Enter:");
    const rl = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of rl) return line.slice(0, MAX_LINK_BYTES);
      return "";
    } finally {
      rl.close();
    }
  }
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > MAX_LINK_BYTES) throw new ResumeError("The link read from standard input is too long.");
  }
  return text;
}

export interface ResumeDeps {
  cwd?: string;
  sessionsRoot?: string;
  fetch?: typeof globalThis.fetch;
  git?: Git;
  claudeVersion?: () => Promise<string | undefined>;
  launch?: (cwd: string, args: string[]) => Promise<number>;
  out?: (line: string) => void;
  /** Reads the link for "-" (default: standard input). */
  readLink?: () => Promise<string>;
}

/** Returns the process exit code. */
export async function resumeCommand(argv: string[], deps: ResumeDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stderr.write(`${line}\n`));
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        here: { type: "boolean" },
        force: { type: "boolean" },
        print: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    out(RESUME_USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(RESUME_USAGE);
    return 0;
  }
  if (positionals.length !== 1 || (values.dir !== undefined && values.here)) {
    out(RESUME_USAGE);
    return 2;
  }
  const cwd = deps.cwd ?? process.cwd();
  let rawLink = positionals[0];
  try {
    if (rawLink === "-") rawLink = (await (deps.readLink ?? (() => readLinkFromStdin(out)))()).trim();
    const link = parseResumeLink(rawLink);
    out(`Downloading the transcript from ${link.origin} ...`);
    const transcript = await downloadTranscript(link, deps.fetch);
    const { meta } = transcript;
    if (meta.provider !== "claude-code") {
      throw new ResumeError(`Resuming ${meta.provider} runs locally is not supported yet.`);
    }
    // Check out first, so a refused checkout leaves nothing behind.
    const checkout = await prepareCheckout(meta, {
      cwd,
      dir: values.dir,
      here: values.here,
      git: deps.git,
      linkIsLoopback: isLoopbackLink(link),
    });
    const session = await writeSessionFile(transcript, { root: deps.sessionsRoot, force: values.force });
    const from = WORKER_WORKSPACE;
    const configPath = await writeMcpConfig(session.dir, mcpConfig({ checkout: checkout.dir, from }));
    const versionText = await (deps.claudeVersion ?? claudeVersion)();
    const version = versionText ? parseClaudeVersion(versionText) : undefined;
    const args = claudeArgs({
      sessionFile: session.path,
      mcpConfigPath: configPath,
      note: moveNote({
        runId: meta.runId,
        ref: checkout.ref,
        from,
        checkout: checkout.dir,
        // prepareCheckout checks out the base commit only when the run's branch is missing.
        runChanges: checkout.outcome === "here" ? undefined : checkout.ref !== meta.baseSha,
      }),
      version,
    });

    out(`Run:          ${meta.runId}`);
    out(
      `Session file: ${session.path}` +
        (session.outcome === "same"
          ? " (already imported)"
          : session.outcome === "continued"
            ? " (kept: it holds your local continuation)"
            : session.outcome === "replaced"
              ? " (replaced)"
              : ""),
    );
    out(`MCP config:   ${configPath}`);
    out(
      `Checkout:     ${checkout.dir} at ${checkout.ref}` +
        (checkout.outcome === "reused" ? " (existing worktree reused)" : checkout.outcome === "here" ? " (as is)" : ""),
    );
    for (const warning of checkout.warnings) out(`Warning: ${warning}`);
    if (!version) out(`Note: ${UNKNOWN_VERSION_NOTE}`);
    out(
      `To remove the import later: delete ${session.dir}${checkout.outcome === "created" ? ` and run git worktree remove ${checkout.dir}` : ""}.`,
    );

    const command = printableCommand(checkout.dir, args);
    if (values.print || !versionText) {
      if (!versionText && !values.print) out("Claude Code (claude) was not found on PATH. Install it, then run:");
      process.stdout.write(`${command}\n`);
      return 0;
    }
    out("Starting Claude Code ...");
    return await (deps.launch ?? launchClaude)(checkout.dir, args);
  } catch (error) {
    if (error instanceof ResumeError) {
      out(`wardby resume: ${error.message}`);
      return 1;
    }
    // Unexpected (a file system or git failure): its message, with the link removed by exact value.
    out(`wardby resume: ${withoutLink(error instanceof Error ? error.message : String(error), rawLink)}`);
    return 1;
  }
}

/** Removes the link and its token, in every form they could be quoted, from a message. */
export function withoutLink(message: string, rawLink: string): string {
  const values = new Set<string>([rawLink, rawLink.trim()]);
  try {
    const token = new URL(rawLink.trim()).searchParams.get("t");
    if (token) for (const v of [token, encodeURIComponent(token)]) values.add(v);
  } catch {
    // Not a URL: only the raw value can appear.
  }
  let result = message;
  for (const value of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(value).join("[link]");
  }
  return result;
}
