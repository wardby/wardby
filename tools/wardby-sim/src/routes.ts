// TEST ONLY (wardby-sim). The route table: every route the simulator answers, and whether
// its behaviour has been checked against the real service (task 11 of the phase 2 plan).
//
// A route is `verified` only when a recorded, redacted response from the real service
// is replayed against it by `npm run test:contract`; `recording` names that fixture.
// Everything else is `unverified`: what a Flow G run finds through an unverified route is
// UNCONFIRMED until it is reproduced against production code without the simulator, and
// each Flow G record lists the unverified routes it went through.
//
// "Docs only" = modelled on the service's public API documentation, never compared with a
// recorded response.
//
// routes.test.ts keeps this table equal to the routes the services actually register.

export interface RouteEntry {
  service: string;
  method: string;
  /** The path pattern after the service prefix, in matchPath syntax. */
  pattern: string;
  verified: boolean;
  /** The recorded real response a verified route is replayed against. */
  recording?: string;
  /** Where the modelled behaviour comes from, and what it leaves out. */
  note: string;
}

function unverified(service: string, method: string, pattern: string, note: string): RouteEntry {
  return { service, method, pattern, verified: false, note };
}

const github = (method: string, pattern: string, note: string): RouteEntry =>
  unverified("github", method, pattern, note);

const jira = (method: string, pattern: string, note: string): RouteEntry => unverified("jira", method, pattern, note);

