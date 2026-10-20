// TEST ONLY (wardby-sim). The GitHub REST subset wardby calls, answered from GitHubState and
// the repositories' real git content. Every route here is listed in routes.ts (unverified
// until a recorded real response is replayed against it).
//
// Modelled GitHub behaviour (from GitHub's REST docs, not yet checked against recordings):
// - installation tokens are scoped to repositories (404 outside them) and permissions (403
//   "Resource not accessible by integration"); write implies read;
// - paging with per_page (default 30, max 100) and page, plus a Link header;
// - `pulls/{n}/files` serves at most 3,000 files; `compare` lists at most 300 files and 250
//   commits;
// - a pull request's author cannot APPROVE or REQUEST_CHANGES on it (422).
import { header, json, jsonBody, record, empty, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { RouteContext } from "../service.js";
import { handleGitHubAuth, verifyRs256AppJwt } from "./auth.js";
import type { ChangedFile } from "./git-store.js";
import {
  appJson,
  checkRunJson,
  commentJson,
  issueJson,
  pullJson,
  repoJson,
  reviewCommentJson,
  reviewJson,
  userJson,
  type PullFacts,
} from "./shapes.js";
import type { GitHubState, IssuedToken, Permission, SimPull, SimRepo, SimUser } from "./state.js";
import { handleGraphql } from "./graphql.js";

export const PULL_FILES_LIMIT = 3000;
export const COMPARE_FILES_LIMIT = 300;
export const COMPARE_COMMITS_LIMIT = 250;

const DOCS = "https://docs.github.com/rest";

export function notFound(): SimResponse {
  return json({ message: "Not Found", documentation_url: DOCS, status: "404" }, 404);
}

export function forbidden(): SimResponse {
  return json({ message: "Resource not accessible by integration", documentation_url: DOCS, status: "403" }, 403);
}

export function badCredentials(): SimResponse {
  return json({ message: "Bad credentials", documentation_url: DOCS, status: "401" }, 401);
}

export function validationFailed(message: string, errors: unknown[] = []): SimResponse {
  return json({ message, errors, documentation_url: DOCS, status: "422" }, 422);
}

export interface Caller {
  token: IssuedToken;
  user: SimUser;
  viaApp: number;
}

function bearerOf(req: SimRequest): string | null {
  const value = header(req, "authorization");
  const match = value ? /^(?:Bearer|token)\s+(.+)$/i.exec(value) : null;
  return match ? match[1] : null;
}

/** The installation token's caller for `repo`, or the error GitHub would answer. */
export function installationCaller(
  gh: GitHubState,
  req: SimRequest,
  ctx: RouteContext,
  repo: SimRepo | undefined,
  need: Record<string, Permission>,
): Caller | SimResponse {
  const value = bearerOf(req);
  const token = value ? gh.liveToken(value) : undefined;
  if (!token) return badCredentials();
  ctx.principal(`installation:${token.installationId}:${token.id}`);
  if (!repo) return notFound();
  if (!token.repositories.includes(repo.fullName.toLowerCase()) || token.installationId !== repo.installationId) {
    return notFound();
  }
  for (const [name, level] of Object.entries(need)) {
    const granted = token.permissions[name];
    if (granted !== "write" && granted !== level) return forbidden();
  }
  return { token, user: gh.botUser(), viaApp: gh.app.id };
}

/** True when the token holds one of the alternatives (each a permission set). */
export function holdsAny(token: IssuedToken, alternatives: Record<string, Permission>[]): boolean {
  return alternatives.some((need) =>
    Object.entries(need).every(
      ([name, level]) => token.permissions[name] === "write" || token.permissions[name] === level,
    ),
  );
}

export function paged<T>(req: SimRequest, items: T[], max = 100): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(Math.max(Number(req.query.get("per_page") ?? 30) || 30, 1), max);
  const pageNumber = Math.max(Number(req.query.get("page") ?? 1) || 1, 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const last = Math.max(Math.ceil(items.length / perPage), 1);
  const link = (n: number, rel: string): string => {
    const query = new URLSearchParams(req.query);
    query.set("page", String(n));
    query.set("per_page", String(perPage));
    return `<https://api.github.com${req.path}?${query.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (pageNumber < last) links.push(link(pageNumber + 1, "next"), link(last, "last"));
  if (pageNumber > 1) links.push(link(1, "first"), link(pageNumber - 1, "prev"));
  return { page, headers: links.length > 0 ? { link: links.join(", ") } : {} };
}

export async function pullFiles(gh: GitHubState, pull: SimPull): Promise<ChangedFile[]> {
  const head = await gh.headSha(pull);
  const base = await gh.git.resolve(pull.repo, `refs/heads/${pull.baseRef}`);
  if (!head || !base) return [];
  // A merged PR keeps the diff it merged with: its base side is the merge commit's first parent.
  const from =
    pull.merged && pull.mergeCommitSha ? await firstParent(gh, pull) : await gh.git.mergeBase(pull.repo, base, head);
  if (!from) return [];
  return gh.git.diff(pull.repo, from, head);
}

async function firstParent(gh: GitHubState, pull: SimPull): Promise<string | null> {
  const info = await gh.git.commitInfo(pull.repo, pull.mergeCommitSha!);
  return info?.parents[0] ?? null;
}

export async function pullFacts(gh: GitHubState, pull: SimPull): Promise<PullFacts> {
  const headSha = await gh.headSha(pull);
  const baseSha = await gh.git.resolve(pull.repo, `refs/heads/${pull.baseRef}`);
  const files = await pullFiles(gh, pull);
  const mergeBase = headSha && baseSha ? await gh.git.mergeBase(pull.repo, baseSha, headSha) : null;
  const commits = headSha && mergeBase ? await gh.git.countBetween(pull.repo, mergeBase, headSha) : 0;
  const mergeable =
    pull.state === "closed" || !headSha || !baseSha
      ? null
      : (await gh.git.mergeTree(pull.repo, baseSha, headSha)) !== null;
  return {
    headSha,
    baseSha,
    changedFiles: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    commits,
    mergeable,
  };
}

export async function pullBody(gh: GitHubState, pull: SimPull): Promise<Record<string, unknown>> {
  return pullJson(gh, pull, await pullFacts(gh, pull));
}

function repoOf(gh: GitHubState, params: Record<string, string>): SimRepo | undefined {
  return gh.repo(`${params.owner}/${params.repo}`);
}

const READ_PR = { pull_requests: "read" } as const;
const WRITE_PR = { pull_requests: "write" } as const;
const ISSUE_OR_PR_READ = [{ issues: "read" }, { pull_requests: "read" }] as Record<string, Permission>[];

/** Writes on an issue thread: Issues: write, or Pull requests: write when the number is a PR. */
function canWriteThread(token: IssuedToken, isPull: boolean): boolean {
  return holdsAny(token, isPull ? [{ issues: "write" }, { pull_requests: "write" }] : [{ issues: "write" }]);
}

function reactionAnswer(
  gh: GitHubState,
  subject: { kind: "issue" | "issue_comment" | "review_comment"; repo: string; id: number },
  content: unknown,
  user: SimUser,
): SimResponse {
  const allowed = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"];
  if (typeof content !== "string" || !allowed.includes(content)) {
    return validationFailed("Validation Failed", [{ resource: "Reaction", field: "content", code: "invalid" }]);
  }
  const existing = gh.reactions.find(
    (r) =>
      r.subject.kind === subject.kind &&
      r.subject.repo === subject.repo &&
      r.subject.id === subject.id &&
      r.content === content &&
      r.user.login === user.login,
  );
  const reaction = existing ?? { id: gh.nextId(), subject, content, user, createdAt: gh.iso() };
  if (!existing) gh.reactions.push(reaction);
  return json(
    { id: reaction.id, content: reaction.content, user: userJson(user), created_at: reaction.createdAt },
    existing ? 200 : 201,
  );
}

/** Lines a review comment may sit on: those the file's patch shows on that side. */
export function commentableLines(patch: string | undefined, side: "LEFT" | "RIGHT"): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;
  let left = 0;
  let right = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+")) {
      if (side === "RIGHT") lines.add(right);
      right += 1;
    } else if (line.startsWith("-")) {
      if (side === "LEFT") lines.add(left);
      left += 1;
    } else if (!line.startsWith("\\")) {
      lines.add(side === "RIGHT" ? right : left);
      left += 1;
      right += 1;
    }
  }
  return lines;
}

export function githubRestRouter(gh: GitHubState): Router {
  const router = new Router();

  // --- App authentication (shared with the in-process fake: auth.ts) ---------------------
  const authRoute = (req: SimRequest, ctx: RouteContext): SimResponse => {
    const answer = handleGitHubAuth(
      { method: req.method, path: req.path, body: jsonBody(req), authorization: header(req, "authorization") ?? null },
      {
        app: () => appJson(gh) as { id: number; slug: string; owner: { login: string } },
        ...(gh.app.publicKeyPem
          ? { verifyAppJwt: (jwt: string) => verifyRs256AppJwt(jwt, gh.app.publicKeyPem!, gh.app.id, gh.now()) }
          : {}),
        installationFor: (fullName) => {
          const id = gh.repo(fullName)?.installationId;
          return id !== undefined && gh.installations.has(id) ? id : undefined;
        },
        issue: (installationId, requested) => {
          const installation = gh.installations.get(installationId);
          if (!installation) return { status: 404, message: "Not Found" };
          for (const [name, level] of Object.entries(requested.permissions)) {
            const max = installation.permissions[name];
            if (max !== "write" && max !== level) {
              return { status: 422, message: `The permissions requested are not granted to this installation.` };
            }
          }
          const repos = requested.repositories.map((name) => `${installation.account}/${name}`.toLowerCase());
          for (const full of repos) {
            if (gh.repo(full)?.installationId !== installationId) {
              return {
                status: 422,
                message:
                  "There is at least one repository that does not exist or is not accessible to the parent installation.",
              };
            }
          }
          const scope =
            repos.length > 0
              ? repos
              : [...gh.repos.values()]
                  .filter((r) => r.installationId === installationId)
                  .map((r) => r.fullName.toLowerCase());
          const permissions = { ...requested.permissions, metadata: "read" } as Record<string, Permission>;
          const token = gh.mintToken(installationId, permissions, scope);
          ctx.principal(`app:${gh.app.id}->${token.id}`);
          return {
            token: token.token,
            expires_at: new Date(token.expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
            permissions,
            repositories: scope.map((full) => ({ full_name: gh.repo(full)!.fullName })),
          };
        },
        revoke: (value) => {
          const token = gh.liveToken(value);
          if (!token) return false;
          token.revoked = true;
          ctx.principal(`installation:${token.installationId}:${token.id}`);
          return true;
        },
      },
    );
    if (!answer) return notFound();
    if (answer.status === 204) return empty(204);
    if (req.path === "/app" || req.path.endsWith("/installation")) ctx.principal("app");
    return json(answer.body, answer.status);
  };
  router.on("GET", "/app", (req, _p, ctx) => authRoute(req, ctx));
  router.on("GET", "/repos/{owner}/{repo}/installation", (req, _p, ctx) => authRoute(req, ctx));
  router.on("POST", "/app/installations/{id}/access_tokens", (req, _p, ctx) => authRoute(req, ctx));
  router.on("DELETE", "/installation/token", (req, _p, ctx) => authRoute(req, ctx));
  router.on("DELETE", "/app/installations/{id}", (req, params, ctx) => {
    const appOk = gh.app.publicKeyPem
      ? (() => {
          const value = bearerOf(req);
          return value !== null && verifyRs256AppJwt(value, gh.app.publicKeyPem, gh.app.id, gh.now());
        })()
      : true;
    if (!appOk) return badCredentials();
    ctx.principal("app");
    return gh.installations.delete(Number(params.id)) ? empty(204) : notFound();
  });

  // --- Repository ----------------------------------------------------------------------
  router.on("GET", "/repos/{owner}/{repo}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { metadata: "read" });
    if ("status" in caller) return caller;
    return json(repoJson(gh, repo!));
  });

  router.on("GET", "/repos/{owner}/{repo}/collaborators/{login}/permission", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { metadata: "read" });
    if ("status" in caller) return caller;
    const known = gh.users.get(params.login.toLowerCase());
    if (!known) return notFound();
    const isOwner = known.login.toLowerCase() === repo!.owner.toLowerCase();
    const role = isOwner
      ? "admin"
      : (repo!.collaborators.get(known.login.toLowerCase())?.role ?? (repo!.private ? "none" : "read"));
    const legacy =
      role === "admin"
        ? "admin"
        : role === "maintain" || role === "write"
          ? "write"
          : role === "none"
            ? "none"
            : "read";
    const rank = ["none", "read", "triage", "write", "maintain", "admin"].indexOf(role);
    return json({
      permission: legacy,
      role_name: role,
      user: {
        ...userJson(known),
        permissions: { pull: rank >= 1, triage: rank >= 2, push: rank >= 3, maintain: rank >= 4, admin: rank >= 5 },
      },
    });
  });

  // --- Pull requests ---------------------------------------------------------------------
  router.on("GET", "/repos/{owner}/{repo}/pulls", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const state = req.query.get("state") ?? "open";
    const head = req.query.get("head");
    const base = req.query.get("base");
    const pulls = [...gh.pulls.values()]
      .filter((p) => p.repo === repo!.fullName.toLowerCase())
      .filter((p) => state === "all" || p.state === state)
      .filter((p) => !head || `${repo!.owner}:${p.headRef}`.toLowerCase() === head.toLowerCase())
      .filter((p) => !base || p.baseRef === base)
      .sort((a, b) => b.number - a.number);
    const { page, headers } = paged(req, pulls);
    const bodies: unknown[] = [];
    for (const pull of page) bodies.push(await pullBody(gh, pull));
    return json(bodies, 200, headers);
  });

  router.on("POST", "/repos/{owner}/{repo}/pulls", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const body = record(jsonBody(req));
    const headRef = typeof body.head === "string" ? body.head.replace(new RegExp(`^${repo!.owner}:`, "i"), "") : "";
    const baseRef = typeof body.base === "string" ? body.base : "";
    if (typeof body.title !== "string" || body.title === "") {
      return validationFailed("Validation Failed", [
        { resource: "PullRequest", field: "title", code: "missing_field" },
      ]);
    }
    const headSha = await gh.git.resolve(repo!.fullName, `refs/heads/${headRef}`);
    const baseSha = await gh.git.resolve(repo!.fullName, `refs/heads/${baseRef}`);
    if (!headSha)
      return validationFailed("Validation Failed", [{ resource: "PullRequest", field: "head", code: "invalid" }]);
    if (!baseSha)
      return validationFailed("Validation Failed", [{ resource: "PullRequest", field: "base", code: "invalid" }]);
    const existing = [...gh.pulls.values()].find(
      (p) =>
        p.repo === repo!.fullName.toLowerCase() && p.state === "open" && p.headRef === headRef && p.baseRef === baseRef,
    );
    if (existing) {
      return validationFailed("Validation Failed", [
        {
          resource: "PullRequest",
          code: "custom",
          message: `A pull request already exists for ${repo!.owner}:${headRef}.`,
        },
      ]);
    }
    if (await gh.git.isAncestor(repo!.fullName, headSha, baseSha)) {
      return validationFailed("Validation Failed", [
        { resource: "PullRequest", code: "custom", message: `No commits between ${baseRef} and ${headRef}` },
      ]);
    }
    const pull = openPull(gh, repo!, {
      title: body.title,
      body: typeof body.body === "string" ? body.body : null,
      headRef,
      baseRef,
      draft: body.draft === true,
      user: caller.user,
    });
    const payload = await pullBody(gh, pull);
    gh.emit("pull_request", { action: "opened", number: pull.number, pull_request: payload }, repo!, caller.user);
    return json(payload, 201);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/{number}", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    if (!pull) return notFound();
    return json(await pullBody(gh, pull));
  });

  router.on("PATCH", "/repos/{owner}/{repo}/pulls/{number}", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    if (!pull) return notFound();
    const body = record(jsonBody(req));
    const issue = gh.issue(repo!.fullName, pull.number)!;
    if (typeof body.title === "string") pull.title = issue.title = body.title;
    if (typeof body.body === "string" || body.body === null) pull.body = issue.body = body.body;
    if (typeof body.base === "string") {
      if (!(await gh.git.resolve(repo!.fullName, `refs/heads/${body.base}`))) {
        return validationFailed("Validation Failed", [{ resource: "PullRequest", field: "base", code: "invalid" }]);
      }
      pull.baseRef = body.base;
    }
    if (body.state === "closed" && pull.state === "open") {
      pull.headShaAtClose = await gh.headSha(pull);
      pull.state = issue.state = "closed";
      pull.closedAt = issue.closedAt = gh.iso();
    } else if (body.state === "open" && pull.state === "closed" && !pull.merged) {
      pull.state = issue.state = "open";
      pull.closedAt = issue.closedAt = null;
      pull.headShaAtClose = null;
    }
    pull.updatedAt = issue.updatedAt = gh.iso();
    const payload = await pullBody(gh, pull);
    gh.emit(
      "pull_request",
      { action: body.state === "closed" ? "closed" : "edited", number: pull.number, pull_request: payload },
      repo!,
      caller.user,
    );
    return json(payload);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/{number}/files", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    if (!pull) return notFound();
    const files = (await pullFiles(gh, pull)).slice(0, PULL_FILES_LIMIT);
    const { page, headers } = paged(req, files);
    return json(page, 200, headers);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/{number}/commits", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    if (!pull) return notFound();
    const head = await gh.headSha(pull);
    const base = await gh.git.resolve(repo!.fullName, `refs/heads/${pull.baseRef}`);
    const from = head && base ? await gh.git.mergeBase(repo!.fullName, base, head) : null;
    const commits = head && from ? await gh.git.commitsBetween(repo!.fullName, from, head) : [];
    const { page, headers } = paged(req, commits.slice(0, 250).map(commitJson));
    return json(page, 200, headers);
  });

  // --- Reviews ---------------------------------------------------------------------------
  router.on("POST", "/repos/{owner}/{repo}/pulls/{number}/reviews", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    if (!pull) return notFound();
    const body = record(jsonBody(req));
    const event = typeof body.event === "string" ? body.event : "COMMENT";
    const state = event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
    if (state !== "COMMENTED" && pull.user.login === caller.user.login) {
      return validationFailed("Unprocessable Entity", [
        state === "APPROVED"
          ? "Can not approve your own pull request"
          : "Can not request changes on your own pull request",
      ]);
    }
    if ((state === "CHANGES_REQUESTED" || state === "COMMENTED") && !body.body && !Array.isArray(body.comments)) {
      return validationFailed("Unprocessable Entity", ["Review body is required"]);
    }
    const head = (await gh.headSha(pull))!;
    const commitId = typeof body.commit_id === "string" ? body.commit_id : head;
    const files = await pullFiles(gh, pull);
    const comments = Array.isArray(body.comments) ? body.comments.map(record) : [];
    for (const c of comments) {
      const file = files.find((f) => f.filename === c.path);
      const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
      if (!file || typeof c.line !== "number" || !commentableLines(file.patch, side).has(c.line)) {
        return validationFailed("Unprocessable Entity", ["Line could not be resolved"]);
      }
    }
    const review = registerReview(gh, repo!, pull, {
      user: caller.user,
      viaApp: caller.viaApp,
      state,
      body: textOf(body.body),
      commitId,
    });
    for (const c of comments) {
      await addReviewComment(gh, repo!, pull, {
        reviewId: review.id,
        path: String(c.path),
        line: c.line as number,
        side: c.side === "LEFT" ? "LEFT" : "RIGHT",
        body: textOf(c.body),
        user: caller.user,
        viaApp: caller.viaApp,
        commitId,
        inReplyTo: null,
      });
    }
    gh.emit(
      "pull_request_review",
      { action: "submitted", review: reviewJson(gh, review), pull_request: await pullBody(gh, pull) },
      repo!,
      caller.user,
    );
    await gh.reviewed(repo!, pull.number);
    return json(reviewJson(gh, review), 200);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/{number}/reviews", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const reviews = [...gh.reviews.values()]
      .filter((r) => r.repo === repo!.fullName.toLowerCase() && r.pull === Number(params.number))
      .sort((a, b) => a.id - b.id)
      .map((r) => reviewJson(gh, r));
    const { page, headers } = paged(req, reviews);
    return json(page, 200, headers);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/{number}/comments", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const comments = [...gh.reviewComments.values()]
      .filter((c) => c.repo === repo!.fullName.toLowerCase() && c.pull === Number(params.number))
      .sort((a, b) => a.id - b.id)
      .map((c) => reviewCommentJson(gh, c));
    const { page, headers } = paged(req, comments);
    return json(page, 200, headers);
  });

  router.on("POST", "/repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const pull = gh.pull(repo!.fullName, Number(params.number));
    const parent = gh.reviewComments.get(Number(params.id));
    if (!pull || !parent || parent.pull !== pull.number || parent.repo !== repo!.fullName.toLowerCase())
      return notFound();
    const body = record(jsonBody(req));
    const reply = await addReviewComment(gh, repo!, pull, {
      reviewId: null,
      path: parent.path,
      line: parent.line,
      side: parent.side,
      body: textOf(body.body),
      user: caller.user,
      viaApp: caller.viaApp,
      commitId: parent.commitId,
      inReplyTo: parent.inReplyTo ?? parent.id,
    });
    return json(reviewCommentJson(gh, reply), 201);
  });

  router.on("GET", "/repos/{owner}/{repo}/pulls/comments/{id}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, READ_PR);
    if ("status" in caller) return caller;
    const comment = gh.reviewComments.get(Number(params.id));
    if (!comment || comment.repo !== repo!.fullName.toLowerCase()) return notFound();
    return json(reviewCommentJson(gh, comment));
  });

  router.on("PATCH", "/repos/{owner}/{repo}/pulls/comments/{id}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const comment = gh.reviewComments.get(Number(params.id));
    if (!comment || comment.repo !== repo!.fullName.toLowerCase()) return notFound();
    if (comment.user.login !== caller.user.login) return forbidden();
    comment.body = textOf(record(jsonBody(req)).body, comment.body);
    comment.updatedAt = gh.iso();
    return json(reviewCommentJson(gh, comment));
  });

  router.on("POST", "/repos/{owner}/{repo}/pulls/comments/{id}/reactions", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, WRITE_PR);
    if ("status" in caller) return caller;
    const comment = gh.reviewComments.get(Number(params.id));
    if (!comment || comment.repo !== repo!.fullName.toLowerCase()) return notFound();
    return reactionAnswer(
      gh,
      { kind: "review_comment", repo: comment.repo, id: comment.id },
      record(jsonBody(req)).content,
      caller.user,
    );
  });

  // --- Issues and their comments ---------------------------------------------------------
  router.on("GET", "/repos/{owner}/{repo}/issues/{number}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!holdsAny(caller.token, issue.isPull ? ISSUE_OR_PR_READ : [{ issues: "read" }])) return forbidden();
    return json(issueJson(gh, issue));
  });

  router.on("PATCH", "/repos/{owner}/{repo}/issues/{number}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    const body = record(jsonBody(req));
    if (typeof body.title === "string") issue.title = body.title;
    if (typeof body.body === "string") issue.body = body.body;
    if (Array.isArray(body.labels)) issue.labels = body.labels.map(String);
    if (!issue.isPull && (body.state === "closed" || body.state === "open")) {
      const was = issue.state;
      issue.state = body.state;
      issue.stateReason =
        body.state === "closed"
          ? body.state_reason === "not_planned"
            ? "not_planned"
            : "completed"
          : was === "closed"
            ? "reopened"
            : null;
      issue.closedAt = body.state === "closed" ? gh.iso() : null;
      if (was !== issue.state) {
        gh.emit(
          "issues",
          { action: issue.state === "closed" ? "closed" : "reopened", issue: issueJson(gh, issue) },
          repo!,
          caller.user,
        );
      }
    }
    issue.updatedAt = gh.iso();
    return json(issueJson(gh, issue));
  });

  router.on("GET", "/repos/{owner}/{repo}/issues/{number}/comments", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!holdsAny(caller.token, issue.isPull ? ISSUE_OR_PR_READ : [{ issues: "read" }])) return forbidden();
    const comments = [...gh.comments.values()]
      .filter((c) => c.repo === repo!.fullName.toLowerCase() && c.issueNumber === issue.number)
      .sort((a, b) => a.id - b.id)
      .map((c) => commentJson(gh, c));
    const { page, headers } = paged(req, comments);
    return json(page, 200, headers);
  });

  router.on("POST", "/repos/{owner}/{repo}/issues/{number}/comments", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    const text = record(jsonBody(req)).body;
    if (typeof text !== "string" || text === "") {
      return validationFailed("Validation Failed", [
        { resource: "IssueComment", field: "body", code: "missing_field" },
      ]);
    }
    if (text.length > 65536) {
      return validationFailed("Validation Failed", [
        {
          resource: "IssueComment",
          field: "body",
          code: "custom",
          message: "body is too long (maximum is 65536 characters)",
        },
      ]);
    }
    const comment = addComment(gh, repo!, issue.number, text, caller.user, caller.viaApp);
    gh.emit(
      "issue_comment",
      { action: "created", issue: issueJson(gh, issue), comment: commentJson(gh, comment) },
      repo!,
      caller.user,
    );
    return json(commentJson(gh, comment), 201);
  });

  const commentRoute = (
    method: string,
    handler: (
      repo: SimRepo,
      comment: ReturnType<typeof gh.comments.get> & object,
      caller: Caller,
      req: SimRequest,
    ) => SimResponse,
  ) => {
    router.on(method, "/repos/{owner}/{repo}/issues/comments/{id}", (req, params, ctx) => {
      const repo = repoOf(gh, params);
      const caller = installationCaller(gh, req, ctx, repo, {});
      if ("status" in caller) return caller;
      const comment = gh.comments.get(Number(params.id));
      if (!comment || comment.repo !== repo!.fullName.toLowerCase()) return notFound();
      return handler(repo!, comment, caller, req);
    });
  };
  commentRoute("GET", (repo, comment, caller) => {
    const isPull = gh.issue(repo.fullName, comment.issueNumber)?.isPull ?? false;
    if (!holdsAny(caller.token, isPull ? ISSUE_OR_PR_READ : [{ issues: "read" }])) return forbidden();
    return json(commentJson(gh, comment));
  });
  commentRoute("PATCH", (repo, comment, caller, req) => {
    const issue = gh.issue(repo.fullName, comment.issueNumber)!;
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    // An App edits only what it wrote (a person's comment needs their own token).
    if (comment.user.login !== caller.user.login) return forbidden();
    const text = record(jsonBody(req)).body;
    if (typeof text !== "string" || text === "") {
      return validationFailed("Validation Failed", [
        { resource: "IssueComment", field: "body", code: "missing_field" },
      ]);
    }
    comment.body = text;
    comment.updatedAt = gh.iso();
    gh.emit(
      "issue_comment",
      { action: "edited", issue: issueJson(gh, issue), comment: commentJson(gh, comment) },
      repo,
      caller.user,
    );
    return json(commentJson(gh, comment));
  });
  commentRoute("DELETE", (repo, comment, caller) => {
    const issue = gh.issue(repo.fullName, comment.issueNumber)!;
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    if (comment.user.login !== caller.user.login) return forbidden();
    gh.comments.delete(comment.id);
    return empty(204);
  });

  router.on("POST", "/repos/{owner}/{repo}/issues/comments/{id}/reactions", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const comment = gh.comments.get(Number(params.id));
    if (!comment || comment.repo !== repo!.fullName.toLowerCase()) return notFound();
    const isPull = gh.issue(repo!.fullName, comment.issueNumber)?.isPull ?? false;
    if (!canWriteThread(caller.token, isPull)) return forbidden();
    return reactionAnswer(
      gh,
      { kind: "issue_comment", repo: comment.repo, id: comment.id },
      record(jsonBody(req)).content,
      caller.user,
    );
  });

  router.on("POST", "/repos/{owner}/{repo}/issues/{number}/reactions", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    return reactionAnswer(
      gh,
      { kind: "issue", repo: issue.repo, id: issue.number },
      record(jsonBody(req)).content,
      caller.user,
    );
  });

  router.on("POST", "/repos/{owner}/{repo}/issues/{number}/labels", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, {});
    if ("status" in caller) return caller;
    const issue = gh.issue(repo!.fullName, Number(params.number));
    if (!issue) return notFound();
    if (!canWriteThread(caller.token, issue.isPull)) return forbidden();
    const labels = record(jsonBody(req)).labels;
    if (!Array.isArray(labels))
      return validationFailed("Validation Failed", [{ resource: "Label", field: "labels", code: "invalid" }]);
    for (const label of labels.map(String)) if (!issue.labels.includes(label)) issue.labels.push(label);
    const pull = gh.pull(repo!.fullName, issue.number);
    if (pull) pull.labels = issue.labels;
    return json(
      issue.labels.map((name) => ({ name })),
      200,
    );
  });

  // --- Checks and statuses ----------------------------------------------------------------
  router.on("POST", "/repos/{owner}/{repo}/check-runs", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { checks: "write" });
    if ("status" in caller) return caller;
    const body = record(jsonBody(req));
    if (typeof body.name !== "string" || typeof body.head_sha !== "string") {
      return validationFailed("Invalid request.", ["name and head_sha are required"]);
    }
    if (!(await gh.git.commitInfo(repo!.fullName, body.head_sha))) {
      return validationFailed("No commit found for SHA: " + body.head_sha);
    }
    const status =
      body.status === "in_progress" || body.status === "completed"
        ? body.status
        : body.conclusion
          ? "completed"
          : "queued";
    if (status === "completed" && typeof body.conclusion !== "string") {
      return validationFailed("Invalid request.", ["conclusion is required when status is completed"]);
    }
    const output = record(body.output);
    const run = {
      id: gh.nextId(),
      repo: repo!.fullName.toLowerCase(),
      headSha: body.head_sha,
      name: body.name,
      status,
      conclusion: status === "completed" ? String(body.conclusion) : null,
      externalId: typeof body.external_id === "string" ? body.external_id : null,
      detailsUrl: typeof body.details_url === "string" ? body.details_url : null,
      output: {
        title: typeof output.title === "string" ? output.title : null,
        summary: typeof output.summary === "string" ? output.summary : null,
        text: typeof output.text === "string" ? output.text : null,
      },
      appId: caller.viaApp,
      startedAt: gh.iso(),
      completedAt: status === "completed" ? gh.iso() : null,
    } as const;
    gh.checkRuns.set(run.id, { ...run });
    await gh.checkChanged(repo!, run.headSha);
    return json(checkRunJson(gh, gh.checkRuns.get(run.id)!), 201);
  });

  router.on("PATCH", "/repos/{owner}/{repo}/check-runs/{id}", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { checks: "write" });
    if ("status" in caller) return caller;
    const run = gh.checkRuns.get(Number(params.id));
    if (!run || run.repo !== repo!.fullName.toLowerCase()) return notFound();
    if (run.appId !== caller.viaApp) return forbidden();
    const body = record(jsonBody(req));
    if (typeof body.name === "string") run.name = body.name;
    if (typeof body.details_url === "string") run.detailsUrl = body.details_url;
    if (typeof body.external_id === "string") run.externalId = body.external_id;
    if (body.status === "queued" || body.status === "in_progress" || body.status === "completed")
      run.status = body.status;
    if (typeof body.conclusion === "string") {
      run.conclusion = body.conclusion;
      run.status = "completed";
    }
    if (run.status === "completed" && !run.conclusion) {
      return validationFailed("Invalid request.", ["conclusion is required when status is completed"]);
    }
    if (run.status === "completed") run.completedAt ??= gh.iso();
    const output = body.output === undefined ? undefined : record(body.output);
    if (output) {
      if (typeof output.title === "string") run.output.title = output.title;
      if (typeof output.summary === "string") run.output.summary = output.summary;
      if (typeof output.text === "string") run.output.text = output.text;
    }
    await gh.checkChanged(repo!, run.headSha);
    return json(checkRunJson(gh, run));
  });

  router.on("GET", "/repos/{owner}/{repo}/check-runs/{id}", (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { checks: "read" });
    if ("status" in caller) return caller;
    const run = gh.checkRuns.get(Number(params.id));
    if (!run || run.repo !== repo!.fullName.toLowerCase()) return notFound();
    return json(checkRunJson(gh, run));
  });

  router.on("GET", "/repos/{owner}/{repo}/commits/{ref}/check-runs", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { checks: "read" });
    if ("status" in caller) return caller;
    const sha = await gh.git.resolve(repo!.fullName, params.ref);
    if (!sha) return validationFailed(`No commit found for SHA: ${params.ref}`);
    const name = req.query.get("check_name");
    const filter = req.query.get("filter") ?? "latest";
    let runs = [...gh.checkRuns.values()]
      .filter((r) => r.repo === repo!.fullName.toLowerCase() && r.headSha === sha)
      .filter((r) => !name || r.name === name)
      .sort((a, b) => b.id - a.id);
    if (filter === "latest") {
      const seen = new Set<string>();
      runs = runs.filter((r) => {
        const key = `${r.appId}:${r.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const { page, headers } = paged(req, runs);
    return json({ total_count: runs.length, check_runs: page.map((r) => checkRunJson(gh, r)) }, 200, headers);
  });

  router.on("POST", "/repos/{owner}/{repo}/statuses/{sha}", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { statuses: "write" });
    if ("status" in caller) return caller;
    const body = record(jsonBody(req));
    if (!["error", "failure", "pending", "success"].includes(String(body.state))) {
      return validationFailed("Validation Failed", [{ resource: "Status", field: "state", code: "custom" }]);
    }
    if (!(await gh.git.commitInfo(repo!.fullName, params.sha)))
      return validationFailed(`No commit found for SHA: ${params.sha}`);
    const status = {
      id: gh.nextId(),
      repo: repo!.fullName.toLowerCase(),
      sha: params.sha,
      state: body.state as "error" | "failure" | "pending" | "success",
      context: typeof body.context === "string" ? body.context : "default",
      description: typeof body.description === "string" ? body.description : null,
      targetUrl: typeof body.target_url === "string" ? body.target_url : null,
      createdAt: gh.iso(),
    };
    gh.statuses.push(status);
    await gh.checkChanged(repo!, status.sha);
    return json(
      {
        id: status.id,
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.targetUrl,
        created_at: status.createdAt,
      },
      201,
    );
  });

  router.on("GET", "/repos/{owner}/{repo}/commits/{ref}/status", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { statuses: "read" });
    if ("status" in caller) return caller;
    const sha = await gh.git.resolve(repo!.fullName, params.ref);
    if (!sha) return validationFailed(`No commit found for SHA: ${params.ref}`);
    const latest = latestStatuses(gh, repo!, sha);
    const { page } = paged(req, latest);
    return json({
      state: combinedState(latest),
      sha,
      total_count: latest.length,
      statuses: page.map((s) => ({
        id: s.id,
        state: s.state,
        context: s.context,
        description: s.description,
        target_url: s.targetUrl,
        created_at: s.createdAt,
      })),
    });
  });

  // --- Content ---------------------------------------------------------------------------
  router.on("GET", "/repos/{owner}/{repo}/compare/*", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { contents: "read" });
    if ("status" in caller) return caller;
    const spec = params["*"];
    const split = spec.indexOf("...");
    if (split <= 0) return notFound();
    const fromRef = decodeURIComponent(spec.slice(0, split));
    const toRef = decodeURIComponent(spec.slice(split + 3));
    const from = await gh.git.resolve(repo!.fullName, fromRef);
    const to = await gh.git.resolve(repo!.fullName, toRef);
    if (!from || !to) return notFound();
    const mergeBase = await gh.git.mergeBase(repo!.fullName, from, to);
    if (!mergeBase) return notFound();
    const aheadBy = await gh.git.countBetween(repo!.fullName, from, to);
    const behindBy = await gh.git.countBetween(repo!.fullName, to, from);
    const status =
      aheadBy === 0 && behindBy === 0 ? "identical" : behindBy === 0 ? "ahead" : aheadBy === 0 ? "behind" : "diverged";
    const commits = await gh.git.commitsBetween(repo!.fullName, mergeBase, to);
    const files = await gh.git.diff(repo!.fullName, mergeBase, to);
    return json({
      status,
      ahead_by: aheadBy,
      behind_by: behindBy,
      total_commits: aheadBy,
      base_commit: { sha: from },
      merge_base_commit: { sha: mergeBase },
      commits: commits.slice(0, COMPARE_COMMITS_LIMIT).map(commitJson),
      files: files.slice(0, COMPARE_FILES_LIMIT),
    });
  });

  router.on("GET", "/repos/{owner}/{repo}/contents/*", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { contents: "read" });
    if ("status" in caller) return caller;
    const path = params["*"].split("/").map(decodeURIComponent).join("/");
    const ref = req.query.get("ref") ?? repo!.defaultBranch;
    const found = await gh.git.read(repo!.fullName, ref, path);
    if (!found) return notFound();
    const accept = header(req, "accept") ?? "";
    if (found.kind === "dir") {
      return json(
        found.entries.map((e) => ({
          type: e.type === "tree" ? "dir" : "file",
          name: e.path.split("/").pop(),
          path: e.path,
          sha: e.sha,
          size: e.size ?? 0,
        })),
      );
    }
    if (accept.includes("raw")) {
      return {
        status: 200,
        headers: {
          "content-type": "application/vnd.github.raw+json; charset=utf-8",
          "content-length": String(found.content.length),
        },
        body: found.content,
      };
    }
    return json({
      type: "file",
      encoding: "base64",
      name: path.split("/").pop(),
      path,
      sha: found.sha,
      size: found.content.length,
      content: found.content.toString("base64"),
    });
  });

  router.on("GET", "/repos/{owner}/{repo}/git/trees/{ref}", async (req, params, ctx) => {
    const repo = repoOf(gh, params);
    const caller = installationCaller(gh, req, ctx, repo, { contents: "read" });
    if ("status" in caller) return caller;
    const sha = await gh.git.resolve(repo!.fullName, params.ref);
    if (!sha) return notFound();
    const entries = await gh.git.lsTree(repo!.fullName, sha, req.query.get("recursive") !== null);
    return json({
      sha,
      truncated: false,
      tree: entries.map((e) => ({
        path: e.path,
        mode: e.mode,
        type: e.type,
        sha: e.sha,
        ...(e.size !== undefined ? { size: e.size } : {}),
      })),
    });
  });

  // --- GraphQL (review threads, ready for review) -----------------------------------------
  router.on("POST", "/graphql", (req, _params, ctx) => handleGraphql(gh, req, ctx));

  return router;
}

