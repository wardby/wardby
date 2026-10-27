// TEST ONLY (wardby-sim). The GitHub GraphQL operations wardby sends, recognised by their
// root field (not a GraphQL engine): the review-thread list, resolveReviewThread and
// markPullRequestReadyForReview. Anything else answers a GraphQL error.
import { json, jsonBody, record, type SimRequest, type SimResponse } from "../http.js";
import type { RouteContext } from "../service.js";
import { holdsAny, installationCaller, pullBody } from "./rest.js";
import type { GitHubState, SimThread } from "./state.js";

function gqlError(message: string, type = "UNPROCESSABLE"): SimResponse {
  return json({ data: null, errors: [{ type, message }] });
}

async function threadOutdated(gh: GitHubState, thread: SimThread): Promise<boolean> {
  const pull = gh.pull(thread.repo, thread.pull);
  if (!pull) return false;
  const head = await gh.headSha(pull);
  if (!head || head === thread.commitId) return false;
  // Outdated when the file changed since the commit the thread was made on.
  const changed = await gh.git.diff(thread.repo, thread.commitId, head).catch(() => []);
  return changed.some((f) => f.filename === thread.path || f.previous_filename === thread.path);
}

export async function handleGraphql(gh: GitHubState, req: SimRequest, ctx: RouteContext): Promise<SimResponse> {
  const body = record(jsonBody(req));
  const query = typeof body.query === "string" ? body.query : "";
  const variables = record(body.variables);

  if (/\breviewThreads\s*\(/.test(query) && !query.trimStart().startsWith("mutation")) {
    const repo = gh.repo(`${String(variables.owner)}/${String(variables.name)}`);
    const caller = installationCaller(gh, req, ctx, repo, { pull_requests: "read" });
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(variables.number));
    if (!pull)
      return gqlError(
        `Could not resolve to a PullRequest with the number of ${String(variables.number)}.`,
        "NOT_FOUND",
      );
    const threads = [...gh.threads.values()].filter(
      (t) => t.repo === repo!.fullName.toLowerCase() && t.pull === pull.number,
    );
    const nodes = [];
    for (const thread of threads.slice(0, 100)) {
      const first = gh.reviewComments.get(thread.commentIds[0]);
      const outdated = await threadOutdated(gh, thread);
      nodes.push({
        id: thread.id,
        isResolved: thread.resolved,
        isOutdated: outdated,
        path: thread.path,
        line: outdated ? null : thread.line,
        comments: {
          nodes: first
            ? [
                {
                  body: first.body,
                  // GraphQL names a Bot by its slug, without "[bot]".
                  author: {
                    __typename: first.user.type,
                    login: first.user.type === "Bot" ? first.user.login.replace(/\[bot\]$/, "") : first.user.login,
                  },
                },
              ]
            : [],
        },
      });
    }
    return json({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
  }

  if (/\bresolveReviewThread\s*\(/.test(query)) {
    const thread = gh.threads.get(String(variables.threadId));
    if (!thread)
      return gqlError(`Could not resolve to a node with the global id of '${String(variables.threadId)}'`, "NOT_FOUND");
    const repo = gh.repo(thread.repo);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    // wardby's own note: resolving needs Contents write for an App token.
    if (!holdsAny(caller.token, [{ contents: "write", pull_requests: "write" }])) {
      return gqlError("Resource not accessible by integration", "FORBIDDEN");
    }
    thread.resolved = true;
    return json({ data: { resolveReviewThread: { thread: { id: thread.id, isResolved: true } } } });
  }

  if (/\bmarkPullRequestReadyForReview\s*\(/.test(query)) {
    const pull = [...gh.pulls.values()].find((p) => p.nodeId === variables.id);
    if (!pull)
      return gqlError(`Could not resolve to a node with the global id of '${String(variables.id)}'`, "NOT_FOUND");
    const repo = gh.repo(pull.repo);
    const caller = installationCaller(gh, req, ctx, repo, { pull_requests: "write" });
    if ("status" in caller) return caller;
    if (pull.state !== "open") return gqlError("Pull request is closed");
    const wasDraft = pull.draft;
    pull.draft = false;
    pull.updatedAt = gh.iso();
    if (wasDraft) {
      gh.emit(
        "pull_request",
        { action: "ready_for_review", number: pull.number, pull_request: await pullBody(gh, pull) },
        repo!,
        caller.user,
      );
    }
    return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  }

  return gqlError("This simulator does not answer that GraphQL operation", "SIMULATOR_UNSUPPORTED");
}
