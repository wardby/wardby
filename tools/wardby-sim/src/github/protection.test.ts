import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GITHUB_GIT_PREFIX } from "./git.js";
import { githubHarness, OWNER, REPO, type Harness } from "./harness.test-support.js";
import { closingIssueNumbers } from "./protection.js";

const R = `/repos/${REPO}`;
let h: Harness;
beforeEach(async () => {
  h = await githubHarness();
});
afterEach(async () => {
  h.gh.git.dispose();
  await h.sim.close();
});

async function prWith(files: Record<string, string>, body = "Adds things", head = "feature"): Promise<{ sha: string }> {
  const [commit] = (await h.script([
    { action: "github.commit", repo: REPO, branch: head, files, message: "first change" },
    { action: "github.pull", repo: REPO, head, title: "Feature", body, author: "dev" },
  ])) as { sha: string }[];
  return commit;
}

async function protect(rule: Record<string, unknown>): Promise<void> {
  await h.script([{ action: "github.protect", repo: REPO, branch: "main", ...rule }]);
}

async function merge(number: number, method = "merge", author = OWNER): Promise<{ status: number; body: any }> {
  const response = await h.sim.dispatch(
    (await import("../server.js")).simRequest("POST", "/__sim/script", {
      steps: [{ action: "github.merge", repo: REPO, number, method, author }],
    }),
  );
  const parsed = JSON.parse(String(response.body));
  return parsed.results[0];
}

