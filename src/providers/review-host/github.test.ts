// src/providers/review-host/github.test.ts
import { describe, expect, it } from "vitest";
import type { GitHubAppClient } from "../vcs/github.js";
import { GitHubReviewHost } from "./github.js";
import { fakeGitHub, json, OLD_SHA, PATCH, PR, REPO, SHA } from "./github.test-support.js";
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
          { id: 1, body: `${reviewMarker("other", OLD_SHA)}\nnot mine` },
          { id: 2, body: `${reviewMarker("agent1", OLD_SHA)}\nmine` },
        ]);
      }
      return undefined;
    });
    const view = await new GitHubReviewHost(client).readPullRequest(REPO, 7, {
      maxPatchChars: PATCH.length + 5,
      agentMarker: "agent1",
    });
    expect(grants).toEqual([{ contents: "read", pull_requests: "read" }]);
    expect(view).toMatchObject({ number: 7, headSha: SHA, isFork: false, lastReviewedSha: OLD_SHA, comparedFrom: null });
    expect(view.files[0]).toMatchObject({ patch: PATCH, patchTruncated: false });
    expect(view.files[1]).toMatchObject({ patch: PATCH.slice(0, 5), patchTruncated: true });
  });

  it("uses the compare API when sinceSha is an ancestor of the head", async () => {
    const { client } = fakeGitHub(({ path }) => {
      if (path === `${BASE}/pulls/7`) return json(PR);
      if (path === `${BASE}/compare/${OLD_SHA}...${SHA}`) {
        return json({ status: "ahead", files: [{ filename: "c.py", status: "modified", additions: 1, deletions: 0, patch: PATCH }] });
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
    expect(view.files.map((f) => f.filename)).toEqual(["c.py"]);
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
