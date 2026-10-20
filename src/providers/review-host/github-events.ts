/**
 * GitHub App webhook → host-neutral HostEvent. Pure: no I/O. Signature
 * verification is over the exact request body text GitHub signed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeGitHubRepository } from "../../coding/protocol.js";
import { withoutMarkdownCode } from "../../core/markdown-code.js";
import type { HostEvent } from "./types.js";

const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
/**
 * GitHub labels an organization member whose membership is private CONTRIBUTOR
 * or NONE, so both pass; first-time authors and mannequins are drive-by
 * accounts that cannot have access to a repository they never committed to.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"]);
const SAFE_SHA = /^[0-9a-f]{40}$/;
// GitHub's push payload includes at most 2048 commits.
const PUSH_MAX_COMMITS = 2048;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const PUSH_MAX_PATHS = 1000;
/** Pull requests one CI completion may re-review; a commit is rarely the head of more. */
const MAX_CI_PRS = 10;
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

/** A mention of the App outside code: a mention quoted in code documents it, not requests a run. */
function mentions(body: string, slug: string): boolean {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w@.-])@${escaped}(?![\\w-])`, "i").test(withoutMarkdownCode(body));
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function subjectOf(item: Json | null): { title: string; body: string } | undefined {
  return typeof item?.title === "string" ? { title: item.title, body: text(item.body) } : undefined;
}

/**
 * The run id in a PR description's marker. Only a PR the App itself authored
 * counts: anyone can write the marker into their own PR's description.
 */
export function appMarkerRunId(pr: Json | null, slug: string): string | undefined {
  const author = obj(pr?.user);
  if (author?.type !== "Bot" || typeof author.login !== "string") return undefined;
  if (author.login.toLowerCase() !== `${slug}[bot]`.toLowerCase()) return undefined;
  const id = RUN_MARKER.exec(text(pr?.body))?.[1];
  return id && SAFE_RUN_ID.test(id) ? id : undefined;
}

/**
 * The run that opened this PR, for a follow-up. Only an open PR counts: a
 * merged or closed PR's branch is stale (a squash merge leaves its commits
 * behind), so a follow-up there starts from the default branch.
 */
function priorRunIdOf(pr: Json | null, slug: string): string | undefined {
  if (pr?.state !== "open") return undefined;
  return appMarkerRunId(pr, slug);
}

/** Why a mention was dropped before routing; never carries the body. */
export interface DroppedMention {
  eventName: string;
  repository: string;
  association: string;
  reason: "author_association" | "not_a_user";
}

/**
 * A cheap pre-filter only: author_association is not a permission (MEMBER is
 * any org member, COLLABORATOR includes read and triage). The real gate is the
 * author's live repository permission, checked by id in core/host-events.ts.
 */
function trustedHuman(
  association: unknown,
  user: Json | null,
  drop: (reason: DroppedMention["reason"], association: string) => void,
): user is Json & { login: string; id: number } {
  const label = typeof association === "string" ? association : "missing";
  if (typeof association !== "string" || !TRUSTED_ASSOCIATIONS.has(association)) {
    drop("author_association", label);
    return false;
  }
  if (user?.type !== "User" || typeof user.login !== "string" || int(user.id) === null) {
    drop("not_a_user", label);
    return false;
  }
  return true;
}

/** `onDropped` hears about a mention the author pre-filter dropped, so the caller can log it. */
export function normalizeGitHubEvent(
  eventName: string,
  payload: unknown,
  app: { id: number; slug: string },
  onDropped?: (dropped: DroppedMention) => void,
): HostEvent | null {
  const p = obj(payload);
  if (!p) return null;
  const repository = repositoryOf(p);
  if (!repository) return null;
  const drop = (reason: DroppedMention["reason"], association: string) =>
    onDropped?.({ eventName, repository, association, reason });

  if (eventName === "push") {
    const defaultBranch = obj(p.repository)?.default_branch;
    const { before, after } = p;
    if (typeof defaultBranch !== "string" || !SAFE_BRANCH.test(defaultBranch)) return null;
    if (p.ref !== `refs/heads/${defaultBranch}` || p.deleted === true) return null;
    if (typeof before !== "string" || typeof after !== "string") return null;
    if (!SAFE_SHA.test(before) || !SAFE_SHA.test(after) || /^0+$/.test(after)) return null;
    const commits = Array.isArray(p.commits) ? p.commits : [];
    const paths = new Set<string>();
    for (const commit of commits) {
      const c = obj(commit);
      for (const list of [c?.added, c?.modified, c?.removed]) {
        if (Array.isArray(list)) for (const path of list) if (typeof path === "string") paths.add(path);
      }
    }
    return {
      kind: "push",
      provider: "github",
      repository,
      branch: defaultBranch,
      before,
      after,
      changedPaths: [...paths].sort().slice(0, PUSH_MAX_PATHS),
      // GitHub includes at most 2048 commits, so a full list may be truncated.
      changedPathsComplete: commits.length < PUSH_MAX_COMMITS && paths.size <= PUSH_MAX_PATHS,
    };
  }

  if (eventName === "pull_request") {
    const pr = obj(p.pull_request);
    if (p.action === "closed") {
      // No author or fork gate: this only marks issue/PR pairs wardby itself
      // recorded for this repository and number, never acting on PR text.
      const prNumber = int(pr?.number);
      if (!prNumber) return null;
      return { kind: "pr_closed", provider: "github", repository, prNumber, merged: pr?.merged === true };
    }
    if (typeof p.action !== "string" || !PR_ACTIONS.has(p.action)) return null;
    const head = obj(pr?.head);
    const prNumber = int(pr?.number);
    const headSha = head?.sha;
    if (!prNumber || typeof headSha !== "string" || !SAFE_SHA.test(headSha)) return null;
    const headRepo = obj(head?.repo)?.full_name;
    const isFork = typeof headRepo !== "string" || headRepo.toLowerCase() !== repository;
    return { kind: "pr_updated", provider: "github", repository, prNumber, headSha, isFork };
  }

  if (eventName === "check_suite") {
    if (p.action !== "completed") return null;
    const suite = obj(p.check_suite);
    // wardby's own review check finishing is not CI.
    if (int(obj(suite?.app)?.id) === app.id) return null;
    const headSha = suite?.head_sha;
    if (typeof headSha !== "string" || !SAFE_SHA.test(headSha)) return null;
    const prs = Array.isArray(suite?.pull_requests) ? suite.pull_requests : [];
    const prNumbers = [...new Set(prs.map((pr) => int(obj(pr)?.number)).filter((n): n is number => n !== null))];
    if (prNumbers.length === 0) return null;
    return { kind: "ci_completed", provider: "github", repository, headSha, prNumbers: prNumbers.slice(0, MAX_CI_PRS) };
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
    if (!mentions(title, app.slug) && !mentions(body, app.slug)) return null;
    if (!trustedHuman(issue?.author_association, user, drop)) return null;
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
      authorAssociation: String(issue?.author_association),
      ...(typeof obj(p.repository)?.private === "boolean"
        ? { repositoryPrivate: obj(p.repository)?.private as boolean }
        : {}),
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
    if (!trustedHuman(comment?.author_association, user, drop)) return null;
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
      authorAssociation: String(comment?.author_association),
      ...(typeof obj(p.repository)?.private === "boolean"
        ? { repositoryPrivate: obj(p.repository)?.private as boolean }
        : {}),
      ...(subject ? { subject } : {}),
      ...(priorRunId ? { priorRunId } : {}),
    };
  }
  return null;
}
