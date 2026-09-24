import { lstat, mkdir } from "node:fs/promises";

/**
 * Creates `path` as a private directory, or verifies an existing one is safe to
 * trust.
 *
 * `mkdir(..., { mode: 0o700 })` does nothing to a directory that already
 * exists. The coding state roots default to fixed names under the OS temp
 * directory, so on a shared host another user could create one first -- or
 * point it somewhere else with a symlink -- and then read or plant the job
 * records, workspaces and artifacts wardby keeps there. This refuses:
 *
 * - a symlink, or anything that is not a directory;
 * - a directory owned by a different user (root excepted: an operator-mounted
 *   volume is commonly root-owned);
 * - a directory any other user can write to.
 *
 * Group write is allowed, since a Kubernetes `fsGroup` volume is group-writable
 * by design and its group is chosen by the operator. Ownership and mode are not
 * checked on platforms without POSIX uids.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${path} must be a real directory, not a symlink.`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) return;
  if (metadata.uid !== uid && metadata.uid !== 0) {
    throw new Error(
      `${path} is owned by uid ${metadata.uid}, not this process (uid ${uid}). Remove it or choose another path.`,
    );
  }
  if ((metadata.mode & 0o002) !== 0) {
    throw new Error(`${path} is writable by other users. Run chmod o-w on it or choose another path.`);
  }
}
