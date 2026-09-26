/**
 * GitHub App webhook → host-neutral HostEvent. Pure: no I/O. Signature
 * verification is over the exact request body text GitHub signed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeGitHubRepository } from "../../coding/protocol.js";
import type { HostEvent } from "./types.js";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const SAFE_SHA = /^[0-9a-f]{40}$/;

export function verifyGitHubSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const presented = Buffer.from(header.slice("sha256=".length), "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const int = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null);

function repositoryOf(payload: Json): string | null {
  const name = obj(payload.repository)?.full_name;
  if (typeof name !== "string") return null;
  try {
    return normalizeGitHubRepository(name);
  } catch {
    return null;
  }
}

function mentions(body: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@.-])@${escaped}(?![\\w-])`, "i").test(body);
}

export function normalizeGitHubEvent(eventName: string, payload: unknown, app: { id: number; slug: string }): HostEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const repository = repositoryOf(p);
  if (!repository) return null;

  if (eventName === "pull_request") {
    if (typeof p.action !== "string" || !PR_ACTIONS.has(p.action)) return null;
    const pr = obj(p.pull_request);
    const head = obj(pr?.head);
    const prNumber = int(pr?.number);
    const headSha = head?.sha;
    if (!prNumber || typeof headSha !== "string" || !SAFE_SHA.test(headSha)) return null;
    const headRepo = obj(head?.repo)?.full_name;
    const isFork = typeof headRepo !== "string" || headRepo.toLowerCase() !== repository;
    return { kind: "pr_updated", provider: "github", repository, prNumber, headSha, isFork };
  }

  if (eventName === "check_run") {
    if (p.action !== "rerequested") return null;
    const check = obj(p.check_run);
    if (int(obj(check?.app)?.id) !== app.id) return null;
    const prNumber = int(obj(Array.isArray(check?.pull_requests) ? check.pull_requests[0] : null)?.number);
    const headSha = check?.head_sha;
    const checkName = check?.name;
    if (!prNumber || typeof headSha !== "string" || !SAFE_SHA.test(headSha) || typeof checkName !== "string") return null;
    return { kind: "check_rerun", provider: "github", repository, prNumber, headSha, checkName };
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    if (p.action !== "created") return null;
    const comment = obj(p.comment);
    const user = obj(comment?.user);
    const body = comment?.body;
    const commentId = int(comment?.id);
    if (typeof body !== "string" || !commentId || !mentions(body, app.slug)) return null;
    if (typeof comment?.author_association !== "string" || !TRUSTED_ASSOCIATIONS.has(comment.author_association)) return null;
    if (user?.type !== "User" || typeof user.login !== "string") return null;
    if (eventName === "issue_comment") {
      const issue = obj(p.issue);
      const number = int(issue?.number);
      if (!number) return null;
      return {
        kind: "mention",
        provider: "github",
        repository,
        number,
        isPullRequest: obj(issue?.pull_request) !== null,
        comment: { kind: "conversation", id: String(commentId) },
        body,
        author: user.login,
      };
    }
    const number = int(obj(p.pull_request)?.number);
    if (!number) return null;
    return {
      kind: "mention",
      provider: "github",
      repository,
      number,
      isPullRequest: true,
      comment: { kind: "inline", id: String(commentId) },
      replyToReviewCommentId: String(commentId),
      body,
      author: user.login,
    };
  }
  return null;
}