describe("GitHub sim branch protection", () => {
  it("refuses a merge while a required check is missing, pending or failing, and without approval", async () => {
    const { sha } = await prWith({ "b.txt": "b\n" });
    await protect({ requiredChecks: ["ci", "wardby review"], requiredApprovals: 1 });
    let result = await merge(1);
    expect(result).toMatchObject({ status: 405 });
    expect(result.body.blockers).toEqual([
      'Required status check "ci" is expected.',
      'Required status check "wardby review" is expected.',
      "At least 1 approving review is required by reviewers with write access.",
    ]);
    await h.script([
      { action: "github.check", repo: REPO, ref: sha, name: "ci", status: "in_progress" },
      { action: "github.status", repo: REPO, ref: sha, context: "wardby review", state: "failure" },
    ]);
    result = await merge(1);
    expect(result.body.blockers.slice(0, 2)).toEqual([
      'Required status check "ci" is not successful.',
      'Required status check "wardby review" is not successful.',
    ]);
    await h.script([
      { action: "github.check", repo: REPO, ref: sha, name: "ci", conclusion: "success" },
      { action: "github.status", repo: REPO, ref: sha, context: "wardby review", state: "success" },
      { action: "github.review", repo: REPO, number: 1, author: "reviewer", event: "REQUEST_CHANGES", body: "no" },
    ]);
    result = await merge(1);
    expect(result.body.blockers).toEqual([
      "Changes must be made if a reviewer requests changes.",
      "At least 1 approving review is required by reviewers with write access.",
    ]);
    await h.script([{ action: "github.review", repo: REPO, number: 1, author: "reviewer", event: "APPROVE" }]);
    result = await merge(1);
    expect(result).toMatchObject({ status: 200, body: { merged: true } });
  });

  it("refuses a draft and a conflicting PR; the author's own approval does not count", async () => {
    await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "README.md": "feature side\n" } },
    ]);
    await h.script([{ action: "github.pull", repo: REPO, head: "feature", title: "F", author: "dev", draft: true }]);
    expect((await merge(1)).body.message).toBe("Pull Request is still a draft");
    await h.script([{ action: "github.commit", repo: REPO, branch: "main", files: { "README.md": "main side\n" } }]);
    h.gh.pull(REPO, 1)!.draft = false;
    expect((await merge(1)).body.message).toBe("Pull Request is not mergeable");
    await prWith({ "z.txt": "z\n" }, "x", "other");
    await protect({ requiredApprovals: 1 });
    await h.script([{ action: "github.review", repo: REPO, number: 2, author: "dev", event: "APPROVE" }]);
    expect((await merge(2)).status).toBe(405);
  });

  it("a merge commit has two parents; a squash one, with the PR title; both fire closed+merged and push", async () => {
    await prWith({ "b.txt": "b\n" });
    await h.script([
      {
        action: "github.webhook_subscribe",
        url: "http://127.0.0.1:9/x",
        secret: "s",
        events: ["pull_request", "push"],
      },
      { action: "github.webhook_pause" },
    ]);
    const merged = await merge(1, "merge");
    const mergeCommit = (await h.gh.git.commitInfo(REPO, merged.body.sha))!;
    expect(mergeCommit.parents).toHaveLength(2);
    expect(mergeCommit.message).toMatch(/^Merge pull request #1 from acme\/feature/);
    expect(await h.gh.git.resolve(REPO, "main")).toBe(merged.body.sha);
    const deliveries = ((await h.script([{ action: "github.webhook_deliveries" }]))[0] as { deliveries: any[] })
      .deliveries;
    const closed = deliveries.find((d) => d.event === "pull_request" && d.action === "closed");
    expect(JSON.parse(closed.body).pull_request).toMatchObject({
      merged: true,
      state: "closed",
      merge_commit_sha: merged.body.sha,
    });
    expect(deliveries.at(-1)).toMatchObject({ event: "push" });

    await prWith({ "c.txt": "c\n" }, "body", "second");
    const squashed = await merge(2, "squash");
    const squash = (await h.gh.git.commitInfo(REPO, squashed.body.sha))!;
    expect(squash.parents).toEqual([merged.body.sha]);
    expect(squash.message.split("\n")[0]).toBe("Feature (#2)");
    const token = await h.mint({ pull_requests: "read" });
    const pr = await h.call("GET", `${R}/pulls/2`, undefined, { token });
    expect(pr.body).toMatchObject({ merged: true, state: "closed", merge_commit_sha: squashed.body.sha });
    // The merged PR still lists the files it merged.
    expect((await h.call("GET", `${R}/pulls/2/files`, undefined, { token })).body.map((f: any) => f.filename)).toEqual([
      "c.txt",
    ]);
  });

  it("refuses a merge whose head moved since the given sha (409), and answers PUT /merge with Contents: write", async () => {
    await prWith({ "b.txt": "b\n" });
    const token = await h.mint({ contents: "write" });
    const stale = await h.call("PUT", `${R}/pulls/1/merge`, { merge_method: "squash", sha: "0".repeat(40) }, { token });
    expect(stale.status).toBe(409);
    const readOnly = await h.mint({ contents: "read" });
    expect((await h.call("PUT", `${R}/pulls/1/merge`, { merge_method: "squash" }, { token: readOnly })).status).toBe(
      403,
    );
    expect((await h.call("PUT", `${R}/pulls/1/merge`, { merge_method: "rebase" }, { token })).status).toBe(405);
    const ok = await h.call("PUT", `${R}/pulls/1/merge`, { merge_method: "squash" }, { token });
    expect(ok).toMatchObject({ status: 200, body: { merged: true } });
  });

  it("closes issues named with GitHub's closing keywords on the default branch, and nothing for 'From issue #N'", async () => {
    await h.script([
      { action: "github.issue", repo: REPO, title: "one", author: "dev" },
      { action: "github.issue", repo: REPO, title: "two", author: "dev" },
      { action: "github.issue", repo: REPO, title: "three", author: "dev" },
    ]);
    await prWith({ "b.txt": "b\n" }, "From issue #1\n\nResolves #2\nfixes acme/widgets#3\nCloses other/repo#1");
    await merge(4, "squash");
    const token = await h.mint({ issues: "read" });
    const state = async (n: number) => (await h.call("GET", `${R}/issues/${n}`, undefined, { token })).body;
    expect((await state(1)).state).toBe("open");
    expect(await state(2)).toMatchObject({ state: "closed", state_reason: "completed" });
    expect((await state(3)).state).toBe("closed");
  });

  it("parses every closing keyword form, case-insensitively, and nothing else", () => {
    const repo = h.gh.repo(REPO)!;
    for (const keyword of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
      "Closes",
      "FIXES",
      "Resolves:",
    ]) {
      expect(closingIssueNumbers(`${keyword} #7`, repo), keyword).toEqual([7]);
    }
    for (const text of [
      "From issue #7",
      "refs #7",
      "closes#7",
      "see closes",
      "fixing #7",
      "acme/other#7 fixes",
      "closes acme/other#7",
    ]) {
      expect(closingIssueNumbers(text, repo), text).toEqual([]);
    }
  });

  it("dismisses stale approvals on push, and auto-merges once green", async () => {
    const { sha } = await prWith({ "b.txt": "b\n" });
    await protect({ requiredChecks: ["ci"], requiredApprovals: 1, dismissStaleReviews: true });
    await h.script([{ action: "github.review", repo: REPO, number: 1, author: "reviewer", event: "APPROVE" }]);
    const [next] = (await h.script([
      { action: "github.commit", repo: REPO, branch: "feature", files: { "b.txt": "c\n" } },
    ])) as { sha: string }[];
    expect([...h.gh.reviews.values()][0].state).toBe("DISMISSED");
    await h.script([{ action: "github.auto_merge", repo: REPO, number: 1, method: "squash", author: "dev" }]);
    await h.script([{ action: "github.check", repo: REPO, ref: next.sha, name: "ci", conclusion: "success" }]);
    expect(h.gh.pull(REPO, 1)!.merged).toBe(false);
    await h.script([{ action: "github.review", repo: REPO, number: 1, author: "reviewer", event: "APPROVE" }]);
    expect(h.gh.pull(REPO, 1)!.merged).toBe(true);
    expect(h.gh.pull(REPO, 1)!.mergedBy?.login).toBe("dev");
    void sha;
  });

  it("refuses a push straight to a branch whose protection blocks pushes (GH006)", async () => {
    await protect({ blockPushes: true });
    const url = `${await h.sim.listen()}${GITHUB_GIT_PREFIX}/${REPO}.git`;
    const token = await h.mint({ contents: "write" });
    const work = mkdtempSync(join(tmpdir(), "wardby-sim-protect-"));
    const auth = [
      "-c",
      `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    ];
    const run = (cwd: string, args: string[]) =>
      new Promise<{ code: number; stderr: string }>((resolve) =>
        execFile(
          "git",
          [...auth, "-c", "user.name=S", "-c", "user.email=s@x.invalid", ...args],
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: tmpdir(),
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
          (e, _o, stderr) => resolve({ code: e ? 1 : 0, stderr }),
        ),
      );
    try {
      expect((await run(work, ["clone", url, "r"])).code).toBe(0);
      const repo = join(work, "r");
      writeFileSync(join(repo, "x.txt"), "x\n");
      await run(repo, ["add", "x.txt"]);
      await run(repo, ["commit", "-m", "direct"]);
      const before = await h.gh.git.resolve(REPO, "main");
      const pushed = await run(repo, ["push", "origin", "main"]);
      expect(pushed.code).not.toBe(0);
      expect(pushed.stderr).toContain("GH006: Protected branch update failed for refs/heads/main.");
      expect(await h.gh.git.resolve(REPO, "main")).toBe(before);
      // Another branch still takes pushes.
      await run(repo, ["checkout", "-b", "topic"]);
      expect((await run(repo, ["push", "origin", "topic"])).code).toBe(0);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
