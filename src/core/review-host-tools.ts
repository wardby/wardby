/**
 * Built-in code-review tools (`repo_*`) for native agents with at least one
 * AgentRepository link. Like the memory built-ins they are synthesized by the
 * runner, recognized by name, and never run in the sandbox. The security
 * boundary is here: every call names a repository, which must resolve to one
 * of this agent's links (with write access for write tools); the host then
 * mints its own least-permission credential. The model never sees a token,
 * a check id, or a marker. Never throws — failures are JSON tool results.
 * See docs/private/2026-09-25-code-review-host-design.md §7.
 */
import { z } from "zod";
import type { LoadedTool } from "../providers/engine/types.js";
import {
  REVIEW_HOST_PROVIDERS,
  ReviewHostError,
  type ReviewHostProvider,
  type ReviewHostRegistry,
} from "../providers/review-host/types.js";
import { normalizeGitHubRepository } from "../coding/protocol.js";

export interface RepositoryLink {
  provider: ReviewHostProvider;
  repository: string;
  access: "read" | "write";
  checkName: string | null;
}

export interface RunHostCheckRef {
  provider: string;
  repository: string;
  checkId: string;
}

export interface ReviewToolContext {
  agentId: string;
  links: readonly RepositoryLink[];
  hosts: ReviewHostRegistry;
  /** The run's open check, if the control plane started one. */
  runCheck: RunHostCheckRef | null;
  /** Records that the run's check is now completed (RunHostCheck.completedAt). */
  markRunCheckCompleted: () => Promise<void>;
}

const DEFAULT_PATCH_CHARS = 60_000;
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const Repository = z.string().min(1).max(300);

const PrReadArgs = z
  .object({
    repository: Repository,
    prNumber: z.number().int().positive(),
    sinceSha: SHA.optional(),
    maxPatchChars: z.number().int().positive().max(200_000).optional(),
  })
  .strict();
const ReadFileArgs = z
  .object({
    repository: Repository,
    path: z.string().min(1).max(500),
    ref: z.string().min(1).max(200).optional(),
    startLine: z.number().int().positive().optional(),
    maxLines: z.number().int().positive().max(2000).optional(),
  })
  .strict();
const ListFilesArgs = z
  .object({
    repository: Repository,
    ref: z.string().min(1).max(200).optional(),
    pathPrefix: z.string().max(500).optional(),
  })
  .strict();
const InlineCommentArgs = z
  .object({
    path: z.string().min(1).max(500),
    line: z.number().int().positive(),
    side: z.enum(["LEFT", "RIGHT"]).optional(),
    severity: z.string().min(1).max(20),
    body: z.string().min(1).max(4000),
  })
  .strict();
const PublishArgs = z
  .object({
    repository: Repository,
    prNumber: z.number().int().positive(),
    headSha: SHA,
    verdict: z.enum(["APPROVE", "CHANGES_REQUESTED", "COMMENT"]),
    summary: z.string().min(1).max(140),
    body: z.string().min(1).max(60_000),
    comments: z.array(InlineCommentArgs).max(50).optional(),
  })
  .strict();
const CommentArgs = z
  .object({
    repository: Repository,
    number: z.number().int().positive(),
    body: z.string().min(1).max(20_000),
    replyToReviewCommentId: z
      .string()
      .regex(/^\d{1,20}$/)
      .optional(),
  })
  .strict();

const REPOSITORY_PROP = {
  type: "string",
  description: 'The repository as "owner/name" (or "github.com/owner/name"); must be one this agent is linked to.',
};

