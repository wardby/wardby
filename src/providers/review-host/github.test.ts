// src/providers/review-host/github.test.ts
import { describe, expect, it, vi } from "vitest";
import type { GitHubAppClient } from "../vcs/github.js";
import { GitHubReviewHost } from "./github.js";
import { BY_APP, fakeGitHub, json, OLD_SHA, PATCH, PR, REPO, SHA } from "./github.test-support.js";
import { reviewMarker } from "./review-format.js";

const BASE = "/repos/chfields/knock-knock-jokes";

describe("GitHubReviewHost reads", () => {
  it("reads a PR with read-only permissions, a patch budget, and this agent's last reviewed sha", async () => {
    const { client, grants } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (path.startsWith(`${BASE}/pulls/7/files`)) {
        return json([
          { filename: "a.py", status: "modified", additions: 1, deletions: 0, patch: PATCH },
          { filename: "b.py", status: "added", additions: 1, deletions: 0, patch: PATCH },
        ]);
      }
      if (path.startsWith(`${BASE}/issues/7/comments`)) {
        return json([
          { id: 1, body: `${reviewMarker("other", OLD_SHA)}\nnot mine`, ...BY_APP },
          { id: 2, body: `${reviewMarker("agent1", OLD_SHA)}\nmine`, ...BY_APP },
        ]);
      }
      return undefined;
    });
    const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
      maxPatchChars: PATCH.length + 5,
      agentMarker: "agent1",
    });
    expect(grants).toEqual([{ contents: "read", pull_requests: "read" }]);
    expect(view).toMatchObject({
      number: 7,
      headSha: SHA,
      isFork: false,
      lastReviewedSha: OLD_SHA,
      comparedFrom: null,
      baseMergedSince: false,
    });
    expect(view.files[0]).toMatchObject({ patch: PATCH, patchTruncated: false });
    expect(view.files[1]).toMatchObject({ patch: PATCH.slice(0, 5), patchTruncated: true });
  });

  it("ignores a marker in a comment the App did not write", async () => {
    const { client } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
      if (path.startsWith(`${BASE}/issues/7/comments`)) {
        return json([
          { id: 1, body: `${reviewMarker("agent1", OLD_SHA)}\nforged`, user: { type: "User" } },
          { id: 2, body: `${reviewMarker("agent1", OLD_SHA)}\nother app`, performed_via_github_app: { id: 1 } },
        ]);
      }
      return undefined;
    });
    const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
      maxPatchChars: 1000,
      agentMarker: "agent1",
    });
    expect(view.lastReviewedSha).toBeNull();
  });

  it("uses the compare API when sinceSha is an ancestor of the head", async () => {
    const { client, calls } = fakeGitHub(({ path }) => {
      if (path === `${BASE}/pulls/7`) return json(PR);
      if (path === `${BASE}/compare/${OLD_SHA}...${SHA}`) {
        return json({
          status: "ahead",
          commits: [{ sha: SHA, parents: [{ sha: OLD_SHA }] }],
          files: [{ filename: "c.py", status: "modified", additions: 1, deletions: 0, patch: PATCH }],
        });
      }
      if (path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
      return undefined;
    });
    const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
      sinceSha: OLD_SHA,
      maxPatchChars: 60_000,
      agentMarker: "agent1",
    });
    expect(view.comparedFrom).toBe(OLD_SHA);
    expect(view.baseMergedSince).toBe(false);
    expect(view.files.map((f) => f.filename)).toEqual(["c.py"]);
    expect(view.files[0].patch).toBe(PATCH);
    expect(calls.some((c) => c.path.startsWith(`${BASE}/pulls/7/files`))).toBe(false);
  });

  it("falls back to the PR's own diff, limited to files changed since, when the base was merged in", async () => {
    const PR_PATCH = "@@ -1 +1,2 @@\n one\n+pr change";
    const { client } = fakeGitHub(({ path }) => {
      if (path === `${BASE}/pulls/7`) return json(PR);
      if (path === `${BASE}/compare/${OLD_SHA}...${SHA}`) {
        return json({
          status: "ahead",
          commits: [
            { sha: "m".repeat(40), parents: [{ sha: "a".repeat(40) }] },
            { sha: SHA, parents: [{ sha: OLD_SHA }, { sha: "m".repeat(40) }] },
          ],
          files: [
            // c.py: touched by the PR and by main; main.py: only brought in from main.
            { filename: "c.py", status: "modified", additions: 3, deletions: 0, patch: PATCH },
            { filename: "main.py", status: "modified", additions: 9, deletions: 0, patch: PATCH },
          ],
        });
      }
      if (path.startsWith(`${BASE}/pulls/7/files`)) {
        return json([
          { filename: "c.py", status: "modified", additions: 1, deletions: 0, patch: PR_PATCH },
          { filename: "untouched-since.py", status: "added", additions: 1, deletions: 0, patch: PR_PATCH },
        ]);
      }
      if (path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
      return undefined;
    });
    const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
      sinceSha: OLD_SHA,
      maxPatchChars: 60_000,
      agentMarker: "agent1",
    });
    expect(view.comparedFrom).toBe(OLD_SHA);
    expect(view.baseMergedSince).toBe(true);
    expect(view.files.map((f) => [f.filename, f.patch])).toEqual([["c.py", PR_PATCH]]);
  });

  it("flags a fork PR", async () => {
    const fork = { ...PR, head: { ...PR.head, repo: { full_name: "stranger/knock-knock-jokes" } } };
    const { client } = fakeGitHub(({ path }) => (path === `${BASE}/pulls/7` ? json(fork) : undefined));
    await expect(new GitHubReviewHost(client).pullRequestHead(REPO, 7)).resolves.toEqual({
      headSha: SHA,
      isFork: true,
      state: "open",
    });
  });

  it("reads a file window with line numbers, a directory, and a missing path", async () => {
    const { client } = fakeGitHub(({ path, accept }) => {
      expect(accept).toBe("application/vnd.github.raw+json");
      if (path === `${BASE}/contents/knockknock/jokes.py?ref=${SHA}`) return new Response("a\nb\nc\nd");
      if (path === `${BASE}/contents/tests?ref=${SHA}`) return json([{ type: "file", path: "tests/test_a.py" }]);
      if (path === `${BASE}/contents/nope.py?ref=${SHA}`) return json({ message: "Not Found" }, 404);
      return undefined;
    });
    const host = new GitHubReviewHost(client);
    await expect(host.readFile(REPO, "knockknock/jokes.py", SHA, { startLine: 2, maxLines: 2 })).resolves.toEqual({
      kind: "file",
      path: "knockknock/jokes.py",
      ref: SHA,
      totalLines: 4,
      startLine: 2,
      endLine: 3,
      truncated: true,
      content: "2: b\n3: c",
    });
    await expect(host.readFile(REPO, "tests", SHA, { startLine: 1, maxLines: 10 })).resolves.toEqual({
      kind: "directory",
      path: "tests",
      entries: ["file tests/test_a.py"],
    });
    await expect(host.readFile(REPO, "nope.py", SHA, { startLine: 1, maxLines: 10 })).resolves.toEqual({
      kind: "not_found",
      path: "nope.py",
    });
    await expect(host.readFile(REPO, "../etc/passwd", SHA, { startLine: 1, maxLines: 10 })).rejects.toThrow(
      "path_invalid",
    );
  });

  it("lists files at a ref, defaulting to the default branch, skipping vendored paths", async () => {
    const { client } = fakeGitHub(({ path }) => {
      if (path === BASE) return json({ default_branch: "main" });
      if (path === `${BASE}/git/trees/main?recursive=1`) {
        return json({
          truncated: false,
          tree: [
            { type: "blob", path: "tests/test_a.py", size: 10 },
            { type: "blob", path: "web/node_modules/x.js", size: 1 },
            { type: "blob", path: "web/package-lock.json", size: 1 },
            { type: "tree", path: "tests" },
          ],
        });
      }
      return undefined;
    });
    await expect(new GitHubReviewHost(client).listFiles(REPO, undefined)).resolves.toEqual({
      ref: "main",
      count: 1,
      truncated: false,
      files: ["tests/test_a.py (10 bytes)"],
    });
  });

  it("maps an uninstalled repository to host_not_installed", async () => {
    const { client } = fakeGitHub(() => undefined);
    const host = new GitHubReviewHost(client);
    // fakeGitHub always answers /installation with 200; simulate by a client whose mint fails:
    const failing = {
      withScopedToken: async () => {
        throw new Error("github_app_not_installed");
      },
    } as unknown as GitHubAppClient;
    await expect(new GitHubReviewHost(failing).pullRequestHead(REPO, 7)).rejects.toMatchObject({
      code: "host_not_installed",
    });
    expect(host.provider).toBe("github");
  });
});