export function commitJson(info: {
  sha: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
}): Record<string, unknown> {
  return {
    sha: info.sha,
    parents: info.parents.map((sha) => ({ sha })),
    commit: { message: info.message, author: { name: info.authorName, email: info.authorEmail, date: info.date } },
  };
}

export function latestStatuses(gh: GitHubState, repo: SimRepo, sha: string): GitHubState["statuses"] {
  const latest = new Map<string, GitHubState["statuses"][number]>();
  for (const status of gh.statuses) {
    if (status.repo === repo.fullName.toLowerCase() && status.sha === sha) latest.set(status.context, status);
  }
  return [...latest.values()];
}

export function combinedState(statuses: GitHubState["statuses"]): string {
  if (statuses.length === 0) return "pending";
  if (statuses.some((s) => s.state === "error" || s.state === "failure")) return "failure";
  if (statuses.some((s) => s.state === "pending")) return "pending";
  return "success";
}

/** Opens a pull request (and its issue twin) without any request: shared by REST and scripts. */
export function openPull(
  gh: GitHubState,
  repo: SimRepo,
  input: { title: string; body: string | null; headRef: string; baseRef: string; draft: boolean; user: SimUser },
): SimPull {
  const number = repo.nextNumber++;
  const now = gh.iso();
  const id = gh.nextId();
  const pull: SimPull = {
    repo: repo.fullName.toLowerCase(),
    number,
    id,
    nodeId: `PR_sim${id}`,
    title: input.title,
    body: input.body,
    state: "open",
    draft: input.draft,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergedBy: null,
    user: input.user,
    headRef: input.headRef,
    headShaAtClose: null,
    baseRef: input.baseRef,
    labels: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    autoMerge: null,
  };
  gh.pulls.set(gh.issueKey(repo.fullName, number), pull);
  gh.issues.set(gh.issueKey(repo.fullName, number), {
    repo: repo.fullName.toLowerCase(),
    number,
    id: gh.nextId(),
    nodeId: `I_sim${id}`,
    title: input.title,
    body: input.body,
    state: "open",
    stateReason: null,
    user: input.user,
    labels: pull.labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isPull: true,
  });
  return pull;
}

