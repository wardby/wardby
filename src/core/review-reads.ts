/**
 * What one review run attempt has actually read of each pull request head: repo_pr_read pages
 * and repo_read_file reads at that head. repo_publish_review refuses an APPROVE or
 * CHANGES_REQUESTED that would judge a source, test or config file the run never read. A file
 * counts once its whole patch arrived, or once a contiguous chain of parts from offset 0 reached
 * its last part; one repo_read_file read of the path at the head (any window) also counts.
 * In memory for a control-plane attempt. A sandbox run's gateway rebuilds the tools for every
 * request, so it saves the ledger on the gateway session (toJSON) and restores it (fromJSON).
 * A head is gated only when the ledger saw its first page (a repo_pr_read without patchCursor),
 * so a resume whose earlier pages were replayed without reaching the handler is never refused
 * for them. An APPROVE is also refused while the latest file list seen for the head was cut by the
 * host (fileListComplete false): files past the cut were never listed, so never read.
 */
import { reviewGroup } from "../providers/review-host/patch-pages.js";
import type { PullRequestFileView, PullRequestView } from "../providers/review-host/types.js";

interface HeadReads {
  /** This attempt saw the head's first page (a repo_pr_read without patchCursor). */
  sawFirstPage: boolean;
  /** The code files in the latest file list seen for this head. */
  code: Set<string>;
  /** Files whose patch arrived in full, accumulated across pages. */
  read: Set<string>;
  /** How far each file's patch has been delivered contiguously from offset 0. */
  deliveredTo: Map<string, number>;
  /** The latest file list seen for this head was cut by the host. */
  listCut: boolean;
  /** File lists recorded for this head, so a merge keeps the newer list's listCut. */
  lists: number;
}

/** A ledger as JSON, for a sandbox run's gateway session. */
export interface ReviewReadsState {
  v: 1;
  heads: Record<
    string,
    {
      sawFirstPage: boolean;
      code: string[];
      read: string[];
      deliveredTo: Record<string, number>;
      /** Absent in a state saved before the field existed: read as false and 0. */
      listCut?: boolean;
      lists?: number;
    }
  >;
  fileReads: Record<string, string[]>;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isOffsets = (v: unknown): v is Record<string, number> =>
  !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((n) => Number.isSafeInteger(n));

export class ReviewReadLedger {
  private readonly heads = new Map<string, HeadReads>();
  /** `${repository}@${ref}` → paths read with repo_read_file at that ref. */
  private readonly fileReads = new Map<string, Set<string>>();

  /** A ledger from a saved state; a missing or malformed one (or any malformed part) starts empty. */
  static fromJSON(state: unknown): ReviewReadLedger {
    const ledger = new ReviewReadLedger();
    if (!state || typeof state !== "object") return ledger;
    const s = state as Partial<ReviewReadsState>;
    if (s.v !== 1 || !s.heads || typeof s.heads !== "object" || !s.fileReads || typeof s.fileReads !== "object") {
      return ledger;
    }
    for (const [key, head] of Object.entries(s.heads)) {
      if (
        !head ||
        typeof head.sawFirstPage !== "boolean" ||
        !isStringArray(head.code) ||
        !isStringArray(head.read) ||
        !isOffsets(head.deliveredTo) ||
        (head.listCut !== undefined && typeof head.listCut !== "boolean") ||
        (head.lists !== undefined && !Number.isSafeInteger(head.lists))
      ) {
        return new ReviewReadLedger();
      }
      ledger.heads.set(key, {
        sawFirstPage: head.sawFirstPage,
        code: new Set(head.code),
        read: new Set(head.read),
        deliveredTo: new Map(Object.entries(head.deliveredTo)),
        listCut: head.listCut ?? false,
        lists: head.lists ?? 0,
      });
    }
    for (const [key, paths] of Object.entries(s.fileReads)) {
      if (!isStringArray(paths)) return new ReviewReadLedger();
      ledger.fileReads.set(key, new Set(paths));
    }
    return ledger;
  }

  toJSON(): ReviewReadsState {
    return {
      v: 1,
      heads: Object.fromEntries(
        [...this.heads].map(([key, head]) => [
          key,
          {
            sawFirstPage: head.sawFirstPage,
            code: [...head.code],
            read: [...head.read],
            deliveredTo: Object.fromEntries(head.deliveredTo),
            listCut: head.listCut,
            lists: head.lists,
          },
        ]),
      ),
      fileReads: Object.fromEntries([...this.fileReads].map(([key, paths]) => [key, [...paths]])),
    };
  }

