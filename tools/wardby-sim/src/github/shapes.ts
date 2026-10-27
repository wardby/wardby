// TEST ONLY (wardby-sim). GitHub's JSON shapes for the simulated objects, shared by the REST
// routes and the webhook payloads. Only the fields wardby reads, plus the identifying ones a
// test asserts on; html URLs are github.com's, as the real API returns them.
import type {
  GitHubState,
  SimCheckRun,
  SimComment,
  SimIssue,
  SimPull,
  SimRepo,
  SimReview,
  SimReviewComment,
  SimUser,
} from "./state.js";

export const WEB = "https://github.com";

export function userJson(user: SimUser): Record<string, unknown> {
  return { login: user.login, id: user.id, node_id: `U_${user.id}`, type: user.type, site_admin: false };
}

export function repoJson(gh: GitHubState, repo: SimRepo): Record<string, unknown> {
  const owner = gh.user(repo.owner);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    visibility: repo.private ? "private" : "public",
    owner: userJson(owner),
    html_url: `${WEB}/${repo.fullName}`,
    clone_url: `${WEB}/${repo.fullName}.git`,
    default_branch: repo.defaultBranch,
  };
}

export function appJson(gh: GitHubState): Record<string, unknown> {
  return { id: gh.app.id, slug: gh.app.slug, owner: { login: gh.app.ownerLogin }, name: gh.app.slug };
}

export interface PullFacts {
  headSha: string | null;
  baseSha: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  commits: number;
  mergeable: boolean | null;
}

export function pullJson(gh: GitHubState, pull: SimPull, facts: PullFacts): Record<string, unknown> {
  const repo = gh.repo(pull.repo)!;
  const html = `${WEB}/${repo.fullName}/pull/${pull.number}`;
  const comments = [...gh.comments.values()].filter(
    (c) => c.repo === repo.fullName.toLowerCase() && c.issueNumber === pull.number,
  ).length;
  const reviewComments = [...gh.reviewComments.values()].filter(
    (c) => c.repo === repo.fullName.toLowerCase() && c.pull === pull.number,
  ).length;
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    html_url: html,
    url: `https://api.github.com/repos/${repo.fullName}/pulls/${pull.number}`,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    labels: pull.labels.map((name) => ({ name })),
    draft: pull.draft,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merged_by: pull.mergedBy ? userJson(pull.mergedBy) : null,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: facts.mergeable,
    mergeable_state: pull.state === "closed" ? "unknown" : facts.mergeable === false ? "dirty" : "clean",
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: facts.headSha,
      user: userJson(gh.user(repo.owner)),
      repo: repoJson(gh, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: facts.baseSha,
      user: userJson(gh.user(repo.owner)),
      repo: repoJson(gh, repo),
    },
    author_association: gh.association(repo, pull.user.login),
    auto_merge: pull.autoMerge ? { merge_method: pull.autoMerge.method } : null,
    comments,
    review_comments: reviewComments,
    commits: facts.commits,
    additions: facts.additions,
    deletions: facts.deletions,
    changed_files: facts.changedFiles,
  };
}

export function issueJson(gh: GitHubState, issue: SimIssue): Record<string, unknown> {
  const repo = gh.repo(issue.repo)!;
  const comments = [...gh.comments.values()].filter(
    (c) => c.repo === repo.fullName.toLowerCase() && c.issueNumber === issue.number,
  ).length;
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    html_url: `${WEB}/${repo.fullName}/${issue.isPull ? "pull" : "issues"}/${issue.number}`,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.stateReason,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => ({ name })),
    comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: gh.association(repo, issue.user.login),
    ...(issue.isPull
      ? {
          pull_request: {
            url: `https://api.github.com/repos/${repo.fullName}/pulls/${issue.number}`,
            html_url: `${WEB}/${repo.fullName}/pull/${issue.number}`,
          },
        }
      : {}),
  };
}

export function commentJson(gh: GitHubState, comment: SimComment): Record<string, unknown> {
  const repo = gh.repo(comment.repo)!;
  const issue = gh.issue(comment.repo, comment.issueNumber);
  const kind = issue?.isPull ? "pull" : "issues";
  return {
    id: comment.id,
    node_id: comment.nodeId,
    html_url: `${WEB}/${repo.fullName}/${kind}/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `https://api.github.com/repos/${repo.fullName}/issues/${comment.issueNumber}`,
    body: comment.body,
    user: userJson(comment.user),
    author_association: comment.authorAssociation,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    performed_via_github_app: comment.viaApp !== null ? { id: comment.viaApp, slug: gh.app.slug } : null,
  };
}

export function reviewJson(gh: GitHubState, review: SimReview): Record<string, unknown> {
  const repo = gh.repo(review.repo)!;
  return {
    id: review.id,
    node_id: review.nodeId,
    user: userJson(review.user),
    body: review.body,
    state: review.state,
    commit_id: review.commitId,
    submitted_at: review.submittedAt,
    html_url: `${WEB}/${repo.fullName}/pull/${review.pull}#pullrequestreview-${review.id}`,
    author_association: gh.association(repo, review.user.login),
  };
}

export function reviewCommentJson(gh: GitHubState, comment: SimReviewComment): Record<string, unknown> {
  const repo = gh.repo(comment.repo)!;
  return {
    id: comment.id,
    node_id: comment.nodeId,
    pull_request_review_id: comment.reviewId,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
    user: userJson(comment.user),
    commit_id: comment.commitId,
    in_reply_to_id: comment.inReplyTo ?? undefined,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `${WEB}/${repo.fullName}/pull/${comment.pull}#discussion_r${comment.id}`,
    author_association: gh.association(repo, comment.user.login),
    performed_via_github_app: comment.viaApp !== null ? { id: comment.viaApp, slug: gh.app.slug } : null,
  };
}

export function checkRunJson(gh: GitHubState, run: SimCheckRun): Record<string, unknown> {
  const repo = gh.repo(run.repo)!;
  return {
    id: run.id,
    head_sha: run.headSha,
    external_id: run.externalId,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    details_url: run.detailsUrl,
    html_url: `${WEB}/${repo.fullName}/runs/${run.id}`,
    started_at: run.startedAt,
    completed_at: run.completedAt,
    output: { ...run.output, annotations_count: 0 },
    app: { id: run.appId, slug: run.appId === gh.app.id ? gh.app.slug : `app-${run.appId}` },
  };
}
