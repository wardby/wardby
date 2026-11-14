/**
 * Replaces a trusted workspace directory with a freshly filled copy, shared by
 * the Docker and Kubernetes launchers. The copy is filled into a staging
 * directory beside the destination, validated, and only then swapped into
 * place by rename, with the original restored if the swap fails.
 *
 * A fill that rejects has, by definition, produced an untrusted tree (it may
 * contain escaping symlinks): it is never walked, validated, or renamed — the
 * staging directory is removed with `rm({ recursive, force })`, which unlinks
 * symlinks rather than following them.
 */
import { copyFile, lstat, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateMaterializedWorkspace } from "./docker.js";
import type { MaterializeWorkspaceOptions } from "./types.js";

/** The result bundle a history run's worker writes inside the repository's `.git` (#536). */
export const RESULT_BUNDLE_FILE = "wardby-result.bundle";

/** Fills a fresh staging directory next to `destination`, validates it, then atomically swaps it into place. */
export async function replaceDirectoryFromStaging(
  destination: string,
  maxBytes: number,
  destinationInvalidError: string,
  fill: (staging: string) => Promise<void>,
): Promise<void> {
  const target = resolve(destination);
  const parent = dirname(target);
  const [parentReal, targetReal, targetStat] = await Promise.all([realpath(parent), realpath(target), lstat(target)]);
  if (
    !targetStat.isDirectory() ||
    targetStat.isSymbolicLink() ||
    targetReal !== resolve(parentReal, target.slice(parent.length + 1))
  ) {
    throw new Error(destinationInvalidError);
  }

  const staging = await mkdtemp(join(parentReal, ".wardby-workspace-stage-"));
  const backup = await mkdtemp(join(parentReal, ".wardby-workspace-backup-"));
  await rm(backup, { recursive: true });
  let targetMoved = false;
  try {
    await fill(staging);
    await validateMaterializedWorkspace(staging, maxBytes);
    await rename(targetReal, backup);
    targetMoved = true;
    await rename(staging, targetReal);
    targetMoved = false;
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (targetMoved) await rename(backup, targetReal).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
  }
}

/**
 * For a history run (#536): takes `<workspace>/.git/wardby-result.bundle` to the trusted
 * `bundleDestination` and drops the root `.git`, so validation never sees it. Untrusted input: only a
 * regular file inside a real `.git` folder is taken; a symlink (the bundle or `.git` itself), a folder
 * or a special file is never followed and means no bundle. A bundle over `maxBundleBytes` raises
 * `vcs_result_bundle_too_large`. `workspace` is a trusted staging copy nothing else writes to.
 */
export async function takeResultBundle(
  workspace: string,
  gitHistory: NonNullable<MaterializeWorkspaceOptions["gitHistory"]>,
): Promise<boolean> {
  const { bundleDestination, maxBundleBytes } = gitHistory;
  if (!Number.isSafeInteger(maxBundleBytes) || maxBundleBytes <= 0) throw new Error("job_result_bundle_limit_invalid");
  const gitDir = join(workspace, ".git");
  const git = await lstat(gitDir).catch(() => undefined);
  let taken = false;
  if (git?.isDirectory()) {
    const bundle = join(gitDir, RESULT_BUNDLE_FILE);
    const metadata = await lstat(bundle).catch(() => undefined);
    if (metadata?.isFile()) {
      if (metadata.size > maxBundleBytes) throw new Error("vcs_result_bundle_too_large");
      try {
        await rename(bundle, bundleDestination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await copyFile(bundle, bundleDestination);
        await rm(bundle, { force: true });
      }
      taken = true;
    }
  }
  // rm never follows a symlink: a linked .git is unlinked, not its target.
  if (git) await rm(gitDir, { recursive: true, force: true });
  return taken;
}
