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
import { lstat, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateMaterializedWorkspace } from "./docker.js";

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
