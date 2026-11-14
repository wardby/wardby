import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gitInfoExcludeFile, normalizeCollectExclusions } from "../../coding/collect-exclude.js";
import { COMMIT_SHA } from "../../coding/protocol.js";
import type { GitCommandRunner } from "./git.js";

/**
 * The worker `.git`'s whole config (#536), written by hand rather than left to `git init`: no
 * remote, no URL, no credential or http section, hooks off, signing off, and the Wardby identity.
 * The worker has nothing to fetch from or push to; its commits come back as a bundle.
 */
export const WORKER_GIT_CONFIG = [
  "[core]",
  "\trepositoryformatversion = 0",
  "\tbare = false",
  "\thooksPath = /dev/null",
  "[commit]",
  "\tgpgSign = false",
  "[tag]",
  "\tgpgSign = false",
  "[user]",
  "\tname = Wardby",
  "\temail = wardby@users.noreply.github.com",
  "",
].join("\n");

/**
 * Every git call that builds the worker `.git`: no hooks, no credential helper, no transport but
 * the local `file` one (the source is the control plane's own git dir, by path), no reflogs (they
 * would record the source path), and the fetch kept as one pack.
 */
const LOCAL_BUILD_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "core.logAllRefUpdates=false",
  "-c",
  "fetch.unpackLimit=1",
] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Builds a fresh `<workspace>/.git` for a history run (#536) from the control plane's git dir,
 * which wardby made and fully trusts: `git init` with no templates (so no sample hooks), the fixed
 * WORKER_GIT_CONFIG, one local fetch of `head` as `refs/heads/<headRef>` and of each remote's commit
 * as `refs/remotes/<name>/<label>` (its shallow boundary comes with it), HEAD on the branch, the
 * index written from `head` without touching the files `read-tree --reset -u` already checked out,
 * and an `info/exclude` naming every path no run collects (gitInfoExcludeFile), so the agent's own
 * `git add -A` leaves the sandbox's files (the npm config under `.cache` among them) unstaged.
 * Nothing is ever read from the worker's side; no credential is ever involved.
 */
export async function buildWorkerGitDir(options: {
  git: GitCommandRunner;
  gitMetadataPath: string;
  workspacePath: string;
  headRef: string;
  head: string;
  remotes: readonly { name: string; label: string; commit: string }[];
  collectExclude?: readonly string[];
}): Promise<void> {
  const { gitMetadataPath, workspacePath, headRef, head, remotes } = options;
  if (!COMMIT_SHA.test(head) || remotes.some((remote) => !COMMIT_SHA.test(remote.commit))) {
    throw new Error("vcs_worker_git_invalid");
  }
  const gitDir = resolve(workspacePath, ".git");
  const git = (args: readonly string[]) =>
    options.git.run([`--git-dir=${gitDir}`, ...LOCAL_BUILD_CONFIG, ...args], { cwd: workspacePath });
  // Never an existing .git: the checked-out tree cannot hold one (git refuses the path).
  await mkdir(gitDir, { mode: 0o700 });
  await git(["init", "--quiet", "--template="]);
  await writeFile(resolve(gitDir, "config"), WORKER_GIT_CONFIG, { mode: 0o600 });
  await mkdir(resolve(gitDir, "info"), { mode: 0o700 });
  await writeFile(
    resolve(gitDir, "info", "exclude"),
    gitInfoExcludeFile(normalizeCollectExclusions(options.collectExclude)),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  const branch = `refs/heads/${headRef}`;
  const remoteRefs = remotes.map((remote) => ({ ref: `refs/remotes/${remote.name}/${remote.label}`, ...remote }));
  // --update-shallow: from a shallow source, fetch otherwise drops (with only a warning) every ref
  // whose history ends at a shallow boundary.
  await git([
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "--update-shallow",
    gitMetadataPath,
    `${head}:${branch}`,
    ...remoteRefs.map((remote) => `${remote.commit}:${remote.ref}`),
  ]);
  // The shallow boundary must come across, or the worker's history would look broken past it.
  const sourceShallow = resolve(gitMetadataPath, "shallow");
  const workerShallow = resolve(gitDir, "shallow");
  if ((await exists(sourceShallow)) && !(await exists(workerShallow))) {
    await copyFile(sourceShallow, workerShallow, fsConstants.COPYFILE_EXCL);
  }
  // Each ref is checked: fetch can skip a ref and still exit 0.
  for (const { ref, commit } of [{ ref: branch, commit: head }, ...remoteRefs]) {
    const found = (await git(["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    if (found !== commit) throw new Error("vcs_worker_git_invalid");
  }
  await git(["symbolic-ref", "HEAD", branch]);
  await git([`--work-tree=${workspacePath}`, "read-tree", head]);
}
