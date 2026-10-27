// Flow G's checks against a call log recorded by driving the simulator with wardby's own GitHub
// client and review host through G2–G8's GitHub side (the agents and the control plane are not
// in the loop here; the Flow G runner on kind provides those).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHubReviewHost } from "../../../../src/providers/review-host/github.js";
import { githubHarness, REPO, type Harness } from "../github/harness.test-support.js";
import {
  checkAcknowledged,
  checkMarkedReady,
  checkMergedOutcome,
  checkNoSecrets,
  checkPullRequestOpened,
  checkReviewPublished,
  checkRunsStarted,
  checkWroteNothing,
  unverifiedEventsUsed,
  unverifiedRoutesUsed,
  type Inspect,
} from "./checks.js";

let h: Harness;
beforeEach(async () => {
  h = await githubHarness();
});
afterEach(async () => {
  h.gh.git.dispose();
  await h.sim.close();
});

async function inspect(): Promise<Inspect> {
  return (await h.script([{ action: "github.inspect", repo: REPO }]))[0] as Inspect;
}

/** G2–G8's GitHub writes, made by wardby's own client code against the simulator. */
/** Runs the dry run; answers the call-log position at the end of G2 (the runner checks each stage on its own slice). */
async function dryRun(options: { statusComments?: number; leak?: string } = {}): Promise<number> {
  await h.script([
    { action: "github.webhook_subscribe", url: "http://127.0.0.1:9/never", secret: "s".repeat(24) },
    { action: "github.webhook_pause" },
    { action: "github.collaborator", repo: REPO, login: "dev", role: "write" },
    { action: "github.issue", repo: REPO, title: "Add a joke", author: "dev" },
  ]);
  const client = h.client();
  const host = new GitHubReviewHost(client);
  await host.acknowledge(REPO, { kind: "subject", id: "1" });
  for (let i = 0; i < (options.statusComments ?? 1); i += 1) {
    await host.comment(REPO, { number: 1, body: `Working on it.${options.leak ? ` ${options.leak}` : ""}` });
  }
  const afterG2 = h.sim.state.calls.list().at(-1)!.seq;
  await h.script([
    { action: "github.commit", repo: REPO, branch: "wardby/run-r1", files: { "jokes/flow-g.txt": "Knock knock.\n" } },
  ]);
  const pr = await client.createOrFindDraftPullRequest({
    runId: "r1",
    repository: REPO,
    baseRef: "main",
    headRef: "wardby/run-r1",
    summary: "Adds a joke.\n\nFrom issue #1",
  });
  const view = await host.readPullRequest(REPO, pr.number, { maxPatchChars: 10_000, agentMarker: "reviewer" });
  const { checkId } = await host.startCheck(REPO, { headSha: view.headSha, name: "wardby review" });
  await host.publishReview(REPO, {
    prNumber: pr.number,
    headSha: view.headSha,
    verdict: "APPROVE",
    summary: "Good",
    body: "Read every file.",
    comments: [],
    agentMarker: "reviewer",
    checkId,
  });
  await host.markReadyForReview(REPO, pr.number, view.headSha, "r1");
  await h.script([{ action: "github.merge", repo: REPO, number: pr.number, method: "squash", author: "dev" }]);
  await host.comment(REPO, { number: 1, body: `Merged in https://github.com/${REPO}/pull/${pr.number}.` });
  return afterG2;
}

describe("Flow G checks over a recorded simulator log", () => {
  it("hold for a clean G2–G8 pass, and list the unverified routes and events it used", async () => {
    const afterG2 = await dryRun();
    const calls = h.sim.state.calls.list();
    const g2 = calls.filter((c) => c.seq <= afterG2);
    const snapshot = await inspect();
    expect(checkRunsStarted(["run1"], 1)).toEqual([]);
    expect(checkAcknowledged(g2, REPO, 1)).toEqual([]);
    expect(checkPullRequestOpened(calls, snapshot, REPO, 1)).toEqual([]);
    expect(checkReviewPublished(snapshot, 2, "wardby review", "success")).toEqual([]);
    expect(checkMarkedReady(calls, snapshot, 2)).toEqual([]);
    expect(checkMergedOutcome(snapshot, REPO, 1, 2, false)).toEqual([]);
    expect(checkNoSecrets(calls, { appToken: "never-written-anywhere-123" })).toEqual([]);
    const routes = unverifiedRoutesUsed(calls).map((r) => `${r.method} ${r.pattern}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        "POST /repos/{owner}/{repo}/pulls",
        "POST /graphql",
        "POST /app/installations/{id}/access_tokens",
      ]),
    );
    const deliveries = (
      (await h.script([{ action: "github.webhook_deliveries" }]))[0] as { deliveries: { event: string }[] }
    ).deliveries;
    expect(unverifiedEventsUsed(deliveries)).toEqual(expect.arrayContaining(["issues", "pull_request", "push"]));
  });

  it("catch a second status comment, a leaked secret, a closed issue and a still-draft PR", async () => {
    const afterG2 = await dryRun({ statusComments: 2, leak: "ghs_leakedTokenValue1234567890abcdef" });
    const calls = h.sim.state.calls.list();
    expect(
      checkAcknowledged(
        calls.filter((c) => c.seq <= afterG2),
        REPO,
        1,
      ),
    ).toEqual(["expected one status comment on #1, got 2"]);
    expect(checkNoSecrets(calls, { installationToken: "ghs_leakedTokenValue1234567890abcdef" })).toEqual([
      `installationToken reached github POST /repos/${REPO}/issues/1/comments`,
      `installationToken reached github POST /repos/${REPO}/issues/1/comments`,
    ]);
    const snapshot = await inspect();
    expect(checkMergedOutcome(snapshot, REPO, 1, 2, true)).toEqual(["issue #1 is open, expected closed"]);
    snapshot.pulls[0].draft = true;
    expect(checkMarkedReady(calls, snapshot, 2)).toEqual(["#2 is still a draft"]);
    expect(checkRunsStarted([], 1)).toEqual(["expected 1 run(s) started, got 0"]);
  });

  it("the outsider check passes on reads only and names every write", async () => {
    const client = h.client();
    await client.appIdentity();
    expect(checkWroteNothing(h.sim.state.calls.list())).toEqual([]);
    await h.script([{ action: "github.issue", repo: REPO, title: "x", author: "dev" }]);
    await new GitHubReviewHost(client).comment(REPO, { number: 1, body: "hi" });
    expect(checkWroteNothing(h.sim.state.calls.list())).toEqual([
      `unexpected write POST /repos/${REPO}/issues/1/comments`,
    ]);
  });
});
