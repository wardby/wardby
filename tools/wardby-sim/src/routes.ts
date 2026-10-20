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
];

export function routeKey(entry: { service: string; method: string; pattern: string }): string {
  return `${entry.service} ${entry.method} ${entry.pattern}`;
}

export function routeCounts(): { verified: number; unverified: number } {
  const verified = ROUTES.filter((route) => route.verified).length;
  return { verified, unverified: ROUTES.length - verified };
}
