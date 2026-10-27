// TEST ONLY (wardby-sim). The branch-protection emulator: what a person (or auto-merge) can
// merge, and what merging does.
//
// - Per-branch rules: required checks (check run names or status contexts that must conclude
//   success, neutral or skipped on the head), required approving reviews, stale-approval
//   dismissal on push, and a push block (the pre-receive hook in git.ts).
// - `PUT /repos/{owner}/{repo}/pulls/{number}/merge` (merge or squash) only when green;
//   auto-merge merges as soon as a PR becomes green.
// - A merge fires `pull_request.closed` (merged: true) and `push`, and closes the issues the
//   PR names with GitHub's closing keywords (close/closes/closed, fix/fixes/fixed,
//   resolve/resolves/resolved, before #N or owner/repo#N) when it lands on the default
//   branch. "From issue #N" closes nothing.
//
// Messages follow GitHub's documented wording where known; unverified (routes.ts).
import { json, jsonBody, record, textOf, type SimRequest, type SimResponse } from "../http.js";
import type { RouteContext } from "../service.js";
import { writeProtectionHook } from "./git.js";
import { installationCaller, notFound, pullBody, latestStatuses } from "./rest.js";
import { issueJson } from "./shapes.js";
import type { BranchProtection, GitHubState, SimPull, SimRepo, SimUser } from "./state.js";

const GREEN = new Set(["success", "neutral", "skipped"]);
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/gi;

export function protectionKey(repo: SimRepo, branch: string): string {
  return `${repo.fullName.toLowerCase()}:${branch}`;
}

export function setProtection(gh: GitHubState, repo: SimRepo, branch: string, rule: BranchProtection): void {
  gh.protection.set(protectionKey(repo, branch), rule);
  writeProtectionHook(gh, repo.fullName);
}

/** Issue numbers in this repository that `text` closes with a closing keyword. */
export function closingIssueNumbers(text: string, repo: SimRepo): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(CLOSING)) {
    if (match[1] && match[1].toLowerCase() !== repo.fullName.toLowerCase()) continue;
    numbers.add(Number(match[2]));
  }
  return [...numbers];
}

/** Why the PR cannot merge right now; empty when it can. */
export async function mergeBlockers(gh: GitHubState, pull: SimPull): Promise<string[]> {
  const repo = gh.repo(pull.repo)!;
  if (pull.state !== "open") return ["Pull Request is not mergeable"];
  if (pull.draft) return ["Pull Request is still a draft"];
  const head = await gh.headSha(pull);
  const base = await gh.git.resolve(repo.fullName, `refs/heads/${pull.baseRef}`);
  if (!head || !base) return ["Pull Request is not mergeable"];
  if ((await gh.git.mergeTree(repo.fullName, base, head)) === null) return ["Pull Request is not mergeable"];
  const rule = gh.protection.get(protectionKey(repo, pull.baseRef));
  if (!rule) return [];
  const blockers: string[] = [];
  const runs = [...gh.checkRuns.values()]
    .filter((r) => r.repo === pull.repo && r.headSha === head)
    .sort((a, b) => b.id - a.id);
  const statuses = latestStatuses(gh, repo, head);
  for (const name of rule.requiredChecks) {
    const run = runs.find((r) => r.name === name);
    const status = statuses.find((s) => s.context === name);
    const green = run ? run.status === "completed" && GREEN.has(run.conclusion ?? "") : status?.state === "success";
    if (!green) blockers.push(`Required status check "${name}" is ${run || status ? "not successful" : "expected"}.`);
  }
  if (rule.requiredApprovals > 0) {
    const latest = new Map<string, string>();
    for (const review of [...gh.reviews.values()]
      .filter((r) => r.repo === pull.repo && r.pull === pull.number)
      .sort((a, b) => a.id - b.id)) {
      if (review.user.login === pull.user.login || review.state === "COMMENTED") continue;
      latest.set(review.user.login, review.state);
    }
    const approvals = [...latest.values()].filter((s) => s === "APPROVED").length;
    if ([...latest.values()].includes("CHANGES_REQUESTED"))
      blockers.push("Changes must be made if a reviewer requests changes.");
    if (approvals < rule.requiredApprovals) {
      blockers.push(
        `At least ${rule.requiredApprovals} approving review${rule.requiredApprovals === 1 ? " is" : "s are"} required by reviewers with write access.`,
      );
    }
  }
  return blockers;
}

export interface MergeResult {
  status: number;
  body: Record<string, unknown>;
}

