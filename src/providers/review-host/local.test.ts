/** LocalReviewHost against a real git repository and real PostgreSQL. Skipped without DATABASE_URL. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { handleReviewHostTool, type RepositoryLink } from "../../core/review-host-tools.js";
import { LocalReviewHost } from "./local.js";
import { ReviewHostError } from "./types.js";

const run = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return stdout.trim();
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof ReviewHostError ? err.code : `other:${String(err)}`;
  }
  return undefined;
}

describe.skipIf(!process.env.DATABASE_URL)("LocalReviewHost (database)", () => {
  const db = createPrismaClient();
  let base: string;
  let root: string;
  let repoPath: string;
  let repository: string;
  let firstSha: string;
  let headSha: string;
  let prNumber: number;
  let badPrNumber: number;
  const prIds: string[] = [];
  let roots: string[] = [];
  let host: LocalReviewHost;

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "wardby-local-review-")));
    root = join(base, "root");
    repoPath = join(root, "repo");
    await mkdir(join(repoPath, "node_modules", "x"), { recursive: true });
    await run("git", ["init", "--initial-branch=main", repoPath]);
    await writeFile(join(repoPath, "a.txt"), "one\ntwo\nthree\n");
    await writeFile(join(repoPath, "b.txt"), "bee\n");
    await writeFile(join(repoPath, "node_modules", "x", "index.js"), "x\n");
    await writeFile(join(repoPath, "package-lock.json"), "{}\n");
    await git(repoPath, "add", "-A", "-f");
    await git(repoPath, "commit", "-m", "base");
    await git(repoPath, "checkout", "-b", "feature");
    await writeFile(join(repoPath, "a.txt"), "one\nTWO\nthree\n");
    await git(repoPath, "commit", "-am", "edit a");
    firstSha = await git(repoPath, "rev-parse", "HEAD");
    await mkdir(join(repoPath, "src"));
    await writeFile(join(repoPath, "src", "c.txt"), "sea\n");
    await git(repoPath, "add", "src/c.txt");
    await git(repoPath, "commit", "-m", "add c");
    headSha = await git(repoPath, "rev-parse", "HEAD");
    // An uncommitted edit in the source working tree must never be read.
    await writeFile(join(repoPath, "a.txt"), "WORKING TREE\n");

    roots = [root];
    repository = `local:${repoPath}`;
    host = new LocalReviewHost({ db, roots: () => roots });
    const pr = await db.localPullRequest.create({ data: { repository, branch: "feature", base: "main" } });
    prIds.push(pr.id);
    prNumber = pr.number;
    const bad = await db.localPullRequest.create({ data: { repository, branch: "-x", base: "main" } });
    prIds.push(bad.id);
    badPrNumber = bad.number;
  });

  afterAll(async () => {
    await db.localPullRequest.deleteMany({ where: { id: { in: prIds } } });
    await db.$disconnect();
    await rm(base, { recursive: true, force: true });
  });

  it("reads both files of a two-commit branch, with patches", async () => {
    const view = await host.readPullRequest(repository, prNumber, { maxPatchChars: 60_000, agentMarker: "agent-x" });
    expect(view).toMatchObject({
      number: prNumber,
      state: "open",
      merged: false,
      draft: false,
      baseRef: "main",
      headRef: "feature",
      headSha,
      isFork: false,
      comparedFrom: null,
      baseMergedSince: false,
      openThreads: [],
      lastReviewedSha: null,
    });
    expect(view.files.map((f) => [f.filename, f.status, f.additions, f.deletions])).toEqual([
      ["a.txt", "modified", 1, 1],
      ["src/c.txt", "added", 1, 0],
    ]);
    expect(view.files[0].patch).toMatch(/^@@ .*\n one\n-two\n\+TWO\n three/);
    expect(view.files[0].patchTruncated).toBe(false);
    expect(view.files[1].patch).toContain("+sea");
    expect(view.ci).toMatchObject({ headSha, state: "none", checks: [] });
  });

  it("flags truncated patches once the shared budget runs out", async () => {
    const view = await host.readPullRequest(repository, prNumber, { maxPatchChars: 10, agentMarker: "agent-x" });
    expect(view.files[0].patch).toHaveLength(10);
    expect(view.files[0].patchTruncated).toBe(true);
    expect(view.files[1].patch).toBe("");
    expect(view.files[1].patchTruncated).toBe(true);
  });

  it("compares from sinceSha", async () => {
    const view = await host.readPullRequest(repository, prNumber, {
      sinceSha: firstSha,
      maxPatchChars: 60_000,
      agentMarker: "agent-x",
    });
    expect(view.comparedFrom).toBe(firstSha);
    expect(view.files.map((f) => f.filename)).toEqual(["src/c.txt"]);
  });

  it("refuses a pull request of another repository, an unknown number, and an unsafe branch name", async () => {
    await mkdir(join(root, "other"));
    await run("git", ["init", "--initial-branch=main", join(root, "other")]);
    const opts = { maxPatchChars: 100, agentMarker: "a" };
    expect(await codeOf(host.readPullRequest(`local:${join(root, "other")}`, prNumber, opts))).toBe("host_api_error");
    expect(await codeOf(host.readPullRequest(repository, 999_999_999, opts))).toBe("host_api_error");
    expect(await codeOf(host.readPullRequest(repository, badPrNumber, opts))).toBe("host_api_error");
  });

  it("refuses a repository outside the current roots", async () => {
    roots = [join(base, "elsewhere")];
    try {
      expect(await codeOf(host.readFile(repository, "a.txt", "feature", { startLine: 1, maxLines: 10 }))).toBe(
        "host_api_error",
      );
    } finally {
      roots = [root];
    }
  });

  it("reads a file at the branch, never the working tree", async () => {
    const read = await host.readFile(repository, "a.txt", "feature", { startLine: 1, maxLines: 400 });
    expect(read).toMatchObject({ kind: "file", path: "a.txt", ref: "feature", totalLines: 4, truncated: false });
    expect(read.kind === "file" && read.text).toBe("one\nTWO\nthree\n");
    expect(read.kind === "file" && read.content).toContain("2: TWO");
    const atSha = await host.readFile(repository, "a.txt", firstSha, { startLine: 2, maxLines: 1 });
    expect(atSha).toMatchObject({ kind: "file", startLine: 2, endLine: 2, truncated: true, text: "TWO" });
    const atDefault = await host.readFile(repository, "a.txt", undefined, { startLine: 1, maxLines: 10 });
    expect(atDefault.kind === "file" && atDefault.text).toBe("one\nTWO\nthree\n");
    expect(await host.readFile(repository, "src", "feature", { startLine: 1, maxLines: 10 })).toEqual({
      kind: "directory",
      path: "src",
      entries: ["file src/c.txt"],
    });
    expect(await host.readFile(repository, "nope.txt", "feature", { startLine: 1, maxLines: 10 })).toEqual({
      kind: "not_found",
      path: "nope.txt",
    });
  });

  it("rejects traversal, absolute and NUL paths, and option-like or malformed refs", async () => {
    const w = { startLine: 1, maxLines: 10 };
    for (const path of ["../a.txt", "src/../../x", "/etc/passwd", "a\0b"]) {
      expect(await codeOf(host.readFile(repository, path, "feature", w))).toBe("host_api_error");
    }
    for (const ref of ["--output=/tmp/x", "-x", "feature..main", "a b", "@{-1}", "HEAD:a.txt"]) {
      expect(await codeOf(host.readFile(repository, "a.txt", ref, w))).toBe("host_api_error");
      expect(await codeOf(host.listFiles(repository, ref))).toBe("host_api_error");
    }
  });

  it("lists files at a ref, skipping vendored paths and lockfiles", async () => {
    const list = await host.listFiles(repository, "feature");
    expect(list.paths).toEqual(["a.txt", "b.txt", "src/c.txt"]);
    expect(list.files[0]).toBe("a.txt (14 bytes)");
    expect(list).toMatchObject({ ref: "feature", count: 3, truncated: false });
    expect((await host.listFiles(repository, "feature", "src/")).paths).toEqual(["src/c.txt"]);
  });

  it("publishes a review row, records lastReviewedSha, and refuses a stale head", async () => {
    const input = {
      prNumber,
      headSha,
      verdict: "CHANGES_REQUESTED" as const,
      summary: "needs work",
      body: "details",
      comments: [{ path: "a.txt", line: 2, side: "RIGHT" as const, severity: "MAJOR", body: "why caps" }],
      agentMarker: "agent-pub",
    };
    const result = await host.publishReview(repository, input);
    expect(result).toMatchObject({ published: true, inlineCount: 1, checkId: null, checkConclusion: "failure" });
    const rows = await db.localReview.findMany({ where: { pullRequest: { number: prNumber }, agentId: "agent-pub" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ headSha, verdict: "CHANGES_REQUESTED", summary: "needs work", body: "details" });
    expect(rows[0].comments).toEqual(input.comments);

    const view = await host.readPullRequest(repository, prNumber, { maxPatchChars: 100, agentMarker: "agent-pub" });
    expect(view.lastReviewedSha).toBe(headSha);

    const stale = await host.publishReview(repository, { ...input, headSha: firstSha });
    expect(stale).toEqual({ published: false, reason: "stale_head", currentHeadSha: headSha });
    expect(await db.localReview.count({ where: { pullRequest: { number: prNumber }, agentId: "agent-pub" } })).toBe(1);
  });

  it("stores a comment as a COMMENT review and answers the no-op surface", async () => {
    const { id, url } = await host.comment(repository, { number: prNumber, body: "hello" });
    const row = await db.localReview.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ verdict: "COMMENT", body: "hello", headSha, comments: [] });
    expect(url).toMatch(/^wardby:\/\//);
    expect(await host.repositoryPermission(repository, { id: "1", login: "x" })).toEqual({
      level: "admin",
      login: "local",
    });
    expect(await host.startCheck(repository, { headSha, name: "n" })).toEqual({ checkId: "local" });
    expect(await host.pullRequestHead(repository, prNumber)).toEqual({ headSha, isFork: false, state: "open" });
  });

  it("publishes through repo_publish_review on a local link", async () => {
    const link: RepositoryLink = { provider: "local", repository, access: "write", checkName: null, waitForCi: false };
    const out = await handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({ repository, prNumber, headSha, verdict: "APPROVE", summary: "lgtm", body: "fine" }),
      {
        agentId: "agent-tool",
        links: [link],
        hosts: { local: host },
        runCheck: null,
        markRunCheckCompleted: vi.fn(async () => undefined),
        authorize: vi.fn(async () => ({ ok: true as const })),
        db,
      },
    );
    expect(JSON.parse(out)).toMatchObject({ published: true });
    expect(
      await db.localReview.count({
        where: { pullRequest: { number: prNumber }, agentId: "agent-tool", verdict: "APPROVE" },
      }),
    ).toBe(1);
  });
});
