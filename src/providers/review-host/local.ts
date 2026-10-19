/**
 * CodeReviewHost over local git repositories (`local:/abs/path`). A "pull
 * request" is a LocalPullRequest row: a branch compared against a base in the
 * repository, keyed by a durable number. Reviews and comments are stored as
 * LocalReview rows; checks, reactions and threads are no-ops.
 *
 * Every read goes through git objects (`cat-file`, `ls-tree`, `diff A B`),
 * never the working tree, in the canonical repository path that
 * resolveLocalRepository returns at call time (the trusted roots can change).
 * git runs with GIT_* stripped, hooks and fsmonitor off, no external diff or
 * textconv drivers, and literal pathspecs. Every ref from the model or a row
 * is checked before it reaches git (a 40-hex sha, or a branch name that
 * `git check-ref-format --branch` accepts and that cannot read as an option),
 * and revisions follow `--end-of-options`.
 */
import type { PrismaClient } from "#prisma";
import {
  LocalRepoError,
  loadLocalRepoRoots,
  normalizeLocalRepository,
  resolveLocalRepository,
} from "../../coding/local-repo.js";
import { SHA, isSafeRefName, isSafeRepoPath, localGit as git } from "../../coding/local-git.js";
import { skippedInListing } from "./github.js";
import { pagePatches } from "./patch-pages.js";
import { verdictConclusion } from "./review-format.js";
import {
  ReviewHostError,
  type CodeReviewHost,
  type CommentInput,
  type AcknowledgeOutcome,
  type CommentRef,
  type CompleteCheckInput,
  type EditCommentInput,
  type FileListView,
  type FileReadResult,
  type HostPermission,
  type HostUser,
  type PublishReviewInput,
  type PublishReviewResult,
  type PullRequestHead,
  type PullRequestView,
  type StartCheckInput,
} from "./types.js";

/** A pull request's file list is cut at this many files (as GitHub's host bounds its paging). */
const MAX_PR_FILES = 1000;
const MAX_LISTED_FILES = 1000;
const MAX_BODY_CHARS = 8000;
const MAX_LOGGED_COMMITS = 100;
const MAX_PG_INT = 2_147_483_647;

const STATUS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "changed",
};

type Db = Pick<PrismaClient, "localPullRequest" | "localReview">;
type PullRequestRow = {
  id: string;
  number: number;
  repository: string;
  branch: string;
  base: string;
  runId: string | null;
};
type ChangedFile = {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
};

export interface LocalReviewHostOptions {
  db: Db;
  /** Trusted roots, read at each call (default: LOCAL_REPO_ROOTS). */
  roots?: () => readonly string[];
}

function fail(message: string): never {
  throw new ReviewHostError("host_api_error", message);
}

function assertRepoPath(path: string): void {
  if (!isSafeRepoPath(path)) fail("path_invalid");
}

function prUrl(row: PullRequestRow): string {
  return row.runId ? `wardby://runs/${row.runId}/review` : `wardby://local-pulls/${row.number}`;
}

/** Hunks only, as GitHub's `patch` field: the `diff --git`/index/---/+++ header is dropped, no trailing newline. */
function hunks(diff: string): string {
  const start = diff.startsWith("@@") ? 0 : diff.indexOf("\n@@") + 1;
  // indexOf -1 + 1 = 0 without a leading "@@": no hunks (binary, mode or pure rename).
  if (start === 0 && !diff.startsWith("@@")) return "";
  return diff.slice(start).replace(/\n$/, "");
}