export const REVIEW_HOST_TOOL_DEFS: LoadedTool[] = [
  {
    name: "repo_pr_read",
    description:
      "Reads a pull request: title, body, author, state, refs, headSha, isFork, each changed file's unified-diff patch (patches share a character budget; truncated ones are flagged), and lastReviewedSha — the head you last reviewed on this PR, if any. Pass sinceSha (usually lastReviewedSha) to get only what changed since then.",
    jsonSchema: {
      type: "object",
      properties: {
        repository: REPOSITORY_PROP,
        prNumber: { type: "integer", minimum: 1 },
        sinceSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        maxPatchChars: { type: "integer", minimum: 1, maximum: 200000 },
      },
      required: ["repository", "prNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "repo_read_file",
    description:
      "Reads a file with line numbers (paged by startLine/maxLines, default 400 lines) or lists a directory, at a ref. Use the PR's headSha as the ref when reviewing.",
    jsonSchema: {
      type: "object",
      properties: {
        repository: REPOSITORY_PROP,
        path: { type: "string" },
        ref: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        maxLines: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["repository", "path"],
      additionalProperties: false,
    },
  },
  {
    name: "repo_list_files",
    description:
      'Lists every file (path and size) at a ref (default: the default branch), optionally under a path prefix such as "tests/". Skips node_modules, dist, and lockfiles.',
    jsonSchema: {
      type: "object",
      properties: { repository: REPOSITORY_PROP, ref: { type: "string" }, pathPrefix: { type: "string" } },
      required: ["repository"],
      additionalProperties: false,
    },
  },
  {
    name: "repo_publish_review",
    description:
      "Publishes your review of one pull request head, in one call: inline comments on diff lines (a ```suggestion block in a comment body becomes a one-click fix; comments on lines outside the diff move to the summary automatically), one summary comment that is edited in place on later reviews, and — only for an agent linked with a check name — the check conclusion (APPROVE = success, CHANGES_REQUESTED = failure, COMMENT = neutral). Returns published:false with reason stale_head if the PR moved on; then stop.",
    jsonSchema: {
      type: "object",
      properties: {
        repository: REPOSITORY_PROP,
        prNumber: { type: "integer", minimum: 1 },
        headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        verdict: { type: "string", enum: ["APPROVE", "CHANGES_REQUESTED", "COMMENT"] },
        summary: { type: "string", maxLength: 140, description: "One line, shown on the check." },
        body: { type: "string", maxLength: 60000, description: "The full review in markdown." },
        comments: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              line: {
                type: "integer",
                minimum: 1,
                description: "Line number in the new file (side RIGHT) or the old file (side LEFT).",
              },
              side: { type: "string", enum: ["LEFT", "RIGHT"] },
              severity: { type: "string", description: "e.g. CRITICAL, MAJOR, MINOR, NIT" },
              body: { type: "string", maxLength: 4000 },
            },
            required: ["path", "line", "severity", "body"],
            additionalProperties: false,
          },
        },
      },
      required: ["repository", "prNumber", "headSha", "verdict", "summary", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "repo_comment",
    description:
      "Posts a comment on an issue or pull request conversation, or — with replyToReviewCommentId — replies inside an inline review thread.",
    jsonSchema: {
      type: "object",
      properties: {
        repository: REPOSITORY_PROP,
        number: { type: "integer", minimum: 1, description: "The issue or pull request number." },
        body: { type: "string", maxLength: 20000 },
        replyToReviewCommentId: { type: "string", pattern: "^\\d{1,20}$" },
      },
      required: ["repository", "number", "body"],
      additionalProperties: false,
    },
  },
];

export const REVIEW_HOST_TOOL_NAMES: ReadonlySet<string> = new Set(REVIEW_HOST_TOOL_DEFS.map((t) => t.name));
const WRITE_TOOLS: ReadonlySet<string> = new Set(["repo_publish_review", "repo_comment"]);

const HOST_PREFIXES: Record<ReviewHostProvider, string> = { github: "github.com/" };

function normalizeFor(provider: ReviewHostProvider, value: string): string | null {
  try {
    if (provider === "github") return normalizeGitHubRepository(value);
  } catch {
    return null;
  }
  return null;
}

export function resolveLink(
  links: readonly RepositoryLink[],
  repositoryArg: string,
): RepositoryLink | "ambiguous" | null {
  const raw = repositoryArg.trim();
  for (const provider of REVIEW_HOST_PROVIDERS) {
    const prefix = HOST_PREFIXES[provider];
    if (raw.toLowerCase().startsWith(prefix)) {
      const repository = normalizeFor(provider, raw.slice(prefix.length));
      return links.find((l) => l.provider === provider && l.repository === repository) ?? null;
    }
  }
  const matches = links.filter((l) => l.repository === normalizeFor(l.provider, raw));
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

function error(code: string, message: string = code): string {
  return JSON.stringify({ error: code, message });
}

/**
 * Dispatches one built-in repo tool call. Never throws — mirrors
 * runner.ts's `runSandboxTool` contract: a failure becomes a JSON error
 * result fed back to the model as the tool's result, not an engine-halting
 * exception.
 */
export async function handleReviewHostTool(name: string, argsJson: string, ctx: ReviewToolContext): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return error("invalid_arguments_json", err instanceof Error ? err.message : String(err));
  }
  const repositoryArg = (parsed as { repository?: unknown } | null)?.repository;
  if (typeof repositoryArg !== "string") return error("invalid_arguments", "repository is required");
  const link = resolveLink(ctx.links, repositoryArg);
  if (link === "ambiguous")
    return error("repository_not_linked", "Ambiguous repository; qualify it as host/owner/name.");
  if (!link) return error("repository_not_linked", `This agent is not linked to "${repositoryArg}".`);
  if (WRITE_TOOLS.has(name) && link.access !== "write") {
    return error("write_access_required", `This agent's link to ${link.repository} is read-only.`);
  }
  const host = ctx.hosts[link.provider];
  if (!host) return error("host_not_configured", `No ${link.provider} host is configured on this deployment.`);

  try {
    switch (name) {
      case "repo_pr_read": {
        const a = PrReadArgs.parse(parsed);
        return JSON.stringify(
          await host.readPullRequest(link.repository, a.prNumber, {
            sinceSha: a.sinceSha,
            maxPatchChars: a.maxPatchChars ?? DEFAULT_PATCH_CHARS,
            agentMarker: ctx.agentId,
          }),
        );
      }
      case "repo_read_file": {
        const a = ReadFileArgs.parse(parsed);
        return JSON.stringify(
          await host.readFile(link.repository, a.path, a.ref, {
            startLine: a.startLine ?? 1,
            maxLines: a.maxLines ?? 400,
          }),
        );
      }
      case "repo_list_files": {
        const a = ListFilesArgs.parse(parsed);
        return JSON.stringify(await host.listFiles(link.repository, a.ref, a.pathPrefix));
      }
      case "repo_publish_review": {
        const a = PublishArgs.parse(parsed);
        const ownsCheck =
          ctx.runCheck !== null &&
          ctx.runCheck.provider === link.provider &&
          ctx.runCheck.repository === link.repository;
        const result = await host.publishReview(link.repository, {
          prNumber: a.prNumber,
          headSha: a.headSha,
          verdict: a.verdict,
          summary: a.summary,
          body: a.body,
          comments: (a.comments ?? []).map((c) => ({ ...c, side: c.side ?? "RIGHT" })),
          agentMarker: ctx.agentId,
          checkName: link.checkName ?? undefined,
          ...(ownsCheck ? { checkId: ctx.runCheck!.checkId } : {}),
        });
        if (ownsCheck) await ctx.markRunCheckCompleted();
        return JSON.stringify(result);
      }
      case "repo_comment": {
        const a = CommentArgs.parse(parsed);
        return JSON.stringify(
          await host.comment(link.repository, {
            number: a.number,
            body: a.body,
            replyToReviewCommentId: a.replyToReviewCommentId,
          }),
        );
      }
      default:
        return error("unknown_tool", `No built-in tool named "${name}".`);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return error(
        "invalid_arguments",
        err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
      );
    }
    if (err instanceof ReviewHostError) return error(err.code, err.message);
    return error("host_api_error", "The host request failed.");
  }
}
