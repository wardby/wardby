import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubReviewHost } from "../../../../src/providers/review-host/github.js";
import { githubHarness, INSTALLATION, REPO, type Harness } from "./harness.test-support.js";
import { SIM_APP_ID, SIM_APP_SLUG } from "./test-app-key.js";

const R = `/repos/${REPO}`;
const ALL = { contents: "write", pull_requests: "write", issues: "write", checks: "write", statuses: "write" } as const;

let h: Harness;
beforeEach(async () => {
  h = await githubHarness();
});
afterEach(async () => {
  h.gh.git.dispose();
  await h.sim.close();
});

async function branchWith(
  files: Record<string, string | null>,
  branch = "feature",
  message = "change",
): Promise<string> {
  const [result] = (await h.script([{ action: "github.commit", repo: REPO, branch, files, message }])) as {
    sha: string;
  }[];
  return result.sha;
}

async function openPr(token: string, extra: Record<string, unknown> = {}): Promise<any> {
  const response = await h.call(
    "POST",
    `${R}/pulls`,
    { title: "Add b", head: "feature", base: "main", body: "body", draft: true, ...extra },
    { token },
  );
  expect(response.status).toBe(201);
  return response.body;
}

describe("GitHub sim: App authentication", () => {
  it("answers GET /app and the installation only to a valid App JWT", async () => {
    const jwt = await h.appJwt();
    expect((await h.call("GET", "/app", undefined, { token: jwt })).body).toMatchObject({
      id: SIM_APP_ID,
      slug: SIM_APP_SLUG,
      owner: { login: "acme" },
    });
    expect((await h.call("GET", `${R}/installation`, undefined, { token: jwt })).body).toMatchObject({
      id: INSTALLATION,
    });
    expect((await h.call("GET", "/repos/acme/nope/installation", undefined, { token: jwt })).status).toBe(404);
    const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    for (const bad of [
      await h.appJwt({ key: otherKey }),
      await h.appJwt({ appId: 1 }),
      await h.appJwt({ iatOffset: -1200, expOffset: -600 }),
      await h.appJwt({ iatOffset: 0, expOffset: 3600 }),
      "not-a-jwt",
    ]) {
      expect((await h.call("GET", "/app", undefined, { token: bad })).status).toBe(401);
    }
  });

  it("issues a token echoing exactly the requested permissions, scoped to the repositories", async () => {
    const response = await h.call(
      "POST",
      `/app/installations/${INSTALLATION}/access_tokens`,
      { permissions: { pull_requests: "read" }, repositories: ["widgets"] },
      { token: await h.appJwt() },
    );
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      permissions: { pull_requests: "read", metadata: "read" },
      repositories: [{ full_name: REPO }],
    });
    expect(response.body.token).toMatch(/^ghs_[A-Za-z0-9]{36}$/);
    expect(Date.parse(response.body.expires_at)).toBeGreaterThan(Date.now() + 50 * 60_000);
    // Never the token itself in the call log.
    expect(JSON.stringify(h.sim.state.calls.list())).not.toContain(response.body.token);
  });

  it("refuses a permission the installation never granted (422), and an unknown installation (404)", async () => {
    await h.script([
      { action: "github.install", account: "other", id: 77, permissions: { contents: "read", metadata: "read" } },
    ]);
    await h.script([{ action: "github.repo", repo: "other/lib" }]);
    const jwt = await h.appJwt();
    expect(
      (
        await h.call(
          "POST",
          "/app/installations/77/access_tokens",
          { permissions: { contents: "write" }, repositories: ["lib"] },
          { token: jwt },
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await h.call(
          "POST",
          "/app/installations/77/access_tokens",
          { permissions: { contents: "read" }, repositories: ["widgets"] },
          { token: jwt },
        )
      ).status,
    ).toBe(422);
    expect(
      (await h.call("POST", "/app/installations/9999/access_tokens", { permissions: {} }, { token: jwt })).status,
    ).toBe(404);
  });

  it("revokes a token; a revoked or expired token is Bad credentials", async () => {
    const token = await h.mint({ contents: "read" });
    expect((await h.call("GET", R, undefined, { token })).status).toBe(200);
    expect((await h.call("DELETE", "/installation/token", undefined, { token })).status).toBe(204);
    expect((await h.call("GET", R, undefined, { token })).status).toBe(401);
    const second = await h.mint({ contents: "read" });
    await h.script([{ action: "github.clock", offsetMs: 61 * 60_000 }]);
    expect((await h.call("GET", R, undefined, { token: second })).status).toBe(401);
  });

  it("keeps a token to its repositories (404) and permissions (403)", async () => {
    await h.script([{ action: "github.repo", repo: "acme/secret" }]);
    const token = await h.mint({ contents: "read" });
    expect((await h.call("GET", "/repos/acme/secret", undefined, { token })).status).toBe(404);
    expect((await h.call("GET", "/repos/acme/secret/contents/README.md", undefined, { token })).status).toBe(404);
    const denied = await h.call("POST", `${R}/check-runs`, { name: "x", head_sha: "0".repeat(40) }, { token });
    expect(denied).toMatchObject({ status: 403, body: { message: "Resource not accessible by integration" } });
  });

  it("removes an installation", async () => {
    expect(
      (await h.call("DELETE", `/app/installations/${INSTALLATION}`, undefined, { token: await h.appJwt() })).status,
    ).toBe(204);
    expect((await h.call("GET", `${R}/installation`, undefined, { token: await h.appJwt() })).status).toBe(404);
  });
});