  /**
   * Adds what `other` has read. Reads only ever add, so two requests that each read something
   * (a sandbox run's parallel tool calls) merge without losing either.
   */
  merge(other: ReviewReadLedger): void {
    for (const [key, theirs] of other.heads) {
      const mine = this.heads.get(key);
      if (!mine) {
        this.heads.set(key, {
          sawFirstPage: theirs.sawFirstPage,
          code: new Set(theirs.code),
          read: new Set(theirs.read),
          deliveredTo: new Map(theirs.deliveredTo),
          listCut: theirs.listCut,
          lists: theirs.lists,
        });
        continue;
      }
      // The newer list decides; two lists recorded side by side (the same count) keep a cut.
      if (theirs.lists > mine.lists) mine.listCut = theirs.listCut;
      else if (theirs.lists === mine.lists) mine.listCut ||= theirs.listCut;
      mine.lists = Math.max(mine.lists, theirs.lists);
      mine.sawFirstPage ||= theirs.sawFirstPage;
      for (const path of theirs.code) mine.code.add(path);
      for (const path of theirs.read) mine.read.add(path);
      for (const [path, to] of theirs.deliveredTo) {
        mine.deliveredTo.set(path, Math.max(mine.deliveredTo.get(path) ?? 0, to));
      }
    }
    for (const [key, paths] of other.fileReads) {
      const mine = this.fileReads.get(key) ?? new Set<string>();
      for (const path of paths) mine.add(path);
      this.fileReads.set(key, mine);
    }
  }

  private headKey(repository: string, prNumber: number, headSha: string): string {
    return `${repository.toLowerCase()}#${prNumber}@${headSha}`;
  }

  /** `withCursor`: the page was requested with a patchCursor (not the chain's first page). */
  recordPage(repository: string, prNumber: number, view: PullRequestView, withCursor: boolean): void {
    const key = this.headKey(repository, prNumber, view.headSha);
    const head = this.heads.get(key) ?? {
      sawFirstPage: false,
      code: new Set<string>(),
      read: new Set<string>(),
      deliveredTo: new Map<string, number>(),
      listCut: false,
      lists: 0,
    };
    if (!withCursor) head.sawFirstPage = true;
    head.listCut = view.fileListComplete === false;
    head.lists += 1;
    // A removed file has nothing to read at the head (repo_read_file is not_found), so it is never gated.
    head.code = new Set(
      view.files.filter((f) => f.status !== "removed" && reviewGroup(f.filename) === "code").map((f) => f.filename),
    );
    for (const file of view.files) this.recordFile(head, file);
    this.heads.set(key, head);
  }

  private recordFile(head: HeadReads, file: PullRequestFileView): void {
    if (file.patchStatus === "complete" || file.patchStatus === "empty") {
      head.read.add(file.filename);
      return;
    }
    if (file.patchStatus !== "partial" || file.patchOffset === undefined) return;
    // A part counts only where it joins what was already delivered, so a cursor pointing past
    // undelivered text (forged or not) never marks the file read.
    const deliveredTo = head.deliveredTo.get(file.filename) ?? 0;
    if (file.patchOffset > deliveredTo) return;
    head.deliveredTo.set(file.filename, Math.max(deliveredTo, file.patchOffset + file.patch.length));
    if (file.patchContinues === false) head.read.add(file.filename);
  }

  recordFileRead(repository: string, ref: string | undefined, path: string): void {
    if (!ref) return;
    const key = `${repository.toLowerCase()}@${ref}`;
    const paths = this.fileReads.get(key) ?? new Set<string>();
    paths.add(path);
    this.fileReads.set(key, paths);
  }

  /** Code files of this head not yet read, or null when this attempt never saw the head's first page. */
  unreadCode(repository: string, prNumber: number, headSha: string): string[] | null {
    const head = this.heads.get(this.headKey(repository, prNumber, headSha));
    if (!head?.sawFirstPage) return null;
    const viaFile = this.fileReads.get(`${repository.toLowerCase()}@${headSha}`) ?? new Set<string>();
    return [...head.code].filter((path) => !head.read.has(path) && !viaFile.has(path));
  }

  /** The latest file list this attempt saw for the head was cut by the host (false when it never saw the first page). */
  fileListCut(repository: string, prNumber: number, headSha: string): boolean {
    const head = this.heads.get(this.headKey(repository, prNumber, headSha));
    return !!head?.sawFirstPage && head.listCut;
  }
}
