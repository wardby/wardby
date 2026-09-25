import { lstat, opendir, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isCollectExcluded, type CollectExclusions } from "../../coding/collect-exclude.js";

/**
 * Deletes every excluded path from a staging copy of a workspace before it is
 * validated. Walks with lstat and never descends through a symlink; `rm` removes
 * a symlink itself, not its target.
 */
export async function pruneCollectExcluded(root: string, exclusions: CollectExclusions): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const handle = await opendir(directory);
    const children: string[] = [];
    for await (const entry of handle) children.push(join(directory, entry.name));
    for (const child of children) {
      const relativePath = relative(root, child).split(sep).join("/");
      if (isCollectExcluded(relativePath, exclusions)) {
        await rm(child, { recursive: true, force: true });
        continue;
      }
      const metadata = await lstat(child);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) await visit(child);
    }
  };
  await visit(root);
}