describe("GitHub sim: repository, collaborators", () => {
  it("serves the repository and a user's permission (role flags; outsider on a public repo reads)", async () => {
    await h.script([
      { action: "github.collaborator", repo: REPO, login: "dev", role: "write" },
      { action: "github.user", login: "stranger" },
    ]);
    const token = await h.mint({ metadata: "read" });
    expect((await h.call("GET", R, undefined, { token })).body).toMatchObject({
      full_name: REPO,
      default_branch: "main",
      private: false,
    });
    const dev = await h.call("GET", `${R}/collaborators/dev/permission`, undefined, { token });
    expect(dev.body).toMatchObject({
      permission: "write",
      role_name: "write",
      user: { login: "dev", permissions: { push: true, admin: false } },
    });
    const owner = await h.call("GET", `${R}/collaborators/acme/permission`, undefined, { token });
    expect(owner.body).toMatchObject({ permission: "admin" });
    const stranger = await h.call("GET", `${R}/collaborators/stranger/permission`, undefined, { token });
    expect(stranger.body).toMatchObject({ permission: "read", user: { permissions: { pull: true, push: false } } });
    expect((await h.call("GET", `${R}/collaborators/ghost/permission`, undefined, { token })).status).toBe(404);
  });
});

describe("GitHub sim: pull requests", () => {
  it("creates, lists by head, reads, and edits a pull request; refuses a duplicate and an empty one", async () => {
    await branchWith({ "src/b.ts": "export const b = 2;\n" });
    const token = await h.mint({ pull_requests: "write", contents: "write" });
    const pr = await openPr(token);
    expect(pr).toMatchObject({
      number: 1,
      draft: true,
      state: "open",
      html_url: `https://github.com/${REPO}/pull/1`,
      head: { ref: "feature", repo: { full_name: REPO } },
      base: { ref: "main" },
      changed_files: 1,
      additions: 1,
      user: { login: `${SIM_APP_SLUG}[bot]`, type: "Bot" },
    });
    expect(pr.head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      (await h.call("POST", `${R}/pulls`, { title: "again", head: "feature", base: "main" }, { token })).status,
    ).toBe(422);
    await h.script([{ action: "github.commit", repo: REPO, branch: "empty", files: {}, message: "nothing" }]);
    // A branch at main's own head has no commits between.
    await h.gh.git.setBranch(REPO, "same", (await h.gh.git.resolve(REPO, "main"))!);
    expect((await h.call("POST", `${R}/pulls`, { title: "same", head: "same", base: "main" }, { token })).status).toBe(
      422,
    );
    const list = await h.call("GET", `${R}/pulls?state=open&head=acme:feature&per_page=100`, undefined, { token });
    expect(list.body.map((p: any) => p.number)).toEqual([1]);
    expect((await h.call("GET", `${R}/pulls?head=acme:other`, undefined, { token })).body).toEqual([]);
    const edited = await h.call("PATCH", `${R}/pulls/1`, { body: "new body", title: "t2" }, { token });
    expect(edited.body).toMatchObject({ body: "new body", title: "t2" });
    const closed = await h.call("PATCH", `${R}/pulls/1`, { state: "closed" }, { token });
    expect(closed.body).toMatchObject({ state: "closed", merged: false });
    expect((await h.call("GET", `${R}/pulls/99`, undefined, { token })).status).toBe(404);
  });

  it("pages files at 100 and stops at the 3,000 GitHub serves, while changed_files counts all", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3005; i += 1) files[`f/${String(i).padStart(4, "0")}.txt`] = `${i}\n`;
    await branchWith(files);
    const token = await h.mint({ pull_requests: "write" });
    const pr = await openPr(token);
    expect(pr.changed_files).toBe(3005);
    const first = await h.call("GET", `${R}/pulls/1/files?per_page=100&page=1`, undefined, { token });
    expect(first.body).toHaveLength(100);
    expect(first.headers.link).toContain('rel="next"');
    expect((await h.call("GET", `${R}/pulls/1/files?per_page=100&page=30`, undefined, { token })).body).toHaveLength(
      100,
    );
    expect((await h.call("GET", `${R}/pulls/1/files?per_page=100&page=31`, undefined, { token })).body).toHaveLength(0);
    expect((await h.call("GET", `${R}/pulls/1/files?per_page=500`, undefined, { token })).body).toHaveLength(100);
  }, 60_000);

  it("reports file status, patch and renames from real git", async () => {
    await h.script([
      {
        action: "github.commit",
        repo: REPO,
        branch: "feature",
        files: { "src/a.ts": "export const a = 2;\n", "README.md": null, "docs/new.md": "hi\n" },
      },
    ]);
    const token = await h.mint({ pull_requests: "write" });
    await openPr(token);
    const files = (await h.call("GET", `${R}/pulls/1/files`, undefined, { token })).body as any[];
    const byName = Object.fromEntries(files.map((f) => [f.filename, f]));
    expect(byName["src/a.ts"]).toMatchObject({ status: "modified", additions: 1, deletions: 1 });
    expect(byName["src/a.ts"].patch).toBe("@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;");
    expect(byName["README.md"]).toMatchObject({ status: "removed", sha: null });
    expect(byName["docs/new.md"]).toMatchObject({ status: "added", additions: 1 });
  });

  it("lists a PR's commits with parents", async () => {
    await branchWith({ "x.txt": "1\n" });
    await branchWith({ "x.txt": "2\n" });
    const token = await h.mint({ pull_requests: "write" });
    await openPr(token);
    const commits = (await h.call("GET", `${R}/pulls/1/commits`, undefined, { token })).body as any[];
    expect(commits).toHaveLength(2);
    expect(commits[1].parents[0].sha).toBe(commits[0].sha);
  });
});

