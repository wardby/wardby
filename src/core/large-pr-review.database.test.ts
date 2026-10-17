/**
 * End to end, against real PostgreSQL and a real git repository: a large local pull request is
 * read in full (code first, paged by cursor) before an APPROVE is accepted. Skipped without
 * DATABASE_URL.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LocalReviewHost } from "../providers/review-host/local.js";
import { createPrismaClient } from "./db.js";
import { handleReviewHostTool, type RepositoryLink, type ReviewToolContext } from "./review-host-tools.js";
import { ReviewReadLedger } from "./review-reads.js";

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

/** `count` characters of added lines (each line is 50 characters including its newline). */
function lines(count: number, tag: string): string {
  return (
    Array.from(
      { length: Math.ceil(count / 50) },
      (_, i) => `${tag} ${String(i).padStart(6, "0")} ${"x".repeat(33)}`,
    ).join("\n") + "\n"
  );
}

interface PageFile {
  filename: string;
  patchStatus: string;
}
interface Page {
  headSha: string;
  files: PageFile[];
  patchesComplete: boolean;
  nextPatchCursor: string | null;
}

describe.skipIf(!process.env.DATABASE_URL)("large pull request review (database)", () => {
  const db = createPrismaClient();
  let base: string;
  let root: string;
  const prIds: string[] = [];
  const host = new LocalReviewHost({ db, roots: () => [root] });

  async function makeRepo(
    name: string,
    files: Record<string, string>,
  ): Promise<{ repository: string; prNumber: number; headSha: string }> {
    const path = join(root, name);
    await mkdir(join(path, "src"), { recursive: true });
    await mkdir(join(path, "test"), { recursive: true });
    await run("git", ["init", "--initial-branch=main", path]);
    await writeFile(join(path, "src", "app.js"), "export const a = 1;\n");
    await writeFile(join(path, "test", "app.test.js"), "// base\n");
    await git(path, "add", "-A");
    await git(path, "commit", "-m", "base");
    await git(path, "checkout", "-b", "big");
    await writeFile(join(path, "src", "app.js"), "export const a = 2;\n");
    await writeFile(join(path, "test", "app.test.js"), "// changed\n");
    await mkdir(join(path, "docs"), { recursive: true });
    for (const [file, body] of Object.entries(files)) await writeFile(join(path, file), body);
    await git(path, "add", "-A");
    await git(path, "commit", "-m", "big change");
    const headSha = await git(path, "rev-parse", "HEAD");
    const repository = `local:${path}`;
    const pr = await db.localPullRequest.create({ data: { repository, branch: "big", base: "main" } });
    prIds.push(pr.id);
    return { repository, prNumber: pr.number, headSha };
  }

  function context(repository: string): ReviewToolContext {
    const link: RepositoryLink = { provider: "local", repository, access: "write", checkName: null, waitForCi: false };
    return {
      agentId: "agent-large",
      links: [link],
      hosts: { local: host },
      runCheck: null,
      markRunCheckCompleted: vi.fn(async () => undefined),
      authorize: vi.fn(async () => ({ ok: true as const })),
      reads: new ReviewReadLedger(),
      db,
    };
  }

  async function read(
    ctx: ReviewToolContext,
    repository: string,
    prNumber: number,
    patchCursor?: string,
  ): Promise<Page> {
    const out = await handleReviewHostTool("repo_pr_read", JSON.stringify({ repository, prNumber, patchCursor }), ctx);
    return JSON.parse(out) as Page;
  }

  async function approve(
    ctx: ReviewToolContext,
    repository: string,
    prNumber: number,
    headSha: string,
  ): Promise<string> {
    return handleReviewHostTool(
      "repo_publish_review",
      JSON.stringify({ repository, prNumber, headSha, verdict: "APPROVE", summary: "lgtm", body: "fine" }),
      ctx,
    );
  }

  beforeAll(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "wardby-large-pr-")));
    root = join(base, "root");
    await mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    await db.localPullRequest.deleteMany({ where: { id: { in: prIds } } });
    await db.$disconnect();
    await rm(base, { recursive: true, force: true });
  });

  it("reads code first, so a huge doc does not block an APPROVE", async () => {
    const { repository, prNumber, headSha } = await makeRepo("docs-heavy", {
      "docs/history.md": lines(150_000, "history"),
    });
    const ctx = context(repository);
    const page = await read(ctx, repository, prNumber);
    const status = Object.fromEntries(page.files.map((f) => [f.filename, f.patchStatus]));
    expect(status).toEqual({
      "src/app.js": "complete",
      "test/app.test.js": "complete",
      "docs/history.md": "partial",
    });
    expect(page.patchesComplete).toBe(false);
    expect(page.nextPatchCursor).not.toBeNull();

    const out = JSON.parse(await approve(ctx, repository, prNumber, headSha));
    expect(out).toMatchObject({ published: true });
  });

  it("refuses an APPROVE until a code file larger than the budget is read to its end", async () => {
    const { repository, prNumber, headSha } = await makeRepo("code-heavy", {
      "src/big.js": lines(250_000, "const v ="),
    });
    const ctx = context(repository);
    let page = await read(ctx, repository, prNumber);
    expect(page.nextPatchCursor).not.toBeNull();

    const refused = await approve(ctx, repository, prNumber, headSha);
    expect(refused).toContain("unread_files");
    expect(refused).toContain("src/big.js");

    let pages = 1;
    while (page.nextPatchCursor) {
      // Still refused on every page before the last one.
      expect(await approve(ctx, repository, prNumber, headSha)).toContain("unread_files");
      page = await read(ctx, repository, prNumber, page.nextPatchCursor);
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(2);
    expect(page.patchesComplete).toBe(true);

    const out = JSON.parse(await approve(ctx, repository, prNumber, headSha));
    expect(out).toMatchObject({ published: true });
  });
});
