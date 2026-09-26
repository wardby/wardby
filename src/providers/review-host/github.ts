/**
 * GitHub implementation of CodeReviewHost, acting as the wardby GitHub App.
 * Each method mints its own installation token scoped to one repository and
 * the narrowest permission set that call needs (GitHubAppClient.withScopedToken),
 * and revokes it afterwards. See docs/private/2026-09-25-code-review-host-design.md §5.1.
 */
import type { GitHubAppClient } from "../vcs/github.js";
import { normalizeGitHubRepository } from "../../coding/protocol.js";
import { partitionComments } from "./diff-lines.js";
import {
  findingMarker,
  hasFindingMarker,
  hasReviewMarker,
  parseReviewMarker,
  renderInlineComment,
  renderSummaryComment,
  verdictConclusion,
} from "./review-format.js";
import {
  ReviewHostError,
  type CodeReviewHost,
  type CommentInput,
  type CommentRef,
  type CompleteCheckInput,
  type EditCommentInput,
  type FileListView,
  type FileReadResult,
  type HostPermission,
  type HostUser,
  type PublishReviewInput,
  type PublishReviewResult,
  type PullRequestFileView,
  type PullRequestHead,
  type PullRequestView,
  type ReviewThreadView,
  type StartCheckInput,
} from "./types.js";

const READ = { contents: "read", pull_requests: "read" } as const;
const SAFE_SHA = /^[0-9a-f]{40}$/;
const MAX_FILE_PAGES = 3;
const MAX_COMMENT_PAGES = 3;
const MAX_LISTED_FILES = 1000;
const VENDORED = /(^|\/)(node_modules|dist|\.venv)\//;
const CHECK_TEXT_LIMIT = 65_535;
const COMMENT_WRITE = { issues: "write", pull_requests: "write" } as const;
const REVIEW_WRITE = { pull_requests: "write", checks: "write" } as const;
/** Always implicitly granted to an installation token; enough for the collaborator-permission endpoint. */
const METADATA_READ = { metadata: "read" } as const;
const GITHUB_USER_ID = /^[1-9]\d{0,19}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Highest first: user.permissions booleans, which (unlike the legacy field) keep maintain and triage apart. */
const PERMISSION_FLAGS: ReadonlyArray<readonly [flag: string, level: HostPermission]> = [
  ["admin", "admin"],
  ["maintain", "maintain"],
  ["push", "write"],
  ["triage", "triage"],
  ["pull", "read"],
];
const LEGACY_PERMISSIONS: Readonly<Record<string, HostPermission>> = {
  admin: "admin",
  maintain: "maintain",
  write: "write",
  triage: "triage",
  read: "read",
};
const CHECK_TITLES = { APPROVE: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENT: "Comments" } as const;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReviewHostError("host_invalid_response");
  return value as Json;
}

function list(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new ReviewHostError("host_invalid_response");
  return value.map(record);
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new ReviewHostError("host_invalid_response");
  return value;
}

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ReviewHostError("host_invalid_response");
  return value;
}

/** Maps GitHubAppClient's fixed error messages onto host-neutral codes; keeps the body-free message. */
export function toReviewHostError(err: unknown): ReviewHostError {
  if (err instanceof ReviewHostError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (message === "github_app_not_installed") return new ReviewHostError("host_not_installed", message);
  if (message === "github_installation_token_scope_invalid") {
    return new ReviewHostError("host_permission_missing", message);
  }
  if (message === "github_api_invalid_response") return new ReviewHostError("host_invalid_response", message);
  if (message.startsWith("github_api_error") || message === "github_api_unavailable") {
    return new ReviewHostError("host_api_error", message);
  }
  return new ReviewHostError("host_api_error", "github_request_failed");
}

/** Ranks a collaborator-permission answer: user.permissions first, then the legacy permission field. */
function permissionLevel(answer: Json): HostPermission {
  const user = answer.user && typeof answer.user === "object" ? (answer.user as Json) : null;
  const flags = user?.permissions && typeof user.permissions === "object" ? (user.permissions as Json) : null;
  if (flags) return PERMISSION_FLAGS.find(([flag]) => flags[flag] === true)?.[1] ?? "none";
  return typeof answer.permission === "string" ? (LEGACY_PERMISSIONS[answer.permission] ?? "none") : "none";
}

/** True only for a comment the wardby App itself wrote; anyone can type a marker into a comment. */
function writtenByApp(comment: Json, appId: number): boolean {
  const app = comment.performed_via_github_app;
  return !!app && typeof app === "object" && (app as Json).id === appId;
}

function repoPath(repository: string): string {
  const [owner, name] = normalizeGitHubRepository(repository).split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function assertRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) {
    throw new ReviewHostError("host_api_error", "path_invalid");
  }
}