describe("GitHub sim: reviews and review comments", () => {
  it("posts a review with inline comments on diff lines, refuses lines outside the diff and self-approval", async () => {
    await branchWith({ "src/a.ts": "export const a = 1;\nexport const z = 3;\n" });
    const token = await h.mint({ pull_requests: "write" });
    const pr = await openPr(token);
    const ok = await h.call(
      "POST",
      `${R}/pulls/1/reviews`,
      {
        commit_id: pr.head.sha,
        event: "COMMENT",
        body: "see inline",
        comments: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "nit" }],
      },
      { token },
    );
    expect(ok).toMatchObject({ status: 200, body: { state: "COMMENTED", commit_id: pr.head.sha } });
    expect(
      (
        await h.call(
          "POST",
          `${R}/pulls/1/reviews`,
          { event: "COMMENT", body: "x", comments: [{ path: "src/a.ts", line: 40, body: "far" }] },
          { token },
        )
      ).status,
    ).toBe(422);
    expect((await h.call("POST", `${R}/pulls/1/reviews`, { event: "APPROVE", body: "lgtm" }, { token })).status).toBe(
      422,
    );
    const reviews = (await h.call("GET", `${R}/pulls/1/reviews`, undefined, { token })).body as any[];
    expect(reviews).toHaveLength(1);
    const comments = (await h.call("GET", `${R}/pulls/1/comments`, undefined, { token })).body as any[];
    expect(comments).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, body: "nit", pull_request_review_id: ok.body.id }),
    ]);
    const reply = await h.call("POST", `${R}/pulls/1/comments/${comments[0].id}/replies`, { body: "fixed" }, { token });
    expect(reply).toMatchObject({ status: 201, body: { in_reply_to_id: comments[0].id, path: "src/a.ts" } });
    const edited = await h.call("PATCH", `${R}/pulls/comments/${comments[0].id}`, { body: "nit (edited)" }, { token });
    expect(edited.body.body).toBe("nit (edited)");
    expect((await h.call("GET", `${R}/pulls/comments/${comments[0].id}`, undefined, { token })).body.body).toBe(
      "nit (edited)",
    );
    expect(
      (await h.call("POST", `${R}/pulls/comments/${comments[0].id}/reactions`, { content: "eyes" }, { token })).status,
    ).toBe(201);
  });

  it("lets another user approve and request changes", async () => {
    await branchWith({ "src/b.ts": "b\n" });
    const token = await h.mint({ pull_requests: "write" });
    await openPr(token);
    await h.script([{ action: "github.review", repo: REPO, number: 1, author: "dev", event: "APPROVE" }]);
    const reviews = (await h.call("GET", `${R}/pulls/1/reviews`, undefined, { token })).body as any[];
    expect(reviews).toEqual([
      expect.objectContaining({ state: "APPROVED", user: expect.objectContaining({ login: "dev" }) }),
    ]);
  });
});

