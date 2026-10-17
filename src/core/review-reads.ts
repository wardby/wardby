/**
 * What one review run attempt has actually read of each pull request head: repo_pr_read pages
 * (a file counts once its whole patch, or its last part, arrived) and repo_read_file reads at
 * that head. repo_publish_review refuses an APPROVE or CHANGES_REQUESTED that would judge a
 * source, test or config file the run never read. One repo_read_file read of the path at the head
 * (any window) counts. Per attempt and in memory only: a resumed attempt
 * starts empty, and a head it has no file list for is not gated.
 */
import { reviewGroup } from "../providers/review-host/patch-pages.js";
import type { PullRequestFileView, PullRequestView } from "../providers/review-host/types.js";

interface HeadReads {
  /** The code files in the latest file list seen for this head. */
  code: Set<string>;
  /** Files whose patch arrived in full (or whose last part did), accumulated across pages. */
  read: Set<string>;
}

/** A page delivered this file's patch to its end. */
function finished(file: PullRequestFileView): boolean {
  return (
    file.patchStatus === "complete" ||
    file.patchStatus === "empty" ||
    (file.patchStatus === "partial" && file.patchContinues === false)
  );
}

export class ReviewReadLedger {
  private readonly heads = new Map<string, HeadReads>();
  /** `${repository}@${ref}` → paths read with repo_read_file at that ref. */
  private readonly fileReads = new Map<string, Set<string>>();

  private headKey(repository: string, prNumber: number, headSha: string): string {
    return `${repository.toLowerCase()}#${prNumber}@${headSha}`;
  }

  recordPage(repository: string, prNumber: number, view: PullRequestView): void {
    const key = this.headKey(repository, prNumber, view.headSha);
    const head = this.heads.get(key) ?? { code: new Set<string>(), read: new Set<string>() };
    // A removed file has nothing to read at the head (repo_read_file is not_found), so it is never gated.
    head.code = new Set(
      view.files.filter((f) => f.status !== "removed" && reviewGroup(f.filename) === "code").map((f) => f.filename),
    );
    for (const file of view.files) if (finished(file)) head.read.add(file.filename);
    this.heads.set(key, head);
  }

  recordFileRead(repository: string, ref: string | undefined, path: string): void {
    if (!ref) return;
    const key = `${repository.toLowerCase()}@${ref}`;
    const paths = this.fileReads.get(key) ?? new Set<string>();
    paths.add(path);
    this.fileReads.set(key, paths);
  }

  /** Code files of this head not yet read, or null when this attempt never saw the head's file list. */
  unreadCode(repository: string, prNumber: number, headSha: string): string[] | null {
    const head = this.heads.get(this.headKey(repository, prNumber, headSha));
    if (!head) return null;
    const viaFile = this.fileReads.get(`${repository.toLowerCase()}@${headSha}`) ?? new Set<string>();
    return [...head.code].filter((path) => !head.read.has(path) && !viaFile.has(path));
  }
}
