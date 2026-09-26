/**
 * Host-neutral routing of code-review host events (GitHub App webhooks today)
 * to the native agents linked to that repository. Adapters normalise their
 * payloads into HostEvent (providers/review-host/github-events.ts); this
 * module decides which agents run. See
 * docs/private/2026-09-25-code-review-host-design.md §6.3.
 */
import type { PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import type { CodeReviewHost, HostEvent, ReviewHostRegistry } from "../providers/review-host/types.js";
import { dispatchRun } from "./dispatch.js";
import { logger } from "./logger.js";
import { requiredLevel, type RepoAccessGate } from "./repo-access.js";

export type { HostEvent };

const log = logger.child({ module: "host-events" });
const MAX_TASK_BODY = 8000;
const MAX_TITLE = 256;
const HOST_NAMES: Record<HostEvent["provider"], string> = { github: "GitHub" };

export type HostEventDb = Pick<
  PrismaClient,
  "agentRepository" | "agent" | "run" | "runHostCheck" | "codingRun" | "task" | "webhook" | "$transaction" | "$queryRaw"
>;

export interface RouteHostEventDeps {
  db: HostEventDb;
  executor: Executor;
  hosts: ReviewHostRegistry;
  /** The App's @-handle without the "@", e.g. "wardby". */
  mentionHandle: string;
  /** Re-checks each link's authorization, and a mention author's own permission, before anything runs. */
  repoAccess: RepoAccessGate;
}

export interface RouteResult {
  runIds: string[];
  /** Cosmetic work to do after the webhook response is sent (reactions). */
  followUps: Array<() => Promise<void>>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isReviewCommand(body: string, mentionHandle: string): boolean {
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(mentionHandle)}\\s+review(?![\\w-])`, "i").test(body);
}

type MentionEvent = Extract<HostEvent, { kind: "mention" }>;

/**
 * The mention agent's task text. Deterministic so a prompt can parse it:
 * optional continuation hint, a header block, the issue/PR description, and
 * the request comment — omitted when the mention is in the issue/PR itself.
 * All of it is untrusted text; the runner wraps taskOverride as such.
 */
export function mentionTaskText(event: MentionEvent): string {
  const kind = event.isPullRequest ? "PR" : "issue";
  const sections: string[] = [];
  if (event.priorRunId) {
    sections.push(
      `[This request is a follow-up on PR #${event.number}, originally opened by wardby run ${event.priorRunId}. ` +
        `If you delegate, pass continuePriorRun set to exactly "${event.priorRunId}" so the same PR/branch is ` +
        `continued instead of opening a new one.]`,
    );
  }
  const title = event.subject?.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  sections.push(
    [
      `[${HOST_NAMES[event.provider]} ${kind} #${event.number}${title ? `: ${title}` : ""}]`,
      `Repository: ${event.repository}`,
      `Requested by @${event.author}${event.replyToReviewCommentId ? ` (in review thread ${event.replyToReviewCommentId})` : ""}`,
    ].join("\n"),
  );
  const description = event.subject?.body.trim() ? event.subject.body.slice(0, MAX_TASK_BODY) : "";
  if (description) sections.push(`${event.isPullRequest ? "PR" : "Issue"} description:\n${description}`);
  if (event.comment.kind !== "subject") sections.push(`Request comment:\n${event.body.slice(0, MAX_TASK_BODY)}`);
  return sections.join("\n\n");
}

interface ReviewTarget {
  agentId: string;
  checkName: string;
}

async function startReviews(
  deps: RouteHostEventDeps,
  host: CodeReviewHost,
  repository: string,
  prNumber: number,
  headSha: string,
  targets: ReviewTarget[],
): Promise<string[]> {
  const runIds: string[] = [];
  for (const target of targets) {
    let checkId: string | null = null;
    try {
      checkId = (await host.startCheck(repository, { headSha, name: target.checkName })).checkId;
    } catch (err) {
      // The review still runs; repo_publish_review creates the check itself.
      log.warn({ err, repository, prNumber, agentId: target.agentId }, "could not start the review check");
    }
    try {
      const dispatched = await dispatchRun({
        db: deps.db,
        executor: deps.executor,
        agentId: target.agentId,
        trigger: "host_event",
        taskOverride: `Review pull request #${prNumber} in ${repository} (head ${headSha}).`,
        afterPersist: checkId
          ? async (tx, run) => {
              await tx.runHostCheck.create({
                data: { runId: run.id, provider: host.provider, repository, checkId, headSha, prNumber },
              });
            }
          : undefined,
      });
      if (!dispatched) throw new Error("dispatch_refused");
      runIds.push(dispatched.run.id);
      log.info({ repository, prNumber, agentId: target.agentId, runId: dispatched.run.id }, "review run dispatched");
    } catch (err) {
      log.warn({ err, repository, prNumber, agentId: target.agentId }, "review run could not be dispatched");
      if (checkId) {
        await host
          .completeCheck(repository, {
            checkId,
            conclusion: "neutral",
            title: "Review could not be started",
            summary: "wardby could not start this review. Use Re-run to try again.",
          })
          .catch((e: unknown) => log.warn({ err: e, repository, prNumber }, "could not complete the unstarted check"));
      }
    }
  }
  return runIds;
}

