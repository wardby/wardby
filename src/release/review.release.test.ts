/**
 * Release invariant 3: review completeness. repo_publish_review accepts an APPROVE only when the
 * host's whole file list is known and every source, test or config file in it was read; a
 * COMMENT or CHANGES_REQUESTED is always accepted (an unfinished review blocks the merge or
 * stays neutral).
 *
 * Matrix: host (the GitHub fake api.github.com, a local repository on real git) x changed files
 * (0 to 3,000, around the page and list bounds) x verdict x read coverage (nothing, the first
 * page only, every page, the first page then repo_read_file for the rest), through the real tool
 * handlers. Then the sinceSha narrowing case (finding N1) in both run modes: a control-plane
 * attempt keeps its read ledger in memory, a sandbox run's gateway rebuilds it per request and
 * merges it into the saved one; the two must decide the same way. The installation token is
 * swept: no tool result may carry it.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleReviewHostTool, type RepositoryLink, type ReviewToolContext } from "../core/review-host-tools.js";
import { ReviewReadLedger } from "../core/review-reads.js";
import { GitHubReviewHost } from "../providers/review-host/github.js";
import {
  OLD_SHA,
  PATCH,
  PR,
  REPO,
  SHA,
  TOKEN,
  fakeGitHub,
  json,
} from "../providers/review-host/github.test-support.js";
import { LocalReviewHost } from "../providers/review-host/local.js";
import { reviewGroup } from "../providers/review-host/patch-pages.js";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { secretSweep, type SecretSweep } from "./secret-sweep.test-support.js";

const run = promisify(execFile);
const BASE = `/repos/${REPO}`;
/** Small enough that a few dozen files fill a page, so paging is exercised at every size. */
const PAGE_CHARS = 2_000;
const VERDICTS = ["APPROVE", "COMMENT", "CHANGES_REQUESTED"] as const;
type Verdict = (typeof VERDICTS)[number];
type Coverage = "none" | "first-page" | "all-pages" | "first-page-then-files";
const COVERAGES: Coverage[] = ["none", "first-page", "all-pages", "first-page-then-files"];

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

/** File i of a pull request: mostly code, every seventh a doc (never gated). */
const fileName = (i: number) => (i % 7 === 6 ? `docs/f${i}.md` : `src/f${i}.ts`);

function published(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    published: true as const,
    reviewUrl: null,
    summaryCommentUrl: "https://x/5",
    checkId: null,
    checkConclusion: null,
    inlineCount: 0,
    outsideDiffCount: 0,
    resolvedThreadIds: [],
    skippedThreadIds: [],
  }));
}