function tooLarge(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

export class LocalReviewHost implements CodeReviewHost {
  readonly provider = "local" as const;
  private readonly db: Db;
  private readonly roots: () => readonly string[];

  constructor(options: LocalReviewHostOptions) {
    this.db = options.db;
    this.roots = options.roots ?? (() => loadLocalRepoRoots(process.env).roots);
  }

  /** The canonical repository and its realpath, checked against the current roots. */
  private async repo(repository: string): Promise<{ repository: string; path: string }> {
    try {
      return await resolveLocalRepository(repository, this.roots());
    } catch (err) {
      fail(err instanceof LocalRepoError ? err.code : "local_repo_invalid");
    }
  }

  private async pullRequest(canonical: string, requested: string, number: number): Promise<PullRequestRow> {
    const row =
      Number.isSafeInteger(number) && number > 0 && number <= MAX_PG_INT
        ? await this.db.localPullRequest.findUnique({ where: { number } })
        : null;
    if (!row || (row.repository !== canonical && row.repository !== normalizeLocalRepository(requested))) {
      fail("no such local pull request");
    }
    return row;
  }

  /** Rejects anything but a plain branch/tag name before it can reach git as a revision or an option. */
  private async assertRefName(dir: string, name: string): Promise<void> {
    if (!(await isSafeRefName(dir, name))) fail("ref_invalid");
  }

  /** The commit a sha or branch name points at. */
  private async commitOf(dir: string, ref: string): Promise<string> {
    if (!SHA.test(ref)) await this.assertRefName(dir, ref);
    let out: string;
    try {
      out = await git(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], 64 * 1024);
    } catch {
      fail("local_ref_not_found");
    }
    const sha = out.trim();
    if (!SHA.test(sha)) fail("local_ref_not_found");
    return sha;
  }

  /** The repository's checked-out HEAD commit (its "default branch"), and a label for it. */
  private async defaultRef(dir: string): Promise<{ sha: string; label: string }> {
    let label = "HEAD";
    try {
      label = (await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"], 64 * 1024)).trim() || "HEAD";
    } catch {
      // detached HEAD
    }
    let sha: string;
    try {
      sha = (await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], 64 * 1024)).trim();
    } catch {
      fail("local_ref_not_found");
    }
    if (!SHA.test(sha)) fail("local_ref_not_found");
    return { sha, label };
  }

  private async resolveRef(dir: string, ref: string | undefined): Promise<{ sha: string; label: string }> {
    return ref === undefined ? this.defaultRef(dir) : { sha: await this.commitOf(dir, ref), label: ref };
  }

  private async isAncestor(dir: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await git(dir, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant], 64 * 1024);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Files changed between two commits (both 40-hex), with rename detection, in git's order, at
   * most MAX_PR_FILES of them; `complete` is false when the list was cut.
   */
  private async changedFiles(
    dir: string,
    from: string,
    to: string,
  ): Promise<{ files: ChangedFile[]; complete: boolean }> {
    const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", "-z"];
    let nameStatus: string;
    let numstat: string;
    try {
      nameStatus = await git(dir, [...diff, "--name-status", "--end-of-options", from, to]);
      numstat = await git(dir, [...diff, "--numstat", "--end-of-options", from, to]);
    } catch {
      fail("local_git_failed");
    }
    const counts = new Map<string, { additions: number; deletions: number }>();
    const n = numstat.split("\0");
    for (let i = 0; i < n.length && n[i] !== "";) {
      const [add, del, ...rest] = n[i].split("\t");
      let path = rest.join("\t");
      if (path === "") {
        path = n[i + 2] ?? "";
        i += 3;
      } else {
        i += 1;
      }
      // Binary files show "-": GitHub reports 0 for them.
      counts.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
    }
    const files: ChangedFile[] = [];
    const s = nameStatus.split("\0");
    for (let i = 0; i < s.length && s[i] !== "";) {
      const code = s[i].charAt(0);
      let filename: string;
      let previousFilename: string | undefined;
      if (code === "R" || code === "C") {
        previousFilename = s[i + 1];
        filename = s[i + 2] ?? "";
        i += 3;
      } else {
        filename = s[i + 1] ?? "";
        i += 2;
      }
      files.push({
        filename,
        ...(previousFilename !== undefined ? { previousFilename } : {}),
        status: STATUS[code] ?? "changed",
        ...(counts.get(filename) ?? { additions: 0, deletions: 0 }),
      });
    }
    return { files: files.slice(0, MAX_PR_FILES), complete: files.length <= MAX_PR_FILES };
  }

  /** Pages patches like GitHub (patch-pages.ts); a diff is run only for files on the page. */
  private async withPatches(
    dir: string,
    from: string,
    to: string,
    files: ChangedFile[],
    opts: { maxPatchChars: number; patchCursor?: string; headSha: string; comparedFrom: string | null },
  ) {
    return pagePatches(
      files.map((f) => ({ ...f, changes: f.additions + f.deletions })),
      {
        budget: opts.maxPatchChars,
        cursor: opts.patchCursor,
        headSha: opts.headSha,
        comparedFrom: opts.comparedFrom,
      },
      async (file) => {
        const paths = file.previousFilename ? [file.previousFilename, file.filename] : [file.filename];
        try {
          return hunks(
            await git(dir, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-color",
              "-M",
              "--end-of-options",
              from,
              to,
              "--",
              ...paths,
            ]),
          );
        } catch {
          // Too large for the buffer (or unreadable): no patch (unavailable when it has changes).
          return undefined;
        }
      },
    );
  }

  async repositoryPermission(_repository: string, _user: HostUser): Promise<{ level: HostPermission; login: string }> {
    return { level: "admin", login: "local" };
  }

  async readPullRequest(
    repository: string,
    prNumber: number,
    opts: { sinceSha?: string; maxPatchChars: number; agentMarker: string; patchCursor?: string },
  ): Promise<PullRequestView> {
    const { repository: canonical, path: dir } = await this.repo(repository);
    const row = await this.pullRequest(canonical, repository, prNumber);
    const headSha = await this.commitOf(dir, row.branch);
    const baseTip = await this.commitOf(dir, row.base);
    let baseSha: string;
    try {
      baseSha = (await git(dir, ["merge-base", "--end-of-options", baseTip, headSha], 64 * 1024)).trim();
    } catch {
      fail("no common ancestor between the branch and its base");
    }
    if (!SHA.test(baseSha)) fail("no common ancestor between the branch and its base");

    let from = baseSha;
    let files: ChangedFile[] | null = null;
    let fileListComplete = true;
    let comparedFrom: string | null = null;
    let baseMergedSince = false;
    const since = opts.sinceSha;
    if (since && SHA.test(since) && since !== headSha && (await this.isAncestor(dir, since, headSha))) {
      comparedFrom = since;
      ({ files, complete: fileListComplete } = await this.changedFiles(dir, since, headSha));
      from = since;
      let merges = "0";
      try {
        merges = await git(dir, ["rev-list", "--count", "--min-parents=2", "--end-of-options", `${since}..${headSha}`]);
      } catch {
        fail("local_git_failed");
      }
      baseMergedSince = Number(merges.trim()) > 0;
      if (baseMergedSince) {
        // As on GitHub: the PR's own diff against its base, limited to files that changed since.
        const changedSince = new Set(files.map((f) => f.filename));
        const all = await this.changedFiles(dir, baseSha, headSha);
        files = all.files.filter((f) => changedSince.has(f.filename));
        fileListComplete &&= all.complete;
        from = baseSha;
      }
    }
    if (!files) ({ files, complete: fileListComplete } = await this.changedFiles(dir, baseSha, headSha));

    let log = "";
    try {
      log = await git(dir, [
        "log",
        "--no-color",
        `--max-count=${MAX_LOGGED_COMMITS}`,
        "--format=- %h %s",
        "--end-of-options",
        `${baseSha}..${headSha}`,
      ]);
    } catch {
      // The commit list is a courtesy; the diff is the review.
    }

    const page = await this.withPatches(dir, from, headSha, files, {
      maxPatchChars: opts.maxPatchChars,
      patchCursor: opts.patchCursor,
      headSha,
      comparedFrom,
    });

    const last = await this.db.localReview.findFirst({
      where: { pullRequestId: row.id, agentId: opts.agentMarker },
      orderBy: { createdAt: "desc" },
      select: { headSha: true },
    });
    // A review that did not read every file leaves coveredSha null, so the latest covered one counts.
    const covered = await this.db.localReview.findFirst({
      where: { pullRequestId: row.id, agentId: opts.agentMarker, coveredSha: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { coveredSha: true },
    });

    return {
      number: row.number,
      title: `${row.branch} into ${row.base}`,
      body: (log.trim() ? `Commits on ${row.branch} since ${row.base}:\n${log.trimEnd()}` : "").slice(
        0,
        MAX_BODY_CHARS,
      ),
      author: null,
      state: "open",
      merged: false,
      draft: false,
      baseRef: row.base,
      headRef: row.branch,
      headSha,
      isFork: false,
      htmlUrl: prUrl(row),
      lastReviewedSha: last?.headSha ?? null,
      lastCoveredSha: covered?.coveredSha ?? null,
      comparedFrom,
      baseMergedSince,
      files: page.files,
      fileListComplete,
      patchesComplete: page.patchesComplete,
      truncatedFiles: page.truncatedFiles,
      nextPatchCursor: page.nextPatchCursor,
      remainingPatchFiles: page.remainingPatchFiles,
      openThreads: [],
      ci: { headSha, state: "none", checks: [], truncated: false, statusesUnavailable: false },
    };
  }

  async pullRequestHead(repository: string, prNumber: number): Promise<PullRequestHead> {
    const { repository: canonical, path: dir } = await this.repo(repository);
    const row = await this.pullRequest(canonical, repository, prNumber);
    return { headSha: await this.commitOf(dir, row.branch), isFork: false, state: "open" };
  }

  async readFile(
    repository: string,
    path: string,
    ref: string | undefined,
    window: { startLine: number; maxLines: number },
  ): Promise<FileReadResult> {
    assertRepoPath(path);
    const { path: dir } = await this.repo(repository);
    const { sha, label } = await this.resolveRef(dir, ref);
    const object = `${sha}:${path}`;
    let type: string;
    try {
      type = (await git(dir, ["cat-file", "-t", "--end-of-options", object], 64 * 1024)).trim();
    } catch {
      return { kind: "not_found", path };
    }
    if (type === "tree") {
      let listing: string;
      try {
        listing = await git(dir, ["ls-tree", "-z", "--end-of-options", object]);
      } catch {
        fail("local_git_failed");
      }
      const entries = listing
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => {
          const tab = entry.indexOf("\t");
          const kind = entry.slice(0, tab).split(" ")[1];
          return `${kind === "tree" ? "dir " : "file"} ${path}/${entry.slice(tab + 1)}`;
        });
      return { kind: "directory", path, entries };
    }
    if (type !== "blob") return { kind: "not_found", path };
    let text: string;
    try {
      text = await git(dir, ["cat-file", "blob", "--end-of-options", object]);
    } catch (err) {
      fail(tooLarge(err) ? "file_too_large" : "local_git_failed");
    }
    const lines = text.split("\n");
    const slice = lines.slice(window.startLine - 1, window.startLine - 1 + window.maxLines);
    return {
      kind: "file",
      path,
      ref: label,
      totalLines: lines.length,
      startLine: window.startLine,
      endLine: window.startLine + slice.length - 1,
      truncated: window.startLine - 1 + slice.length < lines.length,
      content: slice.map((line, i) => `${window.startLine + i}: ${line}`).join("\n"),
      text: slice.join("\n"),
    };
  }

  async listFiles(repository: string, ref: string | undefined, pathPrefix = ""): Promise<FileListView> {
    const { path: dir } = await this.repo(repository);
    const { sha, label } = await this.resolveRef(dir, ref);
    let listing: string;
    try {
      listing = await git(dir, ["ls-tree", "-r", "-l", "-z", "--full-tree", "--end-of-options", sha]);
    } catch {
      fail("local_git_failed");
    }
    const entries = listing
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const tab = entry.indexOf("\t");
        const [, kind, , size] = entry.slice(0, tab).split(/ +/);
        return { kind, size: Number(size) || 0, path: entry.slice(tab + 1) };
      })
      .filter((e) => e.kind === "blob" && e.path.startsWith(pathPrefix) && !skippedInListing(e.path));
    const shown = entries.slice(0, MAX_LISTED_FILES);
    return {
      ref: label,
      count: entries.length,
      truncated: entries.length > MAX_LISTED_FILES,
      files: shown.map((e) => `${e.path} (${e.size} bytes)`),
      paths: shown.map((e) => e.path),
    };
  }

  async publishReview(repository: string, input: PublishReviewInput): Promise<PublishReviewResult> {
    const { repository: canonical, path: dir } = await this.repo(repository);
    const row = await this.pullRequest(canonical, repository, input.prNumber);
    const currentHeadSha = await this.commitOf(dir, row.branch);
    if (input.headSha !== currentHeadSha) return { published: false, reason: "stale_head", currentHeadSha };
    const review = await this.db.localReview.create({
      data: {
        pullRequestId: row.id,
        agentId: input.agentMarker,
        headSha: currentHeadSha,
        coveredSha: input.coveredSha === currentHeadSha ? currentHeadSha : null,
        verdict: input.verdict,
        summary: input.summary,
        body: input.body,
        comments: input.comments.map(({ path, line, side, severity, body }) => ({ path, line, side, severity, body })),
      },
      select: { id: true },
    });
    const url = `${prUrl(row)}#${review.id}`;
    return {
      published: true,
      reviewUrl: url,
      summaryCommentUrl: url,
      checkId: input.checkId ?? null,
      checkConclusion: verdictConclusion(input.verdict),
      inlineCount: input.comments.length,
      outsideDiffCount: 0,
      resolvedThreadIds: [],
      // A local pull request has no threads to resolve.
      skippedThreadIds: [...new Set(input.resolveThreadIds ?? [])],
    };
  }

  /** Stored as a COMMENT review on the branch's current head. The host is not told who comments: agentId is "". */
  async comment(repository: string, input: CommentInput): Promise<{ url: string; id: string }> {
    const { repository: canonical, path: dir } = await this.repo(repository);
    const row = await this.pullRequest(canonical, repository, input.number);
    const headSha = await this.commitOf(dir, row.branch);
    const review = await this.db.localReview.create({
      data: {
        pullRequestId: row.id,
        agentId: "",
        headSha,
        verdict: "COMMENT",
        summary: "",
        body: input.body,
        comments: [],
      },
      select: { id: true },
    });
    return { url: `${prUrl(row)}#${review.id}`, id: review.id };
  }

  async editComment(_repository: string, _input: EditCommentInput): Promise<void> {}

  async acknowledge(_repository: string, _target: CommentRef, _outcome?: AcknowledgeOutcome): Promise<void> {}

  async startCheck(_repository: string, _input: StartCheckInput): Promise<{ checkId: string }> {
    return { checkId: "local" };
  }

  async completeCheck(_repository: string, _input: CompleteCheckInput): Promise<void> {}
}