function fileView(raw: Json): PullRequestFileView & { fullPatch: string | undefined; changes: number } {
  return {
    filename: str(raw.filename),
    status: str(raw.status),
    additions: num(raw.additions),
    deletions: num(raw.deletions),
    previousFilename: typeof raw.previous_filename === "string" ? raw.previous_filename : undefined,
    patch: "",
    patchTruncated: false,
    fullPatch: typeof raw.patch === "string" ? raw.patch : undefined,
    changes: typeof raw.changes === "number" ? raw.changes : num(raw.additions) + num(raw.deletions),
  };
}

type GraphQl = (query: string, variables: Record<string, unknown>) => Promise<Json>;

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line comments(first: 1) { nodes { body author { __typename login } } } }
      }
    }
  }
}`;
const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;
/** resolveReviewThread is gated on Contents write for App tokens, although it changes no content. */
const RESOLVE_WRITE = { contents: "write", pull_requests: "write" } as const;
const MAX_THREAD_BODY = 1000;

/**
 * The agent's own unresolved threads: the first comment was written by this
 * App (a Bot author with the App's login) and carries the agent's finding
 * marker. Anyone can type a marker; only the App can be a Bot with its login.
 */
async function ownOpenThreads(
  graphql: GraphQl,
  repository: string,
  prNumber: number,
  agentMarker: string,
  slug: string,
): Promise<ReviewThreadView[]> {
  const [owner, name] = normalizeGitHubRepository(repository).split("/");
  const data = await graphql(THREADS_QUERY, { owner, name, number: prNumber });
  const threads = record(record(record(data.repository).pullRequest).reviewThreads);
  const nodes = list(threads.nodes ?? []);
  const marker = findingMarker(agentMarker);
  const out: ReviewThreadView[] = [];
  for (const node of nodes) {
    if (node.isResolved !== false || typeof node.id !== "string") continue;
    const first = list(record(node.comments).nodes ?? [])[0];
    const author = first && first.author && typeof first.author === "object" ? (first.author as Json) : null;
    if (author?.__typename !== "Bot" || (author.login !== slug && author.login !== `${slug}[bot]`)) continue;
    if (typeof first.body !== "string" || !hasFindingMarker(first.body, agentMarker)) continue;
    const outdated = node.isOutdated === true;
    out.push({
      id: node.id,
      path: str(node.path),
      line: !outdated && typeof node.line === "number" ? node.line : null,
      outdated,
      body: first.body.replace(marker, "").trim().slice(0, MAX_THREAD_BODY),
    });
  }
  return out;
}

export class GitHubReviewHost implements CodeReviewHost {
  readonly provider = "github" as const;

  constructor(private readonly client: GitHubAppClient) {}

  /** Runs `action` with a token for exactly `permissions`, translating failures to ReviewHostError. */
  protected async withToken<T>(
    repository: string,
    permissions: Record<string, "read" | "write">,
    action: (
      get: (path: string, init?: RequestInit, expected?: number[]) => Promise<Response>,
      graphql: GraphQl,
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.withScopedToken(repository, permissions, (token) =>
        action(
          (path, init, expected) => this.client.requestJson(path, token, init, expected),
          (query, variables) => this.client.graphql(token, query, variables),
        ),
      );
    } catch (err) {
      throw toReviewHostError(err);
    }
  }

  async repositoryPermission(repository: string, user: HostUser): Promise<{ level: HostPermission; login: string }> {
    if (!GITHUB_USER_ID.test(user.id) || !GITHUB_LOGIN.test(user.login)) {
      throw new ReviewHostError("host_api_error", "host_user_invalid");
    }
    const base = repoPath(repository);
    return this.withToken(repository, METADATA_READ, async (get) => {
      // Null = GitHub answered for no one (404) or for a different account: never trust it.
      const ask = async (login: string): Promise<HostPermission | null> => {
        const response = await get(`${base}/collaborators/${encodeURIComponent(login)}/permission`, {}, [200, 404]);
        if (response.status === 404) return null;
        const answer = record(await response.json());
        const answeredFor = answer.user && typeof answer.user === "object" ? (answer.user as Json).id : undefined;
        if (!Number.isSafeInteger(answeredFor) || String(answeredFor) !== user.id) return null;
        return permissionLevel(answer);
      };
      const level = await ask(user.login);
      if (level !== null) return { level, login: user.login };
      // The login may have been renamed (or recycled): resolve the account by id and retry once.
      const response = await get(`/user/${user.id}`, {}, [200, 404]);
      if (response.status === 404) return { level: "none", login: user.login };
      const current = record(await response.json());
      const login = current.login;
      if (String(current.id) !== user.id || typeof login !== "string" || !GITHUB_LOGIN.test(login)) {
        return { level: "none", login: user.login };
      }
      if (login.toLowerCase() === user.login.toLowerCase()) return { level: "none", login };
      return { level: (await ask(login)) ?? "none", login };
    });
  }

  async pullRequestHead(repository: string, prNumber: number): Promise<PullRequestHead> {
    return this.withToken(repository, READ, async (get) => {
      const pr = record(await (await get(`${repoPath(repository)}/pulls/${prNumber}`)).json());
      return this.head(repository, pr);
    });
  }

  private head(repository: string, pr: Json): PullRequestHead {
    const head = record(pr.head);
    const headRepo = head.repo && typeof head.repo === "object" ? record(head.repo) : null;
    const headSha = str(head.sha);
    if (!SAFE_SHA.test(headSha)) throw new ReviewHostError("host_invalid_response");
    const isFork =
      !headRepo ||
      typeof headRepo.full_name !== "string" ||
      headRepo.full_name.toLowerCase() !== normalizeGitHubRepository(repository);
    return { headSha, isFork, state: str(pr.state) };
  }

  async readPullRequest(
    repository: string,
    prNumber: number,
    opts: { sinceSha?: string; maxPatchChars: number; agentMarker: string },
  ): Promise<PullRequestView> {
    const base = repoPath(repository);
    return this.withToken(repository, READ, async (get, graphql) => {
      const pr = record(await (await get(`${base}/pulls/${prNumber}`)).json());
      const { headSha, isFork, state } = this.head(repository, pr);

      const prFiles = async (): Promise<Json[]> => {
        const all: Json[] = [];
        for (let page = 1; page <= MAX_FILE_PAGES; page++) {
          const batch = list(await (await get(`${base}/pulls/${prNumber}/files?per_page=100&page=${page}`)).json());
          all.push(...batch);
          if (batch.length < 100) break;
        }
        return all;
      };

      let rawFiles: Json[] | null = null;
      let comparedFrom: string | null = null;
      let baseMergedSince = false;
      if (opts.sinceSha && SAFE_SHA.test(opts.sinceSha) && opts.sinceSha !== headSha) {
        const compare = record(await (await get(`${base}/compare/${opts.sinceSha}...${headSha}`)).json());
        if (compare.status === "ahead") {
          rawFiles = list(compare.files ?? []);
          comparedFrom = opts.sinceSha;
          // A merge commit since the last review (typically the base branch
          // merged in) makes the compare carry every base-branch change too.
          // The PR's own diff is always relative to the base, so it holds
          // only the PR's changes; keep those in files that moved since.
          baseMergedSince = list(compare.commits ?? []).some((c) => list(c.parents ?? []).length > 1);
          if (baseMergedSince) {
            const changedSince = new Set(rawFiles.map((f) => f.filename));
            rawFiles = (await prFiles()).filter((f) => changedSince.has(f.filename));
          }
        }
      }
      rawFiles ??= await prFiles();

      let budget = opts.maxPatchChars;
      const files = rawFiles.map((raw) => {
        const { fullPatch, changes, ...view } = fileView(raw);
        const patch = fullPatch ?? "";
        const kept = patch.length <= budget ? patch : patch.slice(0, Math.max(0, budget));
        budget -= kept.length;
        return {
          ...view,
          patch: kept,
          patchTruncated: kept.length < patch.length || (fullPatch === undefined && changes > 0),
        };
      });

      const { id: appId } = await this.client.appIdentity();
      let lastReviewedSha: string | null = null;
      for (let page = 1; page <= MAX_COMMENT_PAGES && !lastReviewedSha; page++) {
        const comments = list(
          await (await get(`${base}/issues/${prNumber}/comments?per_page=100&page=${page}`)).json(),
        );
        for (const comment of comments) {
          if (typeof comment.body === "string" && writtenByApp(comment, appId)) {
            lastReviewedSha ??= parseReviewMarker(comment.body, opts.agentMarker);
          }
        }
        if (comments.length < 100) break;
      }

      const { slug } = await this.client.appIdentity();
      const openThreads = await ownOpenThreads(graphql, repository, prNumber, opts.agentMarker, slug);

      const user = pr.user && typeof pr.user === "object" ? record(pr.user) : null;
      return {
        number: num(pr.number),
        title: str(pr.title),
        body: (typeof pr.body === "string" ? pr.body : "").slice(0, 8000),
        author: user && typeof user.login === "string" ? user.login : null,
        state,
        merged: pr.merged === true,
        draft: pr.draft === true,
        baseRef: str(record(pr.base).ref),
        headRef: str(record(pr.head).ref),
        headSha,
        isFork,
        htmlUrl: str(pr.html_url),
        lastReviewedSha,
        comparedFrom,
        baseMergedSince,
        files,
        openThreads,
      };
    });
  }

  async readFile(
    repository: string,
    path: string,
    ref: string | undefined,
    window: { startLine: number; maxLines: number },
  ): Promise<FileReadResult> {
    assertRelativePath(path);
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.withToken(repository, { contents: "read" }, async (get) => {
      const response = await get(
        `${repoPath(repository)}/contents/${encoded}${query}`,
        { headers: { accept: "application/vnd.github.raw+json" } },
        [200, 404],
      );
      if (response.status === 404) return { kind: "not_found", path };
      const text = await response.text();
      if (text.trimStart().startsWith("[")) {
        try {
          const entries: unknown = JSON.parse(text);
          if (
            Array.isArray(entries) &&
            entries.every((e) => e && typeof e === "object" && "type" in e && "path" in e)
          ) {
            return {
              kind: "directory",
              path,
              entries: (entries as Array<{ type: string; path: string }>).map(
                (e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}`,
              ),
            };
          }
        } catch {
          // A file whose content happens to start with "[" — fall through.
        }
      }
      const lines = text.split("\n");
      const slice = lines.slice(window.startLine - 1, window.startLine - 1 + window.maxLines);
      return {
        kind: "file",
        path,
        ref: ref ?? "default branch",
        totalLines: lines.length,
        startLine: window.startLine,
        endLine: window.startLine + slice.length - 1,
        truncated: window.startLine - 1 + slice.length < lines.length,
        content: slice.map((line, i) => `${window.startLine + i}: ${line}`).join("\n"),
      };
    });
  }

  async listFiles(repository: string, ref: string | undefined, pathPrefix = ""): Promise<FileListView> {
    const base = repoPath(repository);
    return this.withToken(repository, { contents: "read" }, async (get) => {
      const resolvedRef = ref ?? str(record(await (await get(base)).json()).default_branch);
      const tree = record(await (await get(`${base}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`)).json());
      const files = list(tree.tree)
        .filter((e) => e.type === "blob" && typeof e.path === "string" && e.path.startsWith(pathPrefix))
        .filter((e) => !VENDORED.test(str(e.path)) && !str(e.path).endsWith("package-lock.json"))
        .map((e) => `${str(e.path)} (${num(e.size)} bytes)`);
      return {
        ref: resolvedRef,
        count: files.length,
        truncated: tree.truncated === true || files.length > MAX_LISTED_FILES,
        files: files.slice(0, MAX_LISTED_FILES),
      };
    });
  }

  async publishReview(repository: string, input: PublishReviewInput): Promise<PublishReviewResult> {
    const published = await this.publishOnly(repository, input);
    if (!published.published) return published;
    const requested = [...new Set(input.resolveThreadIds ?? [])];
    if (requested.length === 0) return published;
    return { ...published, ...(await this.resolveOwnThreads(repository, input, requested)) };
  }

  /**
   * Resolves the requested threads that are still this agent's own open
   * threads on the PR, each with its own GraphQL call; everything else is
   * skipped. Never throws: the review is already published, so a refusal
   * (for example an App without Contents write) only skips.
   */
  private async resolveOwnThreads(
    repository: string,
    input: PublishReviewInput,
    requested: string[],
  ): Promise<{ resolvedThreadIds: string[]; skippedThreadIds: string[] }> {
    const resolvedThreadIds: string[] = [];
    try {
      const { slug } = await this.client.appIdentity();
      await this.withToken(repository, RESOLVE_WRITE, async (_get, graphql) => {
        const own = new Set(
          (await ownOpenThreads(graphql, repository, input.prNumber, input.agentMarker, slug)).map((t) => t.id),
        );
        for (const threadId of requested) {
          if (!own.has(threadId)) continue;
          try {
            await graphql(RESOLVE_MUTATION, { threadId });
            resolvedThreadIds.push(threadId);
          } catch {
            // Skipped below; the thread stays open.
          }
        }
      });
    } catch {
      // Listing or the token failed: every requested thread is skipped.
    }
    const resolved = new Set(resolvedThreadIds);
    return { resolvedThreadIds, skippedThreadIds: requested.filter((id) => !resolved.has(id)) };
  }

  private async publishOnly(repository: string, input: PublishReviewInput): Promise<PublishReviewResult> {
    const base = repoPath(repository);
    return this.withToken(repository, REVIEW_WRITE, async (get) => {
      const pr = record(await (await get(`${base}/pulls/${input.prNumber}`)).json());
      const { headSha } = this.head(repository, pr);
      if (headSha !== input.headSha) {
        if (input.checkId) {
          await this.patchCheck(get, base, {
            checkId: input.checkId,
            conclusion: "neutral",
            title: "Superseded by a newer push",
            summary: `The pull request moved to ${headSha.slice(0, 7)} before this review finished.`,
          });
        }
        return { published: false, reason: "stale_head", currentHeadSha: headSha };
      }

      const patches = new Map<string, string | undefined>();
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const batch = list(await (await get(`${base}/pulls/${input.prNumber}/files?per_page=100&page=${page}`)).json());
        for (const file of batch)
          patches.set(str(file.filename), typeof file.patch === "string" ? file.patch : undefined);
        if (batch.length < 100) break;
      }
      const { inline, outside } = partitionComments(input.comments, patches);

      let reviewUrl: string | null = null;
      if (inline.length > 0) {
        const review = record(
          await (
            await get(
              `${base}/pulls/${input.prNumber}/reviews`,
              {
                method: "POST",
                body: JSON.stringify({
                  commit_id: input.headSha,
                  event: "COMMENT",
                  body: `wardby review: ${inline.length} inline comment${inline.length === 1 ? "" : "s"} — the summary is in the conversation.`,
                  comments: inline.map((c) => ({
                    path: c.path,
                    line: c.line,
                    side: c.side,
                    body: renderInlineComment(c, input.agentMarker),
                  })),
                }),
              },
              [200],
            )
          ).json(),
        );
        reviewUrl = str(review.html_url);
      }

      const summaryBody = renderSummaryComment({
        agentMarker: input.agentMarker,
        headSha: input.headSha,
        verdict: input.verdict,
        summary: input.summary,
        body: input.body,
        outside,
      });
      const { id: appId } = await this.client.appIdentity();
      const existing = await this.findSummaryComment(get, base, input.prNumber, input.agentMarker, appId);
      const summaryResponse = existing
        ? await get(
            `${base}/issues/comments/${existing}`,
            { method: "PATCH", body: JSON.stringify({ body: summaryBody }) },
            [200],
          )
        : await get(
            `${base}/issues/${input.prNumber}/comments`,
            { method: "POST", body: JSON.stringify({ body: summaryBody }) },
            [201],
          );
      const summaryCommentUrl = str(record(await summaryResponse.json()).html_url);

      const conclusion = verdictConclusion(input.verdict);
      const output = {
        title: CHECK_TITLES[input.verdict],
        summary: input.summary,
        text: summaryBody.slice(0, CHECK_TEXT_LIMIT),
      };
      let checkId: string | null = input.checkId ?? null;
      if (checkId) {
        await this.patchCheck(get, base, { checkId, conclusion, ...output, detailsUrl: summaryCommentUrl });
      } else if (input.checkName) {
        const created = record(
          await (
            await get(
              `${base}/check-runs`,
              {
                method: "POST",
                body: JSON.stringify({
                  name: input.checkName,
                  head_sha: input.headSha,
                  status: "completed",
                  conclusion,
                  details_url: summaryCommentUrl,
                  output,
                }),
              },
              [201],
            )
          ).json(),
        );
        checkId = String(num(created.id));
      }
      return {
        published: true,
        reviewUrl,
        summaryCommentUrl,
        checkId,
        checkConclusion: conclusion,
        inlineCount: inline.length,
        outsideDiffCount: outside.length,
        resolvedThreadIds: [],
        skippedThreadIds: [],
      };
    });
  }

  private async findSummaryComment(
    get: (path: string, init?: RequestInit, expected?: number[]) => Promise<Response>,
    base: string,
    prNumber: number,
    agentMarker: string,
    appId: number,
  ): Promise<number | null> {
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const comments = list(await (await get(`${base}/issues/${prNumber}/comments?per_page=100&page=${page}`)).json());
      const mine = comments.find(
        (c) => typeof c.body === "string" && writtenByApp(c, appId) && hasReviewMarker(c.body, agentMarker),
      );
      if (mine) return num(mine.id);
      if (comments.length < 100) break;
    }
    return null;
  }

  private async patchCheck(
    get: (path: string, init?: RequestInit, expected?: number[]) => Promise<Response>,
    base: string,
    input: CompleteCheckInput,
  ): Promise<void> {
    await get(
      `${base}/check-runs/${encodeURIComponent(input.checkId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "completed",
          conclusion: input.conclusion,
          ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
          output: {
            title: input.title,
            summary: input.summary.slice(0, CHECK_TEXT_LIMIT),
            ...(input.text !== undefined ? { text: input.text.slice(0, CHECK_TEXT_LIMIT) } : {}),
          },
        }),
      },
      [200],
    );
  }

  async comment(repository: string, input: CommentInput): Promise<{ url: string; id: string }> {
    const base = repoPath(repository);
    return this.withToken(repository, COMMENT_WRITE, async (get) => {
      const response = input.replyToReviewCommentId
        ? await get(
            `${base}/pulls/${input.number}/comments/${encodeURIComponent(input.replyToReviewCommentId)}/replies`,
            { method: "POST", body: JSON.stringify({ body: input.body }) },
            [201],
          )
        : await get(
            `${base}/issues/${input.number}/comments`,
            { method: "POST", body: JSON.stringify({ body: input.body }) },
            [201],
          );
      const created = record(await response.json());
      return { url: str(created.html_url), id: String(num(created.id)) };
    });
  }

  async editComment(repository: string, input: EditCommentInput): Promise<void> {
    const base = repoPath(repository);
    const id = encodeURIComponent(input.id);
    const path = input.kind === "inline" ? `${base}/pulls/comments/${id}` : `${base}/issues/comments/${id}`;
    await this.withToken(repository, COMMENT_WRITE, async (get) => {
      await get(path, { method: "PATCH", body: JSON.stringify({ body: input.body }) }, [200]);
    });
  }

  async acknowledge(repository: string, target: CommentRef): Promise<void> {
    const base = repoPath(repository);
    const id = encodeURIComponent(target.id);
    const path =
      target.kind === "inline"
        ? `${base}/pulls/comments/${id}/reactions`
        : target.kind === "subject"
          ? `${base}/issues/${id}/reactions`
          : `${base}/issues/comments/${id}/reactions`;
    await this.withToken(repository, COMMENT_WRITE, async (get) => {
      await get(path, { method: "POST", body: JSON.stringify({ content: "eyes" }) }, [200, 201]);
    });
  }

  async startCheck(repository: string, input: StartCheckInput): Promise<{ checkId: string }> {
    const base = repoPath(repository);
    return this.withToken(repository, { checks: "write" }, async (get) => {
      const created = record(
        await (
          await get(
            `${base}/check-runs`,
            {
              method: "POST",
              body: JSON.stringify({
                name: input.name,
                head_sha: input.headSha,
                status: "in_progress",
                output: { title: "Review in progress", summary: "wardby is reviewing this commit." },
              }),
            },
            [201],
          )
        ).json(),
      );
      return { checkId: String(num(created.id)) };
    });
  }

  async completeCheck(repository: string, input: CompleteCheckInput): Promise<void> {
    const base = repoPath(repository);
    await this.withToken(repository, { checks: "write" }, (get) => this.patchCheck(get, base, input));
  }
}
