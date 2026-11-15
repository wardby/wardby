/**
 * Read-only git helpers shared by the local review host and the local VCS
 * remote: GIT_* stripped, hooks/fsmonitor/signature display off, strict ref and
 * path validation. Never imported by protocol.ts (which keeps no relative imports).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COMMIT_SHA } from "./protocol.js";

const run = promisify(execFile);

export const SHA = COMMIT_SHA;
export const MAX_REF_CHARS = 250;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return env;
}

function gitArgs(dir: string, args: string[]): string[] {
  return [
    "--literal-pathspecs",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "log.showSignature=false",
    "-c",
    "gpg.program=",
    "-c",
    "diff.external=",
    "-C",
    dir,
    ...args,
  ];
}

/** Runs git read-only in `dir`. Throws the raw execFile error; callers decide what a failure means. */
export async function localGit(dir: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<string> {
  const { stdout } = await run("git", gitArgs(dir, args), { env: cleanGitEnv(), maxBuffer, encoding: "utf8" });
  return stdout;
}

/** Like localGit, but the raw stdout bytes (for content that must be validated as UTF-8). */
export async function localGitBytes(dir: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<Buffer> {
  const { stdout } = await run("git", gitArgs(dir, args), { env: cleanGitEnv(), maxBuffer, encoding: "buffer" });
  return stdout;
}

/**
 * The only variables a write may add back after GIT_* is stripped: a scratch
 * index and an explicit identity, so no user configuration is needed.
 */
const WRITE_ENV = new Set([
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/**
 * Runs git in `dir` with the same hardening as localGit, plus optional stdin
 * and a few allow-listed GIT_* variables (WRITE_ENV). For plumbing that
 * writes objects and refs only; it never touches the caller's index or work
 * tree unless the arguments do.
 */
export async function localGitWrite(
  dir: string,
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const extra = options.env ?? {};
  for (const key of Object.keys(extra)) {
    if (!WRITE_ENV.has(key)) throw new Error(`localGitWrite: ${key} is not an allowed git variable`);
  }
  return await new Promise<string>((resolve, reject) => {
    const child = execFile(
      "git",
      gitArgs(dir, args),
      { env: { ...cleanGitEnv(), ...extra }, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (error: Error | null, stdout: string) => (error ? reject(error) : resolve(stdout)),
    );
    // git may exit before reading stdin (an early error, or a command that never
    // reads it); writing to the closed pipe then raises EPIPE on stdin. The
    // callback above already reports git's own result, so a stdin error is not
    // the outcome — but left unhandled it would be an uncaught exception.
    child.stdin?.on("error", () => {});
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

/** True for a plain branch/tag name that cannot read as an option or revision expression. */
export async function isSafeRefName(dir: string, name: string): Promise<boolean> {
  if (
    !name ||
    name.length > MAX_REF_CHARS ||
    name.startsWith("-") ||
    name.includes("\0") ||
    name.includes("@{") ||
    !/^[\x21-\x7e]+$/.test(name)
  ) {
    return false;
  }
  try {
    await localGit(dir, ["check-ref-format", "--branch", name], 64 * 1024);
    return true;
  } catch {
    return false;
  }
}

/** A path inside the repository: relative, no `.`/`..`/empty segments, no NUL. */
export function isSafeRepoPath(path: string): boolean {
  return !(
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}
