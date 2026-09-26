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
/** Mirrors the runId shape validated in providers/vcs (github.ts, git.ts). */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** The hidden marker a coding run writes at the top of every PR it opens (providers/vcs/github.ts); legacy prefix too. */
const RUN_MARKER = /^\s*<!-- (?:wardby|reevo-run):(\S+) -->/;

export function verifyGitHubSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const presented = Buffer.from(header.slice("sha256=".length), "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const int = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;

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

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function subjectOf(item: Json | null): { title: string; body: string } | undefined {
  return typeof item?.title === "string" ? { title: item.title, body: text(item.body) } : undefined;
}

/**
 * The run that opened this PR. Only a PR the App itself authored counts:
 * anyone can write the marker into their own PR's description.
 */
function priorRunIdOf(pr: Json | null, slug: string): string | undefined {
  const author = obj(pr?.user);
  if (author?.type !== "Bot" || typeof author.login !== "string") return undefined;
  if (author.login.toLowerCase() !== `${slug}[bot]`.toLowerCase()) return undefined;
  const id = RUN_MARKER.exec(text(pr?.body))?.[1];
  return id && SAFE_RUN_ID.test(id) ? id : undefined;
}

/**
 * A cheap pre-filter only: author_association is not a permission (MEMBER is
 * any org member, COLLABORATOR includes read and triage). The real gate is the
 * author's live repository permission, checked by id in core/host-events.ts.
 */
function trustedHuman(association: unknown, user: Json | null): user is Json & { login: string; id: number } {
  return (
    typeof association === "string" &&
    TRUSTED_ASSOCIATIONS.has(association) &&
    user?.type === "User" &&
    typeof user.login === "string" &&
    int(user.id) !== null
  );
}

export function normalizeGitHubEvent(
  eventName: string,
  payload: unknown,
  app: { id: number; slug: string },
): HostEvent | null {
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
    if (!prNumber || typeof headSha !== "string" || !SAFE_SHA.test(headSha) || typeof checkName !== "string")
      return null;
    return { kind: "check_rerun", provider: "github", repository, prNumber, headSha, checkName };
  }

  if (eventName === "issues") {
    if (p.action !== "opened" && p.action !== "edited") return null;
    const issue = obj(p.issue);
    const number = int(issue?.number);
    const title = issue?.title;
    if (!number || typeof title !== "string") return null;
    const body = text(issue?.body);
    const user = obj(issue?.user);
    if (!trustedHuman(issue?.author_association, user)) return null;
    if (!mentions(title, app.slug) && !mentions(body, app.slug)) return null;
    if (p.action === "edited") {
      // Only the author's own edit, and only one that newly adds the mention — not every later edit.
      const sender = obj(p.sender);
      if (sender?.type !== "User" || sender.login !== user.login) return null;
      const changes = obj(p.changes);
      const oldTitle = obj(changes?.title)?.from;
      const oldBody = obj(changes?.body)?.from;
      if (typeof oldTitle !== "string" && typeof oldBody !== "string") return null;
      const before = [typeof oldTitle === "string" ? oldTitle : title, typeof oldBody === "string" ? oldBody : body];
      if (before.some((t) => mentions(t, app.slug))) return null;
    }
    return {
      kind: "mention",
      provider: "github",
      repository,
      number,
      isPullRequest: obj(issue?.pull_request) !== null,
      comment: { kind: "subject", id: String(number) },
      body,
      author: user.login,
      authorId: String(user.id),
      subject: { title, body },
    };
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    if (p.action !== "created") return null;
    const comment = obj(p.comment);
    const user = obj(comment?.user);
    const body = comment?.body;
    const commentId = int(comment?.id);
    if (typeof body !== "string" || !commentId || !mentions(body, app.slug)) return null;
    if (!trustedHuman(comment?.author_association, user)) return null;
    const isInline = eventName === "pull_request_review_comment";
    const parent = obj(isInline ? p.pull_request : p.issue);
    const number = int(parent?.number);
    if (!number) return null;
    const isPullRequest = isInline || obj(parent?.pull_request) !== null;
    const subject = subjectOf(parent);
    const priorRunId = isPullRequest ? priorRunIdOf(parent, app.slug) : undefined;
    return {
      kind: "mention",
      provider: "github",
      repository,
      number,
      isPullRequest,
      comment: { kind: isInline ? "inline" : "conversation", id: String(commentId) },
      ...(isInline ? { replyToReviewCommentId: String(commentId) } : {}),
      body,
      author: user.login,
      authorId: String(user.id),
      ...(subject ? { subject } : {}),
      ...(priorRunId ? { priorRunId } : {}),
    };
  }
  return null;
}