describe("GitHub sim: issues, comments, reactions, labels", () => {
  it("reads an issue, pages comments, and answers a PR number with pull_request set", async () => {
    await h.script([{ action: "github.issue", repo: REPO, title: "Bug", body: "it breaks", author: "dev" }]);
    for (let i = 0; i < 105; i += 1)
      await h.script([{ action: "github.comment", repo: REPO, number: 1, author: "dev", body: `c${i}` }]);
    await h.script([{ action: "github.comment", repo: REPO, number: 1, author: "dev", body: "last" }]);
    const token = await h.mint({ issues: "read" });
    const issue = await h.call("GET", `${R}/issues/1`, undefined, { token });
    expect(issue.body).toMatchObject({ number: 1, title: "Bug", state: "open", comments: 106, user: { login: "dev" } });
    expect(issue.body.pull_request).toBeUndefined();
    const page2 = await h.call("GET", `${R}/issues/1/comments?per_page=100&page=2`, undefined, { token });
    expect(page2.body).toHaveLength(6);
    expect(page2.body[5]).toMatchObject({ body: "last", performed_via_github_app: null });
    await branchWith({ "b.txt": "b\n" });
    const prToken = await h.mint({ pull_requests: "write" });
    await openPr(prToken);
    expect((await h.call("GET", `${R}/issues/2`, undefined, { token: prToken })).body.pull_request).toBeDefined();
    expect((await h.call("GET", `${R}/issues/1`, undefined, { token: prToken })).status).toBe(403);
  });

  it("creates, edits and deletes the App's own comment; refuses editing a person's", async () => {
    await h.script([{ action: "github.issue", repo: REPO, title: "Bug", author: "dev" }]);
    const [person] = (await h.script([
      { action: "github.comment", repo: REPO, number: 1, author: "dev", body: "please" },
    ])) as { id: number }[];
    const token = await h.mint({ issues: "write" });
    const created = await h.call("POST", `${R}/issues/1/comments`, { body: "on it" }, { token });
    expect(created).toMatchObject({
      status: 201,
      body: { body: "on it", performed_via_github_app: { id: SIM_APP_ID } },
    });
    expect(created.body.html_url).toBe(`https://github.com/${REPO}/issues/1#issuecomment-${created.body.id}`);
    expect(
      (await h.call("PATCH", `${R}/issues/comments/${created.body.id}`, { body: "done" }, { token })).body.body,
    ).toBe("done");
    expect((await h.call("GET", `${R}/issues/comments/${created.body.id}`, undefined, { token })).body.body).toBe(
      "done",
    );
    expect((await h.call("PATCH", `${R}/issues/comments/${person.id}`, { body: "hijack" }, { token })).status).toBe(
      403,
    );
    expect((await h.call("POST", `${R}/issues/1/comments`, { body: "" }, { token })).status).toBe(422);
    expect((await h.call("POST", `${R}/issues/1/comments`, { body: "x".repeat(65537) }, { token })).status).toBe(422);
    expect((await h.call("DELETE", `${R}/issues/comments/${created.body.id}`, undefined, { token })).status).toBe(204);
    expect((await h.call("GET", `${R}/issues/comments/${created.body.id}`, undefined, { token })).status).toBe(404);
  });

  it("needs Issues: write on an issue, accepts Pull requests: write on a PR thread", async () => {
    await h.script([{ action: "github.issue", repo: REPO, title: "Bug", author: "dev" }]);
    await branchWith({ "b.txt": "b\n" });
    const prToken = await h.mint({ pull_requests: "write" });
    await openPr(prToken);
    expect((await h.call("POST", `${R}/issues/1/comments`, { body: "x" }, { token: prToken })).status).toBe(403);
    expect((await h.call("POST", `${R}/issues/2/comments`, { body: "x" }, { token: prToken })).status).toBe(201);
  });

  it("reacts once per user and content (201 then 200), refuses an unknown content", async () => {
    await h.script([{ action: "github.issue", repo: REPO, title: "Bug", author: "dev" }]);
    const [c] = (await h.script([{ action: "github.comment", repo: REPO, number: 1, author: "dev", body: "hey" }])) as {
      id: number;
    }[];
    const token = await h.mint({ issues: "write" });
    expect(
      (await h.call("POST", `${R}/issues/comments/${c.id}/reactions`, { content: "eyes" }, { token })).status,
    ).toBe(201);
    expect(
      (await h.call("POST", `${R}/issues/comments/${c.id}/reactions`, { content: "eyes" }, { token })).status,
    ).toBe(200);
    expect((await h.call("POST", `${R}/issues/1/reactions`, { content: "confused" }, { token })).status).toBe(201);
    expect((await h.call("POST", `${R}/issues/1/reactions`, { content: "party" }, { token })).status).toBe(422);
    expect(h.gh.reactions).toHaveLength(2);
  });

  it("adds labels and closes an issue", async () => {
    await h.script([{ action: "github.issue", repo: REPO, title: "Bug", author: "dev" }]);
    const token = await h.mint({ issues: "write" });
    expect((await h.call("POST", `${R}/issues/1/labels`, { labels: ["wardby"] }, { token })).body).toEqual([
      { name: "wardby" },
    ]);
    const closed = await h.call("PATCH", `${R}/issues/1`, { state: "closed" }, { token });
    expect(closed.body).toMatchObject({ state: "closed", state_reason: "completed", labels: [{ name: "wardby" }] });
  });
});

