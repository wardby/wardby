/**
 * What a continuation's agent and its pull request are told when wardby
 * merged the PR's target branch into the branch before the run started
 * (GitVcsProvider.prepareWorkspace, src/providers/vcs/git.ts). Refs and paths
 * come from the repository, so they go through the same sanitizer as a
 * protected path before they reach a task or a public comment.
 */
import { sanitizePath } from "./protected-path-wording.js";
import { byteLength, MAX_CODING_TASK_BYTES } from "./protocol.js";

/** CodingRun.failureCategory for a run that left conflict markers in a file the merge conflicted. */
export const MERGE_CONFLICT_CATEGORY = "merge_conflict";
/** CodingRun.failureCategory for a target branch that could not be fetched or merged. */
export const TARGET_MERGE_CATEGORY = "target_merge";

/** git.ts's finalizeChanges throws this when a conflicted file still holds conflict markers. */
export const CONFLICT_MARKERS_ERROR_PREFIX = "vcs_conflict_markers_remain:";
/** git.ts's prepareWorkspace throws this when the target branch cannot be fetched or merged. */
export const TARGET_MERGE_FAILED_ERROR = "vcs_target_merge_failed";

/** The most conflicted paths a task lists; the rest are counted. */
const MAX_LISTED_PATHS = 200;

function shortSha(sha: string): string {
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 7) : "";
}

function code(value: string): string {
  return `\`${sanitizePath(value) ?? "?"}\``;
}

/** The path a `vcs_conflict_markers_remain:<path>` error names, or null for any other error. */
export function conflictMarkersPathFromError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message.startsWith(CONFLICT_MARKERS_ERROR_PREFIX)) return null;
  const path = message.slice(CONFLICT_MARKERS_ERROR_PREFIX.length);
  return path.length > 0 ? path : null;
}

/** The success comment's sentence: what was merged, and how many files had conflicts to resolve. */
export function mergeSentence(merge: { ref: string; targetCommit: string; conflicts: number }): string {
  const sha = shortSha(merge.targetCommit);
  const resolved =
    merge.conflicts === 0
      ? "no conflicts"
      : `resolved conflicts in ${merge.conflicts} ${merge.conflicts === 1 ? "file" : "files"}`;
  return `Merged ${code(merge.ref)}${sha ? ` @ \`${sha}\`` : ""} into this branch; ${resolved}.`;
}

/** The failure comment's sentence for a run that left conflict markers behind. */
export function conflictMarkersSentence(path: string | null | undefined): string {
  const safe = path ? sanitizePath(path) : null;
  const named = safe ? `\`${safe}\` still has conflict markers` : "a conflicted file still has conflict markers";
  return `${named} after merging this pull request's target branch, so none of its changes were pushed. Ask again to resolve the conflicts.`;
}

function mergeNote(
  merge: { ref: string; targetCommit: string; conflictedPaths: readonly string[] },
  headRef: string,
  listed: number,
): string {
  const sha = shortSha(merge.targetCommit);
  const target = `${code(merge.ref)}${sha ? ` @ ${sha}` : ""}`;
  if (merge.conflictedPaths.length === 0) {
    return `Target branch: before you started, wardby merged ${target} (this pull request's target branch) into this branch with no conflicts. Check that the combined code still builds and its tests pass.`;
  }
  const shown = merge.conflictedPaths.slice(0, listed).map((path) => `- ${code(path)}`);
  const more = merge.conflictedPaths.length - shown.length;
  return [
    `Merge conflicts: before you started, wardby merged ${target} (this pull request's target branch) into this branch, and ${merge.conflictedPaths.length} ${merge.conflictedPaths.length === 1 ? "file conflicts" : "files conflict"}:`,
    ...shown,
    ...(more > 0 ? [`- and ${more} more`] : []),
    `In each conflict, the lines between \`<<<<<<<\` and \`=======\` are this pull request's branch (${code(headRef)}) and the lines between \`=======\` and \`>>>>>>>\` are ${code(merge.ref)}. Resolve every conflict, keeping the intent of both sides; update the tests the combination broke; then run the repository's checks. Your changes are refused while any of these files still has conflict markers. A listed file with no markers (a binary file, or one deleted on one side and changed on the other) holds one side's version, or the changed version: check it is the one to keep, and edit or delete it if not.`,
  ].join("\n");
}

/**
 * The coding task with a note on the target-branch merge appended, listing as
 * many conflicted paths as fit. Never grows a task past MAX_CODING_TASK_BYTES:
 * the list shrinks first, then the note is left out.
 */
export function withTargetMerge(
  task: string,
  merge: { ref: string; targetCommit: string; conflictedPaths: readonly string[] } | undefined,
  headRef: string,
): string {
  if (!merge) return task;
  const counts = [MAX_LISTED_PATHS, 50, 10, 0].filter(
    (count, index) => index === 0 || count < merge.conflictedPaths.length,
  );
  for (const count of counts) {
    const withNote = `${task}\n\n${mergeNote(merge, headRef, count)}`;
    if (byteLength(withNote) <= MAX_CODING_TASK_BYTES) return withNote;
  }
  return task;
}