export const ROUTES: readonly RouteEntry[] = [
  // --- GitHub REST (github/rest.ts, github/graphql.ts) ---
  github("GET", "/app", "App JWT checked (RS256, iss, exp/iat); id, slug, owner. Docs only."),
  github("GET", "/repos/{owner}/{repo}/installation", "App JWT; 404 when the App is not installed. Docs only."),
  github(
    "POST",
    "/app/installations/{id}/access_tokens",
    "Echoes the requested permissions + metadata:read; 422 for an ungranted permission or repo; 1 h expiry. " +
      "Shared with the in-process unit-test fake (github/auth.ts). Docs only.",
  ),
  github("DELETE", "/installation/token", "Revokes the calling token; 401 afterwards. Docs only."),
  github("DELETE", "/app/installations/{id}", "App JWT; removes the installation. Docs only."),
  github("GET", "/repos/{owner}/{repo}", "metadata:read; default_branch, private, owner. Docs only."),
  github(
    "GET",
    "/repos/{owner}/{repo}/collaborators/{login}/permission",
    "Role flags; an outsider on a public repo answers read (per the design doc), on a private repo none; an unknown user 404.",
  ),
  github("GET", "/repos/{owner}/{repo}/pulls", "state/head/base filters, paging, Link header. Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/pulls",
    "422 for a duplicate head/base, an unknown ref, or no commits between; fires pull_request.opened. Error bodies approximated.",
  ),
  github(
    "GET",
    "/repos/{owner}/{repo}/pulls/{number}",
    "changed_files/additions/deletions/commits from the repository content; mergeable from merge-tree; html_url is github.com's.",
  ),
  github("PATCH", "/repos/{owner}/{repo}/pulls/{number}", "title, body, base, state. Docs only."),
  github(
    "GET",
    "/repos/{owner}/{repo}/pulls/{number}/files",
    "per_page max 100; stops at 3,000 files (GitHub's documented cap). GitHub omits very large patches; the sim never does.",
  ),
  github("GET", "/repos/{owner}/{repo}/pulls/{number}/commits", "Oldest first, 250 max. Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/pulls/{number}/reviews",
    "Inline comments only on lines in the patch (422 otherwise); the PR author cannot APPROVE/REQUEST_CHANGES (422); 200. " +
      "Error wording approximated.",
  ),
  github("GET", "/repos/{owner}/{repo}/pulls/{number}/reviews", "Oldest first. Docs only."),
  github("GET", "/repos/{owner}/{repo}/pulls/{number}/comments", "Review comments, oldest first. Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies",
    "A reply joins the parent's thread. Docs only.",
  ),
  github("GET", "/repos/{owner}/{repo}/pulls/comments/{id}", "Docs only."),
  github(
    "PATCH",
    "/repos/{owner}/{repo}/pulls/comments/{id}",
    "The App edits only its own (403 otherwise). Docs only.",
  ),
  github("POST", "/repos/{owner}/{repo}/pulls/comments/{id}/reactions", "201 new, 200 existing. Docs only."),
  github(
    "GET",
    "/repos/{owner}/{repo}/issues/{number}",
    "A PR number carries pull_request; Issues: read, or Pull requests: read for a PR. Permission mapping approximated.",
  ),
  github(
    "PATCH",
    "/repos/{owner}/{repo}/issues/{number}",
    "state/state_reason, title, body, labels; fires issues.closed/reopened. Docs only.",
  ),
  github("GET", "/repos/{owner}/{repo}/issues/{number}/comments", "Paging (per_page max 100). Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/issues/{number}/comments",
    "Issues: write, or Pull requests: write on a PR (wardby's empirical note in vcs/github.ts); 65,536-char body cap; 201.",
  ),
  github("GET", "/repos/{owner}/{repo}/issues/comments/{id}", "Docs only."),
  github(
    "PATCH",
    "/repos/{owner}/{repo}/issues/comments/{id}",
    "The App edits only its own (403 otherwise). Docs only.",
  ),
  github("DELETE", "/repos/{owner}/{repo}/issues/comments/{id}", "The App deletes only its own. Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/issues/comments/{id}/reactions",
    "201 new, 200 existing; content validated. Docs only.",
  ),
  github("POST", "/repos/{owner}/{repo}/issues/{number}/reactions", "201 new, 200 existing. Docs only."),
  github("POST", "/repos/{owner}/{repo}/issues/{number}/labels", "Answers the full label list, 200. Docs only."),
  github(
    "POST",
    "/repos/{owner}/{repo}/check-runs",
    "Checks: write; conclusion required when completed; app.id is the caller's. Docs only.",
  ),
  github("PATCH", "/repos/{owner}/{repo}/check-runs/{id}", "Only the App that created it (403 otherwise). Docs only."),
  github("GET", "/repos/{owner}/{repo}/check-runs/{id}", "Docs only."),
  github(
    "GET",
    "/repos/{owner}/{repo}/commits/{ref}/check-runs",
    "check_name filter; filter=latest (default) keeps the newest per App and name. Docs only.",
  ),
  github("POST", "/repos/{owner}/{repo}/statuses/{sha}", "Statuses: write. Docs only."),
  github(
    "GET",
    "/repos/{owner}/{repo}/commits/{ref}/status",
    "Combined state, latest per context; pending with none. Docs only.",
  ),
  github(
    "GET",
    "/repos/{owner}/{repo}/compare/*",
    "status ahead/behind/identical/diverged; commits with parents (250 max); files from the merge base (300 max, GitHub's cap).",
  ),
  github(
    "GET",
    "/repos/{owner}/{repo}/contents/*",
    "The raw media type returns the bytes; JSON returns base64; a directory lists entries. The raw content-type is a guess.",
  ),
  github(
    "GET",
    "/repos/{owner}/{repo}/git/trees/{ref}",
    "Recursive listing; never truncated (GitHub truncates very large trees).",
  ),
  github(
    "PUT",
    "/repos/{owner}/{repo}/pulls/{number}/merge",
    "Branch-protection emulator (protection.ts): merge or squash only when required checks/statuses are green and " +
      "approvals met; 405 with GitHub-style wording otherwise, 409 for a stale sha; rebase unsupported (405). " +
      "Closing keywords close issues on the default branch. Wording approximated.",
  ),
  github(
    "POST",
    "/graphql",
    "Only reviewThreads, resolveReviewThread (needs Contents write, per wardby's note) and markPullRequestReadyForReview; " +
      "a Bot author's login without [bot].",
  ),

  // --- GitHub git smart HTTP (github/git.ts), served by git http-backend ---
  unverified(
    "github-git",
    "GET",
    "/{owner}/{repo}/info/refs",
    "Ref advertisement by git http-backend (real git); Basic auth with a live installation token, Contents read/write. " +
      "The 401/403/404 bodies are approximated.",
  ),
  unverified("github-git", "POST", "/{owner}/{repo}/git-upload-pack", "Fetch/clone by git http-backend (real git)."),
  unverified(
    "github-git",
    "POST",
    "/{owner}/{repo}/git-receive-pack",
    "Push by git http-backend (real git); Contents: write; a protected branch refuses in a pre-receive hook with GH006. " +
      "Fires push and pull_request.synchronize.",
  ),

  // --- Slack Web API (slack/web.ts) ---
  unverified(
    "slack",
    "POST",
    "/auth.test",
    "Bearer auth (not_authed/invalid_auth/token_revoked); form body only. Docs only.",
  ),
  unverified(
    "slack",
    "POST",
    "/conversations.info",
    "Form body only (JSON → invalid_arguments, per wardby's own note); private not-member → channel_not_found; " +
      "channels:read / groups:read scopes. Docs only.",
  ),
  unverified(
    "slack",
    "POST",
    "/chat.postMessage",
    "chat:write; archived → is_archived; public not-member → not_in_channel; private not-member → channel_not_found; " +
      "an unknown thread_ts → thread_not_found (a guess).",
  ),
  unverified(
    "slack",
    "POST",
    "/chat.update",
    "message_not_found for an unknown or deleted ts; cant_update_message for another user's. Docs only.",
  ),

  // --- Jira Cloud REST v3 (jira/rest.ts): Bearer token of the service account; writes fire webhooks ---
  jira(
    "GET",
    "/rest/api/3/myself",
    "accountId, accountType (app for the service account), displayName, locale. Docs only.",
  ),
  jira(
    "GET",
    "/rest/api/3/issue/{key}",
    "`fields` limits the fields; ADF description; comment block {comments,total} unpaged; attachments always empty; " +
      "404 for an unknown key (Jira's hidden-or-missing). Docs only.",
  ),
  jira(
    "PUT",
    "/rest/api/3/issue/{key}",
    "labels/priority set; components and customfield_* accepted unmodelled; any other field 400; 204. Docs only.",
  ),
  jira("GET", "/rest/api/3/issue/{key}/editmeta", "Fixed: labels, priority, components. Docs only."),
  jira("GET", "/rest/api/3/issue/{key}/comment", "startAt/maxResults paging, oldest first. Docs only."),
  jira(
    "POST",
    "/rest/api/3/issue/{key}/comment",
    "ADF doc required (400 otherwise); role visibility must name a project role; 201; fires comment_created. " +
      "Error bodies approximated.",
  ),
  jira("GET", "/rest/api/3/issue/{key}/comment/{id}", "404 for an unknown id. Docs only."),
  jira(
    "PUT",
    "/rest/api/3/issue/{key}/comment/{id}",
    "The author only (403 otherwise: Edit Own Comments, not Edit All); ADF required; fires comment_updated.",
  ),
  jira(
    "GET",
    "/rest/api/3/issue/{key}/transitions",
    "Simplified workflow: every other status, transition named after its target; never a screen. Docs only.",
  ),
  jira(
    "POST",
    "/rest/api/3/issue/{key}/transitions",
    "204; 400 for a transition not offered; fires jira:issue_updated with a status changelog. Docs only.",
  ),
  jira("GET", "/rest/api/3/issue/{key}/remotelink", "Links with globalId and object. Docs only."),
  jira(
    "POST",
    "/rest/api/3/issue/{key}/remotelink",
    "Upsert by globalId: 201 new, 200 update; object.url and object.title required; status.resolved kept. Docs only.",
  ),
  jira("GET", "/rest/api/3/issue/{key}/properties/{property}", "{key,value}, 404 when unset. Docs only."),
  jira(
    "PUT",
    "/rest/api/3/issue/{key}/properties/{property}",
    "Any JSON up to 32 KiB; 201 new, 200 update, empty body. Docs only.",
  ),
  jira(
    "POST",
    "/rest/api/3/search/jql",
    "A JQL subset (jql.ts): AND/OR/NOT, =, !=, ~, in, is EMPTY over common fields; unknown field 400; " +
      "nextPageToken paging; newest first. Not Jira's full JQL.",
  ),
  jira("GET", "/rest/api/3/issueLinkType", "Blocks, Duplicate, Relates. Docs only."),
  jira("POST", "/rest/api/3/issueLink", "201 empty; 404 for an unknown type or issue. Docs only."),

  // --- npm registry (registry/npm.ts, npm-model.ts) ---
  unverified(
    "npm",
    "GET",
    "/{package}",
    "Packument: versions, time (+created/modified), dist-tags.latest, deprecated, dist.integrity/shasum of real " +
      "tarballs. Abbreviated (corgi) documents are not modelled; the full document is always sent.",
  ),
  unverified("npm", "GET", "/{package}/{version}", "Per-version manifest. Docs only."),
  unverified("npm", "GET", "/{package}/-/{file}", "A real .tgz (package/package.json, index.js)."),
  unverified("npm", "GET", "/{scope}/{package}/-/{file}", "A scoped package's real .tgz."),

  // --- PyPI (registry/pypi.ts, pypi-model.ts) ---
  unverified(
    "pypi",
    "GET",
    "/simple/{project}/",
    "PEP 691 JSON (Accept: application/vnd.pypi.simple.v1+json) or PEP 503 HTML; names PEP 503-normalized; " +
      "yanked and requires-python. Unverified against pypi.org.",
  ),
  unverified("pypi", "GET", "/pypi/{project}/json", "Project JSON: info of the newest upload, urls, releases."),
  unverified("pypi", "GET", "/pypi/{project}/{version}/json", "Release JSON: info (requires_dist), urls with sha256."),
  unverified(
    "pypi-files",
    "GET",
    "/packages/*",
    "Real pure-Python wheels and sdists, each with its own sha256; unknown files 404.",
  ),

  // --- OSV (registry/osv.ts) ---
  unverified(
    "osv",
    "POST",
    "/v1/query",
    "Full advisories, or {} when none. Version matching simplified (dotted numeric).",
  ),
  unverified("osv", "POST", "/v1/querybatch", "ids + modified per query, or {}; 1,000 queries max. Docs only."),
  unverified("osv", "GET", "/v1/vulns/{id}", "The advisory, or 404 {code:5}. Docs only."),

  // --- Scripted model (model/service.ts): not a simulation of a provider, a replay of turn scripts ---
  unverified(
    "model",
    "POST",
    "/openai/v1/responses",
    "Streams scripted Responses output items (message text also as output_text deltas). Replayed by the pinned " +
      "Codex CLI through the proxy and by wardby's native OpenAI client (model/script.test.ts, Flow G), not " +
      "every event the real API sends.",
  ),
  unverified(
    "model",
    "POST",
    "/anthropic/v1/messages",
    "Streams scripted content blocks (text, tool_use). Replayed by Claude Code through the proxy and by wardby's " +
      "native Anthropic client in Flow G; the real API's full event set is not modelled.",
  ),
];