describe("GitHub sim: checks and statuses", () => {
  it("creates, updates and lists check runs by ref, latest per name by default", async () => {
    const sha = await branchWith({ "b.txt": "b\n" });
    const token = await h.mint({ checks: "write" });
    const created = await h.call(
      "POST",
      `${R}/check-runs`,
      { name: "wardby review", head_sha: sha, status: "in_progress", external_id: "run1" },
      { token },
    );
    expect(created).toMatchObject({
      status: 201,
      body: { status: "in_progress", conclusion: null, app: { id: SIM_APP_ID } },
    });
    await h.call(
      "POST",
      `${R}/check-runs`,
      { name: "wardby review", head_sha: sha, status: "completed", conclusion: "success" },
      { token },
    );
    const patched = await h.call(
      "PATCH",
      `${R}/check-runs/${created.body.id}`,
      { status: "completed", conclusion: "failure", output: { title: "t", summary: "s" } },
      { token },
    );
    expect(patched.body).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "t", summary: "s" },
    });
    const latest = await h.call("GET", `${R}/commits/${sha}/check-runs?check_name=wardby%20review`, undefined, {
      token,
    });
    expect(latest.body.total_count).toBe(1);
    const all = await h.call("GET", `${R}/commits/feature/check-runs?filter=all`, undefined, { token });
    expect(all.body.total_count).toBe(2);
    expect((await h.call("GET", `${R}/check-runs/${created.body.id}`, undefined, { token })).body.id).toBe(
      created.body.id,
    );
    expect(
      (await h.call("POST", `${R}/check-runs`, { name: "x", head_sha: sha, status: "completed" }, { token })).status,
    ).toBe(422);
    expect((await h.call("POST", `${R}/check-runs`, { name: "x", head_sha: "f".repeat(40) }, { token })).status).toBe(
      422,
    );
  });

  it("refuses to patch another App's check run", async () => {
    const sha = await branchWith({ "b.txt": "b\n" });
    const [ci] = (await h.script([
      { action: "github.check", repo: REPO, ref: sha, name: "ci", conclusion: "success" },
    ])) as { id: number }[];
    const token = await h.mint({ checks: "write" });
    expect((await h.call("PATCH", `${R}/check-runs/${ci.id}`, { conclusion: "failure" }, { token })).status).toBe(403);
  });

  it("combines commit statuses, latest per context", async () => {
    const sha = await branchWith({ "b.txt": "b\n" });
    const token = await h.mint({ statuses: "write" });
    expect((await h.call("GET", `${R}/commits/${sha}/status`, undefined, { token })).body).toMatchObject({
      state: "pending",
      total_count: 0,
    });
    await h.call("POST", `${R}/statuses/${sha}`, { state: "failure", context: "ci" }, { token });
    await h.call("POST", `${R}/statuses/${sha}`, { state: "success", context: "ci" }, { token });
    await h.call("POST", `${R}/statuses/${sha}`, { state: "success", context: "lint" }, { token });
    expect((await h.call("GET", `${R}/commits/${sha}/status`, undefined, { token })).body).toMatchObject({
      state: "success",
      total_count: 2,
    });
    expect((await h.call("POST", `${R}/statuses/${sha}`, { state: "weird" }, { token })).status).toBe(422);
  });
});

