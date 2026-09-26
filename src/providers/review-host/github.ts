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
  type FileListView,
  type FileReadResult,
  type PublishReviewInput,
  type PublishReviewResult,
  type PullRequestFileView,
  type PullRequestHead,
  type PullRequestView,
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

export class GitHubReviewHost implements CodeReviewHost {
  readonly provider = "github" as const;

  constructor(private readonly client: GitHubAppClient) {}

  /** Runs `action` with a token for exactly `permissions`, translating failures to ReviewHostError. */
  protected async withToken<T>(
    repository: string,
    permissions: Record<string, "read" | "write">,
    action: (get: (path: string, init?: RequestInit, expected?: number[]) => Promise<Response>) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.client.withScopedToken(repository, permissions, (token) =>
        action((path, init, expected) => this.client.requestJson(path, token, init, expected)),
      );
    } catch (err) {
      throw toReviewHostError(err);
    }
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
    return this.withToken(repository, READ, async (get) => {
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
                    body: renderInlineComment(c),
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

  async comment(repository: string, input: CommentInput): Promise<{ url: string }> {
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
      return { url: str(record(await response.json()).html_url) };
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