type LinkRow = Awaited<ReturnType<HostEventDb["agentRepository"]["findMany"]>>[number] & {
  agent: { ownerId: string | null };
};

/**
 * Keeps only the links the gate still authorizes: the agent must have an
 * owner, and the owner's current access (or a recorded admin/grandfathered
 * approval) must cover the link. Denials are logged, never surfaced.
 */
async function authorizedLinks(deps: RouteHostEventDeps, event: HostEvent, links: LinkRow[]): Promise<LinkRow[]> {
  const kept: LinkRow[] = [];
  for (const link of links) {
    const decision = await deps.repoAccess.authorizeUse({
      ownerId: link.agent.ownerId,
      provider: event.provider,
      repository: event.repository,
      required: requiredLevel(link.access === "write" ? "write" : "read"),
      authorizedVia: link.authorizedVia,
    });
    if (decision.ok) kept.push(link);
    else {
      log.warn(
        { repository: event.repository, agentId: link.agentId, reason: decision.reason },
        "host event skipped an agent whose repository access is not authorized",
      );
    }
  }
  return kept;
}

const reviewTargets = (links: LinkRow[]): ReviewTarget[] =>
  links.map((l) => ({ agentId: l.agentId, checkName: l.checkName! }));

export async function routeHostEvent(event: HostEvent, deps: RouteHostEventDeps): Promise<RouteResult> {
  const none: RouteResult = { runIds: [], followUps: [] };
  const host = deps.hosts[event.provider];
  if (!host) return none;
  const links = (await deps.db.agentRepository.findMany({
    where: { provider: event.provider, repository: event.repository },
    include: { agent: { select: { ownerId: true } } },
  })) as LinkRow[];
  const reviewerLinks = links.filter((l) => l.access === "write" && l.triggers.includes("pull_request") && l.checkName);

  switch (event.kind) {
    case "pr_updated": {
      if (event.isFork || reviewerLinks.length === 0) return none;
      const reviewers = reviewTargets(await authorizedLinks(deps, event, reviewerLinks));
      if (reviewers.length === 0) return none;
      return {
        runIds: await startReviews(deps, host, event.repository, event.prNumber, event.headSha, reviewers),
        followUps: [],
      };
    }
    case "check_rerun": {
      const owners = reviewerLinks.filter((l) => l.checkName === event.checkName);
      if (owners.length === 0) return none;
      const reviewers = reviewTargets(await authorizedLinks(deps, event, owners));
      if (reviewers.length === 0) return none;
      return {
        runIds: await startReviews(deps, host, event.repository, event.prNumber, event.headSha, reviewers),
        followUps: [],
      };
    }
    case "mention": {
      const react = async () => {
        await host.acknowledge(event.repository, event.comment).catch((err: unknown) => {
          log.warn({ err, repository: event.repository, number: event.number }, "could not add the reaction");
        });
      };
      const reviewCommand = event.isPullRequest && isReviewCommand(event.body, deps.mentionHandle);
      const responderLink = links.find((l) => l.access === "write" && l.triggers.includes("mention"));
      const candidates = reviewCommand ? reviewerLinks : responderLink ? [responderLink] : [];
      if (candidates.length === 0) return none;
      // H5-3: a mention drives a write-capable agent holding its owner's
      // tools and secrets, so its author needs real push access to the
      // repository (author_association, checked upstream, is only a
      // pre-filter). Checked by the author's immutable id.
      const author = await deps.repoAccess.authorizeHostUser({
        provider: event.provider,
        repository: event.repository,
        user: { id: event.authorId, login: event.author },
        required: requiredLevel("mention"),
      });
      if (!author.ok) {
        log.info(
          { repository: event.repository, number: event.number, reason: author.reason, level: author.level },
          "mention ignored: its author lacks write access",
        );
        return none;
      }
      const allowed = await authorizedLinks(deps, event, candidates);
      if (allowed.length === 0) return none;
      if (reviewCommand) {
        const head = await host.pullRequestHead(event.repository, event.number);
        if (head.isFork || head.state !== "open") return none;
        return {
          runIds: await startReviews(deps, host, event.repository, event.number, head.headSha, reviewTargets(allowed)),
          followUps: [react],
        };
      }
      const dispatched = await dispatchRun({
        db: deps.db,
        executor: deps.executor,
        agentId: allowed[0].agentId,
        trigger: "host_event",
        taskOverride: mentionTaskText(event),
      });
      if (!dispatched) return none;
      log.info(
        { repository: event.repository, number: event.number, runId: dispatched.run.id },
        "mention run dispatched",
      );
      return { runIds: [dispatched.run.id], followUps: [react] };
    }
  }
}
