// E-08/H5-4 regression, end to end: the repo_publish_review tool driving the
// real GitHubReviewHost against a faked GitHub API. A review published on a
// PR other than the one the run was dispatched for (a fork PR included) must
// never create or complete a check run.
import { describe, expect, it, vi } from "vitest";
import { GitHubReviewHost } from "../providers/review-host/github.js";
import { fakeGitHub, json, PR, REPO, SHA, type Call } from "../providers/review-host/github.test-support.js";
import { handleReviewHostTool, type ReviewToolContext } from "./review-host-tools.js";

const BASE = "/repos/chfields/knock-knock-jokes";

function github(prNumber: number, fork = false) {
  return fakeGitHub(({ method, path }) => {
    const head = fork ? { ...PR.head, repo: { full_name: "attacker/knock-knock-jokes" } } : PR.head;
    if (method === "GET" && path === `${BASE}/pulls/${prNumber}`) return json({ ...PR, number: prNumber, head });
    if (method === "GET" && path.startsWith(`${BASE}/pulls/${prNumber}/files`)) return json([]);
    if (method === "GET" && path.startsWith(`${BASE}/issues/${prNumber}/comments`)) return json([]);
    if (method === "POST" && path === `${BASE}/issues/${prNumber}/comments`) {
      return json({ id: 5, html_url: `https://github.com/r/pull/${prNumber}#issuecomment-5` }, 201);
    }
    if (method === "POST" && path === `${BASE}/check-runs`) return json({ id: 99 }, 201);
    if (method === "PATCH" && path.startsWith(`${BASE}/check-runs/`)) return json({ id: 11 });
    return undefined;
  });
}

function ctx(host: GitHubReviewHost, runCheck: ReviewToolContext["runCheck"]): ReviewToolContext {
  return {
    agentId: "agent1",
    links: [{ provider: "github", repository: REPO, access: "write", checkName: "wardby review" }],
    hosts: { github: host },
    runCheck,
    markRunCheckCompleted: vi.fn(async () => undefined),
    authorize: vi.fn(async () => ({ ok: true as const })),
  };
}

const publish = (prNumber: number) =>
  JSON.stringify({ repository: REPO, prNumber, headSha: SHA, verdict: "APPROVE", summary: "ok", body: "fine" });

const checkRunWrites = (calls: Call[]) => calls.filter((c) => c.path.startsWith(`${BASE}/check-runs`));

describe("repo_publish_review against GitHub (E-08)", () => {
  const dispatchedFor7 = { provider: "github", repository: REPO, checkId: "11", headSha: SHA, prNumber: 7 };

  it("posts no check run for a PR the run was not dispatched for, fork or not", async () => {
    for (const fork of [false, true]) {
      const { client, calls } = github(8, fork);
      const result = JSON.parse(
        await handleReviewHostTool(
          "repo_publish_review",
          publish(8),
          ctx(new GitHubReviewHost(client), dispatchedFor7),
        ),
      );
      expect(result).toMatchObject({ published: true, checkId: null });
      expect(checkRunWrites(calls)).toEqual([]);
    }
  });

  it("posts no check run from a run with no check of its own (a manual or scheduled run)", async () => {
    const { client, calls } = github(7);
    await handleReviewHostTool("repo_publish_review", publish(7), ctx(new GitHubReviewHost(client), null));
    expect(checkRunWrites(calls)).toEqual([]);
  });

  it("completes the run's own check on the dispatched PR's current head, as before", async () => {
    const { client, calls } = github(7);
    const result = JSON.parse(
      await handleReviewHostTool("repo_publish_review", publish(7), ctx(new GitHubReviewHost(client), dispatchedFor7)),
    );
    expect(result).toMatchObject({ published: true, checkId: "11", checkConclusion: "success" });
    expect(checkRunWrites(calls).map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH ${BASE}/check-runs/11`]);
  });

  it("creates a new check on the dispatched PR's newer head, after superseding the old one", async () => {
    const { client, calls } = github(7);
    const stale = { ...dispatchedFor7, headSha: "89abcdef0123456789abcdef0123456789abcdef" };
    await handleReviewHostTool("repo_publish_review", publish(7), ctx(new GitHubReviewHost(client), stale));
    expect(checkRunWrites(calls).map((c) => `${c.method} ${c.path}`)).toEqual([
      `PATCH ${BASE}/check-runs/11`,
      `POST ${BASE}/check-runs`,
    ]);
  });
});
