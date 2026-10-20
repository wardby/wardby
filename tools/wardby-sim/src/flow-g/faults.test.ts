// Flow G's first fault variants that need no running wardby: the GitHub side of a PR with
// 1,001 files (bug 2) through wardby's own review host. (A webhook delivered twice, and one
// retried after a 500, are in github/webhooks.test.ts against wardby's real ingress; stop_run at
// finish needs a running wardby and waits for the Flow G runner.)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubReviewHost } from "../../../../src/providers/review-host/github.js";
import { githubHarness, REPO, type Harness } from "../github/harness.test-support.js";

let h: Harness;
beforeEach(async () => {
  h = await githubHarness();
});
afterEach(async () => {
  h.gh.git.dispose();
  await h.sim.close();
});

async function prWithFiles(count: number): Promise<number> {
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i += 1) files[`src/f${String(i).padStart(4, "0")}.ts`] = `export const v${i} = ${i};\n`;
  await h.script([
    { action: "github.commit", repo: REPO, branch: "wide", files },
    { action: "github.pull", repo: REPO, head: "wide", title: "Wide change", author: "acme" },
  ]);
  return 1;
}

describe("a pull request past the review host's file listing (bug 2)", () => {
  it("1,001 files: the read says the list is incomplete", async () => {
    const number = await prWithFiles(1001);
    const view = await new GitHubReviewHost(h.client()).readPullRequest(REPO, number, {
      maxPatchChars: 60_000,
      agentMarker: "reviewer",
    });
    expect(view.fileListComplete).toBe(false);
    expect(view.files.length).toBeLessThanOrEqual(1000);
  }, 60_000);

  it("1,000 files: complete", async () => {
    const number = await prWithFiles(1000);
    const view = await new GitHubReviewHost(h.client()).readPullRequest(REPO, number, {
      maxPatchChars: 60_000,
      agentMarker: "reviewer",
    });
    expect(view.fileListComplete).toBe(true);
    expect(view.files).toHaveLength(1000);
  }, 60_000);
});