describe("GitHubReviewHost writes", () => {
  const input = {
    prNumber: 7,
    headSha: SHA,
    verdict: "CHANGES_REQUESTED" as const,
    summary: "One bug.",
    body: "## Findings\n- bug",
    agentMarker: "agent1",
    checkName: "wardby review",
    comments: [
      {
        path: "a.py",
        line: 2,
        side: "RIGHT" as const,
        severity: "MAJOR",
        body: "off by one\n```suggestion\nnew 2\n```",
      },
      { path: "a.py", line: 50, side: "RIGHT" as const, severity: "MINOR", body: "outside" },
    ],
  };

  it("posts inline comments, creates the summary comment, and completes the run's check", async () => {
    const { client, calls, grants } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) {
        return json([{ filename: "a.py", status: "modified", additions: 1, deletions: 0, patch: PATCH }]);
      }
      if (method === "POST" && path === `${BASE}/pulls/7/reviews`) {
        return json({ id: 9, html_url: "https://github.com/r/pull/7#pullrequestreview-9" });
      }
      if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
      if (method === "POST" && path === `${BASE}/issues/7/comments`) {
        return json({ id: 5, html_url: "https://github.com/r/pull/7#issuecomment-5" }, 201);
      }
      if (method === "PATCH" && path === `${BASE}/check-runs/11`) return json({ id: 11 });
      return undefined;
    });
    const result = await new GitHubReviewHost(client).publishReview(REPO, { ...input, checkId: "11" });

    expect(grants).toEqual([{ pull_requests: "write", checks: "write" }]);
    expect(result).toEqual({
      published: true,
      reviewUrl: "https://github.com/r/pull/7#pullrequestreview-9",
      summaryCommentUrl: "https://github.com/r/pull/7#issuecomment-5",
      checkId: "11",
      checkConclusion: "failure",
      inlineCount: 1,
      outsideDiffCount: 1,
      resolvedThreadIds: [],
      skippedThreadIds: [],
    });
    const review = calls.find((c) => c.path === `${BASE}/pulls/7/reviews`)!.body as Record<string, unknown>;
    expect(review).toMatchObject({ commit_id: SHA, event: "COMMENT" });
    expect(review.comments).toEqual([
      {
        path: "a.py",
        line: 2,
        side: "RIGHT",
        body: "**[MAJOR]** off by one\n```suggestion\nnew 2\n```\n\n<!-- wardby:finding:agent1 -->",
      },
    ]);
    const summary = calls.find((c) => c.method === "POST" && c.path === `${BASE}/issues/7/comments`)!.body as {
      body: string;
    };
    expect(summary.body).toContain(reviewMarker("agent1", SHA));
    expect(summary.body).toContain("**[MINOR] a.py:50** outside");
    const check = calls.find((c) => c.path === `${BASE}/check-runs/11`)!.body as Record<string, unknown>;
    expect(check).toMatchObject({
      status: "completed",
      conclusion: "failure",
      details_url: "https://github.com/r/pull/7#issuecomment-5",
      output: { title: "Changes requested", summary: "One bug." },
    });
    const checkText = (check.output as { text: string }).text;
    expect(checkText).toBe(summary.body);
    expect(checkText).toContain("## Findings\n- bug");
    expect(checkText).toContain("## Outside the diff");
  });

  describe("review threads", () => {
    const APP_BOT = { __typename: "Bot", login: "wardby" };
    const thread = (id: string, over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
      id,
      isResolved: false,
      isOutdated: false,
      path: "a.py",
      line: 2,
      comments: {
        nodes: [{ body: "**[MAJOR]** off by one\n\n<!-- wardby:finding:agent1 -->", author: APP_BOT, ...comment }],
      },
      ...over,
    });
    const THREADS = [
      thread("T1"),
      thread("T2", { isOutdated: true, line: null }),
      thread("T3", { isResolved: true }),
      thread("T4", {}, { author: { __typename: "User", login: "wardby" } }),
      thread("T5", {}, { author: { __typename: "Bot", login: "other-app" } }),
      thread("T6", {}, { body: "**[MINOR]** x\n\n<!-- wardby:finding:agent2 -->" }),
      thread("T7", {}, { body: "a human-looking comment" }),
    ];
    const threadsAnswer = () => json({ data: { repository: { pullRequest: { reviewThreads: { nodes: THREADS } } } } });
    const isThreadsQuery = (body: unknown) => String((body as { query: string }).query).includes("reviewThreads");

    it("lists only this agent's own unresolved threads when reading a PR", async () => {
      const { client, calls } = fakeGitHub(({ method, path, body }) => {
        if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
        if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
        if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
        if (method === "POST" && path === "/graphql" && isThreadsQuery(body)) return threadsAnswer();
        return undefined;
      });
      const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
        maxPatchChars: 1000,
        agentMarker: "agent1",
      });
      expect(view.openThreads).toEqual([
        { id: "T1", path: "a.py", line: 2, outdated: false, body: "**[MAJOR]** off by one" },
        { id: "T2", path: "a.py", line: null, outdated: true, body: "**[MAJOR]** off by one" },
      ]);
      expect(calls.find((c) => c.path === "/graphql")!.body).toMatchObject({
        variables: { owner: "chfields", name: "knock-knock-jokes", number: 7 },
      });
    });

    const publishFake = (mutation: (threadId: string) => Response | undefined) =>
      fakeGitHub(({ method, path, body }) => {
        if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
        if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
        if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
        if (method === "POST" && path === `${BASE}/issues/7/comments`)
          return json({ id: 6, html_url: "https://x/6" }, 201);
        if (method === "PATCH" && path === `${BASE}/check-runs/11`) return json({ id: 11 });
        if (method === "POST" && path === "/graphql") {
          if (isThreadsQuery(body)) return threadsAnswer();
          return mutation((body as { variables: { threadId: string } }).variables.threadId);
        }
        return undefined;
      });
    const resolvedOk = (threadId: string) =>
      json({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } });

    it("resolves only its own open threads, with a Contents-write token, after publishing", async () => {
      const { client, calls, grants } = publishFake(resolvedOk);
      const result = await new GitHubReviewHost(client).publishReview(REPO, {
        ...input,
        comments: [],
        checkId: "11",
        resolveThreadIds: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "nope", "T1"],
      });
      expect(result).toMatchObject({
        published: true,
        resolvedThreadIds: ["T1", "T2"],
        skippedThreadIds: ["T3", "T4", "T5", "T6", "T7", "nope"],
      });
      expect(grants).toEqual([
        { pull_requests: "write", checks: "write" },
        { contents: "write", pull_requests: "write" },
      ]);
      const mutations = calls
        .filter((c) => c.path === "/graphql" && !isThreadsQuery(c.body))
        .map((c) => (c.body as { variables: unknown }).variables);
      expect(mutations).toEqual([{ threadId: "T1" }, { threadId: "T2" }]);
    });

    it("skips a thread the host refuses to resolve, and every thread when the token is refused", async () => {
      const partial = publishFake((id) => (id === "T1" ? json({ errors: [{ message: "no" }] }) : resolvedOk(id)));
      await expect(
        new GitHubReviewHost(partial.client).publishReview(REPO, {
          ...input,
          comments: [],
          checkId: "11",
          resolveThreadIds: ["T1", "T2"],
        }),
      ).resolves.toMatchObject({ published: true, resolvedThreadIds: ["T2"], skippedThreadIds: ["T1"] });

      const refused = publishFake(resolvedOk);
      let call = 0;
      const host = new GitHubReviewHost(refused.client);
      const scoped = refused.client.withScopedToken.bind(refused.client);
      vi.spyOn(refused.client, "withScopedToken").mockImplementation((repo, perms, action) => {
        call += 1;
        if (call === 2) return Promise.reject(new Error("github_installation_token_scope_invalid"));
        return scoped(repo, perms, action);
      });
      await expect(
        host.publishReview(REPO, { ...input, comments: [], checkId: "11", resolveThreadIds: ["T1"] }),
      ).resolves.toMatchObject({ published: true, resolvedThreadIds: [], skippedThreadIds: ["T1"] });
    });

    it("makes no thread calls without ids, or when the head moved on", async () => {
      const none = publishFake(resolvedOk);
      await new GitHubReviewHost(none.client).publishReview(REPO, { ...input, comments: [], checkId: "11" });
      expect(none.calls.some((c) => c.path === "/graphql")).toBe(false);
      expect(none.grants).toHaveLength(1);

      const moved = fakeGitHub(({ method, path }) => {
        if (method === "GET" && path === `${BASE}/pulls/7`) return json({ ...PR, head: { ...PR.head, sha: OLD_SHA } });
        if (method === "PATCH" && path === `${BASE}/check-runs/11`) return json({ id: 11 });
        return undefined;
      });
      const stale = await new GitHubReviewHost(moved.client).publishReview(REPO, {
        ...input,
        checkId: "11",
        resolveThreadIds: ["T1"],
      });
      expect(stale).toMatchObject({ published: false, reason: "stale_head" });
      expect(moved.calls.some((c) => c.path === "/graphql")).toBe(false);
    });
  });

  it("edits the existing summary comment and creates a completed check when the run has none", async () => {
    const { client, calls } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
      if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) {
        return json([{ id: 5, body: `${reviewMarker("agent1", OLD_SHA)}\nold`, html_url: "https://x/5", ...BY_APP }]);
      }
      if (method === "PATCH" && path === `${BASE}/issues/comments/5`) return json({ id: 5, html_url: "https://x/5" });
      if (method === "POST" && path === `${BASE}/check-runs`) return json({ id: 12 }, 201);
      return undefined;
    });
    const result = await new GitHubReviewHost(client).publishReview(REPO, {
      ...input,
      verdict: "APPROVE",
      comments: [],
    });
    expect(result).toMatchObject({ published: true, reviewUrl: null, checkId: "12", checkConclusion: "success" });
    expect(calls.some((c) => c.path === `${BASE}/pulls/7/reviews`)).toBe(false);
    expect(calls.find((c) => c.path === `${BASE}/check-runs`)!.body).toMatchObject({
      name: "wardby review",
      head_sha: SHA,
      status: "completed",
      conclusion: "success",
    });
  });

  it("posts a new summary rather than editing a forged one the App did not write", async () => {
    const { client, calls } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
      if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) {
        return json([{ id: 5, body: `${reviewMarker("agent1", OLD_SHA)}\nforged`, user: { type: "User" } }]);
      }
      if (method === "POST" && path === `${BASE}/issues/7/comments`)
        return json({ id: 6, html_url: "https://x/6" }, 201);
      if (method === "PATCH" && path === `${BASE}/check-runs/11`) return json({ id: 11 });
      return undefined;
    });
    const result = await new GitHubReviewHost(client).publishReview(REPO, { ...input, comments: [], checkId: "11" });
    expect(result).toMatchObject({ published: true, summaryCommentUrl: "https://x/6" });
    expect(calls.some((c) => c.path === `${BASE}/issues/comments/5`)).toBe(false);
  });

  it("creates no check when given neither a check id nor a check name", async () => {
    const { client, calls } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(PR);
      if (method === "GET" && path.startsWith(`${BASE}/pulls/7/files`)) return json([]);
      if (method === "GET" && path.startsWith(`${BASE}/issues/7/comments`)) return json([]);
      if (method === "POST" && path === `${BASE}/issues/7/comments`)
        return json({ id: 6, html_url: "https://x/6" }, 201);
      return undefined;
    });
    const { checkName: _omitted, ...unchecked } = input;
    const result = await new GitHubReviewHost(client).publishReview(REPO, { ...unchecked, comments: [] });
    expect(result).toMatchObject({ published: true, checkId: null, checkConclusion: "failure" });
    expect(calls.some((c) => c.path.includes("/check-runs"))).toBe(false);
  });

  it("refuses a stale head and marks the run's check superseded", async () => {
    const moved = { ...PR, head: { ...PR.head, sha: OLD_SHA } };
    const { client, calls } = fakeGitHub(({ method, path }) => {
      if (method === "GET" && path === `${BASE}/pulls/7`) return json(moved);
      if (method === "PATCH" && path === `${BASE}/check-runs/11`) return json({ id: 11 });
      return undefined;
    });
    await expect(new GitHubReviewHost(client).publishReview(REPO, { ...input, checkId: "11" })).resolves.toEqual({
      published: false,
      reason: "stale_head",
      currentHeadSha: OLD_SHA,
    });
    expect(calls.find((c) => c.path === `${BASE}/check-runs/11`)!.body).toMatchObject({
      conclusion: "neutral",
      output: { title: "Superseded by a newer push" },
    });
  });

  it("edits a conversation comment or a review-thread reply with issues+pull_requests write", async () => {
    const { client, calls, grants } = fakeGitHub(({ method, path }) => {
      if (method === "PATCH" && path === `${BASE}/issues/comments/31`) return json({ id: 31 }, 200);
      if (method === "PATCH" && path === `${BASE}/pulls/comments/32`) return json({ id: 32 }, 200);
      return undefined;
    });
    const host = new GitHubReviewHost(client);
    await host.editComment(REPO, { kind: "conversation", id: "31", body: "done" });
    await host.editComment(REPO, { kind: "inline", id: "32", body: "done too" });
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PATCH", `${BASE}/issues/comments/31`, { body: "done" }],
      ["PATCH", `${BASE}/pulls/comments/32`, { body: "done too" }],
    ]);
    expect(grants).toEqual([
      { issues: "write", pull_requests: "write" },
      { issues: "write", pull_requests: "write" },
    ]);
  });

  it("comments on an issue or replies in a review thread with issues+pull_requests write", async () => {
    const { client, calls, grants } = fakeGitHub(({ method, path }) => {
      if (method === "POST" && path === `${BASE}/issues/3/comments`)
        return json({ id: 31, html_url: "https://x/c" }, 201);
      if (method === "POST" && path === `${BASE}/pulls/7/comments/88/replies`)
        return json({ id: 32, html_url: "https://x/r" }, 201);
      if (method === "POST" && path === `${BASE}/issues/comments/4/reactions`) return json({ id: 1 }, 201);
      if (method === "POST" && path === `${BASE}/issues/12/reactions`) return json({ id: 2 }, 201);
      return undefined;
    });
    const host = new GitHubReviewHost(client);
    await expect(host.comment(REPO, { number: 3, body: "hi" })).resolves.toEqual({ url: "https://x/c", id: "31" });
    await expect(host.comment(REPO, { number: 7, body: "yes", replyToReviewCommentId: "88" })).resolves.toEqual({
      url: "https://x/r",
      id: "32",
    });
    await host.acknowledge(REPO, { kind: "conversation", id: "4" });
    await host.acknowledge(REPO, { kind: "subject", id: "12" });
    expect(grants).toEqual([
      { issues: "write", pull_requests: "write" },
      { issues: "write", pull_requests: "write" },
      { issues: "write", pull_requests: "write" },
      { issues: "write", pull_requests: "write" },
    ]);
    expect(calls.at(-2)!.body).toEqual({ content: "eyes" });
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: `${BASE}/issues/12/reactions`,
      body: { content: "eyes" },
    });
  });

  it("starts an in-progress check and completes it with capped text", async () => {
    const { client, calls, grants } = fakeGitHub(({ method, path }) => {
      if (method === "POST" && path === `${BASE}/check-runs`) return json({ id: 21 }, 201);
      if (method === "PATCH" && path === `${BASE}/check-runs/21`) return json({ id: 21 });
      return undefined;
    });
    const host = new GitHubReviewHost(client);
    await expect(host.startCheck(REPO, { headSha: SHA, name: "wardby review" })).resolves.toEqual({ checkId: "21" });
    await host.completeCheck(REPO, {
      checkId: "21",
      conclusion: "neutral",
      title: "Review did not complete",
      summary: "s",
      text: "x".repeat(70_000),
    });
    expect(grants).toEqual([{ checks: "write" }, { checks: "write" }]);
    expect(calls[0].body).toMatchObject({ name: "wardby review", head_sha: SHA, status: "in_progress" });
    expect((calls[1].body as { output: { text: string } }).output.text.length).toBe(65_535);
  });
});