export function addComment(
  gh: GitHubState,
  repo: SimRepo,
  issueNumber: number,
  body: string,
  user: SimUser,
  viaApp: number | null,
): NonNullable<ReturnType<typeof gh.comments.get>> {
  const id = gh.nextId();
  const now = gh.iso();
  const comment = {
    id,
    nodeId: `IC_sim${id}`,
    repo: repo.fullName.toLowerCase(),
    issueNumber,
    body,
    user,
    viaApp,
    authorAssociation: user.type === "Bot" ? "NONE" : gh.association(repo, user.login),
    createdAt: now,
    updatedAt: now,
  };
  gh.comments.set(id, comment);
  return comment;
}

export function registerReview(
  gh: GitHubState,
  repo: SimRepo,
  pull: SimPull,
  input: {
    user: SimUser;
    viaApp: number | null;
    state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
    body: string;
    commitId: string;
  },
): NonNullable<ReturnType<typeof gh.reviews.get>> {
  const id = gh.nextId();
  const review = {
    id,
    nodeId: `PRR_sim${id}`,
    repo: repo.fullName.toLowerCase(),
    pull: pull.number,
    user: input.user,
    viaApp: input.viaApp,
    state: input.state,
    body: input.body,
    commitId: input.commitId,
    submittedAt: gh.iso(),
  };
  gh.reviews.set(id, review);
  return review;
}