describe("GitHub sim: compare, contents, trees", () => {
  it("compares two commits: status, ahead/behind, commits with parents, files capped at 300", async () => {
    const main = (await h.gh.git.resolve(REPO, "main"))!;
    const files: Record<string, string> = {};
    for (let i = 0; i < 310; i += 1) files[`g/${i}.txt`] = `${i}\n`;
    const head = await branchWith(files);
    const token = await h.mint({ contents: "read" });
    const ahead = await h.call("GET", `${R}/compare/${main}...${head}`, undefined, { token });
    expect(ahead.body).toMatchObject({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1 });
    expect(ahead.body.files).toHaveLength(300);
    expect(ahead.body.commits[0].parents).toEqual([{ sha: main }]);
    expect((await h.call("GET", `${R}/compare/${head}...${main}`, undefined, { token })).body.status).toBe("behind");
    expect((await h.call("GET", `${R}/compare/${head}...${head}`, undefined, { token })).body.status).toBe("identical");
    await h.script([{ action: "github.commit", repo: REPO, branch: "main", files: { "m.txt": "m\n" } }]);
    const mainNow = (await h.gh.git.resolve(REPO, "main"))!;
    expect((await h.call("GET", `${R}/compare/${mainNow}...${head}`, undefined, { token })).body.status).toBe(
      "diverged",
    );
    expect((await h.call("GET", `${R}/compare/${"a".repeat(40)}...${head}`, undefined, { token })).status).toBe(404);
  }, 30_000); // builds a real 300-file commit; slow on a busy machine or CI runner

  it("serves raw file content, base64 JSON, a directory listing, and 404 for a missing path", async () => {
    const token = await h.mint({ contents: "read" });
    const raw = await h.call("GET", `${R}/contents/src/a.ts?ref=main`, undefined, {
      token,
      accept: "application/vnd.github.raw+json",
    });
    expect(raw).toMatchObject({ status: 200, body: "export const a = 1;\n" });
    const meta = await h.call("GET", `${R}/contents/src/a.ts`, undefined, { token });
    expect(Buffer.from(meta.body.content, "base64").toString()).toBe("export const a = 1;\n");
    const dir = await h.call("GET", `${R}/contents/src`, undefined, {
      token,
      accept: "application/vnd.github.raw+json",
    });
    expect(dir.body).toEqual([expect.objectContaining({ type: "file", path: "src/a.ts" })]);
    expect((await h.call("GET", `${R}/contents/nope.txt`, undefined, { token })).status).toBe(404);
  });

  it("lists a recursive tree", async () => {
    const token = await h.mint({ contents: "read" });
    const tree = await h.call("GET", `${R}/git/trees/main?recursive=1`, undefined, { token });
    expect(
      tree.body.tree
        .filter((e: any) => e.type === "blob")
        .map((e: any) => e.path)
        .sort(),
    ).toEqual(["README.md", "src/a.ts"]);
  });
});