describe("GitHubReviewHost.repositoryPermission", () => {
  const PERM = `${BASE}/collaborators/octo/permission`;
  const answer = (permission: string, perms: Record<string, boolean> | undefined, id = 42, extra = {}) =>
    json({
      permission,
      role_name: permission,
      user: { id, login: "octo", type: "User", ...(perms ? { permissions: perms } : {}) },
      ...extra,
    });
  const bools = (on: string[]) =>
    Object.fromEntries(["admin", "maintain", "push", "triage", "pull"].map((k) => [k, on.includes(k)]));

  it("asks for a metadata-only token and ranks from user.permissions", async () => {
    const { client, calls, grants } = fakeGitHub(({ method, path }) =>
      method === "GET" && path === PERM ? answer("write", bools(["push", "triage", "pull"])) : undefined,
    );
    await expect(new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).resolves.toEqual(
      { level: "write", login: "octo" },
    );
    expect(grants).toEqual([{ metadata: "read" }]);
    expect(calls.map((c) => c.path)).toEqual([PERM]);
  });

  it.each([
    [["admin", "maintain", "push", "triage", "pull"], "admin"],
    [["maintain", "push", "triage", "pull"], "maintain"],
    [["triage", "pull"], "triage"],
    [["pull"], "read"],
    [[], "none"],
  ])("maps user.permissions %j to %s (legacy permission is ignored when booleans are present)", async (on, level) => {
    // The legacy field folds maintain into write and triage into read; the booleans don't.
    const { client } = fakeGitHub(({ path }) => (path === PERM ? answer("read", bools(on)) : undefined));
    expect((await new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).level).toBe(
      level,
    );
  });

  it("ranks a custom role by its booleans, and falls back to the legacy permission without them", async () => {
    const custom = fakeGitHub(({ path }) =>
      path === PERM ? answer("write", bools(["push", "triage", "pull"]), 42, { role_name: "release-bot" }) : undefined,
    );
    expect(
      (await new GitHubReviewHost(custom.client).repositoryPermission(REPO, { id: "42", login: "octo" })).level,
    ).toBe("write");
    for (const [legacy, level] of [
      ["admin", "admin"],
      ["write", "write"],
      ["read", "read"],
      ["none", "none"],
      ["weird", "none"],
    ]) {
      const { client } = fakeGitHub(({ path }) => (path === PERM ? answer(legacy, undefined) : undefined));
      expect((await new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).level).toBe(
        level,
      );
    }
  });

  it("treats a 404 as none when the login still belongs to the same user", async () => {
    const { client, calls } = fakeGitHub(({ path }) => {
      if (path === PERM) return json({ message: "Not Found" }, 404);
      if (path === "/user/42") return json({ id: 42, login: "octo", type: "User" });
      return undefined;
    });
    await expect(new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).resolves.toEqual(
      { level: "none", login: "octo" },
    );
    expect(calls.map((c) => c.path)).toEqual([PERM, "/user/42"]);
  });

  it("re-resolves a renamed user by id and retries once, returning the new login", async () => {
    const { client, calls } = fakeGitHub(({ path }) => {
      if (path === PERM) return json({ message: "Not Found" }, 404);
      if (path === "/user/42") return json({ id: 42, login: "octo-renamed", type: "User" });
      if (path === `${BASE}/collaborators/octo-renamed/permission`)
        return json({ permission: "admin", user: { id: 42, login: "octo-renamed", permissions: bools(["admin"]) } });
      return undefined;
    });
    await expect(new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).resolves.toEqual(
      { level: "admin", login: "octo-renamed" },
    );
    expect(calls).toHaveLength(3);
  });

  it("never trusts an answer for a different user id: re-resolves, and fails closed if it still differs", async () => {
    // The login was recycled by another account: the answer is about someone else.
    const { client } = fakeGitHub(({ path }) => {
      if (path === PERM) return answer("admin", bools(["admin"]), 999);
      if (path === "/user/42") return json({ id: 42, login: "octo", type: "User" });
      return undefined;
    });
    await expect(new GitHubReviewHost(client).repositoryPermission(REPO, { id: "42", login: "octo" })).resolves.toEqual(
      { level: "none", login: "octo" },
    );
  });

  it("is none when the user account no longer exists, and an API error is a ReviewHostError", async () => {
    const gone = fakeGitHub(({ path }) => {
      if (path === PERM) return json({}, 404);
      if (path === "/user/42") return json({}, 404);
      return undefined;
    });
    expect(
      (await new GitHubReviewHost(gone.client).repositoryPermission(REPO, { id: "42", login: "octo" })).level,
    ).toBe("none");
    const broken = fakeGitHub(({ path }) => (path === PERM ? json({}, 500) : undefined));
    await expect(
      new GitHubReviewHost(broken.client).repositoryPermission(REPO, { id: "42", login: "octo" }),
    ).rejects.toMatchObject({ name: "ReviewHostError", code: "host_api_error" });
  });

  it("refuses a malformed user id or login without calling GitHub", async () => {
    const { client, calls } = fakeGitHub(() => undefined);
    const host = new GitHubReviewHost(client);
    await expect(host.repositoryPermission(REPO, { id: "abc", login: "octo" })).rejects.toThrow();
    await expect(host.repositoryPermission(REPO, { id: "42", login: "../../x" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
