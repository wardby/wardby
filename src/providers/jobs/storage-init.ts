import { resolve, sep } from "node:path";
import { isCodingRepositoryName, MAX_RUN_REPOSITORIES_IN_INPUT } from "../../coding/protocol.js";
import type { JobSpec } from "./types.js";

/** Where each extra repository of a run is mounted in the containers that see /workspace: /repos/<name>. */
export const REPOSITORY_MOUNT_ROOT = "/repos";

/**
 * Creates storage subdirectories owned by the run uid, before any container mounts them as a subpath
 * (otherwise Kubernetes's kubelet creates them root-owned, and Docker's fixed-folder keeper never has
 * them). Idempotent; no shell. Names are validated before this.
 */
export function storageInitScript(root: string, directories: readonly string[]): string {
  return [
    'const fs = require("node:fs");',
    `for (const name of ${JSON.stringify(directories).replaceAll(",", ", ")}) {`,
    `  const path = ${JSON.stringify(root)} + "/" + name;`,
    "  fs.mkdirSync(path, { recursive: true, mode: 0o700 });",
    "  fs.chmodSync(path, 0o700);",
    "}",
  ].join("\n");
}

/** The storage folder of each extra repository, in spec order: `repos/<name>`. */
export function repositoryStorageDirectories(spec: Pick<JobSpec, "repositories">): string[] {
  return (spec.repositories ?? []).map((r) => `repos/${r.name}`);
}

/**
 * Whether a spec's repository list is well formed: absent, or 1 to MAX_RUN_REPOSITORIES_IN_INPUT
 * entries, each a valid link name (isCodingRepositoryName) with "read" or "write" access and a
 * host path, no name twice. The host path itself is checked by the launcher, which knows the root.
 */
export function jobRepositoriesValid(spec: Pick<JobSpec, "repositories">): boolean {
  const repositories = spec.repositories;
  if (repositories === undefined) return true;
  if (!Array.isArray(repositories) || repositories.length === 0) return false;
  if (repositories.length > MAX_RUN_REPOSITORIES_IN_INPUT) return false;
  const names = new Set<string>();
  for (const entry of repositories) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Object.keys(entry).sort().join(",") !== "access,hostPath,name" ||
      typeof entry.name !== "string" ||
      !isCodingRepositoryName(entry.name) ||
      (entry.access !== "read" && entry.access !== "write") ||
      typeof entry.hostPath !== "string" ||
      entry.hostPath.length === 0 ||
      names.has(entry.name)
    ) {
      return false;
    }
    names.add(entry.name);
  }
  return true;
}

/**
 * Where the VCS prepared an extra repository's files for this run (git.ts expectedPaths), recomputed
 * by a launcher only to check a spec's hostPath against it, never to find the files. Undefined when
 * the name is not a link name or the path would leave the root.
 */
export function expectedRepositoryHostPath(workspaceRoot: string, runId: string, name: string): string | undefined {
  if (!isCodingRepositoryName(name)) return undefined;
  const root = resolve(workspaceRoot);
  const runRoot = resolve(root, runId);
  if (!runRoot.startsWith(`${root}${sep}`) || runRoot.slice(root.length + 1).includes(sep)) return undefined;
  return resolve(runRoot, "repos", name, "workspace");
}