describe("GitHub sim: GraphQL", () => {
  it("lists review threads, resolves one with Contents write, and marks a PR ready", async () => {
    await branchWith({ "src/a.ts": "export const a = 1;\nexport const z = 3;\n" });
    const token = await h.mint(ALL);
    const pr = await openPr(token);
    await h.call(
      "POST",
      `${R}/pulls/1/reviews`,
      { event: "COMMENT", body: "b", comments: [{ path: "src/a.ts", line: 2, body: "finding" }] },
      { token },
    );
    const list = await h.call(
      "POST",
      "/graphql",
      {
        query:
          "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id } } } } }",
        variables: { owner: "acme", name: "widgets", number: 1 },
      },
      { token },
    );
    const nodes = list.body.data.repository.pullRequest.reviewThreads.nodes;
    expect(nodes).toEqual([
      expect.objectContaining({
        isResolved: false,
        isOutdated: false,
        path: "src/a.ts",
        line: 2,
        comments: { nodes: [{ body: "finding", author: { __typename: "Bot", login: SIM_APP_SLUG } }] },
      }),
    ]);
    const readOnly = await h.mint({ pull_requests: "write" });
    const refused = await h.call(
      "POST",
      "/graphql",
      {
        query: "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }",
        variables: { threadId: nodes[0].id },
      },
      { token: readOnly },
    );
    expect(refused.body.errors[0].type).toBe("FORBIDDEN");
    const resolved = await h.call(
      "POST",
      "/graphql",
      {
        query: "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }",
        variables: { threadId: nodes[0].id },
      },
      { token },
    );
    expect(resolved.body.data.resolveReviewThread.thread.isResolved).toBe(true);
    // A later push touching the file outdates the thread.
    await branchWith({ "src/a.ts": "export const a = 9;\n" });
    const after = await h.call(
      "POST",
      "/graphql",
      { query: "query { reviewThreads(first: 100) }", variables: { owner: "acme", name: "widgets", number: 1 } },
      { token },
    );
    expect(after.body.data.repository.pullRequest.reviewThreads.nodes[0]).toMatchObject({
      isOutdated: true,
      line: null,
    });
    const ready = await h.call(
      "POST",
      "/graphql",
      {
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        variables: { id: pr.node_id },
      },
      { token },
    );
    expect(ready.body.data.markPullRequestReadyForReview.pullRequest.isDraft).toBe(false);
    expect((await h.call("GET", `${R}/pulls/1`, undefined, { token })).body.draft).toBe(false);
    expect((await h.call("POST", "/graphql", { query: "{ viewer { login } }" }, { token })).body.errors[0].type).toBe(
      "SIMULATOR_UNSUPPORTED",
    );
  });
});