/** Merges like GitHub's merge button, when green. */
export async function mergePull(
  gh: GitHubState,
  pull: SimPull,
  input: { method: string; sha?: string; title?: string; message?: string; mergedBy: SimUser },
): Promise<MergeResult> {
  const repo = gh.repo(pull.repo)!;
  if (input.method !== "merge" && input.method !== "squash") {
    return { status: 405, body: { message: `The simulator does not support ${input.method} merges` } };
  }
  const head = await gh.headSha(pull);
  if (input.sha && head !== input.sha) {
    return { status: 409, body: { message: "Head branch was modified. Review and try the merge again." } };
  }
  const blockers = await mergeBlockers(gh, pull);
  if (blockers.length > 0) return { status: 405, body: { message: blockers[0], blockers } };
  const base = (await gh.git.resolve(repo.fullName, `refs/heads/${pull.baseRef}`))!;
  const tree = (await gh.git.mergeTree(repo.fullName, base, head!))!;
  const commits = await gh.git.commitsBetween(
    repo.fullName,
    (await gh.git.mergeBase(repo.fullName, base, head!))!,
    head!,
  );
  const title =
    input.title ??
    (input.method === "squash"
      ? `${pull.title} (#${pull.number})`
      : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
  const message =
    input.message ?? (input.method === "squash" ? commits.map((c) => `* ${c.message}`).join("\n\n") : pull.title);
  const author = { name: input.mergedBy.login, email: `${input.mergedBy.login}@users.noreply.github.com` };
  const sha = await gh.git.commitTree(
    repo.fullName,
    tree,
    input.method === "squash" ? [base] : [base, head!],
    `${title}\n\n${message}`,
    pull.baseRef,
    base,
    author,
  );
  const now = gh.iso();
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.mergedBy = input.mergedBy;
  pull.headShaAtClose = head;
  pull.state = "closed";
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.autoMerge = null;
  const twin = gh.issue(repo.fullName, pull.number)!;
  twin.state = "closed";
  twin.closedAt = now;
  twin.updatedAt = now;
  gh.emit(
    "pull_request",
    { action: "closed", number: pull.number, pull_request: await pullBody(gh, pull) },
    repo,
    input.mergedBy,
  );
  await gh.pushed(repo, pull.baseRef, base, sha, input.mergedBy);
  if (pull.baseRef === repo.defaultBranch) {
    const texts = [pull.body ?? "", `${title}\n\n${message}`, ...commits.map((c) => c.message)];
    const numbers = new Set(texts.flatMap((text) => closingIssueNumbers(text, repo)));
    for (const number of numbers) {
      const issue = gh.issue(repo.fullName, number);
      if (!issue || issue.isPull || issue.state === "closed") continue;
      issue.state = "closed";
      issue.stateReason = "completed";
      issue.closedAt = now;
      issue.updatedAt = now;
      gh.emit("issues", { action: "closed", issue: issueJson(gh, issue) }, repo, input.mergedBy);
    }
  }
  return { status: 200, body: { sha, merged: true, message: "Pull Request successfully merged" } };
}

/** Merges every auto-merge PR that has become green (called on check, review and push changes). */
export async function runAutoMerge(gh: GitHubState, repo: SimRepo): Promise<void> {
  for (const pull of [...gh.pulls.values()]) {
    if (pull.repo !== repo.fullName.toLowerCase() || pull.state !== "open" || !pull.autoMerge) continue;
    if ((await mergeBlockers(gh, pull)).length > 0) continue;
    await mergePull(gh, pull, { method: pull.autoMerge.method, mergedBy: pull.autoMergeBy ?? pull.user });
  }
}

/** On a push to a PR head: dismiss stale approvals where the base's rule says so. */
export async function dismissStaleReviews(gh: GitHubState, repo: SimRepo, branch: string): Promise<void> {
  for (const pull of gh.pulls.values()) {
    if (pull.repo !== repo.fullName.toLowerCase() || pull.state !== "open" || pull.headRef !== branch) continue;
    const rule = gh.protection.get(protectionKey(repo, pull.baseRef));
    if (!rule?.dismissStaleReviews) continue;
    const head = await gh.headSha(pull);
    for (const review of gh.reviews.values()) {
      if (
        review.repo === pull.repo &&
        review.pull === pull.number &&
        review.state === "APPROVED" &&
        review.commitId !== head
      ) {
        review.state = "DISMISSED";
      }
    }
  }
}

export function wireProtection(gh: GitHubState): void {
  gh.pushListeners.push(async (repo, branch) => {
    await dismissStaleReviews(gh, repo, branch);
    await runAutoMerge(gh, repo);
  });
  gh.checkListeners.push(async (repo) => {
    await runAutoMerge(gh, repo);
  });
  gh.reviewListeners.push(async (repo) => {
    await runAutoMerge(gh, repo);
  });
}

/** PUT /repos/{owner}/{repo}/pulls/{number}/merge, with an installation token (Contents: write). */
export async function mergeRoute(
  gh: GitHubState,
  req: SimRequest,
  params: Record<string, string>,
  ctx: RouteContext,
): Promise<SimResponse> {
  const repo = gh.repo(`${params.owner}/${params.repo}`);
  const caller = installationCaller(gh, req, ctx, repo, { contents: "write" });
  if ("status" in caller) return caller;
  const pull = gh.pull(repo!.fullName, Number(params.number));
  if (!pull) return notFound();
  const body = record(jsonBody(req));
  const result = await mergePull(gh, pull, {
    method: textOf(body.merge_method, "merge"),
    ...(typeof body.sha === "string" ? { sha: body.sha } : {}),
    ...(typeof body.commit_title === "string" ? { title: body.commit_title } : {}),
    ...(typeof body.commit_message === "string" ? { message: body.commit_message } : {}),
    mergedBy: caller.user,
  });
  return json(result.body, result.status);
}
