/**
 * The checkout a resumed session continues in: a detached git worktree at
 * the run's branch (detached, so it works while that branch is checked out
 * elsewhere).
 *
 * - `local:/abs/path` repositories: the worktree comes from that repository.
 * - Hosted repositories: the current directory must be a clone of the run's
 *   repository; the branch is fetched from the matching remote.
 * - A branch that no longer exists (a failed run that pushed nothing) falls
 *   back to the run's base commit, with a warning.
 *
 * git runs with argument arrays (no shell), and every ref and path from the
 * server is validated before it reaches git.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isLocalRepository,
  normalizeGitHubRepository,
  normalizeGitRef,
  normalizeLocalRepository,
} from "../../protocol.js";
import { ResumeError, type TranscriptMeta } from "./download.js";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{7,64}$/i;

export type Git = (args: string[], cwd: string) => Promise<string>;

export const realGit: Git = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
};

async function tryGit(git: Git, args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await git(args, cwd);
  } catch {
    return undefined;
  }
}

export interface CheckoutOptions {
  /** Where the command runs (a clone of the repository, for hosted runs). */
  cwd: string;
  /** --dir: the checkout directory. Default: a sibling `<repo>-run-<short run id>`. */
  dir?: string;
  /** --here: use cwd as it is; no checkout. */
  here?: boolean;
  git?: Git;
}

export interface Checkout {
  dir: string;
  /** What is checked out: the branch name, or the base commit. */
  ref: string;
  /** "created", "reused" (an earlier import's worktree) or "here". */
  outcome: "created" | "reused" | "here";
  warnings: string[];
}

/** owner/name from a GitHub remote URL (https, ssh or scp form); undefined for anything else. */
export function githubRemoteRepository(url: string): string | undefined {
  const trimmed = url.trim();
  const scp = /^[^@/\s]+@github\.com:(.+)$/i.exec(trimmed);
  let path: string | undefined;
  if (scp) path = scp[1];
  else {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() === "github.com" && ["https:", "ssh:", "git:"].includes(parsed.protocol)) {
        path = parsed.pathname;
      }
    } catch {
      return undefined;
    }
  }
  if (!path) return undefined;
  try {
    return normalizeGitHubRepository(path.replace(/^\/+|\/+$/g, ""));
  } catch {
    return undefined;
  }
}

function shortRunId(runId: string): string {
  return runId.slice(-8);
}

function validRef(ref: string | null): string | undefined {
  if (!ref) return undefined;
  try {
    return normalizeGitRef(ref);
  } catch {
    return undefined;
  }
}

