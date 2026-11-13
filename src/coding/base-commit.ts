import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";

/**
 * The coding workspace has no git metadata, so the worker cannot learn which
 * commit it is looking at. The executor appends it to the task when it writes
 * the worker input (after cloning). Never grows a task past the limit.
 */
export function withBaseCommit(task: string, baseCommit: string): string {
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) return task;
  const withLine = `${task}\n\nBase commit: ${baseCommit} (the commit this workspace was checked out at; the workspace has no git metadata).`;
  return byteLength(withLine) <= MAX_CODING_TASK_BYTES ? withLine : task;
}

export interface ExtraRepositoryCommit {
  name: string;
  repository: string;
  access: "read" | "write";
  commit: string;
}

/**
 * A run with extra repositories: the worker's own note shows each one's commit
 * shortened, and no folder has git metadata, so the executor appends every
 * extra's full commit to the task (a fork sync writes upstream's into its
 * marker). Unchanged without extras; never grows a task past the limit.
 */
export function withExtraRepositories(task: string, extras: readonly ExtraRepositoryCommit[]): string {
  if (extras.length === 0) return task;
  const lines = extras.map(
    (extra) =>
      `Extra repository /repos/${extra.name}: ${extra.repository} at ${extra.commit}, ${extra.access === "read" ? "read-only" : "writable"}.`,
  );
  const withLines = `${task}\n\n${lines.join("\n")}`;
  return byteLength(withLines) <= MAX_CODING_TASK_BYTES ? withLines : task;
}
