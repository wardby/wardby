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
import { downloadTranscript, parseResumeLink, ResumeError } from "./download.js";
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
  writeMcpConfig,
} from "./launch.js";

export const RESUME_USAGE = `usage: wardby resume '<link>' [--dir <path> | --here] [--force] [--print]

Continue a wardby coding run's Claude Code session on this machine. Get the
link (valid for 10 minutes) from the get_run_transcript MCP tool.

  --dir <path>  Check the run out here (default: a sibling <repo>-run-<id>)
  --here        Use the current directory as it is; no checkout
  --force       Replace a different session file already imported for this run
  --print       Print the claude command instead of starting it`;

export interface ResumeDeps {
  cwd?: string;
  sessionsRoot?: string;
  fetch?: typeof globalThis.fetch;
  git?: Git;
  claudeVersion?: () => Promise<string | undefined>;
  launch?: (cwd: string, args: string[]) => Promise<number>;
  out?: (line: string) => void;
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
  const rawLink = positionals[0];
  try {
    const link = parseResumeLink(positionals[0]);
    out(`Downloading the transcript from ${link.origin} ...`);
    const transcript = await downloadTranscript(link, deps.fetch);
    const { meta } = transcript;
    if (meta.provider !== "claude-code") {
      throw new ResumeError(`Resuming ${meta.provider} runs locally is not supported yet.`);
    }
    // Check out first, so a refused checkout leaves nothing behind.
    const checkout = await prepareCheckout(meta, { cwd, dir: values.dir, here: values.here, git: deps.git });
    const session = await writeSessionFile(transcript, { root: deps.sessionsRoot, force: values.force });
    const from = WORKER_WORKSPACE;
    const configPath = await writeMcpConfig(session.dir, mcpConfig({ checkout: checkout.dir, from }));
    const versionText = await (deps.claudeVersion ?? claudeVersion)();
    const args = claudeArgs({
      sessionFile: session.path,
      mcpConfigPath: configPath,
      note: moveNote({ runId: meta.runId, ref: checkout.ref, from, checkout: checkout.dir }),
      version: versionText ? parseClaudeVersion(versionText) : undefined,
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