/** The real GitHub host over the fake api.github.com, serving a pull request of `total` files. */
function gitHubHost(
  total: number,
  compareFiles?: number[],
): { host: CodeReviewHost; publish: ReturnType<typeof vi.fn> } {
  const entry = (i: number) => ({
    filename: fileName(i),
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: PATCH,
  });
  const { client } = fakeGitHub(({ method, path }) => {
    if (method === "GET" && path === `${BASE}/pulls/7`) return json({ ...PR, changed_files: total });
    if (path.startsWith(`${BASE}/pulls/7/files`)) {
      const page = Number(new URL(path, "https://x").searchParams.get("page"));
      const from = (page - 1) * 100;
      return json(Array.from({ length: Math.max(0, Math.min(100, total - from)) }, (_, i) => entry(from + i)));
    }
    if (compareFiles && path.startsWith(`${BASE}/compare/${OLD_SHA}...${SHA}`)) {
      return json({ status: "ahead", files: compareFiles.map(entry), commits: [] });
    }
    if (path.startsWith(`${BASE}/contents/`)) return new Response("line one\nnew two\nline three\n");
    if (path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
    return undefined;
  });
  const host = new GitHubReviewHost(client);
  const publish = published();
  return { host: Object.assign(Object.create(host) as CodeReviewHost, { publishReview: publish }), publish };
}

const LINK: RepositoryLink = {
  provider: "github",
  repository: REPO,
  access: "write",
  checkName: null,
  waitForCi: false,
};

function contextFor(host: CodeReviewHost, link: RepositoryLink, reads: ReviewReadLedger): ReviewToolContext {
  return {
    agentId: "reviewer",
    links: [link],
    hosts: { [link.provider]: host },
    runCheck: null,
    markRunCheckCompleted: async () => undefined,
    authorize: async () => ({ ok: true as const }),
    reads,
    db: { codingRun: { findUnique: async () => null } } as unknown as ReviewToolContext["db"],
  };
}

/** One review attempt's tool calls, in a run mode: how the read ledger lives between calls. */
interface Attempt {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function controlPlaneAttempt(host: CodeReviewHost, link: RepositoryLink): Attempt {
  const ctx = contextFor(host, link, new ReviewReadLedger());
  return {
    call: async (name, args) => {
      const out = await handleReviewHostTool(name, JSON.stringify(args), ctx);
      sweep?.record(`${name} result`, out);
      return JSON.parse(out) as Record<string, unknown>;
    },
  };
}

/** As the native gateway does: rebuild the ledger from the saved state per request, then merge it back. */
function sandboxAttempt(host: CodeReviewHost, link: RepositoryLink): Attempt {
  let saved = new ReviewReadLedger().toJSON();
  return {
    call: async (name, args) => {
      const reads = ReviewReadLedger.fromJSON(saved);
      const out = await handleReviewHostTool(name, JSON.stringify(args), contextFor(host, link, reads));
      if (name === "repo_pr_read" || name === "repo_read_file") {
        const merged = ReviewReadLedger.fromJSON(saved);
        merged.merge(reads);
        saved = merged.toJSON();
      }
      sweep?.record(`${name} result`, out);
      return JSON.parse(out) as Record<string, unknown>;
    },
  };
}

interface PageView {
  headSha: string;
  files: Array<{ filename: string; patchStatus: string }>;
  fileListComplete: boolean;
  nextPatchCursor?: string | null;
}

/** Reads the pull request as `coverage` says; returns the head, the listed files and whether the list was cut. */
async function read(attempt: Attempt, repository: string, coverage: Coverage) {
  if (coverage === "none") {
    return { headSha: undefined as string | undefined, listed: [] as string[], cut: false, firstPageComplete: false };
  }
  const args = { repository, prNumber: 7, maxPatchChars: PAGE_CHARS };
  let page = (await attempt.call("repo_pr_read", args)) as unknown as PageView;
  const first = page;
  const delivered = new Set(page.files.filter((f) => f.patchStatus === "complete").map((f) => f.filename));
  if (coverage === "all-pages") {
    while (page.nextPatchCursor) {
      page = (await attempt.call("repo_pr_read", {
        ...args,
        patchCursor: page.nextPatchCursor,
      })) as unknown as PageView;
    }
  }
  if (coverage === "first-page-then-files") {
    for (const file of first.files) {
      if (reviewGroup(file.filename) !== "code" || delivered.has(file.filename)) continue;
      await attempt.call("repo_read_file", { repository, path: file.filename, ref: first.headSha });
    }
  }
  return {
    headSha: first.headSha,
    listed: first.files.map((f) => f.filename),
    cut: !first.fileListComplete,
    // Every code file's whole patch arrived on the first page.
    firstPageComplete: first.files.every((f) => reviewGroup(f.filename) !== "code" || delivered.has(f.filename)),
  };
}

async function publish(attempt: Attempt, repository: string, headSha: string, verdict: Verdict) {
  return attempt.call("repo_publish_review", {
    repository,
    prNumber: 7,
    headSha,
    verdict,
    summary: "release suite review",
    body: "Reviewed.",
  });
}

/**
 * The invariant, from what the host listed and what was read: may this verdict be accepted? An
 * APPROVE needs the whole list (not cut) and every code file in it read: by the first page alone,
 * or by reading on (every page, or repo_read_file for each code file the first page did not hold).
 */
function mayAccept(verdict: Verdict, coverage: Coverage, read: { cut: boolean; firstPageComplete: boolean }) {
  if (verdict !== "APPROVE") return true;
  if (coverage === "none" || read.cut) return false;
  return coverage === "first-page" ? read.firstPageComplete : true;
}

describe("review completeness: the GitHub host", () => {
  const COUNTS = [0, 1, 99, 100, 101, 299, 300, 301, 450, 999, 1000, 1001, 3000];

  for (const total of COUNTS) {
    it(`${total} changed files: every verdict x read coverage`, async () => {
      sweep = secretSweep(total);
      sweep.track("installation token", TOKEN);
      for (const verdict of VERDICTS) {
        for (const coverage of COVERAGES) {
          // FINDING: R2, unconfirmed (below): an attempt that never read the pull request is not gated.
          if (coverage === "none" && verdict === "APPROVE") continue;
          const { host, publish: publishSpy } = gitHubHost(total);
          const attempt = controlPlaneAttempt(host, LINK);
          const seen = await read(attempt, REPO, coverage);
          const { headSha, cut } = seen;
          const out = await publish(attempt, REPO, headSha ?? SHA, verdict);
          const accepted = !("error" in out);
          const expected = mayAccept(verdict, coverage, seen);
          expect({ verdict, coverage, accepted }).toEqual({ verdict, coverage, accepted: expected });
          expect(publishSpy).toHaveBeenCalledTimes(accepted ? 1 : 0);
          if (!accepted) expect(out.error).toBe(cut ? "file_list_truncated" : "unread_files");
          // The host lists at most 1,000 files; past that the list is cut, and no reading reaches the rest.
          if (coverage !== "none") expect(cut).toBe(total > 1000);
        }
      }
      sweep.assertClean();
    });
  }

  // FINDING: R2, unconfirmed; see regression-phase1-report.md. an attempt that never called repo_pr_read is not gated at
  // all (unreadCode is null, by design, so a resumed attempt whose earlier pages were replayed
  // without reaching the handler is not refused). So an APPROVE with nothing read is accepted.
  it.fails("an APPROVE with nothing read is refused", async () => {
    const { host } = gitHubHost(5);
    const out = await publish(controlPlaneAttempt(host, LINK), REPO, SHA, "APPROVE");
    expect(out.error).toBe("unread_files");
  });
});

describe("review completeness: sinceSha narrowing (finding N1)", () => {
  const MODES = [
    ["control plane", controlPlaneAttempt],
    ["sandbox", sandboxAttempt],
  ] as const;

  for (const [mode, attemptFor] of MODES) {
    // FINDING: N1, unconfirmed; see regression-phase1-report.md. in the control plane a
    // repo_pr_read with sinceSha replaces the head's code-file set (ReviewReadLedger.recordPage),
    // so files the full list showed but nobody read stop being gated. The sandbox merges the
    // sets, so it still refuses. Both should refuse.
    const test = mode === "control plane" ? it.fails : it;
    test(`${mode}: files the full list showed stay gated after a narrower sinceSha read`, async () => {
      for (const total of [10, 120, 450]) {
        sweep = secretSweep(total);
        sweep.track("installation token", TOKEN);
        // The compare since OLD_SHA shows only file 0.
        const { host, publish: publishSpy } = gitHubHost(total, [0]);
        const attempt = attemptFor(host, LINK);
        const first = (await attempt.call("repo_pr_read", {
          repository: REPO,
          prNumber: 7,
          maxPatchChars: 60,
        })) as unknown as PageView;
        expect(first.files.filter((f) => f.patchStatus !== "complete").length).toBeGreaterThan(0);
        await attempt.call("repo_pr_read", { repository: REPO, prNumber: 7, sinceSha: OLD_SHA });
        const out = await publish(attempt, REPO, SHA, "APPROVE");
        expect(out.error).toBe("unread_files");
        expect(publishSpy).not.toHaveBeenCalled();
        sweep.assertClean();
        sweep.dispose();
      }
    });
  }

  it("both modes decide every other read sequence the same way", async () => {
    for (const total of [0, 1, 50, 301, 1001]) {
      for (const coverage of COVERAGES.filter((c) => c !== "none")) {
        const decisions: unknown[] = [];
        for (const [, attemptFor] of MODES) {
          const { host } = gitHubHost(total);
          const attempt = attemptFor(host, LINK);
          const { headSha } = await read(attempt, REPO, coverage);
          const out = await publish(attempt, REPO, headSha ?? SHA, "APPROVE");
          decisions.push(out.error ?? "accepted");
        }
        expect({ total, coverage, sandbox: decisions[1] }).toEqual({ total, coverage, sandbox: decisions[0] });
      }
    }
  });
});

describe("review completeness: a local repository", () => {
  const COUNTS = [0, 1, 40, 1000, 1001, 3000];
  let base: string;
  let repoPath: string;
  const branchOf = (total: number) => `pr-${total}`;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "wardby-release-review-")));
    repoPath = join(base, "root", "repo");
    await mkdir(repoPath, { recursive: true });
    const git = (...args: string[]) =>
      run("git", ["-C", repoPath, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
        maxBuffer: 64 * 1024 * 1024,
      });
    await git("init", "--initial-branch=main");
    await writeFile(join(repoPath, "README.md"), "base\n");
    await git("add", "-A");
    await git("commit", "-m", "base");
    for (const total of COUNTS) {
      await git("checkout", "-q", "-b", branchOf(total), "main");
      await mkdir(join(repoPath, "src"), { recursive: true });
      await mkdir(join(repoPath, "docs"), { recursive: true });
      await Promise.all(Array.from({ length: total }, (_, i) => writeFile(join(repoPath, fileName(i)), `line ${i}\n`)));
      await git("add", "-A");
      await git("commit", "-q", "--allow-empty", "-m", `pr of ${total}`);
    }
    await git("checkout", "-q", "main");
  }, 120_000);

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function localHost(total: number): { host: CodeReviewHost; link: RepositoryLink; publish: ReturnType<typeof vi.fn> } {
    const repository = `local:${repoPath}`;
    const row = { id: `pr-${total}`, number: 7, repository, branch: branchOf(total), base: "main" };
    const db = {
      localPullRequest: { findUnique: async () => row },
      localReview: { findFirst: async () => null },
    };
    const real = new LocalReviewHost({ db: db as never, roots: () => [join(base, "root")] });
    const publishSpy = published();
    return {
      host: Object.assign(Object.create(real) as CodeReviewHost, { publishReview: publishSpy }),
      link: { provider: "local", repository, access: "write", checkName: null, waitForCi: false },
      publish: publishSpy,
    };
  }

  for (const total of COUNTS) {
    it(`${total} changed files: an APPROVE needs the whole list, every code file read`, async () => {
      for (const coverage of COVERAGES.filter((c) => c !== "none")) {
        // Reading every page or file of thousands of files spawns a git diff per file: the list
        // bound (1,000) is what matters past it, and the first page shows it.
        if (total >= 1000 && coverage !== "first-page") continue;
        const { host, link, publish: publishSpy } = localHost(total);
        const attempt = controlPlaneAttempt(host, link);
        const seen = await read(attempt, link.repository, coverage);
        expect(seen.cut).toBe(total > 1000);
        for (const verdict of VERDICTS) {
          publishSpy.mockClear();
          const out = await publish(attempt, link.repository, seen.headSha!, verdict);
          const expected = mayAccept(verdict, coverage, seen);
          expect({ total, coverage, verdict, accepted: !("error" in out) }).toEqual({
            total,
            coverage,
            verdict,
            accepted: expected,
          });
          expect(publishSpy).toHaveBeenCalledTimes(expected ? 1 : 0);
          if (!expected) expect(out.error).toBe(seen.cut ? "file_list_truncated" : "unread_files");
        }
      }
    }, 60_000);
  }
});