/** Outbound events (webhooks the simulator sends), with the same verified rule as routes. */
export interface EventEntry {
  service: string;
  event: string;
  actions: string[];
  verified: boolean;
  recording?: string;
  note: string;
}

export const EVENTS: readonly EventEntry[] = [
  {
    service: "github",
    event: "issues",
    actions: ["opened", "labeled", "closed", "reopened"],
    verified: false,
    note: "issue with author_association; repository, sender, installation added. Docs only.",
  },
  {
    service: "github",
    event: "issue_comment",
    actions: ["created", "edited"],
    verified: false,
    note: "comment.author_association from the repo role (OWNER/COLLABORATOR/NONE; overridable by script). Docs only.",
  },
  {
    service: "github",
    event: "pull_request",
    actions: ["opened", "edited", "synchronize", "ready_for_review", "labeled", "closed"],
    verified: false,
    note: "closed carries merged; synchronize carries before/after. Docs only.",
  },
  {
    service: "github",
    event: "pull_request_review",
    actions: ["submitted"],
    verified: false,
    note: "Docs only.",
  },
  {
    service: "github",
    event: "pull_request_review_comment",
    actions: ["created"],
    verified: false,
    note: "Docs only.",
  },
  {
    service: "github",
    event: "push",
    actions: [],
    verified: false,
    note: "ref, before/after (zeros for create/delete), commits with added/modified/removed (2,048 max). Docs only.",
  },
  {
    service: "github",
    event: "check_suite",
    actions: ["completed"],
    verified: false,
    note: "once every run of one App on a head is completed; pull_requests = open PRs at that head. Approximates GitHub's suites.",
  },
  {
    service: "github",
    event: "check_run",
    actions: ["rerequested"],
    verified: false,
    note: "scripted only (github.check_rerequest). Docs only.",
  },
  {
    service: "jira",
    event: "jira:issue_created",
    actions: [],
    verified: false,
    note:
      "user, issue (description as wiki markup by default, or ADF), epoch-ms timestamp; X-Hub-Signature sha256, " +
      "X-Atlassian-Webhook-Identifier kept on retries. Docs only.",
  },
  {
    service: "jira",
    event: "jira:issue_updated",
    actions: ["issue_assigned", "issue_updated", "issue_generic"],
    verified: false,
    note:
      "changelog items for assignee (to = accountId), labels (space-separated from/toString) and status; the " +
      "service account's own writes fire it too, with it as the user. Docs only.",
  },
  {
    service: "jira",
    event: "comment_created",
    actions: [],
    verified: false,
    note:
      "comment (author, updateAuthor; body as wiki markup with [~accountid:...] mentions by default, or ADF), " +
      "issue summary/status. Whether real deliveries carry wiki or ADF bodies is unverified. Docs only.",
  },
  {
    service: "jira",
    event: "comment_updated",
    actions: [],
    verified: false,
    note: "as comment_created; updateAuthor is the editor. Docs only.",
  },
];

export function routeKey(entry: { service: string; method: string; pattern: string }): string {
  return `${entry.service} ${entry.method} ${entry.pattern}`;
}

export function routeCounts(): { verified: number; unverified: number } {
  const verified = ROUTES.filter((route) => route.verified).length;
  return { verified, unverified: ROUTES.length - verified };
}