async function commonDir(git: Git, dir: string): Promise<string | undefined> {
  const out = await tryGit(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  return out ? realpathSync(out) : undefined;
}

/** Creates the worktree, or reuses one an earlier import made for the same repository. */
async function addWorktree(git: Git, repoDir: string, dir: string, commit: string): Promise<"created" | "reused"> {
  if (existsSync(dir)) {
    const [mine, theirs] = await Promise.all([commonDir(git, repoDir), commonDir(git, dir)]);
    if (mine && theirs && mine === theirs) return "reused";
    throw new ResumeError(
      `${dir} already exists and is not a checkout of this repository. Pass --dir <path> or --here.`,
    );
  }
  try {
    await git(["worktree", "add", "--detach", dir, commit], repoDir);
  } catch {
    throw new ResumeError(
      `git could not create a worktree at ${dir}. Pass --dir <path>, or --here to use this directory.`,
    );
  }
  return "created";
}

export async function prepareCheckout(meta: TranscriptMeta, opts: CheckoutOptions): Promise<Checkout> {
  const git = opts.git ?? realGit;
  const branch = validRef(meta.resultBranch ?? meta.headRef);
  const baseSha = meta.baseSha && SHA.test(meta.baseSha) ? meta.baseSha : undefined;
  if (opts.here) return { dir: resolve(opts.cwd), ref: branch ?? baseSha ?? "", outcome: "here", warnings: [] };
  const warnings: string[] = [];
  const fallbackWarning = (why: string) =>
    `${why}; checked out the run's base commit ${baseSha} instead. The run's changes are not in this checkout.`;

  if (isLocalRepository(meta.repository)) {
    let repoDir: string;
    try {
      repoDir = normalizeLocalRepository(meta.repository).slice("local:".length);
    } catch {
      throw new ResumeError("The run's local repository path is invalid.");
    }
    if (!existsSync(repoDir)) throw new ResumeError(`The run's repository ${repoDir} does not exist on this machine.`);
    let commit: string | undefined;
    let ref = branch;
    if (branch)
      commit = await tryGit(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], repoDir);
    if (!commit) {
      if (!baseSha || !(await tryGit(git, ["rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`], repoDir))) {
        throw new ResumeError(`The run's branch ${branch ?? "(none)"} and base commit are not in ${repoDir}.`);
      }
      warnings.push(fallbackWarning(`The branch ${branch ?? "(none)"} is not in ${repoDir}`));
      commit = baseSha;
      ref = baseSha;
    }
    const dir = opts.dir
      ? resolve(opts.cwd, opts.dir)
      : join(dirname(repoDir), `${basename(repoDir)}-run-${shortRunId(meta.runId)}`);
    const outcome = await addWorktree(git, repoDir, dir, commit);
    return { dir, ref: ref!, outcome, warnings };
  }

  let repository: string;
  try {
    repository = normalizeGitHubRepository(meta.repository);
  } catch {
    throw new ResumeError(
      "The run's repository is not one wardby resume can check out. Pass --here to skip the checkout.",
    );
  }
  const cloneUrl = `https://github.com/${repository}.git`;
  const top = await tryGit(git, ["rev-parse", "--show-toplevel"], opts.cwd);
  if (!top) {
    throw new ResumeError(
      `Run this inside a clone of ${repository} (git clone ${cloneUrl}), or pass --here to skip the checkout.`,
    );
  }
  const remotes = (await tryGit(git, ["remote"], top))?.split("\n").filter(Boolean) ?? [];
  let remote: string | undefined;
  for (const name of remotes) {
    const url = await tryGit(git, ["remote", "get-url", name], top);
    if (url && githubRemoteRepository(url) === repository) {
      remote = name;
      break;
    }
  }
  if (!remote) {
    throw new ResumeError(
      `This directory is not a clone of ${repository}. Run the command inside one (git clone ${cloneUrl}), or pass --here to skip the checkout.`,
    );
  }
  let commit: string | undefined;
  let ref = branch;
  if (branch && (await tryGit(git, ["fetch", "--quiet", remote, `refs/heads/${branch}`], top)) !== undefined) {
    commit = await tryGit(git, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"], top);
  }
  if (!commit) {
    if (!baseSha) throw new ResumeError(`The run's branch ${branch ?? "(none)"} could not be fetched from ${remote}.`);
    let found = await tryGit(git, ["rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`], top);
    if (!found && (await tryGit(git, ["fetch", "--quiet", remote, baseSha], top)) !== undefined) {
      found = await tryGit(git, ["rev-parse", "--verify", "--quiet", `${baseSha}^{commit}`], top);
    }
    if (!found) throw new ResumeError(`Neither the run's branch nor its base commit could be fetched from ${remote}.`);
    warnings.push(fallbackWarning(`The branch ${branch ?? "(none)"} could not be fetched from ${remote}`));
    commit = found;
    ref = baseSha;
  }
  const dir = opts.dir
    ? isAbsolute(opts.dir)
      ? opts.dir
      : resolve(opts.cwd, opts.dir)
    : join(dirname(top), `${basename(top)}-run-${shortRunId(meta.runId)}`);
  const outcome = await addWorktree(git, top, dir, commit);
  return { dir, ref: ref!, outcome, warnings };
}
