// TEST ONLY (wardby-sim). The events GitHub derives from a branch moving or a check finishing:
//
// - a push: `push` (ref, before/after, commits with added/modified/removed), then
//   `pull_request.synchronize` for every open PR whose head is that branch;
// - a check run or status change: `check_suite.completed` once every run one App has on that
//   commit is completed (GitHub's suite per App and head), listing the open PRs at that head.
import { pullBody } from "./rest.js";
import type { GitHubState, SimRepo, SimUser } from "./state.js";

const ZERO = "0".repeat(40);

export function wireDerivedEvents(gh: GitHubState): void {
  gh.pushListeners.push(async (repo, branch, before, after, pusher) => {
    await emitPush(gh, repo, branch, before, after, pusher);
  });
  gh.checkListeners.push(async (repo, sha) => {
    await emitCheckSuites(gh, repo, sha);
  });
}

async function emitPush(
  gh: GitHubState,
  repo: SimRepo,
  branch: string,
  before: string | null,
  after: string | null,
  pusher: SimUser,
): Promise<void> {
  const commits = [];
  if (after) {
    const infos = before
      ? await gh.git.commitsBetween(repo.fullName, before, after)
      : [(await gh.git.commitInfo(repo.fullName, after))!];
    for (const info of infos.slice(-2048)) {
      const parent = info.parents[0];
      const changed = parent ? await gh.git.diff(repo.fullName, parent, info.sha) : [];
      commits.push({
        id: info.sha,
        tree_id: info.tree,
        message: info.message,
        timestamp: info.date,
        author: { name: info.authorName, email: info.authorEmail },
        added: changed.filter((f) => f.status === "added").map((f) => f.filename),
        modified: changed.filter((f) => f.status === "modified" || f.status === "renamed").map((f) => f.filename),
        removed: changed.filter((f) => f.status === "removed").map((f) => f.filename),
      });
    }
  }
  const forced = before && after ? !(await gh.git.isAncestor(repo.fullName, before, after)) : false;
  gh.emit(
    "push",
    {
      ref: `refs/heads/${branch}`,
      before: before ?? ZERO,
      after: after ?? ZERO,
      created: before === null,
      deleted: after === null,
      forced,
      commits,
      head_commit: commits.at(-1) ?? null,
      pusher: { name: pusher.login, email: `${pusher.login}@users.noreply.github.com` },
    },
    repo,
    pusher,
  );
  if (!after) return;
  for (const pull of gh.pulls.values()) {
    if (pull.repo !== repo.fullName.toLowerCase() || pull.state !== "open" || pull.headRef !== branch) continue;
    pull.updatedAt = gh.iso();
    gh.emit(
      "pull_request",
      {
        action: "synchronize",
        number: pull.number,
        before: before ?? ZERO,
        after,
        pull_request: await pullBody(gh, pull),
      },
      repo,
      pusher,
    );
  }
}

/** Suites already reported completed, so one finished suite is reported once. */
const reported = new WeakMap<GitHubState, Set<string>>();

async function emitCheckSuites(gh: GitHubState, repo: SimRepo, sha: string): Promise<void> {
  const seen = reported.get(gh) ?? new Set<string>();
  reported.set(gh, seen);
  const runs = [...gh.checkRuns.values()].filter((r) => r.repo === repo.fullName.toLowerCase() && r.headSha === sha);
  const byApp = new Map<number, typeof runs>();
  for (const run of runs) byApp.set(run.appId, [...(byApp.get(run.appId) ?? []), run]);
  for (const [appId, appRuns] of byApp) {
    if (appRuns.some((r) => r.status !== "completed")) continue;
    const key = `${repo.fullName.toLowerCase()}:${sha}:${appId}:${appRuns.map((r) => `${r.id}=${r.conclusion}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const conclusions = appRuns.map((r) => r.conclusion);
    const conclusion = conclusions.includes("failure")
      ? "failure"
      : conclusions.includes("cancelled")
        ? "cancelled"
        : conclusions.every((c) => c === "success" || c === "neutral" || c === "skipped")
          ? "success"
          : (conclusions[0] ?? "neutral");
    const pullRequests = [];
    for (const pull of gh.pulls.values()) {
      if (pull.repo !== repo.fullName.toLowerCase() || pull.state !== "open") continue;
      if ((await gh.headSha(pull)) === sha)
        pullRequests.push({ number: pull.number, head: { ref: pull.headRef, sha } });
    }
    gh.emit(
      "check_suite",
      {
        action: "completed",
        check_suite: {
          id: appId * 1_000_000 + appRuns[0].id,
          head_sha: sha,
          status: "completed",
          conclusion,
          app: { id: appId, slug: appId === gh.app.id ? gh.app.slug : `app-${appId}` },
          pull_requests: pullRequests,
        },
      },
      repo,
      gh.botUser(),
    );
  }
}

export function resetDerivedEvents(gh: GitHubState): void {
  reported.delete(gh);
}
