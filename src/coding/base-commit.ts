import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";

/** What a history run's task says about the workspace's git history (#536). `ref` is `<name>/<label>`. */
export interface GitHistoryWording {
  depth: number | "full";
  remotes: readonly { ref: string; commit: string }[];
}

function historyClause({ depth, remotes }: GitHistoryWording): string {
  const has = depth === "full" ? "the workspace has full history" : `the workspace has git history to depth ${depth}`;
  const remoteList = remotes.length > 0 ? `; remotes: ${remotes.map((r) => `${r.ref} at ${r.commit}`).join(", ")}` : "";
  return `${has}${remoteList}; fetching and pushing are not possible \u2014 commit your work`;
}

/**
 * The coding workspace has no git metadata, so the worker cannot learn which
 * commit it is looking at. The executor appends it to the task when it writes
 * the worker input (after cloning). Never grows a task past the limit.
 */
export function withBaseCommit(task: string, baseCommit: string, history?: GitHistoryWording): string {
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) return task;
  if (history) return withHistoryBaseCommit(task, baseCommit, history);
  const withLine = `${task}\n\nBase commit: ${baseCommit} (the commit this workspace was checked out at; the workspace has no git metadata).`;
  return byteLength(withLine) <= MAX_CODING_TASK_BYTES ? withLine : task;
}

const HISTORY_CUT_MARKER = "\n[task cut to make room for the git history note]";

/**
 * A history run's Base commit line grows with its remotes (up to ~100 bytes
 * each), beyond CODING_TASK_TRAILER_RESERVE_BYTES, which the upstream
 * truncators keep without knowing about history. So this, the last composer,
 * makes the room itself: the line is never dropped; if the task leaves too
 * little, the task is cut at a character boundary and says so. Only history
 * runs get this; the no-history path above is unchanged.
 */
function withHistoryBaseCommit(task: string, baseCommit: string, history: GitHistoryWording): string {
  const line = `\n\nBase commit: ${baseCommit} (${historyClause(history)}).`;
  if (byteLength(task) + byteLength(line) <= MAX_CODING_TASK_BYTES) return `${task}${line}`;
  const room = MAX_CODING_TASK_BYTES - byteLength(line) - byteLength(HISTORY_CUT_MARKER);
  if (room < 0) return task;
  let kept = Buffer.from(task, "utf8").subarray(0, room).toString("utf8");
  // A multi-byte character cut in half decodes to U+FFFD at the end; drop it.
  while (kept.endsWith("\uFFFD")) kept = kept.slice(0, -1);
  return `${kept}${HISTORY_CUT_MARKER}${line}`;
}

export interface ExtraRepositoryCommit {
  name: string;
  repository: string;
  access: "read" | "write";
  commit: string;
  /** The folder keeps git history (#536); only a writable extra can. */
  history?: boolean;
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
      `Extra repository /repos/${extra.name}: ${extra.repository} at ${extra.commit}, ${extra.access === "read" ? "read-only" : extra.history ? "writable, with git history" : "writable"}.`,
  );
  const withLines = `${task}\n\n${lines.join("\n")}`;
  return byteLength(withLines) <= MAX_CODING_TASK_BYTES ? withLines : task;
}