export async function addReviewComment(
  gh: GitHubState,
  repo: SimRepo,
  pull: SimPull,
  input: {
    reviewId: number | null;
    path: string;
    line: number | null;
    side: "LEFT" | "RIGHT";
    body: string;
    user: SimUser;
    viaApp: number | null;
    commitId: string;
    inReplyTo: number | null;
  },
): Promise<NonNullable<ReturnType<typeof gh.reviewComments.get>>> {
  const id = gh.nextId();
  const now = gh.iso();
  const parent = input.inReplyTo ? gh.reviewComments.get(input.inReplyTo) : undefined;
  const threadId = parent?.threadId ?? `PRRT_sim${id}`;
  const comment = {
    id,
    nodeId: `PRRC_sim${id}`,
    repo: repo.fullName.toLowerCase(),
    pull: pull.number,
    reviewId: input.reviewId,
    threadId,
    path: input.path,
    line: input.line,
    side: input.side,
    body: input.body,
    user: input.user,
    viaApp: input.viaApp,
    inReplyTo: input.inReplyTo,
    commitId: input.commitId,
    createdAt: now,
    updatedAt: now,
  };
  gh.reviewComments.set(id, comment);
  const thread = gh.threads.get(threadId);
  if (thread) thread.commentIds.push(id);
  else {
    gh.threads.set(threadId, {
      id: threadId,
      repo: comment.repo,
      pull: pull.number,
      path: input.path,
      line: input.line,
      commitId: input.commitId,
      resolved: false,
      commentIds: [id],
    });
  }
  gh.emit(
    "pull_request_review_comment",
    { action: "created", comment: reviewCommentJson(gh, comment), pull_request: await pullBody(gh, pull) },
    repo,
    input.user,
  );
  return comment;
}