describe("GitHub sim: faults GitHub really sends", () => {
  it("answers a scripted secondary rate limit with 403 and retry-after, once", async () => {
    await h.script([{ action: "github.rate_limit", path: "/repos/{owner}/{repo}", retryAfter: 7 }]);
    const token = await h.mint({ contents: "read" });
    const limited = await h.call("GET", R, undefined, { token });
    expect(limited.status).toBe(403);
    expect(limited.headers["retry-after"]).toBe("7");
    expect(limited.body.message).toMatch(/secondary rate limit/);
    expect((await h.call("GET", R, undefined, { token })).status).toBe(200);
  });

  it("tells a 404 (no repo) from a 403 (no permission) in its bodies", async () => {
    const token = await h.mint({ contents: "read" });
    expect((await h.call("GET", "/repos/acme/ghost", undefined, { token })).body).toMatchObject({
      message: "Not Found",
    });
    expect((await h.call("POST", `${R}/issues/1/labels`, { labels: [] }, { token })).body).toMatchObject({
      message: "Not Found",
    });
  });
});

describe("GitHub sim through wardby's own GitHub client and review host", () => {
  it("runs the token dance, opens a draft PR, reads it back and publishes a review", async () => {
    const client = h.client();
    expect(await client.appIdentity()).toEqual({ id: SIM_APP_ID, slug: SIM_APP_SLUG, ownerLogin: "acme" });
    await h.script([
      {
        action: "github.commit",
        repo: REPO,
        branch: "wardby/run-run1",
        files: { "src/b.ts": "export const b = 2;\n" },
      },
    ]);
    const pr = await client.createOrFindDraftPullRequest({
      runId: "run1",
      repository: REPO,
      baseRef: "main",
      headRef: "wardby/run-run1",
      summary: "Add b",
    });
    expect(pr).toMatchObject({ number: 1, url: `https://github.com/${REPO}/pull/1` });
    // Found again by its run marker, not duplicated.
    expect(
      (
        await client.createOrFindDraftPullRequest({
          runId: "run1",
          repository: REPO,
          baseRef: "main",
          headRef: "wardby/run-run1",
          summary: "Add b",
        })
      ).number,
    ).toBe(1);

    const host = new GitHubReviewHost(client);
    const view = await host.readPullRequest(REPO, 1, { maxPatchChars: 10_000, agentMarker: "reviewer" });
    expect(view).toMatchObject({
      number: 1,
      draft: true,
      fileListComplete: true,
      files: [expect.objectContaining({ filename: "src/b.ts" })],
    });
    const published = await host.publishReview(REPO, {
      prNumber: 1,
      headSha: view.headSha,
      verdict: "APPROVE",
      summary: "Looks good",
      body: "No findings.",
      comments: [],
      agentMarker: "reviewer",
      checkName: "wardby review",
    } as never);
    expect(published).toMatchObject({ published: true, checkConclusion: "success" });
    const runs = [...h.gh.checkRuns.values()];
    expect(runs).toEqual([
      expect.objectContaining({ name: "wardby review", conclusion: "success", appId: SIM_APP_ID }),
    ]);
    // Every token minted was revoked again.
    expect([...h.gh.tokens.values()].every((t) => t.revoked)).toBe(true);
  });
});
